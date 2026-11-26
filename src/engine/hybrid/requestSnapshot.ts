/**
 * C-FIX-001 — immutable request snapshot and consent integrity.
 *
 * Phase 5C approved a payload by hash and then sent `preview.messages`. Between
 * the approval and the socket, that array was still a mutable object the UI, a
 * React re-render or a late settings change could reach. The hash proved nothing
 * about the object that was actually serialised, only about the object at preview
 * time.
 *
 * The correction is a seal:
 *
 * 1. `sealRequestSnapshot` copies the approved messages, deep-freezes the copy and
 *    computes a digest over endpoint + model + messages + approval time + config.
 * 2. The provider receives that frozen copy — not the preview's array.
 * 3. Immediately before transmitting, `verifyRequestSnapshot` recomputes the
 *    digest from the object it holds, re-checks the destination and model, checks
 *    that no unredacted secret reappeared and that the approval fingerprint still
 *    matches the payload. Any difference refuses the send.
 *
 * The verification is independent of the gate that granted the approval: it does
 * not trust the gate's record, it recomputes from the payload.
 */

import { sha256Hex } from '../../lib/util';
import type { ChatMessage } from './contracts';
import { hybridConfig } from './config';
import { HybridError } from './errors';
import { fingerprintPayload } from './preflight';
import { containsLikelySecret } from './redaction';

export interface SnapshotRedaction {
  total: number;
  byKind: Record<string, number>;
  registryFingerprint?: string;
}

export interface SealInput {
  requestId: string;
  toolId: string;
  endpoint: string;
  model: string;
  destinationHost: string;
  /** The messages the user approved (after redaction). */
  messages: ChatMessage[];
  /** The approval hash of the preview these messages came from. */
  previewFingerprint: string;
  approvedAt: string;
  sourceFileName: string;
  redaction: SnapshotRedaction;
  /** Configuration the run used, so a later request can prove which policy applied. */
  configFingerprint?: string;
}

export interface RequestSnapshot {
  readonly kind: 'adop0001.hybrid.request-snapshot.v1';
  readonly requestId: string;
  readonly toolId: string;
  readonly endpoint: string;
  readonly model: string;
  readonly destinationHost: string;
  readonly approvedAt: string;
  readonly sourceFileName: string;
  readonly messages: ReadonlyArray<Readonly<ChatMessage>>;
  readonly previewFingerprint: string;
  readonly redaction: Readonly<SnapshotRedaction>;
  readonly configFingerprint: string;
  /** sha256 over the exact transmitted payload and its approval context. */
  readonly payloadDigest: string;
  /** sha256 over the payload digest and the consent record. */
  readonly consentDigest: string;
  readonly sealed: true;
}

export type SnapshotProblemCode =
  | 'not-sealed'
  | 'payload-mutated'
  | 'fingerprint-mismatch'
  | 'destination-changed'
  | 'model-changed'
  | 'unredacted-secret'
  | 'empty-payload'
  | 'invalid-role';

export interface SnapshotProblem {
  code: SnapshotProblemCode;
  message: string;
}

export interface SnapshotVerification {
  ok: boolean;
  problems: SnapshotProblem[];
}

export interface SnapshotExpectation {
  endpoint?: string;
  model?: string;
  destinationHost?: string;
  previewFingerprint?: string;
}

/** Deterministic JSON: object keys sorted, so the digest cannot depend on order. */
export function canonicalJson(value: unknown): string {
  const walk = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) sorted[key] = walk(record[key]);
      return sorted;
    }
    return item;
  };
  return JSON.stringify(walk(value));
}

function digestMaterial(input: SealInput): string {
  return canonicalJson([
    'adop0001.hybrid.payload.v2',
    input.endpoint,
    input.model,
    input.messages.map((message) => [message.role, message.content]),
    input.approvedAt,
    input.previewFingerprint,
    input.configFingerprint ?? hybridConfig.fingerprint(),
    input.redaction.total,
  ]);
}

function consentMaterial(payloadDigest: string, input: SealInput, configFingerprint: string): string {
  return canonicalJson([
    'adop0001.hybrid.consent.v1',
    payloadDigest,
    input.requestId,
    input.sourceFileName,
    input.approvedAt,
    input.previewFingerprint,
    configFingerprint,
    input.redaction.total,
  ]);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * Produces the sealed snapshot. The caller sends `snapshot.messages`; it is
 * frozen, so a later mutation throws instead of silently changing the payload.
 */
export async function sealRequestSnapshot(input: SealInput): Promise<RequestSnapshot> {
  const configFingerprint = input.configFingerprint ?? hybridConfig.fingerprint();
  const messages = deepFreeze(input.messages.map((message) => ({ role: message.role, content: message.content })));
  const withConfig: SealInput = { ...input, configFingerprint };
  const payloadDigest = await sha256Hex(digestMaterial(withConfig));
  const consentDigest = await sha256Hex(consentMaterial(payloadDigest, withConfig, configFingerprint));

  return deepFreeze({
    kind: 'adop0001.hybrid.request-snapshot.v1' as const,
    requestId: input.requestId,
    toolId: input.toolId,
    endpoint: input.endpoint,
    model: input.model,
    destinationHost: input.destinationHost,
    approvedAt: input.approvedAt,
    sourceFileName: input.sourceFileName,
    messages,
    previewFingerprint: input.previewFingerprint,
    redaction: deepFreeze({
      total: input.redaction.total,
      byKind: { ...input.redaction.byKind },
      registryFingerprint: input.redaction.registryFingerprint,
    }),
    configFingerprint,
    payloadDigest,
    consentDigest,
    sealed: true as const,
  });
}

/**
 * Recomputes everything from the object that is about to be transmitted. It does
 * not consult the approval gate: a tampered gate cannot make a tampered payload
 * verify.
 */
export async function verifyRequestSnapshot(
  snapshot: RequestSnapshot,
  expectation: SnapshotExpectation = {},
): Promise<SnapshotVerification> {
  const problems: SnapshotProblem[] = [];

  if (!snapshot || snapshot.sealed !== true || !Object.isFrozen(snapshot)) {
    problems.push({ code: 'not-sealed', message: 'リクエストのスナップショットが封印されていません。' });
  }
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  if (!messages.length) problems.push({ code: 'empty-payload', message: '送信内容が空です。' });
  if (!messages.every((message) => Object.isFrozen(message))) {
    problems.push({ code: 'not-sealed', message: 'メッセージが変更可能な状態です。' });
  }
  if (messages.some((message) => message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant')) {
    problems.push({ code: 'invalid-role', message: 'メッセージの役割が想定外です。' });
  }

  const recomputed = await sha256Hex(
    digestMaterial({
      requestId: snapshot.requestId,
      toolId: snapshot.toolId,
      endpoint: snapshot.endpoint,
      model: snapshot.model,
      destinationHost: snapshot.destinationHost,
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
      previewFingerprint: snapshot.previewFingerprint,
      approvedAt: snapshot.approvedAt,
      sourceFileName: snapshot.sourceFileName,
      redaction: snapshot.redaction,
      configFingerprint: snapshot.configFingerprint,
    }),
  );
  if (recomputed !== snapshot.payloadDigest) {
    problems.push({
      code: 'payload-mutated',
      message: '承認した送信内容と、いま送ろうとしている内容が一致しません。',
    });
  }

  const recomputedConsent = await sha256Hex(
    consentMaterial(snapshot.payloadDigest, {
      requestId: snapshot.requestId,
      toolId: snapshot.toolId,
      endpoint: snapshot.endpoint,
      model: snapshot.model,
      destinationHost: snapshot.destinationHost,
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
      previewFingerprint: snapshot.previewFingerprint,
      approvedAt: snapshot.approvedAt,
      sourceFileName: snapshot.sourceFileName,
      redaction: snapshot.redaction,
      configFingerprint: snapshot.configFingerprint,
    }, snapshot.configFingerprint),
  );
  if (recomputedConsent !== snapshot.consentDigest) {
    problems.push({ code: 'payload-mutated', message: '承認記録のダイジェストが一致しません。' });
  }

  // The approval hash was computed over the same messages by the preflight; a
  // payload that no longer hashes to it was changed after consent.
  const fingerprint = await fingerprintPayload(
    snapshot.endpoint,
    snapshot.model,
    messages.map((message) => ({ role: message.role, content: message.content })),
  );
  if (snapshot.previewFingerprint && fingerprint !== snapshot.previewFingerprint) {
    problems.push({
      code: 'fingerprint-mismatch',
      message: '承認したペイロードのハッシュと送信内容が一致しません。',
    });
  }
  if (expectation.previewFingerprint && expectation.previewFingerprint !== snapshot.previewFingerprint) {
    problems.push({ code: 'fingerprint-mismatch', message: '承認したペイロードと異なるリクエストです。' });
  }

  if (expectation.endpoint && expectation.endpoint !== snapshot.endpoint) {
    problems.push({ code: 'destination-changed', message: '宛先が承認時と変わっています。' });
  }
  if (expectation.destinationHost && expectation.destinationHost !== snapshot.destinationHost) {
    problems.push({ code: 'destination-changed', message: '宛先ホストが承認時と変わっています。' });
  }
  if (expectation.model && expectation.model !== snapshot.model) {
    problems.push({ code: 'model-changed', message: 'モデルが承認時と変わっています。' });
  }

  // A second, independent redaction pass must find nothing. This is the check
  // that catches a pattern disabled between preview and send.
  const stillSecret = messages.some((message) => containsLikelySecret(message.content));
  if (stillSecret) {
    problems.push({
      code: 'unredacted-secret',
      message: '送信内容に伏字されていない秘匿情報が残っています。送信を中止しました。',
    });
  }

  return { ok: problems.length === 0, problems };
}

/** The send-path check: throws with the first readable problem. */
export async function assertSnapshotIntegrity(
  snapshot: RequestSnapshot,
  expectation: SnapshotExpectation = {},
): Promise<void> {
  const verification = await verifyRequestSnapshot(snapshot, expectation);
  if (verification.ok) return;
  const first = verification.problems[0];
  throw new HybridError('approval', first?.message ?? '送信内容の整合性を確認できませんでした。');
}
