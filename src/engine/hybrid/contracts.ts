/**
 * Hybrid provider contracts (Option B preparation, Phase 5B).
 *
 * These are *contracts and local mocks only*. No module here opens a network
 * request; Phase 5C supplies a real provider behind `HybridProvider`. Keeping
 * the shape fixed now means the UI, consent gate, budget and validation can be
 * reviewed before any code is allowed to transmit a source file.
 */

import type { ContextBudget, PromptStrategy } from '../../adapters/types';

export interface HybridSettings {
  /** OpenAI-compatible base URL, e.g. `https://example.invalid/v1`. */
  baseUrl: string;
  model: string;
  /** Read from the user at call time; never persisted with the project. */
  apiKey: string | null;
  /** Explicit opt-in. False means every run stays local. */
  consent: boolean;
  promptStrategy?: PromptStrategy;
  /** Sampling temperature (Phase 5C connection setting, default 0.2). */
  temperature?: number;
  /** Whole-request deadline in milliseconds (default 120 000). */
  requestTimeoutMs?: number;
  /** Upper bound for the answer the provider may return. */
  maxOutputTokens?: number;
}

export type HybridFailure =
  | 'no-consent'
  | 'no-key'
  | 'invalid-settings'
  | 'aborted'
  | 'timeout'
  | 'offline'
  | 'schema'
  | 'approval'
  | 'integrity'
  | 'provider';

export type SettingsCheck = { ok: true } | { ok: false; failure: HybridFailure; message: string };

export function validateHybridSettings(settings: HybridSettings): SettingsCheck {
  let url: URL;
  try {
    url = new URL(settings.baseUrl);
  } catch {
    return { ok: false, failure: 'invalid-settings', message: 'Base URL が正しくありません。' };
  }
  const localhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(localhost && url.protocol === 'http:')) {
    return { ok: false, failure: 'invalid-settings', message: 'Base URL は https で指定してください（localhost を除く）。' };
  }
  if (url.username || url.password) {
    return {
      ok: false,
      failure: 'invalid-settings',
      message: 'Base URL に認証情報を含めないでください。API キーは専用の欄で指定します。',
    };
  }
  if (url.hash) {
    return { ok: false, failure: 'invalid-settings', message: 'Base URL に #fragment を含めることはできません。' };
  }
  if (/\s/.test(settings.baseUrl.trim())) {
    return { ok: false, failure: 'invalid-settings', message: 'Base URL に空白を含めることはできません。' };
  }
  if (!settings.model.trim()) {
    return { ok: false, failure: 'invalid-settings', message: 'モデル名を指定してください。' };
  }
  if (!settings.consent) {
    return { ok: false, failure: 'no-consent', message: '送信に同意するまで外部モデルは使いません。' };
  }
  if (!settings.apiKey?.trim()) {
    return { ok: false, failure: 'no-key', message: 'API キーが設定されていません。' };
  }
  return { ok: true };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface HybridProviderRequest {
  settings: HybridSettings;
  messages: ChatMessage[];
  budget: ContextBudget;
  signal?: AbortSignal;
}

export interface HybridProviderResponse {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
  /** Provider stop reason; `length` means the answer was cut off by `max_tokens`. */
  finishReason?: string | null;
  /**
   * Streaming only: true when the stream ended with `[DONE]` or a
   * `finish_reason`, false when it simply closed. `undefined` for a
   * non-streaming response (WO-08 abnormal-EOF detection).
   */
  streamTerminated?: boolean;
  /** Bytes the transport accepted for this answer (C-FIX-005 evidence). */
  responseBytes?: number;
}

export interface HybridProvider {
  readonly id: string;
  /** Receives the already redacted, already budgeted prompt; never the raw file. */
  complete(request: HybridProviderRequest): Promise<HybridProviderResponse>;
  /** Optional streaming transport; a provider without it is still valid. */
  completeStream?(
    request: HybridProviderRequest,
    onDelta: (chunk: string) => void,
  ): Promise<HybridProviderResponse>;
}

export class HybridResponseError extends Error {
  readonly failure: HybridFailure;
  constructor(failure: HybridFailure, message: string) {
    super(message);
    this.name = 'HybridResponseError';
    this.failure = failure;
  }
}

/**
 * The only way a remote answer becomes an artifact: it must parse and pass the
 * caller's structural guard, or the local result is used instead.
 */
export function validateStructuredOutput<T>(text: string, guard: (value: unknown) => value is T): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HybridResponseError('schema', 'The provider response was not valid JSON.');
  }
  if (!guard(value)) throw new HybridResponseError('schema', 'The provider response did not match the expected shape.');
  return value;
}

export interface LocalFallback<T> {
  output: T;
  failure: HybridFailure;
  message: string;
}

function isAbortLike(cause: unknown): boolean {
  return (
    (cause instanceof Error && cause.name === 'AbortError') ||
    (typeof DOMException !== 'undefined' && cause instanceof DOMException && cause.name === 'AbortError')
  );
}

/** A cancel is a cancel whether the signal aborted or the provider said so. */
function isAbortFailure(cause: unknown): boolean {
  return isAbortLike(cause) || (cause instanceof HybridResponseError && cause.failure === 'aborted');
}

/**
 * Fall back to the local result for provider/schema failures. A user cancel is
 * different: no local computation is started and the abort is surfaced with
 * its own failure code (FIX-014).
 *
 * The signal is checked before the remote call, after it resolves (a provider
 * that ignores the signal can still resolve late) and after the fallback runs,
 * so a cancelled request never reports a value — remote or local (FIX-017).
 *
 * A provider that reports `HybridResponseError('aborted')` ends the request
 * without running the local fallback, and a cancellation raised by the local
 * fallback itself is reported the same way instead of escaping raw
 * (PATCH-003).
 */
export async function withLocalFallback<T>(
  local: () => Promise<T>,
  remote: () => Promise<T>,
  options: { signal?: AbortSignal } = {},
): Promise<{ value: T; fallback: LocalFallback<T>['failure'] | null }> {
  if (options.signal?.aborted) {
    throw new HybridResponseError('aborted', 'The hybrid request was cancelled by the user.');
  }
  let remoteValue: T;
  try {
    remoteValue = await remote();
  } catch (cause) {
    if (options.signal?.aborted || isAbortFailure(cause)) {
      throw new HybridResponseError('aborted', 'The hybrid request was cancelled by the user.');
    }
    const failure = cause instanceof HybridResponseError ? cause.failure : 'provider';
    let value: T;
    try {
      value = await local();
    } catch (localCause) {
      if (options.signal?.aborted || isAbortFailure(localCause)) {
        throw new HybridResponseError('aborted', 'The hybrid request was cancelled by the user.');
      }
      throw localCause;
    }
    if (options.signal?.aborted) {
      throw new HybridResponseError('aborted', 'The hybrid request was cancelled by the user.');
    }
    return { value, fallback: failure };
  }
  if (options.signal?.aborted) {
    throw new HybridResponseError('aborted', 'The hybrid request was cancelled by the user.');
  }
  return { value: remoteValue, fallback: null };
}
