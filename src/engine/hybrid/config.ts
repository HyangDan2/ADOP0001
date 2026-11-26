/**
 * C-FIX-008 — one configuration source of truth for the hybrid engine.
 *
 * Before this module the same numbers lived in three places: the provider had
 * its own defaults, the budget had a 5 % safety margin, and the streaming engine
 * had a receive cap. They agreed by coincidence, not by construction, and a
 * reviewer change in one of them could silently contradict another.
 *
 * Now every cross-cutting number, threshold and default is a *descriptor* here:
 *
 * - one key, one default, one validator, one label (the single source of truth)
 * - a typed view (`read()`) that the engine modules consume
 * - validated runtime overrides (`override`, `applyRuntimeOverrides`) so a
 *   deployment can tune a policy without a code change, and an invalid value is
 *   rejected with a readable message instead of breaking a request halfway
 * - a stable fingerprint so a request snapshot and its evidence record can state
 *   which configuration produced them
 *
 * Nothing in this file reads storage or touches the network. A caller that
 * changes nothing gets exactly the Phase 5C numbers, which is why the existing
 * behaviour and tests are preserved.
 */

export type ConfigValue = number | boolean | string;

export interface ConfigDescriptor {
  key: string;
  label: string;
  defaultValue: ConfigValue;
  /** Returns a Japanese message when the candidate is invalid, else null. */
  validate(value: ConfigValue): string | null;
}

function checkBounds(
  value: ConfigValue,
  bounds: { min?: number; max?: number; integer?: boolean },
): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '数値を指定してください。';
  if (bounds.integer && !Number.isInteger(value)) return '整数を指定してください。';
  if (bounds.min !== undefined && value < bounds.min) return `${bounds.min} 以上の値を指定してください。`;
  if (bounds.max !== undefined && value > bounds.max) return `${bounds.max} 以下の値を指定してください。`;
  return null;
}

function numberConfig(
  key: string,
  label: string,
  defaultValue: number,
  bounds: { min?: number; max?: number; integer?: boolean } = {},
): ConfigDescriptor {
  return {
    key,
    label,
    defaultValue,
    validate: (value) => checkBounds(value, bounds),
  };
}

function booleanConfig(key: string, label: string, defaultValue: boolean): ConfigDescriptor {
  return {
    key,
    label,
    defaultValue,
    validate: (value) => (typeof value === 'boolean' ? null : 'true か false を指定してください。'),
  };
}

function stringConfig(
  key: string,
  label: string,
  defaultValue: string,
  allowed?: readonly string[],
): ConfigDescriptor {
  return {
    key,
    label,
    defaultValue,
    validate: (value) => {
      if (typeof value !== 'string' || !value.trim()) return '空でない文字列を指定してください。';
      if (allowed && !allowed.includes(value)) return `${allowed.join(' / ')} のいずれかを指定してください。`;
      return null;
    },
  };
}

/**
 * The complete set. A key added here is immediately available to every consumer
 * through `read()`, so no new magic number needs to be introduced elsewhere.
 */
export const HYBRID_CONFIG_DESCRIPTORS: readonly ConfigDescriptor[] = [
  // Provider client defaults (Phase 5C numbers).
  numberConfig('provider.defaultTemperature', '既定 Temperature', 0.2, { min: 0, max: 2 }),
  numberConfig('provider.defaultTotalTimeoutMs', '既定の全体タイムアウト (ms)', 120_000, {
    min: 1_000,
    max: 600_000,
  }),
  numberConfig('provider.defaultMaxOutputTokens', '既定の出力上限 (tokens)', 4096, {
    min: 16,
    max: 200_000,
    integer: true,
  }),
  // 0 disables a phase timeout; a capability profile may set a real value (C-FIX-005).
  numberConfig('provider.connectTimeoutMs', '接続タイムアウト (ms, 0=無効)', 0, { min: 0, max: 600_000 }),
  numberConfig('provider.ttfbTimeoutMs', '第一トークン待ちタイムアウト (ms, 0=無効)', 0, {
    min: 0,
    max: 600_000,
  }),
  numberConfig('provider.idleChunkTimeoutMs', 'チャンク間タイムアウト (ms, 0=無効)', 0, {
    min: 0,
    max: 600_000,
  }),
  // Retry stays off unless a deployment says otherwise (Phase 5C policy).
  booleanConfig('provider.retryEnabled', '自動リトライを有効にする', false),

  // Streaming protocol limits (C-FIX-004 / C-FIX-005).
  numberConfig('stream.receiveCapSlack', '受信上限の余裕率', 1.5, { min: 1, max: 4 }),
  numberConfig('stream.minReceiveCap', '受信上限の下限 (文字)', 4096, { min: 1024, max: 1_000_000 }),
  numberConfig('stream.defaultReceiveCap', '受信上限の既定値 (文字)', 200_000, { min: 1024, max: 50_000_000 }),
  numberConfig('stream.maxSseLineChars', 'SSE 1 行の上限 (文字)', 1_000_000, {
    min: 1024,
    max: 50_000_000,
  }),
  numberConfig('stream.maxEventDataChars', 'SSE 1 イベントのデータ上限 (文字)', 2_000_000, {
    min: 1024,
    max: 50_000_000,
  }),
  numberConfig('stream.maxDecodedChunkChars', '1 チャンクのデコード上限 (文字)', 2_000_000, {
    min: 1024,
    max: 50_000_000,
  }),

  // Budget arithmetic (C-FIX-002).
  numberConfig('budget.safetyMarginRatio', '安全余白の比率', 0.05, { min: 0, max: 0.5 }),
  numberConfig('budget.safetyMarginMin', '安全余白の下限 (tokens)', 128, { min: 0, max: 100_000 }),
  numberConfig('budget.safetyMarginMax', '安全余白の上限 (tokens)', 2048, { min: 0, max: 200_000 }),
  numberConfig('budget.charsPerToken', '文字数→トークン換算', 4, { min: 0.5, max: 12 }),
  numberConfig('budget.sourceHeadShare', '先頭優先で配分するソース比率', 0.7, { min: 0, max: 1 }),
  numberConfig('budget.minSourceShare', 'ソースに最低限確保する入力比率', 0, { min: 0, max: 0.9 }),

  // Response resource policy (C-FIX-005).
  numberConfig('resource.responseBytesPerToken', '出力 1 token あたりの受信バイト上限', 64, {
    min: 1,
    max: 4096,
  }),
  numberConfig('resource.minResponseBytes', '受信バイト上限の下限', 262_144, { min: 1024, max: 500_000_000 }),
  numberConfig('resource.responseBytesSlack', '受信バイト上限の余裕率', 2, { min: 1, max: 8 }),

  // Lifecycle (C-FIX-003).
  numberConfig('lifecycle.maxActivePerScope', '同一スコープで同時に動かせるリクエスト数', 1, {
    min: 1,
    max: 8,
    integer: true,
  }),
  numberConfig('lifecycle.historyLimit', '終了済みリクエストの履歴数', 32, { min: 1, max: 500, integer: true }),

  // Redaction (C-FIX-006).
  numberConfig('redaction.maxPatterns', '登録できる伏字パターンの上限', 200, {
    min: 1,
    max: 2000,
    integer: true,
  }),
  numberConfig('redaction.maxScanChars', '伏字スキャンの上限文字数', 2_000_000, {
    min: 10_000,
    max: 100_000_000,
  }),

  // Evidence (C-FIX-009).
  numberConfig('evidence.historyLimit', '証跡ログの保持件数', 64, { min: 1, max: 1000, integer: true }),
  stringConfig('evidence.chainAlgorithm', '証跡チェーンの方式', 'sha256-fnv1a64', [
    'sha256-fnv1a64',
    'fnv1a64',
  ]),
];

const DESCRIPTOR_BY_KEY = new Map(HYBRID_CONFIG_DESCRIPTORS.map((descriptor) => [descriptor.key, descriptor]));

/** The typed view the engine modules read. Built from the flat keys above. */
export interface HybridConfigValues {
  provider: {
    defaultTemperature: number;
    defaultTotalTimeoutMs: number;
    defaultMaxOutputTokens: number;
    connectTimeoutMs: number;
    ttfbTimeoutMs: number;
    idleChunkTimeoutMs: number;
    retryEnabled: boolean;
  };
  stream: {
    receiveCapSlack: number;
    minReceiveCap: number;
    defaultReceiveCap: number;
    maxSseLineChars: number;
    maxEventDataChars: number;
    maxDecodedChunkChars: number;
  };
  budget: {
    safetyMarginRatio: number;
    safetyMarginMin: number;
    safetyMarginMax: number;
    charsPerToken: number;
    sourceHeadShare: number;
    minSourceShare: number;
  };
  resource: {
    responseBytesPerToken: number;
    minResponseBytes: number;
    responseBytesSlack: number;
  };
  lifecycle: {
    maxActivePerScope: number;
    historyLimit: number;
  };
  redaction: {
    maxPatterns: number;
    maxScanChars: number;
  };
  evidence: {
    historyLimit: number;
    chainAlgorithm: string;
  };
}

function numberFrom(flat: Record<string, ConfigValue>, key: string): number {
  const value = flat[key];
  if (typeof value !== 'number') {
    const fallback = DESCRIPTOR_BY_KEY.get(key)?.defaultValue;
    return typeof fallback === 'number' ? fallback : 0;
  }
  return value;
}

function stringFrom(flat: Record<string, ConfigValue>, key: string): string {
  const value = flat[key];
  if (typeof value === 'string') return value;
  const fallback = DESCRIPTOR_BY_KEY.get(key)?.defaultValue;
  return typeof fallback === 'string' ? fallback : '';
}

export function toConfigValues(flat: Record<string, ConfigValue>): HybridConfigValues {
  return {
    provider: {
      defaultTemperature: numberFrom(flat, 'provider.defaultTemperature'),
      defaultTotalTimeoutMs: numberFrom(flat, 'provider.defaultTotalTimeoutMs'),
      defaultMaxOutputTokens: numberFrom(flat, 'provider.defaultMaxOutputTokens'),
      connectTimeoutMs: numberFrom(flat, 'provider.connectTimeoutMs'),
      ttfbTimeoutMs: numberFrom(flat, 'provider.ttfbTimeoutMs'),
      idleChunkTimeoutMs: numberFrom(flat, 'provider.idleChunkTimeoutMs'),
      retryEnabled: flat['provider.retryEnabled'] === true,
    },
    stream: {
      receiveCapSlack: numberFrom(flat, 'stream.receiveCapSlack'),
      minReceiveCap: numberFrom(flat, 'stream.minReceiveCap'),
      defaultReceiveCap: numberFrom(flat, 'stream.defaultReceiveCap'),
      maxSseLineChars: numberFrom(flat, 'stream.maxSseLineChars'),
      maxEventDataChars: numberFrom(flat, 'stream.maxEventDataChars'),
      maxDecodedChunkChars: numberFrom(flat, 'stream.maxDecodedChunkChars'),
    },
    budget: {
      safetyMarginRatio: numberFrom(flat, 'budget.safetyMarginRatio'),
      safetyMarginMin: numberFrom(flat, 'budget.safetyMarginMin'),
      safetyMarginMax: numberFrom(flat, 'budget.safetyMarginMax'),
      charsPerToken: numberFrom(flat, 'budget.charsPerToken'),
      sourceHeadShare: numberFrom(flat, 'budget.sourceHeadShare'),
      minSourceShare: numberFrom(flat, 'budget.minSourceShare'),
    },
    resource: {
      responseBytesPerToken: numberFrom(flat, 'resource.responseBytesPerToken'),
      minResponseBytes: numberFrom(flat, 'resource.minResponseBytes'),
      responseBytesSlack: numberFrom(flat, 'resource.responseBytesSlack'),
    },
    lifecycle: {
      maxActivePerScope: numberFrom(flat, 'lifecycle.maxActivePerScope'),
      historyLimit: numberFrom(flat, 'lifecycle.historyLimit'),
    },
    redaction: {
      maxPatterns: numberFrom(flat, 'redaction.maxPatterns'),
      maxScanChars: numberFrom(flat, 'redaction.maxScanChars'),
    },
    evidence: {
      historyLimit: numberFrom(flat, 'evidence.historyLimit'),
      chainAlgorithm: stringFrom(flat, 'evidence.chainAlgorithm'),
    },
  };
}

export function defaultConfigFlat(): Record<string, ConfigValue> {
  const flat: Record<string, ConfigValue> = {};
  for (const descriptor of HYBRID_CONFIG_DESCRIPTORS) flat[descriptor.key] = descriptor.defaultValue;
  return flat;
}

/** Deterministic, dependency-free fingerprint (FNV-1a 64 bit, hex). */
export function fingerprintValues(flat: Record<string, ConfigValue>): string {
  const text = Object.keys(flat)
    .sort()
    .map((key) => `${key}=${String(flat[key])}`)
    .join('\n');
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

export interface ConfigValidation {
  ok: boolean;
  problems: Array<{ key: string; message: string }>;
  accepted: Record<string, ConfigValue>;
}

export interface ConfigOverrideResult {
  ok: boolean;
  message: string | null;
}

export interface HybridConfigStore {
  /** The typed values every module consumes. Frozen: callers cannot edit them. */
  read(): Readonly<HybridConfigValues>;
  /** Flat key → value, including defaults. */
  flat(): Readonly<Record<string, ConfigValue>>;
  keys(): string[];
  descriptor(key: string): ConfigDescriptor | undefined;
  /** Validated runtime override of one key. */
  override(key: string, value: unknown): ConfigOverrideResult;
  /** Validated batch override; nothing is applied when any value is invalid. */
  applyOverrides(candidate: Record<string, unknown>): ConfigValidation;
  /** Reads `ADOP_HYBRID_*` style strings (a build/deploy environment). */
  applyRuntimeOverrides(source: Record<string, string | undefined>): ConfigValidation;
  overrides(): Readonly<Record<string, ConfigValue>>;
  reset(): void;
  /** Stable id of the effective configuration, used by snapshots and evidence. */
  fingerprint(): string;
  subscribe(listener: (values: HybridConfigValues) => void): () => void;
}

function coerceForDescriptor(descriptor: ConfigDescriptor, value: unknown): ConfigValue | null {
  if (typeof value === 'string' && typeof descriptor.defaultValue === 'number') {
    const numeric = Number(value.trim());
    return Number.isFinite(numeric) ? numeric : value;
  }
  if (typeof value === 'string' && typeof descriptor.defaultValue === 'boolean') {
    const lowered = value.trim().toLowerCase();
    if (lowered === 'true' || lowered === '1') return true;
    if (lowered === 'false' || lowered === '0') return false;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value;
  return null;
}

export function createHybridConfigStore(seed: Record<string, unknown> = {}): HybridConfigStore {
  let overrides: Record<string, ConfigValue> = {};
  const listeners = new Set<(values: HybridConfigValues) => void>();
  let cachedValues: HybridConfigValues | null = null;
  let cachedFingerprint: string | null = null;

  const flatNow = (): Record<string, ConfigValue> => ({ ...defaultConfigFlat(), ...overrides });

  const invalidate = () => {
    cachedValues = null;
    cachedFingerprint = null;
  };

  const validateCandidate = (candidate: Record<string, unknown>): ConfigValidation => {
    const problems: Array<{ key: string; message: string }> = [];
    const accepted: Record<string, ConfigValue> = {};
    for (const [key, raw] of Object.entries(candidate)) {
      const descriptor = DESCRIPTOR_BY_KEY.get(key);
      if (!descriptor) {
        problems.push({ key, message: '未知の設定キーです。' });
        continue;
      }
      const value = coerceForDescriptor(descriptor, raw);
      if (value === null) {
        problems.push({ key, message: '対応していない値の型です。' });
        continue;
      }
      const message = descriptor.validate(value);
      if (message) {
        problems.push({ key, message: `${descriptor.label}: ${message}` });
        continue;
      }
      accepted[key] = value;
    }
    return { ok: problems.length === 0, problems, accepted };
  };

  const store: HybridConfigStore = {
    read() {
      if (!cachedValues) cachedValues = Object.freeze(toConfigValues(flatNow()));
      return cachedValues;
    },
    flat() {
      return Object.freeze(flatNow());
    },
    keys: () => descriptorKeys(),
    descriptor: (key) => DESCRIPTOR_BY_KEY.get(key),
    override(key, value) {
      const validation = validateCandidate({ [key]: value });
      if (!validation.ok) return { ok: false, message: validation.problems[0]?.message ?? '設定を適用できません。' };
      overrides = { ...overrides, ...validation.accepted };
      invalidate();
      const values = store.read();
      for (const listener of listeners) listener(values);
      return { ok: true, message: null };
    },
    applyOverrides(candidate) {
      const validation = validateCandidate(candidate);
      if (!validation.ok) return validation;
      overrides = { ...overrides, ...validation.accepted };
      invalidate();
      const values = store.read();
      for (const listener of listeners) listener(values);
      return validation;
    },
    applyRuntimeOverrides(source) {
      const candidate: Record<string, unknown> = {};
      for (const [rawKey, rawValue] of Object.entries(source)) {
        if (rawValue === undefined) continue;
        const key = runtimeKeyFor(rawKey);
        if (!key) continue;
        candidate[key] = rawValue;
      }
      return store.applyOverrides(candidate);
    },
    overrides: () => Object.freeze({ ...overrides }),
    reset() {
      overrides = {};
      invalidate();
      const values = store.read();
      for (const listener of listeners) listener(values);
    },
    fingerprint() {
      if (!cachedFingerprint) cachedFingerprint = fingerprintValues(flatNow());
      return cachedFingerprint;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  if (Object.keys(seed).length) store.applyOverrides(seed);
  return store;
}

function descriptorKeys(): string[] {
  return HYBRID_CONFIG_DESCRIPTORS.map((descriptor) => descriptor.key);
}

/**
 * `ADOP_HYBRID_PROVIDER_DEFAULT_TEMPERATURE` → `provider.defaultTemperature`.
 * A name that does not match a descriptor is ignored (it cannot invent a key).
 */
export function runtimeKeyFor(envName: string): string | null {
  const prefix = 'ADOP_HYBRID_';
  if (!envName.startsWith(prefix)) return null;
  const body = envName.slice(prefix.length).toLowerCase().replace(/_/g, '.');
  if (DESCRIPTOR_BY_KEY.has(body)) return body;
  // `provider.default_temperature` style names collapse to the same key.
  const collapsed = body.replace(/\.(\w)/g, (_, letter: string) => letter.toUpperCase());
  for (const key of DESCRIPTOR_BY_KEY.keys()) {
    if (key.replace(/\./g, '').toLowerCase() === collapsed.replace(/\./g, '').toLowerCase()) return key;
  }
  return null;
}

/** App-wide configuration. Tests that override values must call `reset()`. */
export const hybridConfig: HybridConfigStore = createHybridConfigStore();

/** Convenience for consumers that only need the frozen typed view. */
export function configValues(): Readonly<HybridConfigValues> {
  return hybridConfig.read();
}
