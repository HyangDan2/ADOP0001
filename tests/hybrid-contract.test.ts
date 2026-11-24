import { describe, expect, it, vi } from 'vitest';
import {
  HybridResponseError,
  MockHybridProvider,
  validateHybridSettings,
  validateStructuredOutput,
  withLocalFallback,
  type HybridSettings,
} from '../src/engine/hybrid';

const SETTINGS: HybridSettings = {
  baseUrl: 'https://api.example.invalid/v1',
  model: 'review-model',
  apiKey: 'test-key',
  consent: true,
  promptStrategy: 'few-shot',
};

const BUDGET = {
  maxInputTokens: 4_000,
  maxOutputTokens: 1_000,
  chunkOverlapTokens: 200,
  maxFewShotTokens: 800,
};

describe('hybrid settings gate (ENG-005)', () => {
  it('accepts https with consent and a key', () => {
    expect(validateHybridSettings(SETTINGS)).toEqual({ ok: true });
  });

  it('allows http only for localhost', () => {
    expect(validateHybridSettings({ ...SETTINGS, baseUrl: 'http://localhost:11434/v1' })).toEqual({ ok: true });
    const remote = validateHybridSettings({ ...SETTINGS, baseUrl: 'http://api.example.invalid/v1' });
    expect(remote.ok).toBe(false);
    if (!remote.ok) expect(remote.failure).toBe('invalid-settings');
  });

  it('rejects a missing model, consent or key with distinct failures', () => {
    const cases: [Partial<HybridSettings>, string][] = [
      [{ model: '  ' }, 'invalid-settings'],
      [{ baseUrl: 'not a url' }, 'invalid-settings'],
      [{ consent: false }, 'no-consent'],
      [{ apiKey: null }, 'no-key'],
    ];
    for (const [patch, failure] of cases) {
      const result = validateHybridSettings({ ...SETTINGS, ...patch });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure, failure).toBe(failure);
    }
  });
});

describe('mock provider contract (ENG-005)', () => {
  it('records the request and returns queued text without touching the network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('fetch must not be called in Phase 5B');
    });
    const provider = new MockHybridProvider(['{"answer":"ok"}']);
    const response = await provider.complete({
      settings: SETTINGS,
      messages: [{ role: 'user', content: 'Summarise.' }],
      budget: BUDGET,
    });
    expect(response.text).toBe('{"answer":"ok"}');
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0].settings.consent).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('streams the queued response in order', async () => {
    const provider = new MockHybridProvider(['abcdefghijkl']);
    const chunks: string[] = [];
    const response = await provider.completeStream(
      { settings: SETTINGS, messages: [], budget: BUDGET },
      (chunk) => chunks.push(chunk),
    );
    expect(chunks.join('')).toBe('abcdefghijkl');
    expect(response.text).toBe('abcdefghijkl');
  });

  it('fails loudly when the queue is empty', async () => {
    const provider = new MockHybridProvider([]);
    await expect(provider.complete({ settings: SETTINGS, messages: [], budget: BUDGET })).rejects.toMatchObject({
      failure: 'provider',
    });
  });
});

describe('structured output and local fallback (ENG-005)', () => {
  const guard = (value: unknown): value is { answer: string } =>
    typeof value === 'object' && value !== null && typeof (value as { answer?: unknown }).answer === 'string';

  it('accepts only JSON that matches the guard', () => {
    expect(validateStructuredOutput('{"answer":"ok"}', guard)).toEqual({ answer: 'ok' });
    expect(() => validateStructuredOutput('not json', guard)).toThrow(HybridResponseError);
    expect(() => validateStructuredOutput('{"answer":1}', guard)).toThrow(/expected shape/);
  });

  it('falls back to the local result with the failure reason', async () => {
    const result = await withLocalFallback(
      async () => 'local',
      async () => {
        throw new HybridResponseError('schema', 'bad shape');
      },
    );
    expect(result).toEqual({ value: 'local', fallback: 'schema' });
  });

  it('uses the remote result when it succeeds', async () => {
    const result = await withLocalFallback(async () => 'local', async () => 'remote');
    expect(result).toEqual({ value: 'remote', fallback: null });
  });
});
