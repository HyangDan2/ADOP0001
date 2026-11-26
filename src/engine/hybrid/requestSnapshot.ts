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
import { canonicalJson } from './canonical';
import { bodyDigestMaterial, sameBodySpec, type ChatBodySpec } from './requestBody';
import { hybridConfig } from './config';
import { HybridError } from './errors';
import { fingerprintPayload } from './preflight';
import { containsLikelySecret } from './redaction';

export interface SnapshotRedaction {
  total: number;
  byKind: Record<string, number>;
  registryFingerprint?: string;
}

export interface SnapshotCredential {
  /** A hash of the key that authorised the request — never the key itself. */
  fingerprint: string;
  /** The tab's key revision at seal time (INT-001). */
  revision: number;
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
  /** The exact HTTP parameters the approval covered (INT-001). */
  body?: ChatBodySpec | null;
  /** The credential that was in memory at approval time (hash only). */
  credential?: SnapshotCredential | null;
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
  /** The exact HTTP parameters that were approved (INT-001). */
  readonly body: Readonly<ChatBodySpec> | null;
  /** The credential revision that authorised this payload (INT-001). */
  readonly credential: Readonly<SnapshotCredential> | null;
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
  | 'body-changed'
  | 'credential-changed'
  | 'already-consumed'
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
  /** The parameters the caller is about to put on the wire. */
  body?: ChatBodySpec | null;
  /** The key that is in the tab now (hash + revision). */
  credential?: SnapshotCredential | null;
}

/** Deterministic JSON: object keys sorted, so the digest cannot depend on order. */
export { canonicalJson };

function digestMaterial(input: SealInput): string {
  return canonicalJson([
    'adop0001.hybrid.payload.v3',
    input.endpoint,
    input.model,
    input.messages.map((message) => [message.role, message.content]),
    input.body ? bodyDigestMaterial(input.body) : null,
    input.credential?.fingerprint ?? null,
    input.credential?.revision ?? null,
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
  const body = input.body ? deepFreeze({ ...input.body }) : null;
  const credential = input.credential ? deepFreeze({ ...input.credential }) : null;
  const withConfig: SealInput = { ...input, configFingerprint, body, credential };
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
    body,
    credential,
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
      body: snapshot.body ?? null,
      credential: snapshot.credential ?? null,
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
      body: snapshot.body ?? null,
      credential: snapshot.credential ?? null,
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

  // INT-001: the HTTP parameters are part of the approval. A temperature, output
  // limit, streaming flag or profile change after consent refuses the send.
  if (expectation.body !== undefined && !sameBodySpec(snapshot.body ?? null, expectation.body)) {
    problems.push({
      code: 'body-changed',
      message: '承認した送信パラメータ（Temperature・出力上限・ストリーミング）と、送信しようとしている内容が一致しません。',
    });
  }
  // INT-001: a key that was replaced after approval (or cleared) is a different
  // credential; the approval was for the old one.
  if (expectation.credential !== undefined) {
    const current = expectation.credential;
    const sealed = snapshot.credential;
    const same =
      (current === null && sealed === null) ||
      (current !== null && sealed !== null && current.fingerprint === sealed.fingerprint && current.revision === sealed.revision);
    if (!same) {
      problems.push({
        code: 'credential-changed',
        message: '承認後に API キーが変更（または消去）されたため、この承認は無効です。',
      });
    }
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

/* ------------------------------------------------------------------ */
/* One approved request, one send (INT-001)                            */
/* ------------------------------------------------------------------ */

/**
 * A seal is a licence for exactly one transmission. The first caller to consume
 * it wins; every later attempt is refused, so a double click, a retried send or a
 * reused preview cannot put the same approved payload on the wire twice.
 */
const consumedSnapshots = new WeakSet<object>();

export function consumeRequestSnapshot(snapshot: RequestSnapshot): boolean {
  if (!snapshot || consumedSnapshots.has(snapshot)) return false;
  consumedSnapshots.add(snapshot);
  return true;
}

/** True when this exact snapshot was already sent once. */
export function snapshotConsumed(snapshot: RequestSnapshot): boolean {
  return consumedSnapshots.has(snapshot);
}
