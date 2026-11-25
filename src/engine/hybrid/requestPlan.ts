/**
 * WO-05 / WO-06 — one call that turns a tool's live state into a reviewed request.
 *
 * The prompt builder and the preflight gate know nothing about storage. This is the
 * seam that connects them to the data the app already has:
 *
 * - the operator instruction from `promptStore` (the prompt pane's text)
 * - the few-shot examples from `fewShotStore` (enabled ones for this tool)
 * - the connection settings from `settings` (never the key: the key is passed in
 *   from this tab's memory by the caller)
 *
 * The result is a preview the UI can show and the user can approve; nothing is sent
 * here.
 */

import type { ToolId } from '../../adapters/types';
import { listExamples } from '../../lib/fewShotStore';
import { readPrompt } from '../../lib/promptStore';
import { planBudget, type BudgetPlan, type BudgetSettings } from './budget';
import { buildPreflight, type PreflightPreview } from './preflight';
import { buildPrompt, type BuiltPrompt } from './promptBuilder';
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
}

export interface HybridRequestPlan {
  settings: ConnectionSettings;
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

/**
 * Reads the tool's stored prompt and examples, builds the prompt, plans the budget
 * and produces the approval preview. Any change to the stored instruction, the
 * enabled examples or the settings changes the preview's fingerprint.
 */
export async function planHybridRequest(input: HybridRequestPlanInput): Promise<HybridRequestPlan> {
  const settings = input.settings ?? connectionSettingsStore.read();
  const operatorInstruction = readPrompt(input.toolId);
  const examples = await listExamples(input.toolId);

  const built = buildPrompt({
    toolId: input.toolId,
    strategy: settings.promptStrategy,
    operatorInstruction,
    localAnalysis: input.localAnalysis ?? '',
    source: { name: input.sourceName, text: input.source },
    examples,
    targetLanguage: input.targetLanguage,
    outputSchema: input.outputSchema,
    fewShotTokenBudget: settings.fewShotTokenBudget,
  });

  // The budget counts the sections as they will be sent, so the plan and the
  // preview cannot disagree about how much room the source has.
  const budget = planBudget(
    {
      systemTokens: built.tokens.system,
      operatorTokens: built.tokens.operatorInstruction,
      localAnalysisTokens: built.tokens.localAnalysis,
      schemaTokens: built.tokens.schema,
      fewShotTokens: built.tokens.fewShot,
      source: input.source,
    },
    budgetSettingsFor(settings),
  );

  const preview = await buildPreflight({ settings, built, budget, redaction: input.redaction });
  return { settings, built, budget, preview };
}
