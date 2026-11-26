/**
 * WO-06 — preflight preview and the per-request approval gate.
 *
 * Nothing is sent without a preview the user approved. The preview states where the
 * request goes (origin and host, not just the model), what it carries (source file
 * name, local analysis, instruction, few-shot examples, schema), how many secrets
 * were replaced, the estimated input tokens, the output cap, the exact messages that
 * will be transmitted, and the cost (N/A until the provider publishes a price).
 *
 * The gate is deliberately narrow:
 *
 * - one approval covers exactly one payload, identified by a hash of
 *   endpoint + model + messages
 * - an approval is consumed by the send it authorised, so it cannot be replayed
 * - changing the input, a setting or the redaction invalidates it (the hash moves)
 * - a payload whose redaction is not stable is blocked outright
 */

import { sha256Hex } from '../../lib/util';
import type { ToolId } from '../../adapters/types';
import type { ChatMessage } from './contracts';
import type { BudgetPlan } from './budget';
import { inspectDataBoundary, type BoundaryViolation } from './dataBoundary';
import { HybridError } from './errors';
import type { BuiltPrompt } from './promptBuilder';
import {
  compileCustomPatterns,
  redactMessages,
  redactText,
  type RedactionCounts,
  type RedactionOptions,
} from './redaction';
import { validateConnectionSettings, type ConnectionSettings } from './settings';
import { resolveEndpoint } from './transport';

export interface PreflightInput {
  settings: ConnectionSettings;
  built: BuiltPrompt;
  budget: BudgetPlan;
  redaction?: RedactionOptions;
  /** Needed for the tool-scope boundary rule (C-FIX-006). */
  toolId?: ToolId;
}

export interface PreflightScope {
  includesSource: boolean;
  sourceFileName: string;
  sourceChars: number;
  sourceTokens: number;
  /** True when part of the source is excluded by the budget. */
  sourceTruncated: boolean;
  includedRanges: string[];
  excludedRanges: string[];
  includesLocalAnalysis: boolean;
  includesOperatorInstruction: boolean;
  includesOutputSchema: boolean;
  fewShot: { count: number; titles: string[]; tokens: number };
  strategy: 'zero-shot' | 'few-shot';
  streaming: boolean;
}

export interface PreflightPreview {
  allowed: boolean;
  blockedReasons: string[];
  destination: { origin: string; host: string; endpoint: string } | null;
  model: string;
  sourceFileName: string;
  scope: PreflightScope;
  redaction: RedactionCounts;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  /** The exact messages that would be transmitted, after redaction. */
  messages: ChatMessage[];
  /** Price is unknown until the provider states one. */
  estimatedCostUsd: number | null;
  budget: BudgetPlan;
  warnings: string[];
  /** Data-boundary violations found on the payload (C-FIX-006). */
  boundary: BoundaryViolation[];
  /** One approval key per payload. */
  fingerprint: string;
}

function fingerprintMaterial(endpoint: string, model: string, messages: ChatMessage[]): string {
  return JSON.stringify(['adop0001.hybrid.payload.v1', endpoint, model, messages]);
}

export async function fingerprintPayload(
  endpoint: string,
  model: string,
  messages: ChatMessage[],
): Promise<string> {
  return sha256Hex(fingerprintMaterial(endpoint, model, messages));
}

/**
 * Builds the preview. Redaction happens here, on the messages that will actually be
 * sent, so the preview cannot describe a different payload from the one transmitted.
 */
export async function buildPreflight(input: PreflightInput): Promise<PreflightPreview> {
  const blockedReasons: string[] = [];
  const warnings: string[] = [];

  const validation = validateConnectionSettings(input.settings);
  if (!validation.ok) blockedReasons.push(...validation.messages);

  const endpoint = resolveEndpoint(input.settings.baseUrl);
  if (!endpoint.ok) blockedReasons.push(endpoint.message);

  const compiled = compileCustomPatterns(input.redaction?.customPatterns ?? []);
  if (!compiled.ok) {
    blockedReasons.push(...compiled.errors.map((error) => error.message));
  }

  const redacted = redactMessages(input.built.messages, { compiled: compiled.rules });

  // Redaction is only trusted when a second pass changes nothing. If it does, a
  // secret would still be visible in the payload, so the request is blocked.
  const unstable = redacted.messages.some((message) => redactText(message.content, { compiled: compiled.rules }).text !== message.content);
  if (unstable) blockedReasons.push('伏字を適用しても秘匿情報が残っています。送信を中止しました。');

  if (!input.budget.fits) {
    blockedReasons.push(
      input.budget.reason === 'source-exceeds-budget'
        ? 'ソースがコンテキスト予算に収まりません。ファイルを分割するか上限を上げてください。'
        : input.budget.reason === 'overhead-exceeds-budget'
          ? '指示と Few-shot だけで入力上限を超えています。'
          : '対象ソースが空です。',
    );
  }

  if (input.built.injection.detected) {
    warnings.push(
      `ソース内に指示のような記述があります（${input.built.injection.warnings.join('、')}）。データとして扱いますが、内容を確認してください。`,
    );
  }
  if (redacted.counts.total > 0) {
    warnings.push(`${redacted.counts.total} 件の秘匿情報を伏字にしました。`);
  }
  for (const note of input.budget.notes) warnings.push(note);

  const scope: PreflightScope = {
    includesSource: input.built.sections.source.content.length > 0,
    sourceFileName: input.built.sections.source.name,
    sourceChars: input.built.sections.source.content.length,
    sourceTokens: input.budget.sourceTokens,
    sourceTruncated: input.budget.selection.truncated,
    includedRanges: input.budget.selection.included.map((unit) => `${unit.startLine}-${unit.endLine}`),
    excludedRanges: input.budget.selection.excluded.map((unit) => `${unit.startLine}-${unit.endLine}`),
    includesLocalAnalysis: Boolean(input.built.sections.localAnalysis),
    includesOperatorInstruction: Boolean(input.built.sections.operatorInstruction),
    includesOutputSchema: Boolean(input.built.sections.schema),
    fewShot: {
      count: input.built.selectedExamples.length,
      titles: input.built.selectedExamples.map((example) => example.title),
      tokens: input.built.tokens.fewShot,
    },
    strategy: input.built.strategy,
    streaming: input.settings.streaming,
  };

  // C-FIX-006: the payload the user approved is the one that leaves — binary
  // media, excluded source ranges and out-of-scope tool bundles are refused here.
  const boundary = inspectDataBoundary({
    toolId: input.toolId,
    messages: redacted.messages,
    selection: input.budget.selection,
  });
  for (const violation of boundary) blockedReasons.push(violation.message);

  const fingerprint = endpoint.ok
    ? await fingerprintPayload(endpoint.endpoint, input.settings.model, redacted.messages)
    : '';

  return {
    allowed: blockedReasons.length === 0,
    blockedReasons,
    destination: endpoint.ok
      ? { origin: endpoint.origin, host: endpoint.host, endpoint: endpoint.endpoint }
      : null,
    model: input.settings.model,
    sourceFileName: input.built.sections.source.name,
    scope,
    redaction: redacted.counts,
    estimatedInputTokens: input.budget.overheadTokens + input.budget.selection.tokens,
    maxOutputTokens: input.settings.maxOutputTokens,
    messages: redacted.messages,
    estimatedCostUsd: null,
    budget: input.budget,
    warnings,
    boundary,
    fingerprint,
  };
}

/* ------------------------------------------------------------------ */
/* Approval gate                                                       */
/* ------------------------------------------------------------------ */

export interface ApprovalRecord {
  fingerprint: string;
  approvedAt: string;
  host: string;
  model: string;
  sourceFileName: string;
  redactions: number;
  estimatedInputTokens: number;
}

export type ApprovalFailure = 'not-approved' | 'payload-changed' | 'already-used';

export type ApprovalClaim =
  | { ok: true; approval: ApprovalRecord }
  | { ok: false; reason: ApprovalFailure; message: string };

export interface PreflightGate {
  /** Records the user's explicit approval of exactly this preview. */
  approve(preview: PreflightPreview, at?: Date): ApprovalRecord;
  current(): ApprovalRecord | null;
  /** Drops the approval (input, settings or consent changed). */
  invalidate(): void;
  /** Verifies and consumes the single approval for this payload hash. */
  claim(fingerprint: string): ApprovalClaim;
}

const APPROVAL_MESSAGES: Record<ApprovalFailure, string> = {
  'not-approved': 'この内容への送信の同意がありません。プレビューを確認して承認してください。',
  'payload-changed': '承認した内容と送信内容が一致しません。もう一度プレビューを確認してください。',
  'already-used': 'この承認はすでに使われました。送信ごとに承認が必要です。',
};

export function createPreflightGate(): PreflightGate {
  let current: ApprovalRecord | null = null;
  let used = false;

  return {
    approve(preview, at = new Date()) {
      if (!preview.fingerprint) throw new HybridError('approval', '宛先が不正なため承認できません。');
      current = {
        fingerprint: preview.fingerprint,
        approvedAt: at.toISOString(),
        host: preview.destination?.host ?? '',
        model: preview.model,
        sourceFileName: preview.sourceFileName,
        redactions: preview.redaction.total,
        estimatedInputTokens: preview.estimatedInputTokens,
      };
      used = false;
      return current;
    },
    current: () => current,
    invalidate() {
      current = null;
      used = false;
    },
    claim(fingerprint) {
      if (!current) return { ok: false, reason: 'not-approved', message: APPROVAL_MESSAGES['not-approved'] };
      if (used) return { ok: false, reason: 'already-used', message: APPROVAL_MESSAGES['already-used'] };
      if (current.fingerprint !== fingerprint) {
        return { ok: false, reason: 'payload-changed', message: APPROVAL_MESSAGES['payload-changed'] };
      }
      used = true;
      return { ok: true, approval: current };
    },
  };
}

/**
 * The check a send path runs with the payload it is about to transmit. It throws
 * rather than returning, so a caller cannot forget to handle the refusal.
 */
export function assertApprovedPayload(gate: PreflightGate, fingerprint: string): ApprovalRecord {
  const claim = gate.claim(fingerprint);
  if (!claim.ok) throw new HybridError('approval', claim.message);
  return claim.approval;
}
