/**
 * WO-05 / WO-06 / C-FIX-002 — one call that turns a tool's live state into a
 * reviewed request.
 *
 * The prompt builder and the preflight gate know nothing about storage. This is the
 * seam that connects them to the data the app already has:
 *
 * - the operator instruction from `promptStore` (the prompt pane's text)
 * - the few-shot examples from `fewShotStore` (enabled ones for this tool)
 * - the connection settings from `settings` (never the key: the key is passed in
 *   from this tab's memory by the caller)
 * - the provider profile for the configured model (C-FIX-007), which supplies the
 *   context ceiling and the capability set the allocation runs against
 *
 * The result is a preview the UI can show and the user can approve; nothing is sent
 * here. Since C-FIX-002 the payload and the preview describe the same thing: when
 * the allocation excludes part of the file, the prompt is rebuilt from the selected
 * units, so the user is not approving one payload and sending another.
 */

import type { ToolId } from '../../adapters/types';
import { listExamples } from '../../lib/fewShotStore';
import { readPrompt } from '../../lib/promptStore';
import { planBudget, type BudgetPlan, type BudgetSettings } from './budget';
import { focusTermsFrom, type ContextProfile } from './contextAllocator';
import { buildPreflight, type PreflightPreview } from './preflight';
import { buildPrompt, type BuiltPrompt } from './promptBuilder';
import { contextProfileFor, providerRegistry, type ProviderResolution } from './providerProfiles';
import type { RedactionOptions } from './redaction';
import { connectionSettingsStore, type ConnectionSettings } from './settings';

export interface HybridRequestPlanInput {
  toolId: ToolId;
  source: string;
  sourceName: string;
  /** Deterministic facts from the local engine (already redacted at build time? no — redacted later). */
  localAnalysis?: string;
  targetLanguage?: string;
  outputSchema?: string;
  /** Overrides the saved connection settings (used by tests and by a panel draft). */
  settings?: ConnectionSettings;
  redaction?: RedactionOptions;
  /** Extra terms for the source allocation (defaults to the operator instruction). */
  focusTerms?: string[];
}

export interface HybridRequestPlan {
  settings: ConnectionSettings;
  /** The provider profile the request will run under (C-FIX-007). */
  provider: ProviderResolution;
  /** What the allocation decided for each section (C-FIX-002). */
  contextProfile: ContextProfile;
  /** True when the prompt was rebuilt from the allocated source units only. */
  payloadTrimmed: boolean;
  built: BuiltPrompt;
  budget: BudgetPlan;
  preview: PreflightPreview;
}

function budgetSettingsFor(settings: ConnectionSettings): BudgetSettings {
  return {
    contextLimit: settings.contextLimit,
    maxInputTokens: settings.maxInputTokens,
    maxOutputTokens: settings.maxOutputTokens,
    fewShotTokenBudget: settings.fewShotTokenBudget,
  };
}

function partsFrom(built: BuiltPrompt, source: string) {
  return {
    systemTokens: built.tokens.system,
    operatorTokens: built.tokens.operatorInstruction,
    localAnalysisTokens: built.tokens.localAnalysis,
    schemaTokens: built.tokens.schema,
    fewShotTokens: built.tokens.fewShot,
    source,
  };
}

/**
 * Reads the tool's stored prompt and examples, builds the prompt, plans the budget
 * against the model's capability profile and produces the approval preview. Any
 * change to the stored instruction, the enabled examples or the settings changes
 * the preview's fingerprint.
 */
export async function planHybridRequest(input: HybridRequestPlanInput): Promise<HybridRequestPlan> {
  const settings = input.settings ?? connectionSettingsStore.read();
  const operatorInstruction = readPrompt(input.toolId);
  const examples = await listExamples(input.toolId);
  const budgetSettings = budgetSettingsFor(settings);
  const provider = providerRegistry.resolve({ baseUrl: settings.baseUrl, model: settings.model });
  const contextProfile = contextProfileFor(provider.profile, provider.capabilities);
  const focusTerms = input.focusTerms ?? focusTermsFrom(operatorInstruction);

  const build = (sourceText: string, fewShotBudget: number): BuiltPrompt =>
    buildPrompt({
      toolId: input.toolId,
      strategy: settings.promptStrategy,
      operatorInstruction,
      localAnalysis: input.localAnalysis ?? '',
      source: { name: input.sourceName, text: sourceText },
      examples,
      targetLanguage: input.targetLanguage,
      outputSchema: input.outputSchema,
      fewShotTokenBudget: fewShotBudget,
    });

  let built = build(input.source, settings.fewShotTokenBudget);
  // The budget counts the sections as they will be sent, so the plan and the
  // preview cannot disagree about how much room the source has.
  let budget = planBudget(partsFrom(built, input.source), budgetSettings, { profile: contextProfile, focusTerms });

  // A profile may cap the few-shot block to keep room for the file; the prompt is
  // rebuilt with that cap so the payload and the allocation agree.
  const fewShotSection = budget.allocation.sections.find((section) => section.name === 'fewShot');
  const fewShotAllowed = fewShotSection?.allowed ?? settings.fewShotTokenBudget;
  if (fewShotSection?.truncated) {
    built = build(input.source, fewShotAllowed);
    budget = planBudget(partsFrom(built, input.source), budgetSettings, { profile: contextProfile, focusTerms });
  }

  // C-FIX-002: the transmitted source is exactly the allocated selection. The
  // budget keeps the full unit list so the preview can still name the excluded
  // ranges; the prompt is rebuilt from the selected units only.
  const payloadTrimmed = budget.selection.truncated;
  if (payloadTrimmed) {
    built = build(budget.selection.text, fewShotAllowed);
  }

  const preview = await buildPreflight({
    settings,
    built,
    budget,
    redaction: input.redaction,
    toolId: input.toolId,
  });
  return { settings, provider, contextProfile, payloadTrimmed, built, budget, preview };
}
