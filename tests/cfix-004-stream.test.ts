/**
 * C-FIX-004 — streaming protocol correction.
 *
 * The cases are the boundaries the Phase 5C parser could not see: a UTF-8 sequence
 * split across chunks, a line ending in `\r`, a last event with no blank line, a
 * flush that used to run twice, a JSON payload split across two `data:` lines, and
 * an error frame in the middle of an otherwise healthy stream.
 */
import { describe, expect, it } from 'vitest';
import { createSseEventDecoder, createUtf8FrameDecoder } from '../src/engine/hybrid/streamCodec';
import { createSseParser, parseSseData } from '../src/engine/hybrid/streamParser';
import { OpenAiCompatibleProvider } from '../src/engine/hybrid/openAiCompatible';
import { createHybridSession, runGatewayRequest } from '../src/engine/hybrid/streamEngine';
import type { HybridProviderRequest } from '../src/engine/hybrid/contracts';
import type { Transport, TransportResponse } from '../src/engine/hybrid/transport';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const settings = {
  baseUrl: 'https://api.example.invalid/v1',
  model: 'gpt-test',
  apiKey: 'test-key-0123456789',
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

function byteTransport(chunks: Uint8Array[]): Transport {
  return {
    async send(): Promise<TransportResponse> {
      return {
        status: 200,
        ok: true,
        headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
        text: async () => '',
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
      };
    },
  };
}

function frame(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text }, index: 0 }] })}\n\n`;
}

describe('UTF-8 framing', () => {
  it('holds a split multi-byte sequence until it is complete', () => {
    const bytes = encoder.encode('가나다');
    const framer = createUtf8FrameDecoder();
    const first = framer.push(bytes.slice(0, 4));
    expect(first).toBe('가');
    expect(framer.pendingBytes()).toBe(1);
    const second = framer.push(bytes.slice(4));
    expect(first + second).toBe('가나다');
    expect(framer.pendingBytes()).toBe(0);
  });

  it('reports a truncated tail instead of inventing a character', () => {
    const bytes = encoder.encode('나');
    const framer = createUtf8FrameDecoder();
    expect(framer.push(bytes.slice(0, 2))).toBe('');
    expect(framer.hadTruncatedSequence()).toBe(false);
    expect(framer.flush()).toBe('\uFFFD');
    expect(framer.hadTruncatedSequence()).toBe(true);
  });

  it('round-trips a long mixed-script payload split at every byte', () => {
    const text = '{"a":"안녕하세요 日本語テスト 한글"}'.repeat(20);
    const bytes = encoder.encode(text);
    const framer = createUtf8FrameDecoder();
    let out = '';
    for (const byte of bytes) out += framer.push(new Uint8Array([byte]));
    out += framer.flush();
    expect(out).toBe(text);
  });
});

describe('SSE event framing', () => {
  it('accepts LF, CRLF and CR line endings', () => {
    const decoderLf = createSseEventDecoder();
    expect(decoderLf.push('data: a\n\n').map((event) => event.data)).toEqual(['a']);

    const decoderCrlf = createSseEventDecoder();
    expect(decoderCrlf.push('data: b\r\n\r\n').map((event) => event.data)).toEqual(['b']);

    const decoderCr = createSseEventDecoder();
    expect(decoderCr.push('data: c\r\r').map((event) => event.data)).toEqual(['c']);
  });

  it('holds a trailing CR until the next chunk decides CRLF', () => {
    const decoder = createSseEventDecoder();
    expect(decoder.push('data: x\r')).toEqual([]);
    expect(decoder.push('\n\r\n').map((event) => event.data)).toEqual(['x']);
  });

  it('joins multi-line data and keeps the event name', () => {
    const decoder = createSseEventDecoder();
    const events = decoder.push('event: completion\ndata: {"a":\ndata: 1}\n\n');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'completion', data: '{"a":\n1}' });
  });

  it('strips a BOM, ignores comments and dispatches the last event once', () => {
    const decoder = createSseEventDecoder();
    const first = decoder.push(`\uFEFF: keep-alive\ndata: last`);
    expect(first).toEqual([]);
    const finished = decoder.finish();
    expect(finished.map((event) => event.data)).toEqual(['last']);
    expect(decoder.finish()).toEqual([]);
    expect(decoder.stats().events).toBe(1);
  });

  it('reports an oversized line as a problem instead of buffering it', () => {
    const decoder = createSseEventDecoder({ maxLineChars: 20 });
    decoder.push('data: ' + 'x'.repeat(200));
    const problems = decoder.takeProblems();
    expect(problems.map((problem) => problem.code)).toContain('oversize-line');
  });
});

describe('parser over the framing layer', () => {
  it('maps [DONE], a finish_reason and usage exactly once', () => {
    const parser = createSseParser();
    const events = parser.push(
      `${frame('{"a":')}${frame('1}')}data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`,
    );
    expect(events.filter((event) => event.type === 'delta')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
    expect(parser.terminated).toBe(true);
    expect(parser.flush()).toEqual([]);
  });

  it('accepts a JSON payload split across two data lines of one event', () => {
    const parser = createSseParser();
    // A provider that writes a pretty-printed JSON object over several data lines.
    const events = parser.push('data: {"choices":[{"delta":{"content":"ok"}\ndata: ,"index":0}]}\n\n');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'delta', text: 'ok' });
  });

  it('turns an error frame into an error event and stops', () => {
    const parser = createSseParser();
    const events = parser.push(`data: {"error":{"message":"quota exceeded"}}\n\n`);
    expect(events[0]).toMatchObject({ type: 'error' });
  });

  it('keeps the raw parse vocabulary for a malformed payload', () => {
    expect(parseSseData('{not json')[0]).toMatchObject({ type: 'error' });
    expect(parseSseData('[DONE]')[0]).toMatchObject({ type: 'done', finishReason: null });
  });
});

describe('provider over the corrected stream', () => {
  it('receives a CR-only stream without losing the last event', async () => {
    const body = encoder.encode(
      [
        `data: {"choices":[{"delta":{"content":"ab"}}]}\r\r`,
        `data: {"choices":[{"delta":{"content":"cd"},"finish_reason":"stop"}]}\r\r`,
        'data: [DONE]\r\r',
      ].join(''),
    );
    const provider = new OpenAiCompatibleProvider({ transport: byteTransport([body]) });
    const session = createHybridSession();
    const outcome = await runGatewayRequest({ provider, request: request(session.signal), session, streaming: true });
    expect(outcome.raw).toBe('abcd');
    expect(outcome.terminated).toBe(true);
    expect(outcome.streamed).toBe(true);
    expect(outcome.responseBytes).toBe(body.byteLength);
  });

  it('keeps a Korean character intact when the boundary falls inside it', async () => {
    const payload = `${frame('결제 금액')}data: [DONE]\n\n`;
    const bytes = encoder.encode(payload);
    const splitAt = encoder.encode('data: {"choices":[{"delta":{"content":"결').length;
    expect(decoder.decode(bytes.slice(0, splitAt)).endsWith('결')).toBe(true);
    const provider = new OpenAiCompatibleProvider({
      transport: byteTransport([bytes.slice(0, splitAt - 1), bytes.slice(splitAt - 1)]),
    });
    const session = createHybridSession();
    const outcome = await runGatewayRequest({ provider, request: request(session.signal), session, streaming: true });
    expect(outcome.raw).toBe('결제 금액');
  });
});
