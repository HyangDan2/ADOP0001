/**
 * WO-04 — AI connection settings.
 *
 * Pins the defaults the brief fixes, the field validation, and the two privacy
 * rules: the API key is never persisted anywhere, and "test connection" sends one
 * short message and no user content.
 */
import { describe, expect, it } from 'vitest';
import { createMockTransport } from '../src/engine/hybrid/mock';
import {
  CONNECTION_SETTINGS_KEY,
  DEFAULT_CONNECTION_SETTINGS,
  TEST_CONNECTION_MESSAGE,
  createConnectionSettingsStore,
  createMemoryApiKey,
  normalizeConnectionSettings,
  testConnection,
  toHybridSettings,
  validateConnectionSettings,
  type ConnectionSettings,
  type StorageLike,
} from '../src/engine/hybrid/settings';

function memoryStorage(): StorageLike & { dump(): string } {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    dump: () => [...map.values()].join('\n'),
  };
}

const valid: ConnectionSettings = {
  ...DEFAULT_CONNECTION_SETTINGS,
  baseUrl: 'https://api.example.invalid/v1',
  model: 'gpt-test',
};

describe('defaults match the Phase 5C specification', () => {
  it('uses the documented starting values', () => {
    expect(DEFAULT_CONNECTION_SETTINGS).toMatchObject({
      temperature: 0.2,
      contextLimit: 32768,
      maxInputTokens: 16384,
      maxOutputTokens: 4096,
      fewShotTokenBudget: 2048,
      requestTimeoutMs: 120_000,
      streaming: true,
      promptStrategy: 'zero-shot',
    });
  });
});

describe('normalizeConnectionSettings', () => {
  it('clamps numbers into their bounds and fills the rest from the defaults', () => {
    const normalized = normalizeConnectionSettings({
      baseUrl: ' https://api.example.invalid/v1 ',
      model: 'gpt-test',
      temperature: 9,
      maxOutputTokens: 1,
      streaming: 'yes',
      promptStrategy: 'wild',
      unknownField: 'ignored',
    });
    expect(normalized.baseUrl).toBe('https://api.example.invalid/v1');
    expect(normalized.temperature).toBe(2);
    expect(normalized.maxOutputTokens).toBe(64);
    expect(normalized.streaming).toBe(true);
    expect(normalized.promptStrategy).toBe('zero-shot');
    expect(Object.keys(normalized)).not.toContain('unknownField');
  });

  it('survives a non-object record', () => {
    expect(normalizeConnectionSettings(null)).toEqual(DEFAULT_CONNECTION_SETTINGS);
    expect(normalizeConnectionSettings('nope')).toEqual(DEFAULT_CONNECTION_SETTINGS);
  });
});

describe('validateConnectionSettings', () => {
  it('accepts a complete configuration', () => {
    expect(validateConnectionSettings(valid)).toEqual({ ok: true, fields: {}, messages: [] });
  });

  it('rejects a non-https endpoint and an empty model', () => {
    const invalid = { ...valid, baseUrl: 'http://api.example.invalid/v1', model: '' };
    const result = validateConnectionSettings(invalid);
    expect(result.ok).toBe(false);
    expect(result.fields.baseUrl).toContain('https');
    expect(result.fields.model).toContain('モデル');
  });

  it('rejects an input + output budget larger than the context window', () => {
    const result = validateConnectionSettings({ ...valid, contextLimit: 8192, maxInputTokens: 16384, maxOutputTokens: 4096 });
    expect(result.fields.maxInputTokens).toContain('コンテキスト上限');
  });

  it('rejects a few-shot budget larger than the input budget', () => {
    const result = validateConnectionSettings({ ...valid, fewShotTokenBudget: 32768 });
    expect(result.fields.fewShotTokenBudget).toContain('入力上限');
  });

  it('rejects a timeout shorter than five seconds', () => {
    const result = validateConnectionSettings({ ...valid, requestTimeoutMs: 1000 });
    expect(result.fields.requestTimeoutMs).toContain('タイムアウト');
  });
});

describe('settings store never keeps the API key', () => {
  it('round-trips the connection without a key', () => {
    const storage = memoryStorage();
    const store = createConnectionSettingsStore(storage);
    expect(store.read()).toEqual(DEFAULT_CONNECTION_SETTINGS);

    const written = store.write({ ...valid, temperature: 0.7 });
    expect(written.ok).toBe(true);
    expect(store.read()).toMatchObject({ baseUrl: valid.baseUrl, model: 'gpt-test', temperature: 0.7 });
  });

  it('drops an apiKey that a caller tries to save with the settings', () => {
    const storage = memoryStorage();
    const store = createConnectionSettingsStore(storage);
    store.write({ ...valid, apiKey: 'sk-should-never-be-stored' } as unknown as ConnectionSettings);
    expect(storage.dump()).not.toContain('sk-should-never-be-stored');
    expect(storage.dump()).not.toContain('apiKey');
    expect(storage.getItem(CONNECTION_SETTINGS_KEY)).not.toContain('key');
  });

  it('reports a storage that refuses the write', () => {
    const store = createConnectionSettingsStore({
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => undefined,
    });
    expect(store.write(valid)).toMatchObject({ ok: false });
  });

  it('reads defaults when the stored record is corrupt', () => {
    const storage = memoryStorage();
    storage.setItem(CONNECTION_SETTINGS_KEY, '{not json');
    expect(createConnectionSettingsStore(storage).read()).toEqual(DEFAULT_CONNECTION_SETTINGS);
  });
});

describe('the API key lives in memory only', () => {
  it('holds, replaces and clears a key', () => {
    const holder = createMemoryApiKey();
    expect(holder.present()).toBe(false);
    holder.set('  sk-abc  ');
    expect(holder.get()).toBe('sk-abc');
    expect(holder.present()).toBe(true);
    holder.set('   ');
    expect(holder.get()).toBeNull();
    holder.set('sk-xyz');
    holder.clear();
    expect(holder.present()).toBe(false);
  });

  it('builds the provider request without persisting anything', () => {
    const settings = toHybridSettings(valid, 'sk-temp', true);
    expect(settings).toMatchObject({
      baseUrl: valid.baseUrl,
      model: 'gpt-test',
      apiKey: 'sk-temp',
      consent: true,
      temperature: 0.2,
      requestTimeoutMs: 120_000,
      maxOutputTokens: 4096,
    });
  });
});

describe('testConnection', () => {
  it('sends one minimal message and reports state and latency', async () => {
    const { transport, calls } = createMockTransport([
      {
        body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }),
      },
    ]);
    let clock = 1_000;
    const result = await testConnection({ settings: valid, apiKey: 'sk-temp', transport, now: () => (clock += 250) });

    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThan(0);
    expect(result.message).toContain('接続しました');

    const body = JSON.parse(calls[0].body);
    expect(body.messages).toEqual([{ role: 'user', content: TEST_CONNECTION_MESSAGE }]);
    expect(body.max_tokens).toBe(16);
    expect(body.temperature).toBe(0);
    // No user source, local analysis, instruction or few-shot content can be here.
    expect(calls[0].body).not.toContain('source');
    expect(calls[0].body).not.toContain('few');
    expect(calls[0].body).not.toContain('sk-temp');
  });

  it('reports a refused key with its status', async () => {
    const { transport } = createMockTransport([{ status: 401, body: '{"error":{"message":"bad key"}}' }]);
    const result = await testConnection({ settings: valid, apiKey: 'sk-temp', transport });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.kind).toBe('auth');
    expect(result.message).toContain('401');
  });

  it('does not call the provider without a key', async () => {
    const { transport, calls } = createMockTransport([]);
    const result = await testConnection({ settings: valid, apiKey: null, transport });
    expect(result).toMatchObject({ ok: false, kind: 'no-key' });
    expect(calls).toHaveLength(0);
  });

  it('reports an invalid endpoint before sending anything', async () => {
    const { transport, calls } = createMockTransport([]);
    const result = await testConnection({
      settings: { ...valid, baseUrl: 'http://api.example.invalid/v1' },
      apiKey: 'sk-temp',
      transport,
    });
    expect(result).toMatchObject({ ok: false, kind: 'invalid-settings' });
    expect(calls).toHaveLength(0);
  });
});
