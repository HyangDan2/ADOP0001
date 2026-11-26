/**
 * INT-004 — terminal semantics of a stream.
 *
 * A finish reason is not the end of the stream: the usage block and `[DONE]` follow
 * it. These cases cover a usage chunk after the finish reason, a stream that stops
 * at the finish reason (policy-dependent), a JSON answer to a streaming request,
 * and the non-streaming length/refusal outcomes.
 */
import { describe, expect, it } from 'vitest';
import { OpenAiCompatibleProvider } from '../src/engine/hybrid/openAiCompatible';
import { createHybridSession, runGatewayRequest } from '../src/engine/hybrid/streamEngine';
import { createProviderProfile } from '../src/engine/hybrid/providerProfiles';
import { createMockTransport } from '../src/engine/hybrid/mock';
import type { HybridProviderRequest } from '../src/engine/hybrid/contracts';

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

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

describe('INT-004 — streaming terminal semantics', () => {
  it('keeps reading after a finish reason to collect usage and [DONE]', async () => {
    const transport = createMockTransport([
      {
        stream: [
          frame({ choices: [{ delta: { content: '{"ok":' }, index: 0 }] }),
          frame({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] }),
          // The usage block arrives after the finish reason and before [DONE].
          frame({ choices: [], usage: { prompt_tokens: 21, completion_tokens: 7 } }),
          'data: [DONE]\n\n',
        ],
      },
    ]);
    const provider = new OpenAiCompatibleProvider({ transport: transport.transport });
    const session = createHybridSession();
    const outcome = await runGatewayRequest({
      provider,
      request: request(session.signal),
      session,
      streaming: true,
    });
    expect(outcome.raw).toBe('{"ok":');
    expect(outcome.usage).toEqual({ inputTokens: 21, outputTokens: 7 });
    expect(outcome.terminated).toBe(true);
  });

  it('treats EOF after a finish reason as complete only when the profile allows it', async () => {
    const strict = createProviderProfile({
      id: 'strict-done',
      label: 'strict',
      hosts: ['*'],
      capabilities: { body: { terminalPolicy: 'done' } },
    });
    const transport = createMockTransport([
      {
        stream: [
          frame({ choices: [{ delta: { content: '{"partial":' }, index: 0 }] }),
          frame({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] }),
          // No [DONE].
        ],
      },
    ]);
    const provider = new OpenAiCompatibleProvider({ profile: strict, transport: transport.transport });
    const session = createHybridSession();
    await expect(
      runGatewayRequest({ provider, request: request(session.signal), session, streaming: true }),
    ).rejects.toMatchObject({ kind: 'incomplete-stream' });
  });

  it('reads a JSON answer even when a streaming request was made', async () => {
    const transport = createMockTransport([
      {
        headers: { 'content-type': 'application/json' },
        bodyChunks: ['{"choices":[{"message":{"content":"', '{\\"version\\":1}', '"}, "finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}'],
      },
    ]);
    const provider = new OpenAiCompatibleProvider({ transport: transport.transport });
    const session = createHybridSession();
    const outcome = await runGatewayRequest({ provider, request: request(session.signal), session, streaming: true });
    expect(outcome.raw).toBe('{"version":1}');
    expect(outcome.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
    expect(outcome.streamed).toBe(true);
  });

  it('rejects a non-streaming answer cut at the output cap', async () => {
    const transport = createMockTransport([
      {
        body: JSON.stringify({ choices: [{ message: { content: '{"cut":' }, finish_reason: 'length' }] }),
      },
    ]);
    const provider = new OpenAiCompatibleProvider({ transport: transport.transport });
    await expect(
      provider.complete({
        settings: { ...settings, consent: true },
        messages: [{ role: 'user', content: 'hi' }],
        budget: { maxInputTokens: 10, maxOutputTokens: 10, chunkOverlapTokens: 0, maxFewShotTokens: 0 },
      }),
    ).rejects.toMatchObject({ kind: 'incomplete-stream' });
  });

  it('rejects a provider refusal instead of adopting its text', async () => {
    const transport = createMockTransport([
      {
        body: JSON.stringify({ choices: [{ message: { content: 'I cannot help with that.' }, finish_reason: 'content_filter' }] }),
      },
    ]);
    const provider = new OpenAiCompatibleProvider({ transport: transport.transport });
    await expect(
      provider.complete({
        settings: { ...settings, consent: true },
        messages: [{ role: 'user', content: 'hi' }],
        budget: { maxInputTokens: 10, maxOutputTokens: 10, chunkOverlapTokens: 0, maxFewShotTokens: 0 },
      }),
    ).rejects.toMatchObject({ kind: 'provider' });
  });
});
