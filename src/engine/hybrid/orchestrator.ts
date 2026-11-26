/**
 * WO-09 — hybrid orchestrator.
 *
 * One function runs the whole hybrid pass in a fixed order, and every step has a
 * single job:
 *
 *   1. local engine            → the deterministic result (never recomputed)
 *   2. local analysis          → the compact fact sheet the model may cite
 *   3. prompt build            → one composition, from promptStore/fewShotStore
 *   4. redaction               → secrets replaced on the messages that are sent
 *   5. context budget          → refuse instead of truncating silently
 *   6. preflight preview       → the exact payload, the destination, the counts
 *   7. user approval           → one approval per payload hash, consumed by the send
 *   8. gateway request         → SSE or one response, under a session (WO-08)
 *   9. response validation     → strict schema + evidence against local facts
 *  10. merge policy            → local facts win; AI only proposes, with citations
 *  11. artifact or proposals   → the local artifact stays; proposals wait for review
 *
 * Failure policy: any network/provider/timeout/schema/evidence failure ends at
 * the local result (`local-fallback`). A user Stop ends `cancelled` and starts no
 * new local computation. In both cases the local result computed in step 1 is
 * reused — the deterministic pass never runs twice for one request.
 */

import type { ToolId } from '../../adapters/types';
import type { EngineMode } from '../../lib/engineMode';
import type { HybridFailure, HybridProvider, HybridProviderRequest } from './contracts';
import type { EngineRunResult, ToolOptions, ToolOutput } from '../core/contracts';
import { runEngine } from '../core/runner';
import { HybridError, toHybridError } from './errors';
import { mergeProposals, type AiProposal, type EvidenceFacts, type MergeConflict, type RejectedProposal } from './mergePolicy';
import { OpenAiCompatibleProvider } from './openAiCompatible';
import { assertApprovedPayload, createPreflightGate, type PreflightPreview } from './preflight';
import { planHybridRequest, type HybridRequestPlan } from './requestPlan';
import { toHybridSettings, type ConnectionSettings } from './settings';
import {
  createHybridSession,
  runGatewayRequest,
  TERMINAL_STAGES,
  type GatewayResult,
  type HybridSession,
  type HybridStage,
  type HybridStatus,
  type HybridUsage,
} from './streamEngine';
import { toolHybridSpec } from './tools';
import { buildTelemetry, type HybridTelemetry } from './telemetry';
import { describeActiveContent, findActiveContent } from './sanitize';
import { createEvidenceLog, executionFindings, type EvidenceLog, type EvidenceRecord } from './evidence';
import type { LifecycleRegistry, LifecycleState, RequestLifecycle } from './lifecycle';
import { providerRegistry } from './providerProfiles';
import { policyForProfile } from './resourcePolicy';
import { redactionRegistry } from './redaction';
import {
  assertSnapshotIntegrity,
  sealRequestSnapshot,
  verifyRequestSnapshot,
  type RequestSnapshot,
  type SnapshotProblem,
} from './requestSnapshot';

export type HybridProvenance = 'local-static' | 'hybrid-ai' | 'local-fallback';

export const PROVENANCE_LABEL: Record<HybridProvenance, string> = {
  'local-static': 'ローカル静的解析',
  'hybrid-ai': 'ハイブリッド（AI 補完）',
  'local-fallback': 'ローカル代替（AI 未使用）',
};

export interface HybridPassInput<K extends ToolId> {
  toolId: K;
  sourceName: string;
  source: string;
  options: ToolOptions<K>;
  /** The already-computed local result. When given, the local engine is not run. */
  localResult?: EngineRunResult<K>;
  /** Just the artifact a tool pane already holds; wrapped as a reused result. */
  localOutput?: ToolOutput<K>;
  settings: ConnectionSettings;
  apiKey?: string | null;
  /**
   * The engine mode the operator selected (WO-11). `'local'` ends the pass at the
   * local result before a prompt is built, so Mode A cannot transmit even if a
   * screen calls this function by mistake.
   */
  engineMode?: EngineMode;
  /** The user's approval of the exact preview. `false` keeps the local result. */
  approve(preview: PreflightPreview): boolean | Promise<boolean>;
  /** A preview the caller already showed; the orchestrator sends exactly this. */
  plan?: HybridRequestPlan;
  provider?: HybridProvider;
  signal?: AbortSignal;
  /** The caller's freshness check (input revision, unmount, tool switch). */
  isCurrent?: () => boolean;
  targetLanguage?: string;
  now?: () => number;
  /** Shared single-flight registry: one active request per scope (C-FIX-003). */
  lifecycleRegistry?: LifecycleRegistry;
  /** Scope key for the registry; defaults to the tool id. */
  lifecycleScope?: string;
  /** Evidence log to append to (C-FIX-009); a fresh in-memory log when omitted. */
  evidenceLog?: EvidenceLog;
  /** Explicit provider profile id (C-FIX-007). */
  providerId?: string;
  onStatus?: (status: HybridStatus) => void;
  onSession?: (session: HybridSession) => void;
  onDelta?: (chunk: string, total: string) => void;
  /** Test seam; defaults to the shared engine runner (which also caches). */
  runLocal?: (args: {
    toolId: K;
    sourceName: string;
    source: string;
    options: ToolOptions<K>;
  }) => Promise<EngineRunResult<K>>;
  maxResponseChars?: number;
}

export interface HybridPassOutcome<K extends ToolId> {
  provenance: HybridProvenance;
  stage: HybridStage;
  status: HybridStatus;
  local: EngineRunResult<K>;
  /** The artifact to display. AI text only appears after `applyAccepted`. */
  output: ToolOutput<K>;
  plan: HybridRequestPlan | null;
  preview: PreflightPreview | null;
  proposals: AiProposal[];
  rejected: RejectedProposal[];
  conflicts: MergeConflict[];
  summary: string;
  failure: HybridFailure | null;
  reason: string | null;
  usage: HybridUsage | null;
  ttftMs: number | null;
  elapsedMs: number;
  /** Stable id for this run, shown in the telemetry panel. */
  requestId: string;
  finishReason: string | null;
  redactionCount: number;
  /** Token/time/request numbers for the in-tab panel; never persisted, never sent. */
  telemetry: HybridTelemetry;
  aiText: string | null;
  /** False when the caller moved on while this pass was running (stale). */
  applied: boolean;
  /** The sealed payload that was transmitted (C-FIX-001); null when nothing was sent. */
  snapshot: RequestSnapshot | null;
  /** Chain digest of the sealed payload, for the in-tab evidence row. */
  payloadDigest: string | null;
  /** The request's final lifecycle state (C-FIX-003). */
  lifecycleState: LifecycleState | null;
  /** True when the answer arrived as SSE deltas; null when nothing was received. */
  streamed: boolean | null;
  /** True only when the stream saw `[DONE]` / `finish_reason`. */
  terminated: boolean | null;
  /** Bytes the transport accepted for the answer (C-FIX-005). */
  responseBytes: number | null;
  /** Tamper-evident record for this run (C-FIX-009); filled by the pass wrapper. */
  evidence: EvidenceRecord | null;
}

/** Applies accepted proposals through the tool's own merge function. */
export function applyAccepted<K extends ToolId>(
  toolId: K,
  output: ToolOutput<K>,
  accepted: AiProposal[],
): ToolOutput<K> {
  if (!accepted.length) return output;
  return toolHybridSpec(toolId).apply(output, accepted);
}

/**
 * A tool pane holds the artifact, not the whole engine result. This wrapper marks
 * the analysis as already done (`cacheHit`, 0 ms, no diagnostics) so the hybrid
 * pass never recomputes it just to have a result object.
 */
export function reuseLocalOutput<K extends ToolId>(
  toolId: K,
  output: ToolOutput<K>,
  sourceName: string,
  options: ToolOptions<K>,
): EngineRunResult<K> {
  return {
    output,
    providerMode: 'local-static',
    diagnostics: [],
    elapsedMs: 0,
    cacheKey: `reused:${toolId}:${sourceName}`,
    context: {
      requestId: `reused-${toolId}`,
      toolId,
      sourceName,
      sourceHash: '',
      options,
      providerMode: 'local-static',
      diagnostics: [],
      elapsedMs: 0,
      cacheKey: `reused:${toolId}:${sourceName}`,
      engineVersion: '5b.2',
      cacheHit: true,
    },
  };
}

/**
 * Runs one hybrid pass and appends its evidence record (C-FIX-009). The core pass
 * is unchanged in ordering; the wrapper only exists so the record is written once,
 * after the outcome is final, instead of at every early return.
 */
export async function runHybridPass<K extends ToolId>(input: HybridPassInput<K>): Promise<HybridPassOutcome<K>> {
  const outcome = await runHybridPassCore(input);
  const log = input.evidenceLog ?? createEvidenceLog();
  const evidence = await log.append(evidenceDraftFor(input, outcome));
  return { ...outcome, evidence };
}

/** The record a run leaves behind: payload digest, actual numbers, findings. */
export function evidenceDraftFor<K extends ToolId>(
  input: HybridPassInput<K>,
  outcome: HybridPassOutcome<K>,
): Parameters<EvidenceLog['append']>[0] {
  const execution = {
    stage: outcome.stage,
    providerMode: outcome.provenance,
    engineMode: input.engineMode ?? 'hybrid',
    streamed: outcome.streamed === true,
    terminated: outcome.terminated,
    finishReason: outcome.telemetry.finishReason,
    usageSource: outcome.telemetry.usageSource,
    inputTokens: outcome.telemetry.inputTokens,
    outputTokens: outcome.telemetry.outputTokens,
    elapsedMs: outcome.telemetry.elapsedMs,
    ttftMs: outcome.telemetry.ttftMs,
    receivedChars: (outcome.aiText ?? '').length,
    responseBytes: outcome.responseBytes,
  };
  const counts = {
    redactions: outcome.redactionCount,
    proposals: outcome.proposals.length,
    rejected: outcome.rejected.length,
    retries: outcome.telemetry.retryCount,
  };
  const draft = {
    requestId: outcome.requestId,
    toolId: input.toolId,
    execution,
    snapshot: outcome.snapshot
      ? {
          payloadDigest: outcome.snapshot.payloadDigest,
          consentDigest: outcome.snapshot.consentDigest,
          configFingerprint: outcome.snapshot.configFingerprint,
          destinationHost: outcome.snapshot.destinationHost,
          model: outcome.snapshot.model,
          approvedAt: outcome.snapshot.approvedAt,
        }
      : null,
    counts,
    reason: outcome.reason,
    estimatedInputTokens: outcome.plan?.preview.estimatedInputTokens ?? null,
  };
  // The findings are computed by the log as well; comparing them here keeps the
  // draft honest when a caller inspects it before appending.
  void executionFindings(draft);
  return draft;
}

async function runHybridPassCore<K extends ToolId>(input: HybridPassInput<K>): Promise<HybridPassOutcome<K>> {
  const spec = toolHybridSpec(input.toolId);
  const clock = input.now ?? (() => Date.now());
  const startedAt = clock();
  const engineMode: EngineMode = input.engineMode ?? 'hybrid';
  /** Assigned once the local result exists, before anything can be sent. */
  let lifecycle: RequestLifecycle | null = null;
  /** The sealed payload (C-FIX-001); null until an approval produced one. */
  let snapshot: RequestSnapshot | null = null;
  const session = createHybridSession({
    signal: input.signal,
    now: input.now,
    onStatus: (status) => {
      // The lifecycle mirrors the session without ever throwing on a late event.
      lifecycle?.mirror(status.stage);
      input.onStatus?.(status);
    },
  });
  input.onSession?.(session);
  session.enter('preflight');

  const stale = () => Boolean(input.isCurrent && !input.isCurrent());
  /** Known once the preview exists; the telemetry reads it for host/model/redactions. */
  let plan: HybridRequestPlan | null = null;
  let gatewayFinishReason: string | null = null;
  /** Actual transport facts, recorded for the evidence (C-FIX-009). */
  let gatewayStreamed: boolean | null = null;
  let gatewayTerminated: boolean | null = null;
  let gatewayBytes: number | null = null;

  const finish = (
    fields: Partial<HybridPassOutcome<K>> & Pick<HybridPassOutcome<K>, 'local' | 'provenance'>,
  ): HybridPassOutcome<K> => {
    const provenance = fields.provenance;
    const elapsedMs = Math.max(0, clock() - startedAt);
    const status = session.status();
    const usage = fields.usage ?? session.usage();
    const aiText = fields.aiText ?? null;
    const proposals = fields.proposals ?? [];
    const rejected = fields.rejected ?? [];
    const reason = fields.reason ?? null;
    const telemetry = buildTelemetry({
      requestId: session.requestId,
      toolId: input.toolId,
      engineMode,
      providerMode: provenance,
      modelId: plan ? input.settings.model : null,
      destinationHost: plan?.preview.destination?.host ?? null,
      stage: session.stage(),
      elapsedMs,
      ttftMs: status.ttftMs,
      usage,
      estimatedInputTokens: plan?.preview.estimatedInputTokens ?? null,
      outputChars: (aiText ?? session.text()).length,
      finishReason: gatewayFinishReason,
      redactionCount: plan?.preview.redaction.total ?? 0,
      retryCount: 0,
      fallbackReason: reason,
      proposalCount: proposals.length,
      rejectedCount: rejected.length,
    });
    const outcome: HybridPassOutcome<K> = {
      stage: session.stage(),
      status,
      output: fields.local.output,
      plan,
      preview: null,
      proposals: [],
      rejected: [],
      conflicts: [],
      summary: '',
      failure: null,
      reason: null,
      usage: session.usage(),
      ttftMs: status.ttftMs,
      elapsedMs,
      requestId: session.requestId,
      finishReason: gatewayFinishReason,
      redactionCount: plan?.preview.redaction.total ?? 0,
      telemetry,
      aiText: null,
      applied: true,
      snapshot,
      payloadDigest: snapshot?.payloadDigest ?? null,
      lifecycleState: lifecycle?.state() ?? null,
      streamed: gatewayStreamed,
      terminated: gatewayTerminated,
      responseBytes: gatewayBytes,
      evidence: null,
      ...fields,
    };
    if (lifecycle) {
      lifecycle.mirror(session.stage(), reason ?? undefined);
      lifecycle.dispose(reason ?? undefined);
    }
    session.dispose();
    return outcome;
  };

  const cancel = (reason: string, local: EngineRunResult<K>, plan: HybridRequestPlan | null, extra: Partial<HybridPassOutcome<K>> = {}) => {
    if (!TERMINAL_STAGES.has(session.stage())) session.enter('cancelled', reason);
    return finish({ ...extra, local, plan, provenance: 'local-static', reason });
  };

  const fallback = (
    reason: string,
    failure: HybridFailure | null,
    local: EngineRunResult<K>,
    plan: HybridRequestPlan | null,
    extra: Partial<HybridPassOutcome<K>> = {},
  ) => {
    if (!TERMINAL_STAGES.has(session.stage())) session.enter('local-fallback', reason);
    return finish({ ...extra, local, plan, provenance: 'local-fallback', failure, reason });
  };

  // 1. The deterministic pass. A given result is reused; otherwise the shared
  //    runner computes it once (and caches it for an identical request).
  let local = input.localResult ?? (input.localOutput ? reuseLocalOutput(input.toolId, input.localOutput, input.sourceName, input.options) : undefined);
  if (!local) {
    const runner = input.runLocal ?? ((args: { toolId: K; sourceName: string; source: string; options: ToolOptions<K> }) =>
      runEngine(args.toolId, { sourceName: args.sourceName, source: args.source, options: args.options, mode: 'local-static' }));
    local = await runner({ toolId: input.toolId, sourceName: input.sourceName, source: input.source, options: input.options });
  }
  if (stale()) {
    session.markStale();
    const outcome = cancel('入力が変更されたため、この AI 実行は破棄しました。', local, null);
    return { ...outcome, applied: false };
  }

  // C-FIX-003: one active request per scope. The registry refuses a duplicate
  // instead of letting two passes race for the same tool pane.
  if (input.lifecycleRegistry) {
    const began = input.lifecycleRegistry.begin(input.lifecycleScope ?? input.toolId, {
      signal: input.signal,
      now: input.now,
    });
    if (!began.ok) {
      session.enter('cancelled', began.message);
      return finish({ local, provenance: 'local-static', reason: began.message });
    }
    lifecycle = began.lifecycle;
    lifecycle.mirror('preflight');
  }

  // Mode A: the local result is the artifact. The check runs before a prompt is
  // built, so no payload, destination or approval exists at all (WO-11).
  if (engineMode === 'local') {
    const reason = 'モードA（ローカル解析）が選択されています。外部への送信は行いません。';
    session.enter('completed', reason);
    return finish({ local, provenance: 'local-static', reason });
  }

  // 2–6. Prompt, redaction, budget and the preview the user will approve.
  try {
    plan =
      input.plan ??
      (await planHybridRequest({
        toolId: input.toolId,
        source: input.source,
        sourceName: input.sourceName,
        localAnalysis: spec.describeLocal(local.output),
        outputSchema: spec.outputSchema,
        targetLanguage: input.targetLanguage ?? spec.targetLanguage,
        settings: input.settings,
      }));
  } catch (cause) {
    const error = toHybridError(cause);
    return fallback(error.message, error.failure, local, null);
  }

  if (stale()) {
    session.markStale();
    const outcome = cancel('入力が変更されたため、この AI 実行は破棄しました。', local, plan);
    return { ...outcome, applied: false };
  }

  if (!plan.preview.allowed) {
    const reason = plan.preview.blockedReasons.join(' ') || '事前確認で送信できない項目があります。';
    return fallback(reason, null, local, plan);
  }

  // 7. Approval. The gate consumes exactly one approval for this payload hash.
  session.enter('awaiting-consent');
  let approved = false;
  try {
    approved = await input.approve(plan.preview);
  } catch (cause) {
    const error = toHybridError(cause);
    return fallback(error.message, error.failure, local, plan);
  }
  if (stale()) {
    session.markStale();
    const outcome = cancel('入力が変更されたため、この AI 実行は破棄しました。', local, plan);
    return { ...outcome, applied: false };
  }
  if (!approved) {
    return cancel('送信の承認がなかったため、ローカル結果のままにしました。', local, plan);
  }

  const gate = createPreflightGate();
  gate.approve(plan.preview);
  try {
    assertApprovedPayload(gate, plan.preview.fingerprint);
  } catch (cause) {
    const error = toHybridError(cause);
    return fallback(error.message, error.failure, local, plan);
  }

  // C-FIX-001: seal exactly what the user approved. The digest covers endpoint,
  // model, messages, approval time and the configuration fingerprint; the copy is
  // frozen, so a later mutation throws instead of changing the payload.
  const destination = plan.preview.destination;
  if (!destination) {
    return fallback('宛先が確認できないため送信できません。', 'invalid-settings', local, plan);
  }
  try {
    snapshot = await sealRequestSnapshot({
      requestId: session.requestId,
      toolId: input.toolId,
      endpoint: destination.endpoint,
      model: plan.preview.model,
      destinationHost: destination.host,
      messages: plan.preview.messages,
      previewFingerprint: plan.preview.fingerprint,
      approvedAt: new Date(clock()).toISOString(),
      sourceFileName: plan.preview.sourceFileName,
      redaction: {
        total: plan.preview.redaction.total,
        byKind: { ...plan.preview.redaction.byKind } as Record<string, number>,
        registryFingerprint: redactionRegistry.fingerprint(),
      },
    });
    await assertSnapshotIntegrity(snapshot, {
      endpoint: destination.endpoint,
      model: plan.preview.model,
      destinationHost: destination.host,
      previewFingerprint: plan.preview.fingerprint,
    });
  } catch (cause) {
    const error = toHybridError(cause);
    return fallback(error.message, error.failure, local, plan);
  }

  // 8. The gateway request, under the session (Stop, timeout, receive cap).
  const resolution = providerRegistry.resolve({
    baseUrl: input.settings.baseUrl,
    model: input.settings.model,
    providerId: input.providerId,
  });
  const provider =
    input.provider ??
    new OpenAiCompatibleProvider({
      // The profile decides streaming support, the endpoint path and the phase
      // timeouts (C-FIX-005/007); the user's numbers still bound the request.
      profile: resolution.profile,
      defaults: {
        timeoutMs: input.settings.requestTimeoutMs,
        maxOutputTokens: input.settings.maxOutputTokens,
        temperature: input.settings.temperature,
      },
    });
  const policy = policyForProfile(resolution.profile, {
    requestTimeoutMs: input.settings.requestTimeoutMs,
    maxOutputTokens: input.settings.maxOutputTokens,
    maxInputTokens: input.settings.maxInputTokens,
  });
  const request: HybridProviderRequest = {
    settings: toHybridSettings(input.settings, input.apiKey ?? null, true),
    // The frozen snapshot is what leaves the tab, not the preview's array.
    messages: snapshot.messages.map((message) => ({ role: message.role, content: message.content })),
    budget: {
      maxInputTokens: input.settings.maxInputTokens,
      maxOutputTokens: input.settings.maxOutputTokens,
      chunkOverlapTokens: 0,
      maxFewShotTokens: input.settings.fewShotTokenBudget,
    },
    signal: session.signal,
  };

  // A second, independent check immediately before the socket: recompute the
  // digest and the approval fingerprint from the payload we are holding.
  const preSend = await verifyRequestSnapshot(snapshot, {
    endpoint: destination.endpoint,
    model: plan.preview.model,
    destinationHost: destination.host,
    previewFingerprint: plan.preview.fingerprint,
  });
  if (!preSend.ok) {
    const problem: SnapshotProblem = preSend.problems[0];
    return fallback(problem.message, 'approval', local, plan);
  }

  let gateway: GatewayResult;
  try {
    gateway = await runGatewayRequest({
      provider,
      request,
      session,
      streaming:
        input.settings.streaming &&
        resolution.capabilities.streaming &&
        typeof provider.completeStream === 'function',
      maxResponseChars: input.maxResponseChars ?? policy.limits.maxResponseChars,
      onDelta: input.onDelta,
    });
  } catch (cause) {
    const error = toHybridError(cause);
    if (error.kind === 'aborted' || session.stopRequested()) {
      return cancel('リクエストを中止しました。ローカル結果を表示しています。', local, plan, {
        aiText: session.text() || null,
      });
    }
    if (stale()) {
      session.markStale();
      const outcome = cancel('入力が変更されたため、この AI 実行は破棄しました。', local, plan);
      return { ...outcome, applied: false };
    }
    return fallback(error.message, error.failure, local, plan, { aiText: session.text() || null });
  }
  gatewayFinishReason = gateway.finishReason;
  gatewayStreamed = gateway.streamed;
  gatewayTerminated = gateway.terminated;
  gatewayBytes = gateway.responseBytes;

  if (stale()) {
    session.markStale();
    // The answer describes an artifact that no longer exists on screen; record
    // the conflict so a caller that inspects the outcome sees why it was dropped.
    const outcome = cancel('入力が変更されたため、この AI 実行は破棄しました。', local, plan, {
      aiText: gateway.raw,
      conflicts: [
        {
          kind: 'local-changed',
          message: 'AI の応答中にローカル結果が更新されたため、この応答は現在の成果物に適用できません。',
          proposalIds: [],
        },
      ],
    });
    return { ...outcome, applied: false };
  }
  if (session.stopRequested()) {
    return cancel('リクエストを中止しました。ローカル結果を表示しています。', local, plan, { aiText: gateway.raw });
  }

  // 9–10. Validation against the tool schema and the local facts.
  session.enter('validating');
  let merged;
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(gateway.raw);
    } catch {
      throw new HybridError('schema', 'AI 応答が JSON として読み取れませんでした。');
    }
    const facts: EvidenceFacts = spec.facts(local.output, input.sourceName, input.source);
    merged = mergeProposals(parsed, facts, spec.proposalKinds);
  } catch (cause) {
    const error = toHybridError(cause);
    return fallback(`${error.message} AI の内容は採用せず、ローカル結果を表示しています。`, 'schema', local, plan, {
      aiText: gateway.raw,
    });
  }

  const rejected: RejectedProposal[] = [...merged.rejected];
  const accepted: AiProposal[] = [];
  for (const proposal of merged.proposals) {
    // WO-12: prose that could run or fetch when rendered is refused before it
    // ever reaches an artifact or the screen's proposal list.
    const findings = findActiveContent([proposal.title, proposal.detail, proposal.rationale ?? ''].join('\n'));
    if (findings.length) {
      rejected.push({
        id: proposal.id,
        title: proposal.title,
        reason: 'active-content',
        message: describeActiveContent(findings),
      });
      continue;
    }
    const message = spec.checkProposal?.(proposal, local.output) ?? null;
    if (message) {
      rejected.push({ id: proposal.id, title: proposal.title, reason: 'schema', message });
      continue;
    }
    accepted.push(proposal);
  }

  if (!accepted.length) {
    // The answer was well formed but nothing in it could be verified. That is a
    // fallback, not a hybrid result: no AI text is shown as a fact.
    const reason =
      rejected.length > 0
        ? 'AI の提案がすべて根拠または構文を満たさなかったため、ローカル結果を維持しました。'
        : merged.envelope.summary || 'AI からの追加提案はありませんでした。';
    session.enter('completed', reason);
    return finish({
      local,
      plan,
      provenance: 'local-static',
      preview: plan.preview,
      proposals: [],
      rejected,
      conflicts: merged.conflicts,
      summary: merged.envelope.summary,
      reason,
      usage: gateway.usage,
      aiText: gateway.raw,
    });
  }

  session.enter('completed');
  return finish({
    local,
    plan,
    provenance: 'hybrid-ai',
    preview: plan.preview,
    proposals: accepted,
    rejected,
    conflicts: merged.conflicts,
    summary: merged.envelope.summary,
    usage: gateway.usage,
    aiText: gateway.raw,
  });
}

/** The UI needs the same labels the orchestrator uses; re-exported for it. */
export type { HybridSession, HybridStage, HybridStatus };
