/**
 * WO-13 — token and request telemetry for the tab that ran the request.
 *
 * One record per AI run, built from the numbers the pass already holds. It is
 * shown in the result panel and returned with the outcome; it is never sent
 * anywhere, never written to storage, and it carries no message text — only
 * counts, ids and reasons. That is the whole point: the operator can see what a
 * run cost in tokens and time without a telemetry backend receiving anything.
 *
 * Actual versus estimated is stated, not blurred: a provider that reports usage
 * gives `usageSource: 'provider'`; a run that failed before any usage arrived is
 * reported as `'estimated'` (≈ 4 characters per token) and labelled as such.
 */

import type { EngineMode } from '../../lib/engineMode';

export type TelemetryProviderMode = 'local-static' | 'hybrid-ai' | 'local-fallback';

export type UsageSource = 'provider' | 'estimated' | 'none';

export interface TelemetryUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface HybridTelemetry {
  /** Stable id for this run in this tab (never a user or file identifier). */
  requestId: string;
  toolId: string;
  engineMode: EngineMode;
  /** The same vocabulary the provenance badge uses. */
  providerMode: TelemetryProviderMode;
  modelId: string | null;
  destinationHost: string | null;
  stage: string;
  elapsedMs: number;
  ttftMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Where the token numbers came from: the provider, a character estimate, or nowhere. */
  usageSource: UsageSource;
  finishReason: string | null;
  redactionCount: number;
  /** Attempts beyond the first; the app sends retry off by default. */
  retryCount: number;
  fallbackReason: string | null;
  proposalCount: number;
  rejectedCount: number;
  /** Price is unknown until a provider price table exists; `null` renders as N/A. */
  estimatedCostUsd: number | null;
}

export const NO_PRICE_LABEL = 'N/A（料金表未登録）';

/** ≈ 4 characters per token, the same estimate the budget uses. */
export function estimateTokensFromChars(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / 4);
}

/** `req-<time>-<counter>` with a random suffix; no user data in it. */
let requestSequence = 0;
export function newRequestId(now = Date.now(), random = Math.random): string {
  requestSequence += 1;
  const suffix = Math.floor(random() * 0xffffff)
    .toString(16)
    .padStart(6, '0');
  return `req-${now.toString(36)}-${requestSequence.toString(36)}-${suffix}`;
}

export interface TelemetryInput {
  requestId: string;
  toolId: string;
  engineMode: EngineMode;
  providerMode: TelemetryProviderMode;
  modelId?: string | null;
  destinationHost?: string | null;
  stage: string;
  elapsedMs: number;
  ttftMs?: number | null;
  usage?: TelemetryUsage | null;
  /** The preflight estimate; used when the provider reported no usage. */
  estimatedInputTokens?: number | null;
  /** Characters received, used to estimate output tokens. */
  outputChars?: number;
  finishReason?: string | null;
  redactionCount?: number;
  retryCount?: number;
  fallbackReason?: string | null;
  proposalCount?: number;
  rejectedCount?: number;
}

export function buildTelemetry(input: TelemetryInput): HybridTelemetry {
  const usage = input.usage ?? null;
  const estimatedOutput = estimateTokensFromChars(input.outputChars ?? 0);
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let usageSource: UsageSource = 'none';

  if (usage) {
    inputTokens = usage.inputTokens;
    outputTokens = usage.outputTokens;
    usageSource = 'provider';
  } else if (input.engineMode === 'hybrid' && input.providerMode !== 'local-static') {
    // A run that reached the gateway but came back without a usage block.
    inputTokens = input.estimatedInputTokens ?? null;
    outputTokens = estimatedOutput;
    usageSource = 'estimated';
  }

  return {
    requestId: input.requestId,
    toolId: input.toolId,
    engineMode: input.engineMode,
    providerMode: input.providerMode,
    modelId: input.modelId ?? null,
    destinationHost: input.destinationHost ?? null,
    stage: input.stage,
    elapsedMs: Math.max(0, Math.round(input.elapsedMs)),
    ttftMs: input.ttftMs === undefined || input.ttftMs === null ? null : Math.max(0, Math.round(input.ttftMs)),
    inputTokens,
    outputTokens,
    usageSource,
    finishReason: input.finishReason ?? null,
    redactionCount: Math.max(0, input.redactionCount ?? 0),
    retryCount: Math.max(0, input.retryCount ?? 0),
    fallbackReason: input.fallbackReason ?? null,
    proposalCount: Math.max(0, input.proposalCount ?? 0),
    rejectedCount: Math.max(0, input.rejectedCount ?? 0),
    estimatedCostUsd: null,
  };
}

export function formatTelemetryDuration(value: number | null): string {
  if (value === null) return '—';
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

export interface TelemetryRow {
  label: string;
  value: string;
  testId: string;
}

const USAGE_SOURCE_LABEL: Record<UsageSource, string> = {
  provider: '実測（プロバイダ報告）',
  estimated: '推定（文字数から換算）',
  none: '—',
};

const PROVIDER_MODE_LABEL: Record<TelemetryProviderMode, string> = {
  'local-static': 'local-static（ローカルのみ）',
  'hybrid-ai': 'hybrid-ai（AI 補完あり）',
  'local-fallback': 'local-fallback（AI 未使用）',
};

/** The rows the result panel renders, in a fixed order. */
export function telemetryRows(telemetry: HybridTelemetry): TelemetryRow[] {
  return [
    { label: 'Request ID', value: telemetry.requestId, testId: 'telemetry-request-id' },
    { label: 'Tool ID', value: telemetry.toolId, testId: 'telemetry-tool-id' },
    { label: 'Provider Mode', value: PROVIDER_MODE_LABEL[telemetry.providerMode], testId: 'telemetry-provider-mode' },
    { label: 'Model ID', value: telemetry.modelId ?? 'N/A', testId: 'telemetry-model-id' },
    { label: 'Elapsed', value: formatTelemetryDuration(telemetry.elapsedMs), testId: 'telemetry-elapsed' },
    { label: 'TTFT', value: formatTelemetryDuration(telemetry.ttftMs), testId: 'telemetry-ttft' },
    {
      label: 'Input tokens',
      value: telemetry.inputTokens === null ? '—' : `${telemetry.inputTokens.toLocaleString('ja-JP')}（${USAGE_SOURCE_LABEL[telemetry.usageSource]}）`,
      testId: 'telemetry-input-tokens',
    },
    {
      label: 'Output tokens',
      value: telemetry.outputTokens === null ? '—' : `${telemetry.outputTokens.toLocaleString('ja-JP')}（${USAGE_SOURCE_LABEL[telemetry.usageSource]}）`,
      testId: 'telemetry-output-tokens',
    },
    { label: 'Finish reason', value: telemetry.finishReason ?? '—', testId: 'telemetry-finish-reason' },
    { label: 'Redactions', value: String(telemetry.redactionCount), testId: 'telemetry-redactions' },
    { label: 'Retries', value: String(telemetry.retryCount), testId: 'telemetry-retries' },
    { label: 'Fallback', value: telemetry.fallbackReason ?? '—', testId: 'telemetry-fallback' },
    { label: 'Estimated cost', value: NO_PRICE_LABEL, testId: 'telemetry-cost' },
  ];
}
