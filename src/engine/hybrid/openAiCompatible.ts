/**
 * WO-03 — OpenAI-compatible provider client.
 *
 * Speaks `POST {baseUrl}/chat/completions` over the transport, with:
 *
 * - `complete()` for a single answer and `completeStream()` for SSE deltas
 * - an `AbortSignal` from the caller and a whole-request timeout
 * - usage parsing (`prompt_tokens` / `completion_tokens`, or the
 *   `input_tokens` / `output_tokens` spelling)
 * - error classification (see `errors.ts`)
 * - endpoint policy from `transport.ts` (https, no credentials, no query, no
 *   fragment, no duplicated path, same-origin redirects only)
 * - retry **off** by default; when a caller enables it, only 429/5xx/network
 *   failures are retried, never after a cancel, and never after a stream has
 *   already emitted text
 *
 * The API key only ever travels in the `Authorization` header of the request it
 * was configured for. It is not logged, not put in a URL and not persisted.
 */

import type {
  ChatMessage,
  HybridProvider,
  HybridProviderRequest,
  HybridProviderResponse,
  HybridSettings,
} from './contracts';
import { validateHybridSettings } from './contracts';
import { HybridError, classifyFetchFailure, errorForStatus, type HybridErrorKind } from './errors';
import { createSseParser, readCompletionJson, type StreamUsage } from './streamParser';
import {
  createFetchTransport,
  resolveEndpoint,
  sendWithRedirectPolicy,
  validateModelId,
  type Transport,
  type TransportResponse,
} from './transport';

export const DEFAULT_TEMPERATURE = 0.2;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export interface RetryPolicy {
  /** Total attempts, including the first one. `1` means no retry. */
  maxAttempts: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface OpenAiCompatibleOptions {
  transport?: Transport;
  fetchImpl?: typeof fetch;
  /** Default `null`: retry is disabled unless a caller opts in. */
  retry?: RetryPolicy | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  defaults?: {
    temperature?: number;
    timeoutMs?: number;
    maxOutputTokens?: number;
  };
}

export interface ResolvedRequest {
  endpoint: string;
  model: string;
  apiKey: string;
  temperature: number;
  timeoutMs: number;
  maxOutputTokens: number;
}

function clampTemperature(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(2, Math.max(0, value));
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function assertMessages(messages: ChatMessage[]): void {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new HybridError('invalid-settings', '送信するメッセージがありません。');
  }
  for (const message of messages) {
    if (!message || typeof message.content !== 'string' || typeof message.role !== 'string') {
      throw new HybridError('invalid-settings', 'メッセージの形式が正しくありません。');
    }
  }
}

/** Combines the caller's signal with a deadline and normalizes whatever comes out. */
async function runWithDeadline<T>(
  signal: AbortSignal | undefined,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (signal?.aborted) throw new HybridError('aborted', 'リクエストはキャンセルされました。');
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fn(controller.signal);
  } catch (cause) {
    if (cause instanceof HybridError) throw cause;
    if (timedOut) {
      throw new HybridError('timeout', `応答がタイムアウトしました（${Math.round(timeoutMs / 1000)} 秒）。`);
    }
    if (signal?.aborted) throw new HybridError('aborted', 'リクエストはキャンセルされました。');
    throw classifyFetchFailure(cause, timeoutMs);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function errorForResponse(response: TransportResponse, body: string): HybridError {
  const kind: HybridErrorKind = response.status === 0 ? 'cors' : 'http';
  if (kind === 'cors') {
    return new HybridError('cors', 'ブラウザが応答を読み取れませんでした（CORS）。プロバイダの CORS 設定を確認してください。');
  }
  return errorForStatus(response.status, response.headers, body);
}

export class OpenAiCompatibleProvider implements HybridProvider {
  readonly id = 'openai-compatible';
  private readonly transport: Transport;
  private readonly retry: RetryPolicy | null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly defaults: Required<NonNullable<OpenAiCompatibleOptions['defaults']>>;
  /** Last call's usage, for the UI's in-tab telemetry. Never persisted. */
  lastUsage: StreamUsage | null = null;

  constructor(options: OpenAiCompatibleOptions = {}) {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.transport = options.transport ?? createFetchTransport(fetchImpl);
    const policy = options.retry ?? null;
    // A retry policy with a single attempt is the same as no retry.
    this.retry = policy && policy.maxAttempts > 1 ? policy : null;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.defaults = {
      temperature: options.defaults?.temperature ?? DEFAULT_TEMPERATURE,
      timeoutMs: options.defaults?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputTokens: options.defaults?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    };
  }

  /** Settings → endpoint, model, timeout; throws before anything is sent. */
  resolve(settings: HybridSettings): ResolvedRequest {
    const check = validateHybridSettings(settings);
    if (!check.ok) throw new HybridError(check.failure as HybridErrorKind, check.message);
    const endpoint = resolveEndpoint(settings.baseUrl);
    if (!endpoint.ok) throw new HybridError('invalid-settings', endpoint.message);
    const model = validateModelId(settings.model);
    if (!model.ok) throw new HybridError('invalid-settings', model.message);
    const apiKey = (settings.apiKey ?? '').trim();
    if (!apiKey) throw new HybridError('no-key', 'API キーが設定されていません。');
    return {
      endpoint: endpoint.endpoint,
      model: model.model,
      apiKey,
      temperature: clampTemperature(settings.temperature, this.defaults.temperature),
      timeoutMs: positive(settings.requestTimeoutMs, this.defaults.timeoutMs),
      maxOutputTokens: positive(settings.maxOutputTokens, this.defaults.maxOutputTokens),
    };
  }

  private headers(apiKey: string, stream: boolean): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: stream ? 'text/event-stream' : 'application/json',
      authorization: `Bearer ${apiKey}`,
    };
  }

  private body(resolved: ResolvedRequest, messages: ChatMessage[], stream: boolean): string {
    return JSON.stringify({
      model: resolved.model,
      messages,
      temperature: resolved.temperature,
      max_tokens: resolved.maxOutputTokens,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    });
  }

  /**
   * Sends the request, retrying only when the caller enabled it and only before
   * any answer text was produced.
   */
  private async sendOnce(
    resolved: ResolvedRequest,
    messages: ChatMessage[],
    stream: boolean,
    signal: AbortSignal | undefined,
    onResponse: (response: TransportResponse) => Promise<HybridProviderResponse>,
  ): Promise<HybridProviderResponse> {
    const policy = this.retry;
    const maxAttempts = policy ? Math.max(1, policy.maxAttempts) : 1;
    let lastError: HybridError | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await runWithDeadline(signal, resolved.timeoutMs, async (deadlineSignal) => {
          const response = await sendWithRedirectPolicy(this.transport, {
            url: resolved.endpoint,
            method: 'POST',
            headers: this.headers(resolved.apiKey, stream),
            body: this.body(resolved, messages, stream),
            signal: deadlineSignal,
          });
          return onResponse(response);
        });
      } catch (cause) {
        const error = cause instanceof HybridError ? cause : classifyFetchFailure(cause, resolved.timeoutMs);
        lastError = error;
        const retryable = error.retryable && error.kind !== 'aborted' && error.kind !== 'timeout';
        if (!policy || !retryable || attempt >= maxAttempts) throw error;
        const base = policy.baseDelayMs ?? 500;
        const max = policy.maxDelayMs ?? 5_000;
        const backoff = Math.min(max, base * 2 ** (attempt - 1));
        const wait = error.retryAfterMs ?? backoff;
        if (signal?.aborted) throw new HybridError('aborted', 'リクエストはキャンセルされました。');
        await this.sleep(wait);
      }
    }
    throw lastError ?? new HybridError('provider', '不明なエラーが発生しました。');
  }

  async complete(request: HybridProviderRequest): Promise<HybridProviderResponse> {
    const resolved = this.resolve(request.settings);
    assertMessages(request.messages);
    const result = await this.sendOnce(resolved, request.messages, false, request.signal, async (response) => {
      const text = await response.text();
      if (!response.ok) throw errorForResponse(response, text);
      const parsed = readCompletionJson(text);
      this.lastUsage = parsed.usage ?? null;
      return { text: parsed.text, usage: parsed.usage, finishReason: parsed.finishReason };
    });
    return result;
  }

  async completeStream(
    request: HybridProviderRequest,
    onDelta: (chunk: string) => void,
  ): Promise<HybridProviderResponse> {
    const resolved = this.resolve(request.settings);
    assertMessages(request.messages);
    let emitted = false;

    return this.sendOnce(resolved, request.messages, true, request.signal, async (response) => {
      if (!response.ok) {
        const body = await response.text();
        throw errorForResponse(response, body);
      }
      // A provider that ignores `stream` returns a normal JSON body.
      if (!response.body) {
        const text = await response.text();
        const parsed = readCompletionJson(text);
        this.lastUsage = parsed.usage ?? null;
        if (parsed.text) {
          emitted = true;
          onDelta(parsed.text);
        }
        return { text: parsed.text, usage: parsed.usage, finishReason: parsed.finishReason };
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSseParser();
      let answer = '';
      let usage: StreamUsage | undefined;
      let finishReason: string | null = null;
      let finished = false;

      const consume = (events: ReturnType<typeof parser.push>) => {
        for (const event of events) {
          if (event.type === 'delta') {
            emitted = true;
            answer += event.text;
            onDelta(event.text);
          } else if (event.type === 'done') {
            finished = true;
            finishReason = event.finishReason;
            if (event.usage) usage = event.usage;
          } else {
            throw event.error;
          }
        }
      };

      try {
        while (!finished) {
          const { value, done } = await reader.read();
          if (done) break;
          consume(parser.push(decoder.decode(value, { stream: true })));
        }
        if (!finished) consume(parser.flush());
      } catch (cause) {
        // A cancel keeps escaping as a cancel even mid-stream.
        if (request.signal?.aborted) throw new HybridError('aborted', 'リクエストはキャンセルされました。');
        throw cause instanceof HybridError ? cause : classifyFetchFailure(cause, resolved.timeoutMs);
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* already released */
        }
      }

      if (!answer && !emitted) {
        throw new HybridError('empty-choices', 'ストリームから本文を受け取れませんでした。');
      }
      this.lastUsage = usage ?? null;
      return { text: answer, usage, finishReason };
    });
  }
}
