/**
 * WO-03 — OpenAI-compatible provider client.
 *
 * Everything here runs against a canned transport: no test opens a socket, and no
 * test contains a real key. The suite pins the endpoint policy, request shape, usage
 * parsing, error classification, cancel/timeout behaviour, streaming and the retry
 * default (off).
 */
import { describe, expect, it } from 'vitest';
import { HybridError, classifyStatus, toHybridError } from '../src/engine/hybrid/errors';
import { createMockTransport, sseFrames } from '../src/engine/hybrid/mock';
import { OpenAiCompatibleProvider } from '../src/engine/hybrid/openAiCompatible';
import { readCompletionJson } from '../src/engine/hybrid/streamParser';
import { resolveEndpoint, validateModelId, type Transport } from '../src/engine/hybrid/transport';
import type { HybridSettings } from '../src/engine/hybrid/contracts';

const BASE = 'https://api.example.invalid/v1';
const KEY = 'sk-test-0123456789abcdef';

function settings(overrides: Partial<HybridSettings> = {}): HybridSettings {
  return { baseUrl: BASE, model: 'gpt-test', apiKey: KEY, consent: true, ...overrides };
}

const messages = [
  { role: 'system' as const, content: 'You are a tool.' },
  { role: 'user' as const, content: 'Do the thing.' },
];

function jsonReply(content: string, usage: Record<string, number> = { prompt_tokens: 11, completion_tokens: 7 }): string {
  return JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage });
}

describe('endpoint policy', () => {
  it('appends the completions path to the Base URL', () => {
    expect(resolveEndpoint(BASE)).toMatchObject({ ok: true, endpoint: `${BASE}/chat/completions` });
    expect(resolveEndpoint(`${BASE}/`)).toMatchObject({ ok: true, endpoint: `${BASE}/chat/completions` });
    expect(resolveEndpoint('https://api.example.invalid')).toMatchObject({
      ok: true,
      endpoint: 'https://api.example.invalid/chat/completions',
    });
  });

  it('allows http only for localhost', () => {
    expect(resolveEndpoint('http://localhost:1234/v1')).toMatchObject({ ok: true });
    expect(resolveEndpoint('http://127.0.0.1:1234/v1')).toMatchObject({ ok: true });
    expect(resolveEndpoint('http://[::1]:1234/v1')).toMatchObject({ ok: true });
    expect(resolveEndpoint('http://api.example.invalid/v1')).toMatchObject({ ok: false, reason: 'unsupported-scheme' });
  });

  it('refuses credentials, query strings, fragments, whitespace and a duplicated path', () => {
    expect(resolveEndpoint('https://user:pass@api.example.invalid/v1')).toMatchObject({ ok: false, reason: 'credentials' });
    expect(resolveEndpoint(`${BASE}?key=abc`)).toMatchObject({ ok: false, reason: 'query' });
    expect(resolveEndpoint(`${BASE}#top`)).toMatchObject({ ok: false, reason: 'fragment' });
    expect(resolveEndpoint(' https://api.example.invalid/v1')).toMatchObject({ ok: false, reason: 'whitespace' });
    expect(resolveEndpoint(`${BASE}/chat/completions`)).toMatchObject({ ok: false, reason: 'duplicate-path' });
    expect(resolveEndpoint('')).toMatchObject({ ok: false, reason: 'empty' });
    expect(resolveEndpoint('not a url')).toMatchObject({ ok: false });
  });

  it('validates the model id', () => {
    expect(validateModelId('gpt-4o-mini')).toEqual({ ok: true, model: 'gpt-4o-mini' });
    expect(validateModelId('meta/llama-3.1-70b')).toEqual({ ok: true, model: 'meta/llama-3.1-70b' });
    expect(validateModelId('  gpt-test  ')).toEqual({ ok: true, model: 'gpt-test' });
    expect(validateModelId('')).toMatchObject({ ok: false });
    expect(validateModelId('two words')).toMatchObject({ ok: false });
    expect(validateModelId('bad"quote')).toMatchObject({ ok: false });
  });
});

describe('complete()', () => {
  it('sends an OpenAI-compatible request and parses text and usage', async () => {
    const { transport, calls } = createMockTransport([{ body: jsonReply('hello', { prompt_tokens: 12, completion_tokens: 3 }) }]);
    const provider = new OpenAiCompatibleProvider({ transport });
    const result = await provider.complete({ settings: settings(), messages, budget: { maxInputTokens: 0, maxOutputTokens: 0, chunkOverlapTokens: 0, maxFewShotTokens: 0 } });

    expect(result.text).toBe('hello');
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
    expect(result.finishReason).toBe('stop');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/chat/completions`);
    expect(calls[0].authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(calls[0].body);
    expect(body).toMatchObject({ model: 'gpt-test', temperature: 0.2, max_tokens: 4096, stream: false });
    expect(body.messages).toEqual(messages);
    // The key never appears in the URL or the body.
    expect(calls[0].url).not.toContain(KEY);
    expect(calls[0].body).not.toContain(KEY);
  });

  it('accepts the input_tokens / output_tokens spelling', async () => {
    const { transport } = createMockTransport([
      { body: jsonReply('ok', { input_tokens: 5, output_tokens: 2 } as unknown as Record<string, number>) },
    ]);
    const provider = new OpenAiCompatibleProvider({ transport });
    const result = await provider.complete({ settings: settings(), messages, budget: { maxInputTokens: 0, maxOutputTokens: 0, chunkOverlapTokens: 0, maxFewShotTokens: 0 } });
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
  });

  it('refuses to send without consent, without a key or with invalid settings', async () => {
    const { transport, calls } = createMockTransport([]);
    const provider = new OpenAiCompatibleProvider({ transport });
    await expect(
      provider.complete({ settings: settings({ consent: false }), messages, budget: { maxInputTokens: 0, maxOutputTokens: 0, chunkOverlapTokens: 0, maxFewShotTokens: 0 } }),
    ).rejects.toMatchObject({ kind: 'no-consent' });
    await expect(
      provider.complete({ settings: settings({ apiKey: null }), messages, budget: { maxInputTokens: 0, maxOutputTokens: 0, chunkOverlapTokens: 0, maxFewShotTokens: 0 } }),
    ).rejects.toMatchObject({ kind: 'no-key' });
    await expect(
      provider.complete({ settings: settings({ baseUrl: 'http://example.com/v1' }), messages, budget: { maxInputTokens: 0, maxOutputTokens: 0, chunkOverlapTokens: 0, maxFewShotTokens: 0 } }),
    ).rejects.toMatchObject({ kind: 'invalid-settings' });
    expect(calls).toHaveLength(0);
  });

  it('classifies every documented HTTP status', async () => {
    const cases: [number, string][] = [
      [400, 'bad-request'],
      [401, 'auth'],
      [403, 'forbidden'],
      [404, 'not-found'],
      [429, 'rate-limited'],
      [500, 'server'],
      [502, 'server'],
      [503, 'server'],
      [504, 'server'],
      [418, 'http'],
    ];
    for (const [status, kind] of cases) {
      const { transport } = createMockTransport([{ status, body: '{"error":{"message":"nope"}}' }]);
      const provider = new OpenAiCompatibleProvider({ transport });
      const error = await provider
        .complete({ settings: settings(), messages, budget: { maxInputTokens: 0, maxOutputTokens: 0, chunkOverlapTokens: 0, maxFewShotTokens: 0 } })
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(HybridError);
      expect((error as HybridError).kind).toBe(kind);
      expect((error as HybridError).status).toBe(status);
    }
    expect(classifyStatus(429)).toBe('rate-limited');
  });

  it('marks 429 and 5xx as retryable and 400/401/403/404 as terminal', () => {
    expect(new HybridError('rate-limited', 'x').retryable).toBe(true);
    expect(new HybridError('server', 'x').retryable).toBe(true);
    expect(new HybridError('auth', 'x').retryable).toBe(false);
    expect(new HybridError('bad-request', 'x').retryable).toBe(false);
    expect(new HybridError('timeout', 'x').retryable).toBe(false);
  });

  it('classifies malformed and unexpected bodies', async () => {
    const replies = [
      { body: 'not json' },
      { body: JSON.stringify({ choices: [] }) },
      { body: JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: 'x' }] } }] }) },
      { body: JSON.stringify({ error: { message: 'model overloaded' } }) },
    ];
    const { transport } = createMockTransport(replies);
    const provider = new OpenAiCompatibleProvider({ transport });
    const kinds: string[] = [];
    for (let index = 0; index < replies.length; index += 1) {
      const error = await provider
        .complete({ settings: settings(), messages, budget: { maxInputTokens: 0, maxOutputTokens: 0, chunkOverlapTokens: 0, maxFewShotTokens: 0 } })
        .catch((cause: unknown) => cause as HybridError);
      kinds.push((error as HybridError).kind);
    }
    expect(kinds).toEqual(['invalid-json', 'empty-choices', 'unsupported-format', 'provider']);
  });

  it('reports a network failure and a possible CORS refusal differently', async () => {
    const network = createMockTransport([{ throw: new TypeError('Failed to fetch') }]);
    const provider = new OpenAiCompatibleProvider({ transport: network.transport });
    const error = await provider
      .complete({ settings: settings(), messages, budget: { maxInputTokens: 0, maxOutputTokens: 0, chunkOverlapTokens: 0, maxFewShotTokens: 0 } })
      .catch((cause: unknown) => cause as HybridError);
    expect((error as HybridError).kind).toBe('network');
    expect((error as HybridError).message).toContain('CORS');

    const cors = createMockTransport([{ throw: new TypeError('CORS request rejected') }]);
    const corsProvider = new OpenAiCompatibleProvider({ transport: cors.transport });
    const corsError = await corsProvider
      .complete({ settings: settings(), messages, budget: { maxInputTokens: 0, maxOutputTokens: 0, chunkOverlapTokens: 0, maxFewShotTokens: 0 } })
      .catch((cause: unknown) => cause as HybridError);
    expect((corsError as HybridError).kind).toBe('cors');
  });

  it('never sends after the caller already cancelled', async () => {
    const { transport, calls } = createMockTransport([{ body: jsonReply('late') }]);
    const provider = new OpenAiCompatibleProvider({ transport });
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.complete({
        settings: settings(),
        messages,
        budget: { maxInputTokens: 0, maxOutputTokens: 0, chunkOverlapTokens: 0, maxFewShotTokens: 0 },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ kind: 'aborted' });
    expect(calls).toHaveLength(0);
  });

  it('times a stalled request out', async () => {
    const stalling: Transport = {
      send: (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    };
    const provider = new OpenAiCompatibleProvider({ transport: stalling });
    const started = Date.now();
    const error = await provider
      .complete({
        settings: settings({ requestTimeoutMs: 30 }),
        messages,
        budget: { maxInputTokens: 0, maxOutputTokens: 0, chunkOverlapTokens: 0, maxFewShotTokens: 0 },
      })
      .catch((cause: unknown) => cause as HybridError);
    expect((error as HybridError).kind).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('retry policy', () => {
  it('is disabled by default', async () => {
    const { transport, calls } = createMockTransport([{ status: 500, body: '{}' }, { body: jsonReply('second') }]);
    const provider = new OpenAiCompatibleProvider({ transport });
    await expect(
      provider.complete({ settings: settings(), messages, budget: { maxInputTokens: 0, maxOutputTokens: 0, chunkOverlapTokens: 0, maxFewShotTokens: 0 } }),
    ).rejects.toMatchObject({ kind: 'server' });
    expect(calls).toHaveLength(1);
  });

  it('can retry 429 and 5xx when explicitly enabled', async () => {
    const { transport, calls } = createMockTransport([
      { status: 429, body: '{}', headers: { 'retry-after': '0' } },
      { status: 503, body: '{}' },
      { body: jsonReply('third time') },
    ]);
    const provider = new OpenAiCompatibleProvider({ transport, retry: { maxAttempts: 3 }, sleep: async () => undefined });
    const result = await provider.complete({ settings: settings(), messages, budget: { maxInputTokens: 0, maxOutputTokens: 0, chunkOverlapTokens: 0, maxFewShotTokens: 0 } });
    expect(result.text).toBe('third time');
    expect(calls).toHaveLength(3);
  });

  it('does not retry a terminal status', async () => {
    const { transport, calls } = createMockTransport([{ status: 401, body: '{}' }, { body: jsonReply('never') }]);
    const provider = new OpenAiCompatibleProvider({ transport, retry: { maxAttempts: 3 }, sleep: async () => undefined });
    await expect(
      provider.complete({ settings: settings(), messages, budget: { maxInputTokens: 0, maxOutputTokens: 0, chunkOverlapTokens: 0, maxFewShotTokens: 0 } }),
    ).rejects.toMatchObject({ kind: 'auth' });
    expect(calls).toHaveLength(1);
  });

  it('stops retrying once the caller cancels', async () => {
    const { transport, calls } = createMockTransport([{ status: 500, body: '{}' }, { body: jsonReply('late') }]);
    const controller = new AbortController();
    const provider = new OpenAiCompatibleProvider({
      transport,
      retry: { maxAttempts: 3 },
      sleep: async () => {
        controller.abort();
      },
    });
    await expect(
      provider.complete({
        settings: settings(),
        messages,
        budget: { maxInputTokens: 0, maxOutputTokens: 0, chunkOverlapTokens: 0, maxFewShotTokens: 0 },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ kind: 'aborted' });
    expect(calls).toHaveLength(1);
  });
});

describe('completeStream()', () => {
  it('streams deltas and returns the full text with usage', async () => {
    const { transport, calls } = createMockTransport([
      { stream: sseFrames('streamed answer', { usage: { prompt_tokens: 21, completion_tokens: 4 } }) },
    ]);
    const provider = new OpenAiCompatibleProvider({ transport });
    const chunks: string[] = [];
    const result = await provider.completeStream(
      { settings: settings(), messages, budget: { maxInputTokens: 0, maxOutputTokens: 0, chunkOverlapTokens: 0, maxFewShotTokens: 0 } },
      (chunk) => chunks.push(chunk),
    );
    expect(result.text).toBe('streamed answer');
    expect(chunks.join('')).toBe('streamed answer');
    expect(result.usage).toEqual({ inputTokens: 21, outputTokens: 4 });
    expect(result.finishReason).toBe('stop');
    expect(JSON.parse(calls[0].body).stream).toBe(true);
    expect(calls[0].headers.accept).toBe('text/event-stream');
  });

  it('accepts a provider that ignores stream and answers with JSON', async () => {
    const { transport } = createMockTransport([{ body: jsonReply('plain answer') }]);
    const provider = new OpenAiCompatibleProvider({ transport });
    const chunks: string[] = [];
    const result = await provider.completeStream(
      { settings: settings(), messages, budget: { maxInputTokens: 0, maxOutputTokens: 0, chunkOverlapTokens: 0, maxFewShotTokens: 0 } },
      (chunk) => chunks.push(chunk),
    );
    expect(result.text).toBe('plain answer');
    expect(chunks).toEqual(['plain answer']);
  });

  it('surfaces an error frame instead of a partial answer', async () => {
    const { transport } = createMockTransport([
      { stream: ['data: {"choices":[{"delta":{"content":"part"}}]}\n\n', 'data: {"error":{"message":"upstream broke"}}\n\n'] },
    ]);
    const provider = new OpenAiCompatibleProvider({ transport });
    const chunks: string[] = [];
    const error = await provider
      .completeStream(
        { settings: settings(), messages, budget: { maxInputTokens: 0, maxOutputTokens: 0, chunkOverlapTokens: 0, maxFewShotTokens: 0 } },
        (chunk) => chunks.push(chunk),
      )
      .catch((cause: unknown) => cause as HybridError);
    expect((error as HybridError).kind).toBe('provider');
    expect((error as HybridError).message).toContain('upstream broke');
  });

  it('fails with empty-choices when a stream carries no text at all', async () => {
    const { transport } = createMockTransport([{ stream: ['data: [DONE]\n\n'] }]);
    const provider = new OpenAiCompatibleProvider({ transport });
    const error = await provider
      .completeStream(
        { settings: settings(), messages, budget: { maxInputTokens: 0, maxOutputTokens: 0, chunkOverlapTokens: 0, maxFewShotTokens: 0 } },
        () => undefined,
      )
      .catch((cause: unknown) => cause as HybridError);
    expect((error as HybridError).kind).toBe('empty-choices');
  });
});

describe('redirect policy', () => {
  it('follows a same-origin redirect', async () => {
    const { transport, calls } = createMockTransport([
      { status: 307, headers: { location: '/v1/chat/completions' } },
      { body: jsonReply('after redirect') },
    ]);
    const provider = new OpenAiCompatibleProvider({ transport });
    const result = await provider.complete({ settings: settings(), messages, budget: { maxInputTokens: 0, maxOutputTokens: 0, chunkOverlapTokens: 0, maxFewShotTokens: 0 } });
    expect(result.text).toBe('after redirect');
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe(`${BASE}/chat/completions`);
    expect(calls[1].authorization).toBe(`Bearer ${KEY}`);
  });

  it('refuses a cross-origin redirect instead of sending the key there', async () => {
    const { transport, calls } = createMockTransport([
      { status: 302, headers: { location: 'https://evil.example.net/v1/chat/completions' } },
      { body: jsonReply('should never be reached') },
    ]);
    const provider = new OpenAiCompatibleProvider({ transport });
    const error = await provider
      .complete({ settings: settings(), messages, budget: { maxInputTokens: 0, maxOutputTokens: 0, chunkOverlapTokens: 0, maxFewShotTokens: 0 } })
      .catch((cause: unknown) => cause as HybridError);
    expect((error as HybridError).kind).toBe('cors');
    expect(calls).toHaveLength(1);
    expect(calls.every((call) => call.url.startsWith(BASE))).toBe(true);
  });

  it('stops after the redirect limit', async () => {
    const redirect = { status: 307, headers: { location: '/v1/chat/completions' } };
    const { transport } = createMockTransport([redirect, redirect, redirect, redirect, redirect, redirect]);
    const provider = new OpenAiCompatibleProvider({ transport });
    const error = await provider
      .complete({ settings: settings(), messages, budget: { maxInputTokens: 0, maxOutputTokens: 0, chunkOverlapTokens: 0, maxFewShotTokens: 0 } })
      .catch((cause: unknown) => cause as HybridError);
    expect((error as HybridError).kind).toBe('http');
    expect((error as HybridError).message).toContain('リダイレクト');
  });
});

describe('error helpers', () => {
  it('normalizes a contract error into the rich vocabulary', () => {
    expect(toHybridError(new Error('boom'))).toMatchObject({ kind: 'provider' });
    const abort = new DOMException('stopped', 'AbortError');
    expect(toHybridError(abort)).toMatchObject({ kind: 'aborted' });
  });

  it('reads a completion body the same way for both call styles', () => {
    expect(readCompletionJson(jsonReply('x')).text).toBe('x');
    expect(() => readCompletionJson('{')).toThrowError(HybridError);
  });
});
