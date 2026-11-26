/**
 * C-FIX-005 — timeout and response resource policy.
 *
 * The cases are the ways a provider can be slow or greedy without being wrong: it
 * connects and never answers, it streams one frame and stalls, it answers with more
 * bytes than the output cap allows, or the profile forbids an unbounded phase.
 */
import { describe, expect, it } from 'vitest';
import {
  PHASE_LABEL,
  ResourceGuard,
  policyForProfile,
  resolveResourcePolicy,
  responseByteCapFor,
  responseCharCapFor,
  withPhaseDeadline,
} from '../src/engine/hybrid/resourcePolicy';
import { createProviderProfile, providerRegistry } from '../src/engine/hybrid/providerProfiles';
import { OpenAiCompatibleProvider } from '../src/engine/hybrid/openAiCompatible';
import { createHybridSession, runGatewayRequest } from '../src/engine/hybrid/streamEngine';
import type { HybridProviderRequest } from '../src/engine/hybrid/contracts';
import type { Transport, TransportResponse } from '../src/engine/hybrid/transport';
import { HybridError } from '../src/engine/hybrid/errors';

const settings = {
  baseUrl: 'https://api.example.invalid/v1',
  model: 'gpt-test',
  apiKey: 'test-key-0123456789',
  consent: true,
  requestTimeoutMs: 2_000,
  maxOutputTokens: 128,
};

function request(signal: AbortSignal): HybridProviderRequest {
  return {
    settings,
    messages: [{ role: 'user', content: 'spec' }],
    budget: { maxInputTokens: 1000, maxOutputTokens: 128, chunkOverlapTokens: 0, maxFewShotTokens: 0 },
    signal,
  };
}

const encoder = new TextEncoder();

function frame(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text }, index: 0 }] })}\n\n`;
}

function streamingTransport(frames: string[], options: { stallAfter?: number; never?: boolean } = {}): Transport {
  return {
    async send(): Promise<TransportResponse> {
      if (options.never) {
        return new Promise<TransportResponse>(() => {
          /* headers never arrive */
        });
      }
      let index = 0;
      return {
        status: 200,
        ok: true,
        headers: { get: () => 'text/event-stream' },
        text: async () => '',
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            for (const entry of frames) {
              if (options.stallAfter !== undefined && index === options.stallAfter) break;
              controller.enqueue(encoder.encode(entry));
              index += 1;
            }
          },
        }),
      };
    },
  };
}

describe('policy arithmetic', () => {
  it('bounds a phase timeout by the total request timeout', () => {
    const policy = resolveResourcePolicy({
      requestTimeoutMs: 1_000,
      maxOutputTokens: 100,
      maxInputTokens: 100,
      timeouts: { connectMs: 30_000, ttfbMs: 500, idleChunkMs: null },
    });
    expect(policy.timeouts.totalMs).toBe(1_000);
    expect(policy.timeouts.connectMs).toBe(1_000);
    expect(policy.timeouts.ttfbMs).toBe(500);
    expect(policy.timeouts.idleChunkMs).toBeNull();
  });

  it('derives the character and byte ceilings from the output cap', () => {
    expect(responseCharCapFor(4_096)).toBeGreaterThan(4_096 * 4);
    expect(responseCharCapFor(0)).toBeGreaterThanOrEqual(4_096);
    expect(responseByteCapFor(4_096)).toBeGreaterThan(4_096);
    expect(resolveResourcePolicy({ requestTimeoutMs: 5_000, maxOutputTokens: 100, maxInputTokens: 100 }).limits.maxResponseChars).toBeGreaterThanOrEqual(4096);
    expect(responseCharCapFor(100)).toBeLessThan(responseCharCapFor(4_096));
  });

  it('lets a profile make the ceiling stricter, never wider', () => {
    const profile = createProviderProfile({
      id: 'strict',
      label: 'strict',
      hosts: ['*'],
      capabilities: { response: { maxResponseChars: 512, maxResponseBytes: 1_024 } },
    });
    const policy = policyForProfile(profile, { requestTimeoutMs: 5_000, maxOutputTokens: 4_096, maxInputTokens: 4_096 });
    expect(policy.limits.maxResponseChars).toBe(512);
    expect(policy.limits.maxResponseBytes).toBe(1_024);
  });

  it('counts bytes and refuses to exceed the ceiling', () => {
    const guard = new ResourceGuard(10);
    guard.add(6);
    expect(guard.remaining()).toBe(4);
    expect(() => guard.add(6)).toThrowError(HybridError);
    expect(guard.used()).toBe(12);
  });

  it('names the phase that stalled', async () => {
    await expect(
      withPhaseDeadline(new Promise(() => undefined), 10, 'ttfb', () => undefined),
    ).rejects.toMatchObject({ kind: 'timeout', message: expect.stringContaining(PHASE_LABEL.ttfb) });
  });

  it('resolves the policy of the profile the registry picked', () => {
    const resolution = providerRegistry.resolve({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' });
    expect(resolution.profile.id).toBe('openai');
    const policy = policyForProfile(resolution.profile, { requestTimeoutMs: 120_000, maxOutputTokens: 1_000, maxInputTokens: 1_000 });
    expect(policy.timeouts.connectMs).toBe(15_000);
    expect(policy.timeouts.ttfbMs).toBe(90_000);
    expect(policy.timeouts.idleChunkMs).toBe(45_000);
  });
});

describe('the provider enforces the policy', () => {
  it('stops a stream that stalls between chunks and says it was the stream', async () => {
    const profile = createProviderProfile({
      id: 'short-idle',
      label: 'short',
      hosts: ['*'],
      capabilities: { timeout: { ttfbMs: 1_000, idleChunkMs: 20 } },
    });
    const provider = new OpenAiCompatibleProvider({
      profile,
      transport: streamingTransport([frame('{"a":'), frame('1}')], { stallAfter: 1 }),
    });
    const session = createHybridSession();
    await expect(
      runGatewayRequest({ provider, request: request(session.signal), session, streaming: true }),
    ).rejects.toMatchObject({ kind: 'timeout', message: expect.stringContaining('受信の継続') });
  });

  it('stops a stream that exceeds the byte ceiling', async () => {
    const profile = createProviderProfile({
      id: 'tiny-bytes',
      label: 'tiny',
      hosts: ['*'],
      capabilities: { response: { maxResponseBytes: 64 } },
    });
    const provider = new OpenAiCompatibleProvider({
      profile,
      transport: streamingTransport([frame('x'.repeat(40)), frame('y'.repeat(40)), 'data: [DONE]\n\n']),
    });
    const session = createHybridSession();
    await expect(
      runGatewayRequest({ provider, request: request(session.signal), session, streaming: true }),
    ).rejects.toMatchObject({ kind: 'response-too-long' });
  });

  it('refuses a connection that never answers when the profile bounds it', async () => {
    const profile = createProviderProfile({
      id: 'short-connect',
      label: 'short',
      hosts: ['*'],
      capabilities: { timeout: { connectMs: 20 } },
    });
    const provider = new OpenAiCompatibleProvider({ profile, transport: streamingTransport([], { never: true }) });
    const session = createHybridSession();
    await expect(
      runGatewayRequest({ provider, request: request(session.signal), session, streaming: true }),
    ).rejects.toMatchObject({ kind: 'timeout', message: expect.stringContaining('接続') });
  });

  it('keeps the Phase 5C single-timeout behaviour for a plain gateway', async () => {
    const provider = new OpenAiCompatibleProvider({
      transport: streamingTransport([frame('ok'), 'data: [DONE]\n\n']),
    });
    const session = createHybridSession();
    const outcome = await runGatewayRequest({ provider, request: request(session.signal), session, streaming: true });
    expect(outcome.raw).toBe('ok');
    expect(outcome.terminated).toBe(true);
    expect(outcome.responseBytes).toBeGreaterThan(0);
  });
});
