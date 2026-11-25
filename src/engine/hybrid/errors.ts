/**
 * WO-03 — one error vocabulary for the hybrid pass.
 *
 * Every way an OpenAI-compatible call can fail is classified here, once, so the
 * provider, the preflight gate and the UI agree on what happened. The rich
 * `HybridErrorKind` is mapped onto the smaller `HybridFailure` union that the
 * Phase 5B contracts (and `withLocalFallback`) already understand, so existing
 * fallback behaviour is unchanged.
 *
 * Classification rules:
 * - HTTP 400            → `bad-request`      (settings or payload)
 * - HTTP 401            → `auth`             (key refused)
 * - HTTP 403            → `forbidden`        (key valid, not allowed)
 * - HTTP 404            → `not-found`        (wrong base URL or model)
 * - HTTP 429            → `rate-limited`     (retryable)
 * - HTTP 500/502/503/504→ `server`           (retryable)
 * - any other non-2xx   → `http`
 * - fetch rejection     → `network` / `cors`
 * - no answer in time   → `timeout`
 * - user cancel         → `aborted`
 * - body not JSON       → `invalid-json`
 * - no usable choice    → `empty-choices` / `unsupported-format`
 */

import type { HybridFailure } from './contracts';
import { HybridResponseError } from './contracts';

export type HybridErrorKind =
  | 'invalid-settings'
  | 'no-consent'
  | 'no-key'
  | 'bad-request'
  | 'auth'
  | 'forbidden'
  | 'not-found'
  | 'rate-limited'
  | 'server'
  | 'http'
  | 'network'
  | 'cors'
  | 'timeout'
  | 'aborted'
  | 'invalid-json'
  | 'empty-choices'
  | 'unsupported-format'
  | 'schema'
  | 'provider';

export interface HybridErrorInit {
  status?: number;
  /** Overrides the default classification for the kind. */
  retryable?: boolean;
  /** Milliseconds the provider asked us to wait (Retry-After / reset hint). */
  retryAfterMs?: number;
  /** Short provider text kept for diagnostics; never the API key. */
  detail?: string;
}

/** Kinds that are worth another attempt when retry is explicitly enabled. */
const RETRYABLE: ReadonlySet<HybridErrorKind> = new Set<HybridErrorKind>(['rate-limited', 'server', 'network']);

/** Maps the rich kind onto the Phase 5B `HybridFailure` union. */
export function failureFor(kind: HybridErrorKind): HybridFailure {
  switch (kind) {
    case 'invalid-settings':
      return 'invalid-settings';
    case 'no-consent':
      return 'no-consent';
    case 'no-key':
      return 'no-key';
    case 'aborted':
      return 'aborted';
    case 'timeout':
      return 'timeout';
    case 'network':
      return 'offline';
    case 'schema':
      return 'schema';
    default:
      return 'provider';
  }
}

export class HybridError extends HybridResponseError {
  readonly kind: HybridErrorKind;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly detail?: string;

  constructor(kind: HybridErrorKind, message: string, init: HybridErrorInit = {}) {
    super(failureFor(kind), message);
    this.name = 'HybridError';
    this.kind = kind;
    this.status = init.status;
    this.retryable = init.retryable ?? RETRYABLE.has(kind);
    this.retryAfterMs = init.retryAfterMs;
    this.detail = init.detail;
  }
}

export function classifyStatus(status: number): HybridErrorKind {
  if (status === 400) return 'bad-request';
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 429) return 'rate-limited';
  if (status === 500 || status === 502 || status === 503 || status === 504) return 'server';
  return 'http';
}

/** Japanese message for the connection panel; says what to change, not just the code. */
export function describeStatus(status: number): string {
  switch (classifyStatus(status)) {
    case 'bad-request':
      return 'リクエストが拒否されました（400）。Base URL・モデル ID・パラメータを確認してください。';
    case 'auth':
      return 'API キーが拒否されました（401）。キーを確認してください。';
    case 'forbidden':
      return 'この API キーにはこのモデルを使う権限がありません（403）。';
    case 'not-found':
      return 'エンドポイントまたはモデルが見つかりません（404）。Base URL とモデル ID を確認してください。';
    case 'rate-limited':
      return 'レート制限に達しました（429）。しばらく待ってから再試行してください。';
    case 'server':
      return `プロバイダ側でエラーが発生しました（${status}）。時間をおいて再試行してください。`;
    default:
      return `プロバイダが ${status} を返しました。`;
  }
}

/** A Retry-After header in seconds, or an HTTP-date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - now, 60_000));
  return undefined;
}

export function errorForStatus(status: number, headers?: { get(name: string): string | null }, bodyText?: string): HybridError {
  const kind = classifyStatus(status);
  const retryAfterMs = headers ? parseRetryAfter(headers.get('retry-after')) : undefined;
  return new HybridError(kind, describeStatus(status), {
    status,
    retryAfterMs,
    // The body can echo the request; keep only a short, trimmed excerpt.
    detail: bodyText ? bodyText.slice(0, 400) : undefined,
  });
}

export function isAbortCause(cause: unknown): boolean {
  return (
    (cause instanceof Error && cause.name === 'AbortError') ||
    (typeof DOMException !== 'undefined' && cause instanceof DOMException && cause.name === 'AbortError')
  );
}

/**
 * A `fetch` rejection is a TypeError with no status. In a browser it can mean
 * offline, DNS failure, a TLS problem, or a CORS refusal — the page cannot tell
 * them apart. Both possibilities are reported so the user is not sent to the
 * wrong fix.
 */
export function classifyFetchFailure(cause: unknown, timeoutMs?: number): HybridError {
  if (cause instanceof HybridError) return cause;
  if (isAbortCause(cause)) return new HybridError('aborted', 'リクエストはキャンセルされました。');
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/timed?\s?out/i.test(message)) {
    return new HybridError('timeout', `応答がタイムアウトしました${timeoutMs ? `（${Math.round(timeoutMs / 1000)} 秒）` : ''}。`);
  }
  if (/cors|cross-origin|opaque/i.test(message)) {
    return new HybridError('cors', 'ブラウザが応答を読み取れませんでした（CORS）。プロバイダの CORS 設定を確認してください。', {
      detail: message,
    });
  }
  return new HybridError(
    'network',
    'ネットワークに接続できませんでした。オフラインか、プロバイダがブラウザからの接続（CORS）を許可していない可能性があります。',
    { detail: message },
  );
}

/** Normalizes anything thrown by the provider into a `HybridError`. */
export function toHybridError(cause: unknown): HybridError {
  if (cause instanceof HybridError) return cause;
  if (cause instanceof HybridResponseError) {
    const kind: HybridErrorKind =
      cause.failure === 'aborted'
        ? 'aborted'
        : cause.failure === 'timeout'
          ? 'timeout'
          : cause.failure === 'schema'
            ? 'schema'
            : 'provider';
    return new HybridError(kind, cause.message);
  }
  if (isAbortCause(cause)) return new HybridError('aborted', 'リクエストはキャンセルされました。');
  return new HybridError('provider', cause instanceof Error ? cause.message : '不明なエラーが発生しました。');
}
