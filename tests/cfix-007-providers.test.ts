/**
 * C-FIX-007 — provider registry and capability profiles.
 *
 * The cases are the per-model knowledge that used to live in comments: which
 * endpoint, whether streaming is supported, how big the context is, which phase
 * timeout applies, and what happens when the operator points at a gateway nobody
 * described.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_PROVIDER_PROFILES,
  contextProfileFor,
  createProviderProfile,
  createProviderRegistry,
  providerRegistry,
} from '../src/engine/hybrid/providerProfiles';
import { OpenAiCompatibleProvider } from '../src/engine/hybrid/openAiCompatible';
import { runHybridPass } from '../src/engine/hybrid/orchestrator';
import { runEngine } from '../src/engine/core/runner';
import { DEFAULT_CONNECTION_SETTINGS, type ConnectionSettings } from '../src/engine/hybrid/settings';
import { MockHybridProvider, createMockTransport, sseFrames } from '../src/engine/hybrid/mock';
import { ALL_SECTIONS } from '../src/tools/shiori/adapter';
import { clearExamples } from '../src/lib/fewShotStore';

const SOURCE = ['export function pay(amount: number): boolean {', '  return amount > 0;', '}', ''].join('\n');
const settings: ConnectionSettings = {
  ...DEFAULT_CONNECTION_SETTINGS,
  baseUrl: 'https://api.example.invalid/v1',
  model: 'gpt-test',
  streaming: true,
};

describe('registry resolution', () => {
  it('resolves by exact host, then by model prefix, then the generic fallback', () => {
    expect(providerRegistry.resolve({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' })).toMatchObject({
      reason: 'host',
      profile: { id: 'openai' },
    });
    expect(providerRegistry.resolve({ baseUrl: 'https://gateway.corp.internal/v1', model: 'gpt-4o-mini' })).toMatchObject({
      reason: 'model',
    });
    expect(providerRegistry.resolve({ baseUrl: 'https://example.invalid/v1', model: 'local-thing' })).toMatchObject({
      reason: 'fallback',
      profile: { id: 'openai-compatible' },
    });
    expect(providerRegistry.resolve({ baseUrl: 'http://localhost:8080/v1', model: 'llama' })).toMatchObject({
      profile: { id: 'local-gateway' },
    });
  });

  it('honours an explicit profile id over host guessing', () => {
    const resolution = providerRegistry.resolve({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      providerId: 'local-gateway',
    });
    expect(resolution).toMatchObject({ reason: 'explicit', profile: { id: 'local-gateway' } });
  });

  it('applies a model override to the profile base capabilities', () => {
    const openai = providerRegistry.get('openai')!;
    expect(openai.capabilitiesFor('gpt-4o').maxContextTokens).toBe(128_000);
    expect(openai.capabilitiesFor('gpt-4.1-mini').maxContextTokens).toBe(1_000_000);
    expect(openai.capabilitiesFor('gpt-3.5-turbo').maxContextTokens).toBe(16_385);
    expect(openai.capabilitiesFor('unknown-model').maxContextTokens).toBe(Number.POSITIVE_INFINITY);
  });

  it('registers a new profile as data and resolves it', () => {
    const registry = createProviderRegistry([...BUILTIN_PROVIDER_PROFILES]);
    registry.register({
      id: 'gemini-compatible',
      label: 'Gemini 互換',
      hosts: ['generativelanguage.googleapis.com'],
      models: [{ prefix: 'gemini-3', maxContextTokens: 1_000_000, maxOutputTokens: 65_536 }],
      capabilities: { streaming: true, timeout: { idleChunkMs: 30_000 } },
    });
    const resolution = registry.resolve({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3-pro' });
    expect(resolution.profile.id).toBe('gemini-compatible');
    expect(resolution.capabilities.maxContextTokens).toBe(1_000_000);
    expect(resolution.capabilities.timeout.idleChunkMs).toBe(30_000);
  });

  it('derives the allocator profile from the capabilities', () => {
    const profile = providerRegistry.get('openai')!;
    const context = contextProfileFor(profile, profile.capabilitiesFor('gpt-4o'));
    expect(context.maxContextTokens).toBe(128_000);
    expect(context.maxOutputTokens).toBe(16_384);
    expect(context.charsPerToken).toBe(4);
  });

  it('declares a streaming capability the orchestrator respects', async () => {
    await clearExamples();
    const local = await runEngine('shiori', {
      sourceName: 'payment.ts',
      source: SOURCE,
      options: { sections: ALL_SECTIONS, includePrivate: true },
      mode: 'local-static',
    });
    // A provider whose profile says "no streaming" must be called with complete()
    // even when the operator has streaming switched on.
    const provider = new MockHybridProvider([JSON.stringify({ version: 1, summary: 'ok', proposals: [], notes: [] })]);
    const nonStreamingProfile = createProviderProfile({
      id: 'no-stream',
      label: 'no stream',
      hosts: ['*'],
      capabilities: { streaming: false },
    });
    const registry = createProviderRegistry([
      { id: 'no-stream', label: 'no stream', hosts: ['*'], capabilities: { streaming: false } },
    ]);
    void registry;
    const envelope = JSON.stringify({ version: 1, summary: 'ok', proposals: [], notes: [] });
    const transport = createMockTransport([
      { body: JSON.stringify({ choices: [{ message: { content: envelope }, finish_reason: 'stop' }] }) },
    ]);
    const client = new OpenAiCompatibleProvider({ profile: nonStreamingProfile, transport: transport.transport });
    const outcome = await runHybridPass({
      toolId: 'shiori',
      sourceName: 'payment.ts',
      source: SOURCE,
      options: { sections: ALL_SECTIONS, includePrivate: true },
      localResult: local,
      settings,
      apiKey: 'test-key',
      approve: () => true,
      provider: client,
    });
    expect(transport.calls).toHaveLength(1);
    expect(outcome.stage).toBe('completed');
    void provider;
  });

  it('uses the endpoint path a profile declares', async () => {
    const profile = createProviderProfile({
      id: 'custom-path',
      label: 'custom',
      hosts: ['*'],
      capabilities: { endpoints: { chatCompletions: '/v1/chat/completions' } },
    });
    const transport = createMockTransport([{ body: '{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}' }]);
    const client = new OpenAiCompatibleProvider({ profile, transport: transport.transport });
    await client.complete({
      settings: {
        baseUrl: 'https://gateway.example.invalid',
        model: 'm',
        apiKey: 'k'.repeat(12),
        consent: true,
      },
      messages: [{ role: 'user', content: 'hi' }],
      budget: { maxInputTokens: 10, maxOutputTokens: 10, chunkOverlapTokens: 0, maxFewShotTokens: 0 },
    });
    expect(transport.calls[0].url).toBe('https://gateway.example.invalid/v1/chat/completions');
  });

  it('streams through the default profile exactly as before', async () => {
    const transport = createMockTransport([{ stream: sseFrames('{"version":1}', { usage: { prompt_tokens: 1, completion_tokens: 1 } }) }]);
    const client = new OpenAiCompatibleProvider({ transport: transport.transport });
    const chunks: string[] = [];
    const response = await client.completeStream(
      {
        settings: {
          baseUrl: 'https://api.example.invalid/v1',
          model: 'm',
          apiKey: 'k'.repeat(12),
          consent: true,
        },
        messages: [{ role: 'user', content: 'hi' }],
        budget: { maxInputTokens: 10, maxOutputTokens: 10, chunkOverlapTokens: 0, maxFewShotTokens: 0 },
      },
      (chunk) => chunks.push(chunk),
    );
    expect(response.text).toBe('{"version":1}');
    expect(chunks.join('')).toBe('{"version":1}');
    expect(response.streamTerminated).toBe(true);
  });
});

describe('profile defaults', () => {
  beforeEach(async () => {
    await clearExamples();
  });

  it('matches the Phase 5C transport for an undescribed gateway', () => {
    const resolution = providerRegistry.resolve({ baseUrl: settings.baseUrl, model: settings.model });
    expect(resolution.profile.capabilities.streaming).toBe(true);
    expect(resolution.profile.capabilities.maxContextTokens).toBe(Number.POSITIVE_INFINITY);
    expect(resolution.capabilities.timeout.connectMs).toBeNull();
  });
});
