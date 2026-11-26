/**
 * INT-006 — the body comes from capabilities.
 *
 * A model family that spells its answer allowance `max_completion_tokens` and
 * refuses `temperature` must be described as data, and the provider must build the
 * body from that description — there is no model-name branch anywhere.
 */
import { describe, expect, it } from 'vitest';
import { OpenAiCompatibleProvider } from '../src/engine/hybrid/openAiCompatible';
import { createProviderProfile, providerRegistry } from '../src/engine/hybrid/providerProfiles';
import { createMockTransport } from '../src/engine/hybrid/mock';
import { validateProfiles } from '../src/engine/hybrid/providerConfig';

const settings = {
  baseUrl: 'https://api.example.invalid/v1',
  model: 'gpt-test',
  apiKey: 'test-key-0123456789',
  consent: true,
  requestTimeoutMs: 5_000,
  maxOutputTokens: 256,
  temperature: 0.7,
};

const reply = {
  body: JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
};

describe('INT-006 — capability-driven provider execution', () => {
  it('builds the body from the profile: parameter name and temperature support', async () => {
    const profile = createProviderProfile({
      id: 'int-reasoning',
      label: 'reasoning',
      hosts: ['reasoning.example'],
      capabilities: {
        body: { outputTokenParameter: 'max_completion_tokens', temperature: false, streamingUsage: false },
      },
    });
    const transport = createMockTransport([reply]);
    const client = new OpenAiCompatibleProvider({ profile, transport: transport.transport });
    await client.complete({
      settings: { ...settings, baseUrl: 'https://reasoning.example/v1', consent: true },
      messages: [{ role: 'user', content: 'hi' }],
      budget: { maxInputTokens: 10, maxOutputTokens: 10, chunkOverlapTokens: 0, maxFewShotTokens: 0 },
    });
    const body = JSON.parse(transport.calls[0].body);
    expect(body.max_completion_tokens).toBe(256);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('temperature');
    expect(body.stream).toBe(false);
  });

  it('applies a model override inside a profile without a code change', async () => {
    const profile = createProviderProfile({
      id: 'int-family',
      label: 'family',
      hosts: ['family.example'],
      models: [{ prefix: 'o9', body: { outputTokenParameter: 'max_completion_tokens', temperature: false } }],
    });
    const transport = createMockTransport([reply]);
    const client = new OpenAiCompatibleProvider({ profile, transport: transport.transport });
    await client.complete({
      settings: { ...settings, baseUrl: 'https://family.example/v1', model: 'o9-mini', consent: true },
      messages: [{ role: 'user', content: 'hi' }],
      budget: { maxInputTokens: 10, maxOutputTokens: 10, chunkOverlapTokens: 0, maxFewShotTokens: 0 },
    });
    const body = JSON.parse(transport.calls[0].body);
    expect(body.max_completion_tokens).toBe(256);
    expect(body).not.toHaveProperty('temperature');
  });

  it('accepts a deployment profile as data and rejects a malformed one', () => {
    const good = validateProfiles([
      {
        id: 'my-gateway',
        label: '社内GW',
        hosts: ['gw.example.com'],
        capabilities: { endpoints: { chatCompletions: '/v1/chat' }, body: { terminalPolicy: 'done' } },
      },
    ]);
    expect(good.ok).toBe(true);
    expect(good.profiles[0].capabilities?.endpoints?.chatCompletions).toBe('/v1/chat');
    providerRegistry.register(good.profiles[0]);
    expect(providerRegistry.get('my-gateway')?.capabilities.body.terminalPolicy).toBe('done');

    expect(validateProfiles([{ id: '', label: '', hosts: [] }]).ok).toBe(false);
    expect(validateProfiles([{ id: 'bad', label: 'x', hosts: ['*'], capabilities: { endpoints: { chatCompletions: 'http://x' } } }]).ok).toBe(false);
  });

  it('asks for structured output only when the capability allows it', async () => {
    const profile = createProviderProfile({
      id: 'int-json',
      label: 'json',
      hosts: ['json.example'],
      capabilities: { body: { structuredOutput: true } },
    });
    const plain = createProviderProfile({
      id: 'int-no-json',
      label: 'no json',
      hosts: ['nojson.example'],
      capabilities: { body: { structuredOutput: false } },
    });
    const transport = createMockTransport([reply, reply]);
    const withJson = new OpenAiCompatibleProvider({ profile, transport: transport.transport });
    await withJson.complete({
      settings: { ...settings, baseUrl: 'https://json.example/v1', consent: true, structuredOutput: true },
      messages: [{ role: 'user', content: 'hi' }],
      budget: { maxInputTokens: 10, maxOutputTokens: 10, chunkOverlapTokens: 0, maxFewShotTokens: 0 },
    });
    expect(JSON.parse(transport.calls[0].body).response_format).toEqual({ type: 'json_object' });

    const withoutJson = new OpenAiCompatibleProvider({ profile: plain, transport: transport.transport });
    await withoutJson.complete({
      settings: { ...settings, baseUrl: 'https://nojson.example/v1', consent: true, structuredOutput: true },
      messages: [{ role: 'user', content: 'hi' }],
      budget: { maxInputTokens: 10, maxOutputTokens: 10, chunkOverlapTokens: 0, maxFewShotTokens: 0 },
    });
    expect(JSON.parse(transport.calls[1].body)).not.toHaveProperty('response_format');
  });

  it('forces the central response ceiling even when a profile asks for more', async () => {
    const profile = createProviderProfile({
      id: 'int-greedy',
      label: 'greedy',
      hosts: ['greedy.example'],
      capabilities: { maxOutputTokens: 999_999, response: { maxResponseBytes: 900_000_000 } },
    });
    const transport = createMockTransport([reply]);
    const client = new OpenAiCompatibleProvider({ profile, transport: transport.transport });
    await client.complete({
      settings: { ...settings, baseUrl: 'https://greedy.example/v1', consent: true, maxOutputTokens: 64 },
      messages: [{ role: 'user', content: 'hi' }],
      budget: { maxInputTokens: 10, maxOutputTokens: 10, chunkOverlapTokens: 0, maxFewShotTokens: 0 },
    });
    const body = JSON.parse(transport.calls[0].body);
    // The user's 64 and the derived byte ceiling win over the profile's 900 MB.
    expect(body.max_tokens).toBe(64);
    expect(client.lastPolicy!.limits.maxResponseBytes).toBeLessThan(900_000_000);
  });
});
