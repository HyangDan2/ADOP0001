/**
 * WO-08 — streaming response engine.
 *
 * Every case here would be a user-visible defect: a Korean character broken at a
 * chunk boundary, a JSON event split by the network, a truncated answer shown as
 * complete, a Stop that does not stop, or a stage that jumps backwards.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  canTransition,
  createHybridSession,
  responseCharCapFor,
  runGatewayRequest,
  STAGE_LABEL,
  type HybridStage,
} from '../src/engine/hybrid/streamEngine';
import { OpenAiCompatibleProvider } from '../src/engine/hybrid/openAiCompatible';
import type { HybridProviderRequest } from '../src/engine/hybrid/contracts';
import type { Transport, TransportRequest, TransportResponse } from '../src/engine/hybrid/transport';
import { HybridError } from '../src/engine/hybrid/errors';

const settings = {
  baseUrl: 'https://api.example.invalid/v1',
  model: 'gpt-test',
  apiKey: 'sk-test-0123456789',
  consent: true,
  requestTimeoutMs: 5_000,
  maxOutputTokens: 256,
};

function request(signal: AbortSignal): HybridProviderRequest {
  return {
    settings,
    messages: [{ role: 'user', content: 'spec' }],
    budget: { maxInputTokens: 1000, maxOutputTokens: 256, chunkOverlapTokens: 0, maxFewShotTokens: 0 },
    signal,
  };
}

const encoder = new TextEncoder();

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function delta(text: string): string {
  return frame({ choices: [{ delta: { content: text }, index: 0 }] });
}

const DONE = 'data: [DONE]\n\n';

/** A transport that hands back the response body as raw bytes, chunk by chunk. */
function byteTransport(chunks: Uint8Array[], options: { status?: number; hangAfterChunks?: boolean } = {}) {
  const calls: TransportRequest[] = [];
  const transport: Transport = {
    async send(req): Promise<TransportResponse> {
      calls.push(req);
      const status = options.status ?? 200;
      return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
        text: async () => '',
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            if (options.hangAfterChunks) {
              req.signal.addEventListener('abort', () => {
                controller.error(new DOMException('Aborted', 'AbortError'));
              });
              return;
            }
            controller.close();
          },
        }),
      };
    },
  };
  return { transport, calls };
}

async function collect(chunks: string[], options: { status?: number; hangAfterChunks?: boolean } = {}) {
  const session = createHybridSession();
  const provider = new OpenAiCompatibleProvider({ transport: byteTransport(chunks.map((chunk) => encoder.encode(chunk)), options).transport });
  const deltas: string[] = [];
  const result = await runGatewayRequest({
    provider,
    request: request(session.signal),
    session,
    streaming: true,
    onDelta: (chunk) => deltas.push(chunk),
  });
  return { session, result, deltas };
}

describe('session stage machine', () => {
  it('walks the documented path and labels every stage in Japanese', () => {
    const seen: HybridStage[] = [];
    const session = createHybridSession({ onStatus: (status) => seen.push(status.stage) });
    session.enter('preflight');
    session.enter('awaiting-consent');
    session.enter('connecting');
    session.appendDelta('a');
    session.enter('validating');
    session.enter('completed');
    expect(seen).toEqual(['preflight', 'awaiting-consent', 'connecting', 'streaming', 'validating', 'completed']);
    expect(STAGE_LABEL['awaiting-consent']).toBe('承認待ち');
    expect(session.status().stageLabel).toBe('完了');
  });

  it('refuses a stage that the graph does not allow', () => {
    const session = createHybridSession();
    expect(() => session.enter('completed')).toThrow(HybridError);
    expect(canTransition('streaming', 'awaiting-consent')).toBe(false);
    expect(canTransition('streaming', 'validating')).toBe(true);
    expect(canTransition('local-fallback', 'completed')).toBe(false);
  });

  it('never moves a terminal run again', () => {
    const session = createHybridSession();
    session.enter('preflight');
    session.enter('local-fallback', 'network');
    expect(() => session.enter('streaming')).toThrow();
    expect(session.status().reason).toBe('network');
  });

  it('measures elapsed time and time to first token with an injected clock', () => {
    let now = 1_000;
    const session = createHybridSession({ now: () => now });
    session.enter('preflight');
    now = 1_200;
    session.enter('awaiting-consent');
    now = 1_400;
    session.enter('connecting');
    expect(session.status().ttftMs).toBeNull();
    now = 1_700;
    session.appendDelta('first');
    now = 2_000;
    session.appendDelta(' more');
    now = 2_300;
    session.enter('validating');
    now = 2_600;
    session.enter('completed');
    const status = session.status();
    expect(status.ttftMs).toBe(700);
    expect(status.elapsedMs).toBe(1_600); // frozen at the terminal stage
    expect(status.receivedChars).toBe(10);
    expect(status.canStop).toBe(false);
  });

  it('ignores an empty delta for TTFT and content', () => {
    let now = 0;
    const session = createHybridSession({ now: () => now });
    session.enter('preflight');
    session.enter('awaiting-consent');
    session.enter('connecting');
    now = 500;
    session.appendDelta('');
    expect(session.status().ttftMs).toBeNull();
    expect(session.status().receivedChars).toBe(0);
    now = 900;
    session.appendDelta('x');
    expect(session.status().ttftMs).toBe(900);
  });

  it('Stop aborts the signal, records the reason and closes the Stop control', () => {
    const session = createHybridSession();
    session.enter('preflight');
    session.enter('awaiting-consent');
    session.enter('connecting');
    expect(session.status().canStop).toBe(true);
    session.stop();
    expect(session.signal.aborted).toBe(true);
    expect(session.stopRequested()).toBe(true);
    expect(session.status().reason).toContain('停止');
    expect(session.status().canStop).toBe(false);
  });

  it('derives the receive cap from the output cap', () => {
    expect(responseCharCapFor(4096)).toBeGreaterThan(4096 * 4);
    expect(responseCharCapFor(0)).toBeGreaterThanOrEqual(4096);
  });
});

describe('gateway request', () => {
  it('receives an SSE answer, its usage and [DONE]', async () => {
    const { session, result, deltas } = await collect([
      delta('{"version":1,'),
      delta('"proposals":[]}'),
      frame({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }], usage: { prompt_tokens: 11, completion_tokens: 7 } }),
      DONE,
    ]);
    expect(result.raw).toBe('{"version":1,"proposals":[]}');
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(result.finishReason).toBe('stop');
    expect(deltas.join('')).toBe(result.raw);
    expect(session.stage()).toBe('streaming');
    expect(session.status().ttftMs).not.toBeNull();
  });

  it('keeps a multi-byte character intact when the chunk boundary splits it', async () => {
    const payload = `${delta('안녕하세요: 日本語テスト')}${DONE}`;
    const bytes = encoder.encode(payload);
    // Split inside the first Korean character (three bytes in UTF-8).
    const start = new TextDecoder().decode(bytes.slice(0, 40)).length;
    const splitAt = encoder.encode(payload.slice(0, start)).length + 1;
    const chunks = [bytes.slice(0, splitAt), bytes.slice(splitAt)];
    const session = createHybridSession();
    const provider = new OpenAiCompatibleProvider({ transport: byteTransport(chunks).transport });
    const outcome = await runGatewayRequest({
      provider,
      request: request(session.signal),
      session,
      streaming: true,
    });
    expect(outcome.raw).toBe('안녕하세요: 日本語テスト');
  });

  it('accepts CRLF line endings and a data line split across chunks', async () => {
    const payload = `data: {"choices":[{"delta":{"content":"ab"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"cd"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n`;
    const bytes = encoder.encode(payload);
    const mid = Math.floor(bytes.length / 2);
    const session = createHybridSession();
    const provider = new OpenAiCompatibleProvider({ transport: byteTransport([bytes.slice(0, mid), bytes.slice(mid)]).transport });
    const outcome = await runGatewayRequest({ provider, request: request(session.signal), session, streaming: true });
    expect(outcome.raw).toBe('abcd');
  });

  it('tolerates empty deltas and a usage-only final chunk', async () => {
    const { result } = await collect([
      delta(''),
      delta('answer'),
      frame({ choices: [{ delta: { content: '' }, index: 0 }] }),
      frame({ choices: [{ delta: {}, finish_reason: null, index: 0 }] }),
      frame({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
      DONE,
    ]);
    expect(result.raw).toBe('answer');
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
  });

  it('rejects an answer that was cut at the provider output cap', async () => {
    await expect(
      collect([delta('{"partial":'), frame({ choices: [{ delta: {}, finish_reason: 'length', index: 0 }] })]),
    ).rejects.toMatchObject({ kind: 'incomplete-stream' });
  });

  it('rejects a stream that closes without [DONE] or finish_reason', async () => {
    await expect(collect([delta('{"version":1'), delta(',"proposals":[]}')])).rejects.toMatchObject({
      kind: 'incomplete-stream',
    });
  });

  it('stops receiving at the character cap instead of filling memory', async () => {
    const long = 'x'.repeat(500);
    const session = createHybridSession();
    const provider = new OpenAiCompatibleProvider({ transport: byteTransport([encoder.encode(delta(long) + delta(long) + DONE)]).transport });
    await expect(
      runGatewayRequest({ provider, request: request(session.signal), session, streaming: true, maxResponseChars: 700 }),
    ).rejects.toMatchObject({ kind: 'response-too-long' });
    expect(session.text().length).toBeLessThanOrEqual(1000);
  });

  it('reports the user Stop as an abort even mid-stream', async () => {
    const session = createHybridSession();
    const body = encoder.encode(`${delta('{"version":1')}`);
    const provider = new OpenAiCompatibleProvider({
      transport: {
        async send(req) {
          return {
            status: 200,
            ok: true,
            headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
            text: async () => '',
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(body);
                req.signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
              },
            }),
          };
        },
      },
    });
    let stopped = false;
    const promise = runGatewayRequest({
      provider,
      request: request(session.signal),
      session,
      streaming: true,
      onDelta: () => {
        if (!stopped) {
          stopped = true;
          session.stop();
        }
      },
    });
    await expect(promise).rejects.toMatchObject({ kind: 'aborted' });
    expect(session.stopRequested()).toBe(true);
  });

  it('classifies a provider that answers non-streaming when streaming was asked for', async () => {
    const body = JSON.stringify({
      choices: [{ message: { content: '{"version":1,"proposals":[]}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 4 },
    });
    const provider = new OpenAiCompatibleProvider({
      transport: {
        async send() {
          return {
            status: 200,
            ok: true,
            headers: { get: () => 'application/json' },
            text: async () => body,
            body: null,
          };
        },
      },
    });
    const session = createHybridSession();
    const outcome = await runGatewayRequest({ provider, request: request(session.signal), session, streaming: true });
    expect(outcome.raw).toBe('{"version":1,"proposals":[]}');
    expect(outcome.usage).toEqual({ inputTokens: 5, outputTokens: 4 });
  });

  it('times out a provider that never answers', async () => {
    vi.useFakeTimers();
    try {
      const provider = new OpenAiCompatibleProvider({
        transport: {
          send(req) {
            return new Promise<TransportResponse>((_resolve, reject) => {
              req.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
            });
          },
        },
      });
      const session = createHybridSession();
      const promise = runGatewayRequest({
        provider,
        request: request(session.signal),
        session,
        streaming: true,
      });
      const assertion = expect(promise).rejects.toMatchObject({ kind: 'timeout' });
      await vi.advanceTimersByTimeAsync(5_500);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
