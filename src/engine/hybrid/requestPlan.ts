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
import { sha256Hex } from '../../lib/util';
import { planBudget, type BudgetPlan, type BudgetSettings } from './budget';
import { stableFingerprint } from './canonical';
import { hybridConfig } from './config';
import { focusTermsFrom, type ContextProfile } from './contextAllocator';
import { chatBodySpecFor, type ChatBodySpec } from './requestBody';
import { buildPreflight, type PreflightPreview } from './preflight';
import { buildPrompt, type BuiltPrompt } from './promptBuilder';
import { contextProfileFor, providerProfileFingerprint, providerRegistry, type ProviderCapabilities, type ProviderResolution } from './providerProfiles';
import { redactionRegistry, type RedactionOptions } from './redaction';
import { redactionPolicyFingerprint, redactionPolicyStore } from './redactionPolicy';
import { connectionSettingsStore, settingsFingerprint, type ConnectionSettings } from './settings';
import { scopeAnalysisToSelection, scopeAnalysisToExcluded, sectionsOfMarkdown, type LineRange } from './sourceScope';
import { countMessageTokens } from './tokenAccounting';

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
  /** INT-007: the session's literal secrets (the key in memory). */
  secrets?: string[];
  /** Extra terms for the source allocation (defaults to the operator instruction). */
  focusTerms?: string[];
  /**
   * INT-007 (Kotoha): section indexes the operator ticked for transmission. When
   * present, unselected sections are removed before the prompt is built, and the
   * preview states which ranges were left out.
   */
  sectionSelection?: number[];
  /** INT-006: an explicit provider profile id (otherwise resolved from host/model). */
  providerId?: string;
  /** INT-006: the capabilities of the client that will send (overrides the registry). */
  capabilities?: ProviderCapabilities;
  /** INT-001: the session credential revision when this preview was created. */
  credentialRevision?: number;
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
  /** INT-001: the body parameters this plan approved. */
  body: ChatBodySpec;
  /** INT-003: identity of the settings this preview is valid for. */
  settingsFingerprint: string;
  /** INT-003: identity of every input the preview was built from. */
  inputsFingerprint: string;
  /** Preview-time credential identity; the raw key is never retained here. */
  credentialRevision: number;
  credentialFingerprint: string | null;
  /** Preview-time policy/profile/config identities, rechecked before transmission. */
  redactionPolicyRevision: number;
  redactionPolicyFingerprint: string;
  providerProfileRevision: number;
  providerProfileFingerprint: string;
  configFingerprint: string;
  /** Non-secret arguments needed to recompute the same identity before send. */
  identityInput: {
    targetLanguage?: string;
    sectionSelection?: number[];
    providerId?: string;
    capabilities?: ProviderCapabilities;
    redaction?: Omit<RedactionOptions, 'secrets'>;
  };
  /** INT-001: set once this approved preview was used for a send. */
  approvalUsed?: boolean;
  /** INT-007: the sections the operator allowed (Kotoha). */
  sendSections?: { selected: LineRange[]; excluded: LineRange[] };
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
 * INT-007 — keeps the document's line numbering while removing sections the
 * operator did not tick. Each line of an unselected section becomes empty, so the
 * remaining text still starts at its original line number and the preview and the
 * evidence check refer to the same document.
 */
export function maskUnselectedSections(source: string, selected: number[]): { source: string; selected: LineRange[]; excluded: LineRange[] } {
  const sections = sectionsOfMarkdown(source);
  const wanted = new Set(selected);
  const lines = source.split('\n');
  const excludedRanges: LineRange[] = [];
  for (const section of sections) {
    if (wanted.has(section.index)) continue;
    excludedRanges.push({ start: section.startLine, end: section.endLine });
    for (let line = section.startLine; line <= section.endLine; line += 1) lines[line - 1] = '';
  }
  return {
    source: lines.join('\n'),
    selected: sections
      .filter((section) => wanted.has(section.index))
      .map((section) => ({ start: section.startLine, end: section.endLine })),
    excluded: excludedRanges,
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
  const provider = providerRegistry.resolve({
    baseUrl: settings.baseUrl,
    model: settings.model,
    providerId: input.providerId || settings.providerId || undefined,
  });
  // INT-006: when the caller supplies the actual client's capabilities, the
  // allocation and the body use those — the plan and the sender agree.
  const capabilities = input.capabilities ?? provider.capabilities;
  const contextProfile = contextProfileFor(provider.profile, capabilities);
  const focusTerms = input.focusTerms ?? focusTermsFrom(operatorInstruction);
  const limited = input.sectionSelection ? maskUnselectedSections(input.source, input.sectionSelection) : null;
  const source = limited?.source ?? input.source;
  // INT-007: the local analysis is filtered to the approved scope too; the model
  // must not learn about a section the operator did not tick.
  const initialAnalysis = limited
    ? scopeAnalysisToExcluded(input.localAnalysis ?? '', limited.excluded).text
    : input.localAnalysis ?? '';

  const build = (sourceText: string, fewShotBudget: number, localAnalysis = initialAnalysis): BuiltPrompt =>
    buildPrompt({
      toolId: input.toolId,
      strategy: settings.promptStrategy,
      operatorInstruction,
      localAnalysis,
      source: { name: input.sourceName, text: sourceText },
      examples,
      targetLanguage: input.targetLanguage,
      outputSchema: input.outputSchema,
      fewShotTokenBudget: fewShotBudget,
      charsPerToken: capabilities.charsPerToken,
    });

  let built = build(source, settings.fewShotTokenBudget);
  let budget = planBudget(partsFrom(built, source), budgetSettings, { profile: contextProfile, focusTerms });
  let fewShotAllowed = settings.fewShotTokenBudget;
  let loopSettings = { ...budgetSettings };

  // INT-002: the allocation is final only when the *assembled* payload fits. The
  // section estimate and the final message count differ by the protocol overhead
  // and by the delimiters the builder adds, so the source allowance is reduced by
  // the measured excess and the selection is computed again — never silently sent
  // over the limit, and never blocked for a few tokens the plan itself could give
  // back.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    built = build(source, fewShotAllowed);
    budget = planBudget(partsFrom(built, source), loopSettings, { profile: contextProfile, focusTerms });

    // A profile may cap the few-shot block to keep room for the file.
    const fewShotSection = budget.allocation.sections.find((section) => section.name === 'fewShot');
    if (fewShotSection?.truncated && fewShotSection.allowed < fewShotAllowed) {
      fewShotAllowed = fewShotSection.allowed;
      continue;
    }

    // C-FIX-002: the transmitted source is exactly the allocated selection. The
    // budget keeps the full unit list so the preview can still name the excluded
    // ranges; the prompt is rebuilt from the selected units only.
    const analysisForSelection = budget.selection.truncated
      ? scopeAnalysisToSelection(initialAnalysis, budget.selection).text
      : initialAnalysis;
    built = budget.selection.truncated
      ? build(budget.selection.text, fewShotAllowed, analysisForSelection)
      : build(source, fewShotAllowed, initialAnalysis);

    const finalCount = countMessageTokens(built.messages, { charsPerToken: capabilities.charsPerToken });
    if (finalCount.total <= budget.inputAllowance) break;
    // The deficit is the fixed cost the section estimate missed (role separators,
    // delimiters, the reply priming). Shrinking the user's allowance would shrink
    // the source by the same amount and leave the deficit in place, so the fixed
    // cost is charged to the overhead instead.
    const deficit = finalCount.total - budget.inputAllowance + 3;
    loopSettings = {
      ...loopSettings,
      extraOverheadTokens: (loopSettings.extraOverheadTokens ?? 0) + deficit,
    };
  }

  const payloadTrimmed = budget.selection.truncated;

  // INT-001/006: the exact body the approval will cover.
  const body = chatBodySpecFor({
    model: settings.model,
    temperature: settings.temperature,
    maxOutputTokens: budget.maxOutputTokens,
    streaming: settings.streaming,
    capabilities,
    providerId: provider.profile.id,
    structuredOutput: settings.structuredOutput,
  });

  // INT-007: the operator's saved redaction policy applies to every request, in
  // addition to whatever this call supplies.
  const savedPolicy = redactionPolicyStore.read();
  const redactionOptions: RedactionOptions = {
    customPatterns: [...savedPolicy.customPatterns, ...(input.redaction?.customPatterns ?? [])],
    disabled: [...new Set([...savedPolicy.disabled, ...(input.redaction?.disabled ?? [])])],
    secrets: input.secrets ?? input.redaction?.secrets,
  };

  const configFingerprint = hybridConfig.fingerprint();
  const preview = await buildPreflight({
    settings,
    built,
    budget,
    redaction: redactionOptions,
    toolId: input.toolId,
    body,
    tokenProfile: { charsPerToken: capabilities.charsPerToken },
    provider: provider.profile,
  });

  const identity = await requestIdentityOf({
    input,
    settings,
    operatorInstruction,
    examples,
    provider,
    capabilities,
    savedPolicy,
    configFingerprint,
  });
  const credentialSecret = input.secrets?.[0] ?? input.redaction?.secrets?.find((secret) => typeof secret === 'string' && secret.trim());

  return {
    settings,
    provider,
    contextProfile,
    payloadTrimmed,
    built,
    budget,
    preview,
    body,
    settingsFingerprint: settingsFingerprint(settings),
    inputsFingerprint: identity.fingerprint,
    credentialRevision: input.credentialRevision ?? 0,
    credentialFingerprint: credentialSecret ? await sha256Hex(credentialSecret) : null,
    redactionPolicyRevision: identity.redactionPolicyRevision,
    redactionPolicyFingerprint: identity.redactionPolicyFingerprint,
    providerProfileRevision: identity.providerProfileRevision,
    providerProfileFingerprint: identity.providerProfileFingerprint,
    configFingerprint,
    identityInput: {
      targetLanguage: input.targetLanguage,
      sectionSelection: input.sectionSelection,
      providerId: input.providerId,
      capabilities: input.capabilities,
      redaction: input.redaction
        ? {
            customPatterns: input.redaction.customPatterns,
            disabled: input.redaction.disabled,
            compiled: input.redaction.compiled,
            registry: input.redaction.registry,
          }
        : undefined,
    },
    sendSections: limited ? { selected: limited.selected, excluded: limited.excluded } : undefined,
  };
}

type FingerprintInput = Pick<
  HybridRequestPlanInput,
  | 'toolId'
  | 'source'
  | 'sourceName'
  | 'targetLanguage'
  | 'sectionSelection'
  | 'secrets'
  | 'settings'
  | 'redaction'
  | 'providerId'
  | 'capabilities'
  | 'credentialRevision'
>;

interface FingerprintArgs {
  input: FingerprintInput;
  settings: ConnectionSettings;
  operatorInstruction: string;
  examples: Awaited<ReturnType<typeof listExamples>>;
  provider: ProviderResolution;
  capabilities: ProviderCapabilities;
  savedPolicy: ReturnType<typeof redactionPolicyStore.read>;
  configFingerprint: string;
}

interface RequestIdentity {
  fingerprint: string;
  redactionPolicyRevision: number;
  redactionPolicyFingerprint: string;
  providerProfileRevision: number;
  providerProfileFingerprint: string;
}

function exampleIdentity(example: Awaited<ReturnType<typeof listExamples>>[number]) {
  return [
    example.id,
    example.toolId,
    example.title,
    example.role,
    example.inputFileName ?? '',
    example.inputText ?? '',
    example.outputFileName ?? '',
    example.outputText,
    example.targetLanguage ?? '',
    example.enabled,
    example.estimatedTokens,
  ];
}

function redactionIdentity(input: FingerprintArgs['input'], savedPolicy: FingerprintArgs['savedPolicy']) {
  return {
    customPatterns: [...savedPolicy.customPatterns, ...(input.redaction?.customPatterns ?? [])],
    disabled: [...new Set([...savedPolicy.disabled, ...(input.redaction?.disabled ?? [])])],
    compiled: (input.redaction?.compiled ?? []).map((rule) => ({
      id: rule.id,
      kind: rule.kind,
      label: rule.label,
      source: rule.pattern.source,
      flags: rule.pattern.flags,
      replacement: rule.replacement,
    })),
    registryFingerprint: input.redaction?.registry?.fingerprint() ?? redactionRegistry.fingerprint(),
  };
}

async function requestIdentityOf(args: FingerprintArgs): Promise<RequestIdentity> {
  const secrets = [...new Set((args.input.secrets ?? args.input.redaction?.secrets ?? [])
    .filter((secret): secret is string => typeof secret === 'string' && secret.trim().length > 0)
    .map((secret) => secret.trim()))];
  const secretFingerprints = await Promise.all(secrets.map((secret) => sha256Hex(secret)));
  const policyFingerprint = redactionPolicyFingerprint(args.savedPolicy);
  const profileFingerprint = providerProfileFingerprint(args.provider.profile, args.settings.model);
  const identity = {
    toolId: args.input.toolId,
    source: args.input.source,
    sourceName: args.input.sourceName,
    targetLanguage: args.input.targetLanguage ?? '',
    sectionSelection: args.input.sectionSelection ?? null,
    operatorInstruction: args.operatorInstruction,
    examples: args.examples.map(exampleIdentity).sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    settings: settingsFingerprint(args.settings),
    secrets: secretFingerprints,
    credentialRevision: args.input.credentialRevision ?? 0,
    redactionPolicyRevision: redactionPolicyStore.revision(),
    redactionPolicy: {
      fingerprint: policyFingerprint,
      effective: redactionIdentity(args.input, args.savedPolicy),
    },
    providerProfileRevision: providerRegistry.revision(),
    providerProfile: {
      fingerprint: profileFingerprint,
      capabilities: args.capabilities,
    },
    configFingerprint: args.configFingerprint,
  };
  return {
    fingerprint: stableFingerprint(identity),
    redactionPolicyRevision: identity.redactionPolicyRevision,
    redactionPolicyFingerprint: policyFingerprint,
    providerProfileRevision: identity.providerProfileRevision,
    providerProfileFingerprint: profileFingerprint,
  };
}

/** The identity of every input that shaped a preview (INT-003). */
function inputsFingerprintOf(args: FingerprintArgs): Promise<string> {
  return requestIdentityOf(args).then((identity) => identity.fingerprint);
}

/**
 * INT-003: re-reads the inputs a preview was built from and returns their identity.
 * The send path compares it with the preview's — a prompt, few-shot, credential,
 * policy, profile or configuration change invalidates the approval.
 */
export async function inputsFingerprintFor(input: FingerprintInput): Promise<string> {
  const settings = input.settings ?? connectionSettingsStore.read();
  const operatorInstruction = readPrompt(input.toolId);
  const examples = await listExamples(input.toolId);
  const provider = providerRegistry.resolve({
    baseUrl: settings.baseUrl,
    model: settings.model,
    providerId: input.providerId || settings.providerId || undefined,
  });
  const capabilities = input.capabilities ?? provider.capabilities;
  const savedPolicy = redactionPolicyStore.read();
  return inputsFingerprintOf({
    input,
    settings,
    operatorInstruction,
    examples,
    provider,
    capabilities,
    savedPolicy,
    configFingerprint: hybridConfig.fingerprint(),
  });
}
