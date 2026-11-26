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
import { hybridConfig } from './config';
import { HybridError, classifyFetchFailure, errorForStatus, type HybridErrorKind } from './errors';
import type { ProviderProfile } from './providerProfiles';
import { ResourceGuard, resolveResourcePolicy, withPhaseDeadline, type ResourcePolicy } from './resourcePolicy';
import { createUtf8FrameDecoder } from './streamCodec';
import { createSseParser, readCompletionJson, type StreamUsage } from './streamParser';
import {
  createFetchTransport,
  resolveEndpoint,
  sendWithRedirectPolicy,
  validateModelId,
  type Transport,
  type TransportResponse,
} from './transport';

/**
 * The Phase 5C numbers, now read from the configuration SSoT (C-FIX-008) instead
 * of being duplicated here. They stay exported because callers and tests refer to
 * them by name.
 */
export const DEFAULT_TEMPERATURE = hybridConfig.read().provider.defaultTemperature;
export const DEFAULT_TIMEOUT_MS = hybridConfig.read().provider.defaultTotalTimeoutMs;
export const DEFAULT_MAX_OUTPUT_TOKENS = hybridConfig.read().provider.defaultMaxOutputTokens;

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
  /** Capability profile the client was built for (C-FIX-007). */
  profile?: ProviderProfile | null;
  /** Resolved timeout/response policy; derived from the profile when omitted. */
  policy?: ResourcePolicy;
  /** Endpoint path the profile declares; `/chat/completions` by default. */
  endpointPath?: string;
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
  fn: (signal: AbortSignal, abort: () => void) => Promise<T>,
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
    return await fn(controller.signal, onAbort);
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
  private readonly profile: ProviderProfile | null;
  private readonly endpointPath: string;
  /** Last call's usage, for the UI's in-tab telemetry. Never persisted. */
  lastUsage: StreamUsage | null = null;
  /** The policy the last call ran under, for evidence (C-FIX-005/009). */
  lastPolicy: ResourcePolicy | null = null;

  constructor(options: OpenAiCompatibleOptions = {}) {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.transport = options.transport ?? createFetchTransport(fetchImpl);
    // The configured default is "retry off"; a deployment may switch it on
    // through the configuration SSoT, and a caller may still override per client.
    const configuredRetry = hybridConfig.read().provider.retryEnabled ? { maxAttempts: 2 } : null;
    const policy = options.retry === undefined ? configuredRetry : options.retry;
    // A retry policy with a single attempt is the same as no retry.
    this.retry = policy && policy.maxAttempts > 1 ? policy : null;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.profile = options.profile ?? null;
    this.endpointPath = options.endpointPath ?? this.profile?.capabilities.endpoints.chatCompletions ?? '/chat/completions';
    const defaults = hybridConfig.read().provider;
    this.defaults = {
      temperature: options.defaults?.temperature ?? defaults.defaultTemperature,
      timeoutMs: options.defaults?.timeoutMs ?? defaults.defaultTotalTimeoutMs,
      maxOutputTokens: options.defaults?.maxOutputTokens ?? defaults.defaultMaxOutputTokens,
    };
  }

  /** The timeout/response policy for a request (C-FIX-005). */
  policyFor(resolved: ResolvedRequest): ResourcePolicy {
    return resolveResourcePolicy({
      profileId: this.profile?.id,
      requestTimeoutMs: resolved.timeoutMs,
      maxOutputTokens: resolved.maxOutputTokens,
      maxInputTokens: resolved.maxOutputTokens,
      timeouts: this.profile?.capabilities.timeout,
      maxResponseChars: this.profile?.capabilities.response.maxResponseChars ?? null,
      maxResponseBytes: this.profile?.capabilities.response.maxResponseBytes ?? null,
    });
  }

  /** Settings → endpoint, model, timeout; throws before anything is sent. */
  resolve(settings: HybridSettings): ResolvedRequest {
    const check = validateHybridSettings(settings);
    if (!check.ok) throw new HybridError(check.failure as HybridErrorKind, check.message);
    const endpoint = resolveEndpoint(settings.baseUrl, this.endpointPath);
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
    policy: ResourcePolicy,
    onResponse: (response: TransportResponse, abort: () => void) => Promise<HybridProviderResponse>,
  ): Promise<HybridProviderResponse> {
    const retry = this.retry;
    const maxAttempts = retry ? Math.max(1, retry.maxAttempts) : 1;
    let lastError: HybridError | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await runWithDeadline(signal, resolved.timeoutMs, async (deadlineSignal, abort) => {
          // C-FIX-005: the connection phase has its own ceiling, so a provider
          // that never answers is not reported as a slow model.
          const response = await withPhaseDeadline(
            sendWithRedirectPolicy(this.transport, {
              url: resolved.endpoint,
              method: 'POST',
              headers: this.headers(resolved.apiKey, stream),
              body: this.body(resolved, messages, stream),
              signal: deadlineSignal,
            }),
            policy.timeouts.connectMs,
            'connect',
            abort,
          );
          return onResponse(response, abort);
        });
      } catch (cause) {
        const error = cause instanceof HybridError ? cause : classifyFetchFailure(cause, resolved.timeoutMs);
        lastError = error;
        const retryable = error.retryable && error.kind !== 'aborted' && error.kind !== 'timeout';
        if (!retry || !retryable || attempt >= maxAttempts) throw error;
        const base = retry.baseDelayMs ?? 500;
        const max = retry.maxDelayMs ?? 5_000;
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
    const policy = this.policyFor(resolved);
    this.lastPolicy = policy;
    const result = await this.sendOnce(resolved, request.messages, false, request.signal, policy, async (response, abort) => {
      const text = await withPhaseDeadline(response.text(), policy.timeouts.ttfbMs, 'ttfb', abort);
      if (!response.ok) throw errorForResponse(response, text);
      // C-FIX-005: the answer is also bounded by bytes, not only by the engine's
      // character cap, so a multi-byte flood cannot pass the limit.
      const guard = new ResourceGuard(policy.limits.maxResponseBytes);
      const responseBytes = new TextEncoder().encode(text).byteLength;
      guard.add(responseBytes);
      const parsed = readCompletionJson(text);
      this.lastUsage = parsed.usage ?? null;
      return { text: parsed.text, usage: parsed.usage, finishReason: parsed.finishReason, responseBytes };
    });
    return result;
  }

  async completeStream(
    request: HybridProviderRequest,
    onDelta: (chunk: string) => void,
  ): Promise<HybridProviderResponse> {
    // C-FIX-007: a profile that declares "no streaming" is answered in one piece,
    // even if a caller asks for SSE. The engine also checks the capability first.
    if (this.profile && !this.profile.capabilitiesFor(request.settings.model).streaming) {
      return this.complete(request);
    }
    const resolved = this.resolve(request.settings);
    assertMessages(request.messages);
    const policy = this.policyFor(resolved);
    this.lastPolicy = policy;
    let emitted = false;

    return this.sendOnce(resolved, request.messages, true, request.signal, policy, async (response, abort) => {
      if (!response.ok) {
        const body = await response.text();
        throw errorForResponse(response, body);
      }
      // A provider that ignores `stream` returns a normal JSON body.
      if (!response.body) {
        const text = await withPhaseDeadline(response.text(), policy.timeouts.ttfbMs, 'ttfb', abort);
        const parsed = readCompletionJson(text);
        this.lastUsage = parsed.usage ?? null;
        if (parsed.text) {
          emitted = true;
          onDelta(parsed.text);
        }
        return { text: parsed.text, usage: parsed.usage, finishReason: parsed.finishReason };
      }

      const reader = response.body.getReader();
      // C-FIX-004: explicit UTF-8 framing; a split sequence is held, not mangled.
      const decoder = createUtf8FrameDecoder();
      const parser = createSseParser();
      const guard = new ResourceGuard(policy.limits.maxResponseBytes);
      let firstRead = true;
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
          // C-FIX-005: the first token and the gap between chunks have their own
          // deadlines, so a stalled stream is named instead of waiting for the
          // whole-request timer.
          const phase = firstRead ? policy.timeouts.ttfbMs : policy.timeouts.idleChunkMs;
          const { value, done } = await withPhaseDeadline(
            reader.read(),
            phase,
            firstRead ? 'ttfb' : 'idle',
            abort,
          );
          firstRead = false;
          if (done) break;
          // The byte ceiling is enforced before the text reaches the engine.
          guard.add(value.byteLength);
          consume(parser.push(decoder.push(value)));
        }
        if (!finished) {
          // Flush the decoder first: a trailing partial sequence must not be lost,
          // and the last event may not have been followed by a blank line.
          consume(parser.push(decoder.flush()));
          consume(parser.flush());
        }
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
      return {
        text: answer,
        usage,
        finishReason,
        streamTerminated: parser.terminated,
        responseBytes: guard.used(),
      };
    });
  }
}
