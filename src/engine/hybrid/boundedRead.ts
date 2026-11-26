/**
 * INT-005 — bounded response reading.
 *
 * Phase 5C.1 measured the answer only after `response.text()` had buffered it:
 * the limit was checked on a string that already existed, so a provider could
 * hand the tab a gigabyte and the tab would politely notice afterwards. HTTP
 * error bodies took the same path.
 *
 * This module reads a response body the way a stream is read:
 *
 * - every chunk is counted against the byte ceiling *before* it is decoded, and
 *   the reader is cancelled the moment the ceiling is crossed;
 * - the first byte and every later chunk have their own deadline, so a stalled
 *   body is named (timeout) instead of waiting for the whole-request timer;
 * - an abort from the user is reported as an abort, never as a timeout;
 * - the reader is always released, and cancelled when the read stops early.
 *
 * A runtime that cannot stream (`response.body === null`) still works: the text
 * is read once and counted, which is the fallback for non-browser transports
 * only. The browser path never buffers before counting.
 */
import { HybridError } from './errors';
import { ResourceGuard, withPhaseDeadline, type ResourcePolicy } from './resourcePolicy';
import type { TransportResponse } from './transport';

export interface BoundedReadOptions {
  policy: ResourcePolicy;
  /** Aborts the underlying request when a phase deadline fires. */
  abort?: () => void;
  /** The user's signal, so a cancel is not reported as a timeout. */
  signal?: AbortSignal;
  /** Optional character ceiling in addition to the byte ceiling. */
  maxChars?: number;
}

export interface BoundedReadResult {
  text: string;
  bytes: number;
  /** True when the read stopped because a limit was reached. */
  cancelled: boolean;
}

const decoder = () => new TextDecoder('utf-8', { fatal: false, ignoreBOM: false });

/**
 * Reads the whole body under the policy. Throws `response-too-long` when a
 * ceiling is crossed, `timeout` when a phase deadline fires, and `aborted` when
 * the caller's signal fired first.
 */
export async function readBoundedText(
  response: TransportResponse,
  options: BoundedReadOptions,
): Promise<BoundedReadResult> {
  const guard = new ResourceGuard(options.policy.limits.maxResponseBytes);
  const body = response.body;

  if (!body) {
    // Non-streaming runtime (a test transport, or a browser that did not expose
    // the body). The text is counted immediately and refused if it is too large;
    // the browser path below never reaches this branch.
    const text = await response.text();
    const bytes = new TextEncoder().encode(text).byteLength;
    guard.add(bytes);
    if (options.maxChars !== undefined && text.length > options.maxChars) {
      throw new HybridError('response-too-long', `応答が受信上限（${options.maxChars.toLocaleString('ja-JP')} 文字）を超えたため受信を中止しました。`);
    }
    return { text, bytes: guard.used(), cancelled: false };
  }

  const reader = body.getReader();
  const textDecoder = decoder();
  let text = '';
  let firstRead = true;
  let cancelled = false;

  const cleanup = async (cancel: boolean) => {
    if (cancel) {
      cancelled = true;
      try {
        await reader.cancel();
      } catch {
        /* the source may already be closed */
      }
    }
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  };

  try {
    for (;;) {
      const phase = firstRead ? options.policy.timeouts.ttfbMs : options.policy.timeouts.idleChunkMs;
      const { value, done } = await withPhaseDeadline(reader.read(), phase, firstRead ? 'ttfb' : 'idle', () => {
        options.abort?.();
      });
      firstRead = false;
      if (done) break;
      if (!value) continue;
      // Count before decoding: the ceiling is enforced while the body is still
      // arriving, not after it is a string in memory.
      guard.add(value.byteLength);
      text += textDecoder.decode(value, { stream: true });
      if (options.maxChars !== undefined && text.length > options.maxChars) {
        throw new HybridError(
          'response-too-long',
          `応答が受信上限（${options.maxChars.toLocaleString('ja-JP')} 文字）を超えたため受信を中止しました。`,
        );
      }
      if (options.signal?.aborted) throw new HybridError('aborted', 'リクエストはキャンセルされました。');
    }
    text += textDecoder.decode();
    return { text, bytes: guard.used(), cancelled };
  } catch (cause) {
    await cleanup(true);
    if (options.signal?.aborted) throw new HybridError('aborted', 'リクエストはキャンセルされました。');
    if (cause instanceof HybridError) throw cause;
    throw cause;
  } finally {
    await cleanup(false);
  }
}

/** Release a reader without reading it (a stream that will not be consumed). */
export async function cancelBody(response: TransportResponse): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {
    /* already closed */
  }
}
