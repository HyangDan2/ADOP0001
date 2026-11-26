/**
 * INT-005 — bounded response reading.
 *
 * The ceiling has to be enforced while the body arrives, not after `text()` has
 * buffered it, and the same rule applies to an HTTP error body.
 */
import { describe, expect, it } from 'vitest';
import { OpenAiCompatibleProvider } from '../src/engine/hybrid/openAiCompatible';
import type { Transport, TransportResponse } from '../src/engine/hybrid/transport';
import { createMockTransport } from '../src/engine/hybrid/mock';

const settings = {
  baseUrl: 'https://api.example.invalid/v1',
  model: 'gpt-test',
  apiKey: 'test-key-0123456789',
  consent: true,
  requestTimeoutMs: 5_000,
  maxOutputTokens: 256,
};

function encoderStream(pieces: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  });
}

describe('INT-005 — bounded response reading', () => {
  it('refuses an oversized error body while reading it', async () => {
    const huge = 'x'.repeat(700_000);
    const transport = createMockTransport([
      { status: 500, bodyChunks: [huge.slice(0, 400_000), huge.slice(400_000)] },
    ]);
    const provider = new OpenAiCompatibleProvider({ transport: transport.transport });
    await expect(
      provider.complete({
        settings: { ...settings, consent: true },
        messages: [{ role: 'user', content: 'hi' }],
        budget: { maxInputTokens: 10, maxOutputTokens: 10, chunkOverlapTokens: 0, maxFewShotTokens: 0 },
      }),
    ).rejects.toMatchObject({ kind: 'response-too-long' });
  });

  it('reads a normal answer from the body stream, never from text()', async () => {
    const body = JSON.stringify({ choices: [{ message: { content: '{"ok":1}' }, finish_reason: 'stop' }] });
    const transport: Transport = {
      async send(): Promise<TransportResponse> {
        return {
          status: 200,
          ok: true,
          headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
          // The old path buffered the whole body with text(); this one must not.
          text: async () => {
            throw new Error('text() must not be used for a streamed body');
          },
          body: encoderStream([body.slice(0, 20), body.slice(20)]),
        };
      },
    };
    const provider = new OpenAiCompatibleProvider({ transport });
    const result = await provider.complete({
      settings: { ...settings, consent: true },
      messages: [{ role: 'user', content: 'hi' }],
      budget: { maxInputTokens: 10, maxOutputTokens: 10, chunkOverlapTokens: 0, maxFewShotTokens: 0 },
    });
    expect(result.text).toBe('{"ok":1}');
    expect(result.responseBytes).toBeGreaterThan(0);
  });

  it('counts a multi-byte body by bytes, not characters', async () => {
    const text = '한'.repeat(400_000); // 1.2 MB of UTF-8, 400k characters
    const body = JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] });
    const transport: Transport = {
      async send(): Promise<TransportResponse> {
        return {
          status: 200,
          ok: true,
          headers: { get: () => 'application/json' },
          text: async () => body,
          body: encoderStream([body.slice(0, body.length / 2), body.slice(body.length / 2)]),
        };
      },
    };
    const provider = new OpenAiCompatibleProvider({ transport });
    // maxOutputTokens 256 → byte ceiling well below 1.2 MB.
    await expect(
      provider.complete({
        settings: { ...settings, consent: true },
        messages: [{ role: 'user', content: 'hi' }],
        budget: { maxInputTokens: 10, maxOutputTokens: 10, chunkOverlapTokens: 0, maxFewShotTokens: 0 },
      }),
    ).rejects.toMatchObject({ kind: 'response-too-long' });
  });
});
