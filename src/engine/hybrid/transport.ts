/**
 * WO-03 — endpoint policy and transport.
 *
 * The endpoint policy is deliberately strict, because this is the one place a
 * user-supplied string decides where a source file is sent:
 *
 * - `https` only, with `http` allowed for `localhost` / `127.0.0.1` / `[::1]`
 * - no credentials in the URL (the API key has its own field, kept in memory)
 * - no query string and no `#fragment`
 * - no duplicated `/chat/completions` path
 * - no whitespace
 *
 * Redirects are handled by hand (`redirect: 'manual'`) so the `Authorization`
 * header is never replayed to another origin: a same-origin redirect is followed
 * a bounded number of times, a cross-origin one is refused.
 */

import { HybridError } from './errors';

export const CHAT_COMPLETIONS_PATH = '/chat/completions';

export const MAX_REDIRECTS = 3;

export type EndpointRejection =
  | 'empty'
  | 'invalid-url'
  | 'unsupported-scheme'
  | 'credentials'
  | 'query'
  | 'fragment'
  | 'duplicate-path'
  | 'whitespace';

export type EndpointPolicy =
  | { ok: true; endpoint: string; origin: string; host: string }
  | { ok: false; reason: EndpointRejection; message: string };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname.toLowerCase());
}

/**
 * Resolves the completions endpoint from a Base URL the user typed.
 * A Base URL is expected to be `https://host/v1`; the path is appended.
 */
export function resolveEndpoint(baseUrl: string, path = CHAT_COMPLETIONS_PATH): EndpointPolicy {
  const raw = (baseUrl ?? '').trim();
  if (!raw) return { ok: false, reason: 'empty', message: 'Base URL を入力してください。' };
  if (/\s/.test(baseUrl)) {
    return { ok: false, reason: 'whitespace', message: 'Base URL に空白を含めることはできません。' };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid-url', message: 'Base URL が正しくありません（例: https://api.example.com/v1）。' };
  }

  const https = url.protocol === 'https:';
  const localHttp = url.protocol === 'http:' && isLocalHost(url.hostname);
  if (!https && !localHttp) {
    return {
      ok: false,
      reason: 'unsupported-scheme',
      message: 'Base URL は https で指定してください（localhost のみ http を許可します）。',
    };
  }
  if (url.username || url.password) {
    return {
      ok: false,
      reason: 'credentials',
      message: 'Base URL に認証情報を含めないでください。API キーは専用の欄で指定します。',
    };
  }
  if (url.search) {
    return { ok: false, reason: 'query', message: 'Base URL にクエリ文字列（?…）を含めることはできません。' };
  }
  if (url.hash) {
    return { ok: false, reason: 'fragment', message: 'Base URL に #fragment を含めることはできません。' };
  }

  const normalizedPath = url.pathname.replace(/\/+$/, '');
  if (normalizedPath.endsWith(CHAT_COMPLETIONS_PATH)) {
    return {
      ok: false,
      reason: 'duplicate-path',
      message: `Base URL に ${CHAT_COMPLETIONS_PATH} を含めないでください（自動で付加されます）。`,
    };
  }

  const endpoint = `${url.origin}${normalizedPath}${path}`;
  const policy = resolveAbsolute(endpoint);
  if (!policy.ok) return policy;
  return { ok: true, endpoint, origin: url.origin, host: url.hostname };
}

/** Re-checks an absolute URL (used for an endpoint assembled from parts). */
function resolveAbsolute(endpoint: string): EndpointPolicy {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, reason: 'invalid-url', message: 'エンドポイント URL を組み立てられませんでした。' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'credentials', message: 'エンドポイントに認証情報を含めることはできません。' };
  }
  if (!url.protocol.startsWith('http')) {
    return { ok: false, reason: 'unsupported-scheme', message: 'エンドポイントは http(s) である必要があります。' };
  }
  return { ok: true, endpoint, origin: url.origin, host: url.hostname };
}

export type ModelIdCheck = { ok: true; model: string } | { ok: false; message: string };

/**
 * A model id is used inside the request body only, but it is still validated:
 * control characters and whitespace break providers in confusing ways, and an
 * empty value must not silently request the provider's default model.
 */
export function validateModelId(model: string): ModelIdCheck {
  const value = (model ?? '').trim();
  if (!value) return { ok: false, message: 'モデル ID を入力してください。' };
  if (value.length > 200) return { ok: false, message: 'モデル ID が長すぎます（200 文字まで）。' };
  if (/[\s\u0000-\u001f\u007f]/.test(value)) {
    return { ok: false, message: 'モデル ID に空白や制御文字を含めることはできません。' };
  }
  if (/[<>"'`\\]/.test(value)) {
    return { ok: false, message: 'モデル ID に使用できない文字が含まれています。' };
  }
  return { ok: true, model: value };
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

export interface HeaderReader {
  get(name: string): string | null;
}

export interface TransportRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

export interface TransportResponse {
  status: number;
  ok: boolean;
  headers: HeaderReader;
  text(): Promise<string>;
  /** Present for a streamed response; `null` when the runtime cannot stream. */
  body: ReadableStream<Uint8Array> | null;
}

export interface Transport {
  send(request: TransportRequest): Promise<TransportResponse>;
}

function headersFrom(headers: Headers): HeaderReader {
  return { get: (name) => headers.get(name) };
}

/**
 * `redirect: 'manual'` plus `credentials: 'omit'`: a redirect is inspected by
 * `sendWithRedirectPolicy`, never followed by the browser with our header, and
 * cookies are not sent to a third-party endpoint.
 */
export function createFetchTransport(fetchImpl: typeof fetch = globalThis.fetch): Transport {
  return {
    async send(request) {
      const response = await fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: request.signal,
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
      // A cross-origin redirect in manual mode surfaces as an opaque response.
      if (response.type === 'opaqueredirect') {
        throw new HybridError('cors', '別オリジンへのリダイレクトは Authorization ヘッダを渡せないため中断しました。', {
          status: response.status,
        });
      }
      return {
        status: response.status,
        ok: response.ok,
        headers: headersFrom(response.headers),
        text: () => response.text(),
        body: response.body ?? null,
      };
    },
  };
}

/**
 * Sends the request, following only same-origin redirects. The `Authorization`
 * header is part of the request that is re-sent, so any origin change must be
 * refused rather than silently forwarded.
 */
export async function sendWithRedirectPolicy(
  transport: Transport,
  request: TransportRequest,
  options: { maxRedirects?: number } = {},
): Promise<TransportResponse> {
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const origin = new URL(request.url).origin;
  let url = request.url;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await transport.send({ ...request, url });
    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get('location');
    if (!location) {
      throw new HybridError('http', 'リダイレクト先が指定されていません。', { status: response.status });
    }
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw new HybridError('http', 'リダイレクト先の URL が正しくありません。', { status: response.status });
    }
    if (next.origin !== origin) {
      throw new HybridError(
        'cors',
        '別オリジンへリダイレクトされたため、Authorization ヘッダを渡さずに中断しました。Base URL を確認してください。',
        { status: response.status },
      );
    }
    url = next.toString();
  }
  throw new HybridError('http', 'リダイレクトが多すぎます。Base URL を確認してください。');
}
