/**
 * WO-04 — AI connection settings.
 *
 * Two rules shape this module:
 *
 * 1. The API key lives in this tab's memory only. It is never written to
 *    localStorage, IndexedDB, the console or an export. `write()` cannot store
 *    one even by accident: it serialises an explicit field list, not the caller's
 *    object.
 * 2. Everything except the key is a plain, reviewable preference (Base URL, model,
 *    sampling, limits, timeout, streaming, prompt strategy), so a reload does not
 *    lose the connection the user configured.
 *
 * "Test connection" sends one minimal message and nothing else: the function has
 * no parameter for a source file, so no user code can reach it.
 */

import type { PromptStrategy } from '../../adapters/types';
import type { HybridSettings } from './contracts';
import { HybridError } from './errors';
import { OpenAiCompatibleProvider } from './openAiCompatible';
import { resolveEndpoint, validateModelId, type Transport } from './transport';

export const CONNECTION_SETTINGS_KEY = 'adop0001.hybrid.connection';

export interface ConnectionSettings {
  baseUrl: string;
  model: string;
  /** INT-006: an explicit provider profile id; empty means "resolve from host/model". */
  providerId: string;
  /** Sampling temperature, 0–2. Default 0.2 keeps generated code close to the examples. */
  temperature: number;
  /** The model's context window, used by the budget manager. */
  contextLimit: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  /** Cap for the few-shot block; the source gets the remaining input budget. */
  fewShotTokenBudget: number;
  requestTimeoutMs: number;
  streaming: boolean;
  /** INT-006: ask the provider for a JSON response format when the profile supports it. */
  structuredOutput: boolean;
  promptStrategy: PromptStrategy;
}

export const DEFAULT_CONNECTION_SETTINGS: ConnectionSettings = {
  baseUrl: '',
  model: '',
  providerId: '',
  temperature: 0.2,
  contextLimit: 32768,
  maxInputTokens: 16384,
  maxOutputTokens: 4096,
  fewShotTokenBudget: 2048,
  requestTimeoutMs: 120_000,
  streaming: true,
  structuredOutput: false,
  promptStrategy: 'zero-shot',
};

export const SETTING_BOUNDS = {
  temperature: { min: 0, max: 2, step: 0.1 },
  contextLimit: { min: 1024, max: 2_000_000, step: 1024 },
  maxInputTokens: { min: 256, max: 1_000_000, step: 256 },
  maxOutputTokens: { min: 64, max: 128_000, step: 64 },
  fewShotTokenBudget: { min: 0, max: 256_000, step: 256 },
  requestTimeoutMs: { min: 5_000, max: 600_000, step: 1_000 },
} as const;

export type ConnectionField = keyof ConnectionSettings;

/**
 * INT-003 — the identity of the settings a preview was built from. The preview is
 * only valid while this value is unchanged; the send path compares it instead of
 * re-reading whatever the panel happens to hold now.
 */
export function settingsFingerprint(settings: ConnectionSettings): string {
  return [
    settings.baseUrl,
    settings.model,
    settings.providerId ?? '',
    settings.temperature,
    settings.contextLimit,
    settings.maxInputTokens,
    settings.maxOutputTokens,
    settings.fewShotTokenBudget,
    settings.requestTimeoutMs,
    settings.streaming ? '1' : '0',
    settings.structuredOutput ? '1' : '0',
    settings.promptStrategy,
  ].join('|');
}

/** The persisted shape — an explicit list, so a new field is never saved by accident. */
const PERSISTED_FIELDS: ConnectionField[] = [
  'baseUrl',
  'model',
  'providerId',
  'temperature',
  'contextLimit',
  'maxInputTokens',
  'maxOutputTokens',
  'fewShotTokenBudget',
  'requestTimeoutMs',
  'streaming',
  'structuredOutput',
  'promptStrategy',
];

function clampNumber(value: unknown, fallback: number, bounds: { min: number; max: number }): number {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, numeric));
}

/** Coerces anything (a stored record, a form value) into valid settings. */
export function normalizeConnectionSettings(raw: unknown): ConnectionSettings {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<ConnectionField, unknown>>;
  return {
    baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl.trim() : DEFAULT_CONNECTION_SETTINGS.baseUrl,
    model: typeof record.model === 'string' ? record.model.trim() : DEFAULT_CONNECTION_SETTINGS.model,
    providerId:
      typeof record.providerId === 'string' ? record.providerId.trim() : DEFAULT_CONNECTION_SETTINGS.providerId,
    temperature: clampNumber(record.temperature, DEFAULT_CONNECTION_SETTINGS.temperature, SETTING_BOUNDS.temperature),
    contextLimit: clampNumber(record.contextLimit, DEFAULT_CONNECTION_SETTINGS.contextLimit, SETTING_BOUNDS.contextLimit),
    maxInputTokens: clampNumber(record.maxInputTokens, DEFAULT_CONNECTION_SETTINGS.maxInputTokens, SETTING_BOUNDS.maxInputTokens),
    maxOutputTokens: clampNumber(
      record.maxOutputTokens,
      DEFAULT_CONNECTION_SETTINGS.maxOutputTokens,
      SETTING_BOUNDS.maxOutputTokens,
    ),
    fewShotTokenBudget: clampNumber(
      record.fewShotTokenBudget,
      DEFAULT_CONNECTION_SETTINGS.fewShotTokenBudget,
      SETTING_BOUNDS.fewShotTokenBudget,
    ),
    requestTimeoutMs: clampNumber(
      record.requestTimeoutMs,
      DEFAULT_CONNECTION_SETTINGS.requestTimeoutMs,
      SETTING_BOUNDS.requestTimeoutMs,
    ),
    streaming: typeof record.streaming === 'boolean' ? record.streaming : DEFAULT_CONNECTION_SETTINGS.streaming,
    structuredOutput:
      typeof record.structuredOutput === 'boolean' ? record.structuredOutput : DEFAULT_CONNECTION_SETTINGS.structuredOutput,
    promptStrategy: record.promptStrategy === 'few-shot' ? 'few-shot' : 'zero-shot',
  };
}

export interface SettingsValidation {
  ok: boolean;
  fields: Partial<Record<ConnectionField, string>>;
  messages: string[];
}

/**
 * Field-level validation for the panel. The endpoint and model checks reuse the
 * transport policy, so the panel and the provider cannot disagree.
 */
export function validateConnectionSettings(settings: ConnectionSettings): SettingsValidation {
  const fields: Partial<Record<ConnectionField, string>> = {};

  if (!settings.baseUrl.trim()) {
    fields.baseUrl = 'Base URL を入力してください。';
  } else {
    const endpoint = resolveEndpoint(settings.baseUrl);
    if (!endpoint.ok) fields.baseUrl = endpoint.message;
  }

  if (!settings.model.trim()) {
    fields.model = 'モデル ID を入力してください。';
  } else {
    const model = validateModelId(settings.model);
    if (!model.ok) fields.model = model.message;
  }

  if (!Number.isFinite(settings.temperature) || settings.temperature < 0 || settings.temperature > 2) {
    fields.temperature = 'Temperature は 0〜2 で指定してください。';
  }
  if (settings.contextLimit < SETTING_BOUNDS.contextLimit.min) {
    fields.contextLimit = 'コンテキスト上限が小さすぎます。';
  }
  if (settings.maxInputTokens < SETTING_BOUNDS.maxInputTokens.min) {
    fields.maxInputTokens = '入力上限が小さすぎます。';
  }
  if (settings.maxOutputTokens < SETTING_BOUNDS.maxOutputTokens.min) {
    fields.maxOutputTokens = '出力上限が小さすぎます。';
  }
  if (settings.requestTimeoutMs < SETTING_BOUNDS.requestTimeoutMs.min) {
    fields.requestTimeoutMs = 'タイムアウトが短すぎます（5 秒以上）。';
  }
  if (settings.maxInputTokens + settings.maxOutputTokens > settings.contextLimit) {
    fields.maxInputTokens = '入力上限と出力上限の合計がコンテキスト上限を超えています。';
  }
  if (settings.fewShotTokenBudget > settings.maxInputTokens) {
    fields.fewShotTokenBudget = 'Few-shot 予算が入力上限を超えています。';
  }

  const messages = Object.values(fields).filter((message): message is string => Boolean(message));
  return { ok: messages.length === 0, fields, messages };
}

/* ------------------------------------------------------------------ */
/* Persistence (never the key)                                         */
/* ------------------------------------------------------------------ */

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

export interface SettingsWriteResult {
  ok: boolean;
  error: string | null;
}

export interface ConnectionSettingsStore {
  read(): ConnectionSettings;
  /** Persists the non-secret fields. An `apiKey` in the input is ignored by design. */
  write(settings: ConnectionSettings): SettingsWriteResult;
  clear(): void;
}

export function createConnectionSettingsStore(storage: StorageLike | null = defaultStorage()): ConnectionSettingsStore {
  const read = (): ConnectionSettings => {
    if (!storage) return { ...DEFAULT_CONNECTION_SETTINGS };
    try {
      const raw = storage.getItem(CONNECTION_SETTINGS_KEY);
      if (!raw) return { ...DEFAULT_CONNECTION_SETTINGS };
      return normalizeConnectionSettings(JSON.parse(raw));
    } catch {
      return { ...DEFAULT_CONNECTION_SETTINGS };
    }
  };

  return {
    read,
    write(settings) {
      if (!storage) return { ok: false, error: 'このブラウザに接続設定を保存できません（localStorage が使えません）。' };
      try {
        const record: Record<string, unknown> = {};
        for (const field of PERSISTED_FIELDS) record[field] = settings[field];
        storage.setItem(CONNECTION_SETTINGS_KEY, JSON.stringify(record));
        return { ok: true, error: null };
      } catch {
        return { ok: false, error: '接続設定を保存できませんでした（保存領域がいっぱいか、書き込みが拒否されました）。' };
      }
    },
    clear() {
      try {
        storage?.removeItem(CONNECTION_SETTINGS_KEY);
      } catch {
        /* nothing to do */
      }
    },
  };
}

/** App-wide store; a component reads it on open and writes it on save. */
export const connectionSettingsStore = createConnectionSettingsStore();

/* ------------------------------------------------------------------ */
/* API key (this tab's memory only)                                    */
/* ------------------------------------------------------------------ */

export interface ApiKeyHolder {
  get(): string | null;
  set(value: string): void;
  clear(): void;
  present(): boolean;
  /** INT-001: bumped on every set/clear, so a snapshot names the credential revision. */
  revision(): number;
}

/**
 * The key is a module-level string in the running tab. It is not written
 * anywhere, so a reload (or a closed tab) forgets it — which is the point.
 */
export function createMemoryApiKey(initial: string | null = null): ApiKeyHolder {
  let value = initial?.trim() ? initial.trim() : null;
  let revision = 0;
  return {
    get: () => value,
    set: (next: string) => {
      const normalized = next.trim() ? next.trim() : null;
      if (normalized !== value) revision += 1;
      value = normalized;
    },
    clear: () => {
      if (value !== null) revision += 1;
      value = null;
    },
    present: () => Boolean(value),
    revision: () => revision,
  };
}

/** The tab's key holder, shared by the panel and the provider call site. */
export const sessionApiKey: ApiKeyHolder = createMemoryApiKey();

/** Settings + the in-memory key + the user's consent → the provider's request shape. */
export function toHybridSettings(
  settings: ConnectionSettings,
  apiKey: string | null,
  consent: boolean,
): HybridSettings {
  return {
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey,
    consent,
    promptStrategy: settings.promptStrategy,
    temperature: settings.temperature,
    requestTimeoutMs: settings.requestTimeoutMs,
    maxOutputTokens: settings.maxOutputTokens,
    structuredOutput: settings.structuredOutput,
  };
}

/* ------------------------------------------------------------------ */
/* Test connection                                                     */
/* ------------------------------------------------------------------ */

/** The whole message the test sends. It cannot carry user content. */
export const TEST_CONNECTION_MESSAGE = 'Connection test. Reply with the single word: ok';

export interface ConnectionTestResult {
  ok: boolean;
  /** Round-trip time in milliseconds. */
  latencyMs: number;
  /** HTTP status when the provider answered. */
  status?: number;
  kind?: HybridError['kind'];
  message: string;
}

export interface ConnectionTestParams {
  settings: ConnectionSettings;
  apiKey: string | null;
  transport?: Transport;
  now?: () => number;
}

/**
 * Sends one minimal message to the configured endpoint. Explicitly:
 * no source text, no local analysis, no operator instruction and no few-shot
 * examples are included — the only message is the constant above.
 */
export async function testConnection(params: ConnectionTestParams): Promise<ConnectionTestResult> {
  const started = params.now ? params.now() : Date.now();
  const clock = () => (params.now ? params.now() : Date.now());
  const settings = params.settings;
  const provider = new OpenAiCompatibleProvider({
    transport: params.transport,
    defaults: { timeoutMs: Math.min(settings.requestTimeoutMs, 60_000), maxOutputTokens: 16 },
  });

  if (!params.apiKey?.trim()) {
    return {
      ok: false,
      latencyMs: 0,
      kind: 'no-key',
      message: 'API キーが入力されていません。',
    };
  }

  try {
    // The test uses a small answer budget regardless of the configured maximum.
    const result = await provider.complete({
      settings: {
        ...toHybridSettings(settings, params.apiKey, true),
        maxOutputTokens: 16,
        temperature: 0,
      },
      messages: [{ role: 'user', content: TEST_CONNECTION_MESSAGE }],
      budget: { maxInputTokens: 64, maxOutputTokens: 16, chunkOverlapTokens: 0, maxFewShotTokens: 0 },
    });
    const latencyMs = Math.max(0, clock() - started);
    return {
      ok: true,
      latencyMs,
      message: `接続しました（${latencyMs.toLocaleString('ja-JP')} ms、応答 ${result.text.trim().slice(0, 40) || '（空）'}）。`,
    };
  } catch (cause) {
    const latencyMs = Math.max(0, clock() - started);
    const error = cause instanceof HybridError ? cause : new HybridError('provider', '接続を確認できませんでした。');
    return {
      ok: false,
      latencyMs,
      status: error.status,
      kind: error.kind,
      message: error.message,
    };
  }
}
