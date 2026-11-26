/**
 * WO-03 / INT-001 / INT-004 / INT-005 / INT-006 — OpenAI-compatible provider client.
 *
 * Speaks `POST {baseUrl}/chat/completions` over the transport, with:
 *
 * - `complete()` for a single answer and `completeStream()` for SSE deltas
 * - an `AbortSignal` from the caller and a whole-request timeout
 * - usage parsing (`prompt_tokens` / `completion_tokens`, or the
 *   `input_tokens` / `output_tokens` spelling)
 * - error classification (see `errors.ts`)
 * - endpoint policy from `transport.ts` (https, no credentials, no query, no
 *   fragment, no duplicated path, no redirect that would leave the approved
 *   endpoint)
 * - retry **off** by default; when a caller enables it, only 429/5xx/network
 *   failures are retried, never after a cancel, and never after a stream has
 *   already emitted text
 *
 * Phase 5C.1 corrections that this file now enforces:
 *
 * - INT-001: when the orchestrator supplies the sealed `body`, that spec is the
 *   body. Settings are not consulted again, the resolved endpoint must be the
 *   approved one, and a redirect is refused rather than followed.
 * - INT-004: a `finish_reason` is an event, not the end of the stream. The reader
 *   keeps going for the usage frame and `[DONE]`, and the profile's terminal
 *   policy decides whether EOF after a finish reason is a complete answer.
 * - INT-005: non-streaming and error bodies are read under a byte ceiling while
 *   they arrive, and the reader is cancelled at the limit.
 * - INT-006: the body is built from the capability profile (parameter spelling,
 *   temperature support, usage option, structured output), never from a model
 *   name branch.
 *
 * The API key only ever travels in the `Authorization` header of the request it
 * was configured for. It is not logged, not put in a URL and not persisted, and
 * any text the provider echoes back is scrubbed of it before it reaches the UI.
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
import { HybridError, classifyFetchFailure, errorForStatus, scrubProviderText, type HybridErrorKind } from './errors';
import type { ProviderCapabilities, ProviderProfile } from './providerProfiles';
import { ResourceGuard, resolveResourcePolicy, withPhaseDeadline, type ResourcePolicy } from './resourcePolicy';
import { createUtf8FrameDecoder } from './streamCodec';
import { createSseParser, readCompletionJson, type StreamUsage } from './streamParser';
import { chatBodySpecFor, serializeChatBody, type ChatBodySpec, type TerminalPolicy } from './requestBody';
import { readBoundedText } from './boundedRead';
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

/** Removes the exact session key from any text the provider echoed back. */
export function scrubSessionSecret(text: string, secret: string | null | undefined): string {
  const scrubbed = scrubProviderText(text);
  const value = secret?.trim();
  if (!value || value.length < 6) return scrubbed;
  return scrubbed.split(value).join('[redacted-key]');
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

function errorForResponse(response: TransportResponse, body: string, secret?: string | null): HybridError {
  const kind: HybridErrorKind = response.status === 0 ? 'cors' : 'http';
  if (kind === 'cors') {
    return new HybridError('cors', 'ブラウザが応答を読み取れませんでした（CORS）。プロバイダの CORS 設定を確認してください。');
  }
  return errorForStatus(response.status, response.headers, scrubSessionSecret(body, secret));
}

/** INT-004: a non-streaming finish reason is handled, not ignored. */
export function assertCompletionFinishReason(finishReason: string | null | undefined): void {
  if (!finishReason) return;
  if (finishReason === 'length') {
    throw new HybridError(
      'incomplete-stream',
      '出力上限に達して応答が途中で切れました。出力上限を上げてから再試行してください。',
    );
  }
  if (finishReason === 'content_filter' || finishReason === 'refusal') {
    throw new HybridError(
      'provider',
      'プロバイダがこの内容の生成を拒否しました（content_filter / refusal）。ローカル結果を表示しています。',
    );
  }
}

/** The bytes an SSE stream may hold pending before it is refused (INT-005). */
function pendingLimitFor(policy: ResourcePolicy): number {
  return Math.max(1024, Math.min(policy.limits.maxResponseBytes, hybridConfig.read().stream.maxEventDataChars));
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

  /** INT-006: the capabilities this client actually applies. */
  capabilitiesFor(model: string): ProviderCapabilities | null {
    // No profile means this client applies the neutral Phase 5C behaviour; the
    // orchestrator then keeps the registry's capability profile, which is what an
    // injected test client or a bare connection-test client needs.
    if (this.profile) return this.profile.capabilitiesFor(model);
    return null;
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

  /**
   * INT-001/006: the sealed spec is the body. Without one (a connection test, or a
   * caller that predates the snapshot) a neutral body is built from settings, which
   * is exactly the Phase 5C body.
   */
  private bodyFor(
    request: HybridProviderRequest,
    resolved: ResolvedRequest,
    stream: boolean,
  ): { text: string; sealed: ChatBodySpec | null } {
    const sealed = request.body ?? null;
    if (sealed) {
      if (sealed.model !== resolved.model) {
        throw new HybridError('approval', '承認したモデルと送信しようとしているモデルが一致しません。');
      }
      if (sealed.stream !== stream) {
        throw new HybridError('approval', '承認したストリーミング設定と送信方法が一致しません。');
      }
      return { text: serializeChatBody(sealed, request.messages), sealed };
    }
    // INT-006: the capability profile decides the parameter spelling and which
    // parameters exist, even for a request that was not sealed (a connection test
    // or an injected client).
    const capabilities = this.profile
      ? this.profile.capabilitiesFor(resolved.model)
      : {
          streaming: true,
          maxOutputTokens: Number.POSITIVE_INFINITY,
          body: {
            outputTokenParameter: 'max_tokens' as const,
            temperature: true,
            streamingUsage: true,
            structuredOutput: true,
            terminalPolicy: 'finish-or-done' as const,
          },
        };
    const spec = chatBodySpecFor({
      model: resolved.model,
      temperature: resolved.temperature,
      maxOutputTokens: resolved.maxOutputTokens,
      streaming: stream,
      capabilities: capabilities as never,
      providerId: this.profile?.id ?? 'unspecified',
      structuredOutput: request.settings.structuredOutput === true,
    });
    return { text: serializeChatBody(spec, request.messages), sealed: null };
  }

  /**
   * Sends the request, retrying only when the caller enabled it and only before
   * any answer text was produced.
   */
  private async sendOnce(
    resolved: ResolvedRequest,
    request: HybridProviderRequest,
    stream: boolean,
    signal: AbortSignal | undefined,
    policy: ResourcePolicy,
    onResponse: (response: TransportResponse, abort: () => void) => Promise<HybridProviderResponse>,
  ): Promise<HybridProviderResponse> {
    const retry = this.retry;
    const maxAttempts = retry ? Math.max(1, retry.maxAttempts) : 1;
    const body = this.bodyFor(request, resolved, stream);
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
              body: body.text,
              signal: deadlineSignal,
            }, { refuseRedirects: Boolean(request.expectedEndpoint) }),
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
    if (request.expectedEndpoint && request.expectedEndpoint !== resolved.endpoint) {
      throw new HybridError('approval', '承認した宛先と解決したエンドポイントが一致しません。');
    }
    const policy = this.policyFor(resolved);
    this.lastPolicy = policy;
    return this.sendOnce(resolved, request, false, request.signal, policy, async (response, abort) => {
      // INT-005: the body is read under the byte ceiling while it arrives.
      const read = await readBoundedText(response, {
        policy,
        abort,
        signal: request.signal,
        maxChars: policy.limits.maxResponseChars,
      });
      if (!response.ok) throw errorForResponse(response, read.text, resolved.apiKey);
      const parsed = readCompletionJson(scrubSessionSecret(read.text, resolved.apiKey));
      assertCompletionFinishReason(parsed.finishReason);
      this.lastUsage = parsed.usage ?? null;
      return {
        text: scrubSessionSecret(parsed.text, resolved.apiKey),
        usage: parsed.usage,
        finishReason: parsed.finishReason,
        responseBytes: read.bytes,
      };
    });
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
    if (request.expectedEndpoint && request.expectedEndpoint !== resolved.endpoint) {
      throw new HybridError('approval', '承認した宛先と解決したエンドポイントが一致しません。');
    }
    const policy = this.policyFor(resolved);
    this.lastPolicy = policy;
    const terminalPolicy: TerminalPolicy =
      request.body?.terminalPolicy ?? this.profile?.capabilitiesFor(request.settings.model).body.terminalPolicy ?? 'finish-or-done';

    return this.sendOnce(resolved, request, true, request.signal, policy, async (response, abort) => {
      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      if (!response.ok) {
        const read = await readBoundedText(response, {
          policy,
          abort,
          signal: request.signal,
          maxChars: policy.limits.maxResponseChars,
        });
        throw errorForResponse(response, read.text, resolved.apiKey);
      }

      // INT-004: the Content-Type decides the protocol, not the presence of a body
      // object. A provider that ignores `stream` answers with JSON; one that
      // streams says so.
      const isJson = contentType.includes('application/json');
      const isSse = contentType.includes('text/event-stream');
      if (isJson || (!isSse && !response.body)) {
        const read = await readBoundedText(response, {
          policy,
          abort,
          signal: request.signal,
          maxChars: policy.limits.maxResponseChars,
        });
        const parsed = readCompletionJson(scrubSessionSecret(read.text, resolved.apiKey));
        assertCompletionFinishReason(parsed.finishReason);
        this.lastUsage = parsed.usage ?? null;
        const text = scrubSessionSecret(parsed.text, resolved.apiKey);
        if (text) onDelta(text);
        return {
          text,
          usage: parsed.usage,
          finishReason: parsed.finishReason,
          streamTerminated: true,
          responseBytes: read.bytes,
        };
      }

      if (!response.body) {
        throw new HybridError('unsupported-format', 'ストリームを読み取れない応答形式です。');
      }

      const reader = response.body.getReader();
      // C-FIX-004: explicit UTF-8 framing; a split sequence is held, not mangled.
      const decoder = createUtf8FrameDecoder();
      const parser = createSseParser();
      const guard = new ResourceGuard(policy.limits.maxResponseBytes);
      const pendingLimit = pendingLimitFor(policy);
      let firstRead = true;
      let answer = '';
      let usage: StreamUsage | undefined;
      let pendingChars = 0;
      let completed = false;

      const consume = async (events: ReturnType<typeof parser.push>) => {
        for (const event of events) {
          if (event.type === 'delta') {
            answer += event.text;
            onDelta(scrubSessionSecret(event.text, resolved.apiKey));
          } else if (event.type === 'finish') {
            // INT-004: record it and keep reading — usage and [DONE] follow.
            if (event.finishReason === 'length' || event.finishReason === 'content_filter' || event.finishReason === 'refusal') {
              assertCompletionFinishReason(event.finishReason);
            }
          } else if (event.type === 'usage') {
            usage = event.usage;
          } else if (event.type === 'done') {
            completed = true;
            if (event.usage) usage = event.usage;
          } else {
            throw event.error;
          }
        }
        await Promise.resolve();
      };

      try {
        while (!completed) {
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
          if (!value) continue;
          // The byte ceiling is enforced before the text reaches the engine.
          guard.add(value.byteLength);
          const decoded = decoder.push(value);
          pendingChars += decoded.length;
          if (pendingChars > pendingLimit) {
            throw new HybridError('response-too-long', 'ストリームの未処理データが上限を超えたため受信を中止しました。');
          }
          const events = parser.push(decoded);
          pendingChars = 0;
          await consume(events);
        }
        if (!completed) {
          // Flush the decoder first: a trailing partial sequence must not be lost,
          // and the last event may not have been followed by a blank line.
          await consume(parser.push(decoder.flush()));
          await consume(parser.flush());
        }
      } catch (cause) {
        // A cancel keeps escaping as a cancel even mid-stream.
        if (request.signal?.aborted) throw new HybridError('aborted', 'リクエストはキャンセルされました。');
        throw cause instanceof HybridError ? cause : classifyFetchFailure(cause, resolved.timeoutMs);
      } finally {
        try {
          if (!completed) await reader.cancel();
        } catch {
          /* already closed */
        }
        try {
          reader.releaseLock();
        } catch {
          /* already released */
        }
      }

      if (!answer) {
        throw new HybridError('empty-choices', 'ストリームから本文を受け取れませんでした。');
      }
      this.lastUsage = usage ?? parser.usage ?? null;
      const finishReason = parser.finishReason;
      const sawDone = parser.terminated || completed;
      // INT-004: termination is decided by the profile's terminal policy, not by
      // the first finish reason. EOF without the required marker is abnormal.
      const terminated =
        terminalPolicy === 'done'
          ? sawDone
          : terminalPolicy === 'finish'
            ? parser.sawFinish
            : sawDone || parser.sawFinish;
      return {
        text: scrubSessionSecret(answer, resolved.apiKey),
        usage,
        finishReason,
        streamTerminated: terminated,
        responseBytes: guard.used(),
      };
    });
  }
}
