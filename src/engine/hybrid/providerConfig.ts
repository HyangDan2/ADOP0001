/**
 * INT-006 — a capability profile is data, not code.
 *
 * The built-in profiles are the starting point a deployment may change: a gateway
 * with a different path, a model family whose output parameter is spelled
 * `max_completion_tokens`, a local model with a small window. None of that should
 * need a source edit, so a profile can be registered from the settings panel and
 * is applied on the next start.
 *
 * What is validated here is what the engine relies on: a stable id, a label, at
 * least one host pattern, and values inside the same bounds the built-in profiles
 * obey. A malformed profile is refused whole — a half-applied capability table is
 * worse than no profile at all.
 */
import { hybridConfig } from './config';
import { storageKey } from '../../lib/channel';
import {
  providerRegistry,
  type ModelCapabilityOverride,
  type ProviderProfileInput,
} from './providerProfiles';

export const CUSTOM_PROFILES_KEY = storageKey('adop0001.hybrid.providers.v1');

export interface CustomProfileValidation {
  ok: boolean;
  profiles: ProviderProfileInput[];
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return undefined;
  return value;
}

/** Validates one profile object; unknown keys are ignored, invalid values dropped. */
export function validateProfile(value: unknown, index: number): { profile: ProviderProfileInput | null; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(value)) return { profile: null, errors: [`profiles[${index}] がオブジェクトではありません。`] };
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const label = typeof value.label === 'string' ? value.label.trim() : '';
  const hosts = Array.isArray(value.hosts)
    ? value.hosts
        .filter((host): host is string => typeof host === 'string')
        .map((host) => host.trim())
        .filter(Boolean)
    : [];
  if (!id || !/^[a-z0-9][a-z0-9._-]{1,60}$/i.test(id)) errors.push(`profiles[${index}].id が正しくありません（英数字・-_. で 2〜60 文字）。`);
  if (!label) errors.push(`profiles[${index}].label がありません。`);
  if (!hosts.length) errors.push(`profiles[${index}].hosts が空です。`);
  if (hosts.some((host) => host.length > 200)) errors.push(`profiles[${index}].hosts に長すぎる値があります。`);

  const models: ModelCapabilityOverride[] = [];
  if (Array.isArray(value.models)) {
    for (const entry of value.models) {
      if (!isRecord(entry) || typeof entry.prefix !== 'string' || !entry.prefix.trim()) continue;
      const override: ModelCapabilityOverride = { prefix: entry.prefix.trim() };
      const context = boundNumber(entry.maxContextTokens, 1_024, 10_000_000);
      const output = boundNumber(entry.maxOutputTokens, 16, 2_000_000);
      const chars = boundNumber(entry.charsPerToken, 0.5, 12);
      if (context !== undefined) override.maxContextTokens = context;
      if (output !== undefined) override.maxOutputTokens = output;
      if (chars !== undefined) override.charsPerToken = chars;
      if (typeof entry.streaming === 'boolean') override.streaming = entry.streaming;
      if (isRecord(entry.body)) {
        const body: NonNullable<ModelCapabilityOverride['body']> = {};
        if (entry.body.outputTokenParameter === 'max_tokens' || entry.body.outputTokenParameter === 'max_completion_tokens') {
          body.outputTokenParameter = entry.body.outputTokenParameter;
        }
        if (typeof entry.body.temperature === 'boolean') body.temperature = entry.body.temperature;
        if (typeof entry.body.streamingUsage === 'boolean') body.streamingUsage = entry.body.streamingUsage;
        if (typeof entry.body.structuredOutput === 'boolean') body.structuredOutput = entry.body.structuredOutput;
        if (entry.body.terminalPolicy === 'done' || entry.body.terminalPolicy === 'finish' || entry.body.terminalPolicy === 'finish-or-done') {
          body.terminalPolicy = entry.body.terminalPolicy;
        }
        if (Object.keys(body).length) override.body = body;
      }
      models.push(override);
    }
  }

  const capabilities: ProviderProfileInput['capabilities'] = {};
  if (isRecord(value.capabilities)) {
    const raw = value.capabilities;
    if (typeof raw.streaming === 'boolean') capabilities.streaming = raw.streaming;
    if (typeof raw.usageReporting === 'boolean') capabilities.usageReporting = raw.usageReporting;
    const context = boundNumber(raw.maxContextTokens, 1_024, 10_000_000);
    const output = boundNumber(raw.maxOutputTokens, 16, 2_000_000);
    const chars = boundNumber(raw.charsPerToken, 0.5, 12);
    if (context !== undefined) capabilities.maxContextTokens = context;
    if (output !== undefined) capabilities.maxOutputTokens = output;
    if (chars !== undefined) capabilities.charsPerToken = chars;
    if (isRecord(raw.timeout)) {
      capabilities.timeout = {
        connectMs: raw.timeout.connectMs === null ? null : boundNumber(raw.timeout.connectMs, 1, 600_000) ?? null,
        ttfbMs: raw.timeout.ttfbMs === null ? null : boundNumber(raw.timeout.ttfbMs, 1, 600_000) ?? null,
        idleChunkMs: raw.timeout.idleChunkMs === null ? null : boundNumber(raw.timeout.idleChunkMs, 1, 600_000) ?? null,
        totalMs: raw.timeout.totalMs === null ? null : boundNumber(raw.timeout.totalMs, 1, 600_000) ?? null,
      };
    }
    if (isRecord(raw.endpoints) && typeof raw.endpoints.chatCompletions === 'string') {
      const path = raw.endpoints.chatCompletions.trim();
      if (path.startsWith('/') && !path.includes('?') && !path.includes('#')) {
        capabilities.endpoints = { chatCompletions: path };
      } else {
        errors.push(`profiles[${index}].capabilities.endpoints.chatCompletions は / で始まるパスで指定してください。`);
      }
    }
    if (isRecord(raw.body)) {
      const body: NonNullable<NonNullable<ProviderProfileInput['capabilities']>['body']> = {};
      if (raw.body.outputTokenParameter === 'max_tokens' || raw.body.outputTokenParameter === 'max_completion_tokens') {
        body.outputTokenParameter = raw.body.outputTokenParameter;
      }
      if (typeof raw.body.temperature === 'boolean') body.temperature = raw.body.temperature;
      if (typeof raw.body.streamingUsage === 'boolean') body.streamingUsage = raw.body.streamingUsage;
      if (typeof raw.body.structuredOutput === 'boolean') body.structuredOutput = raw.body.structuredOutput;
      if (raw.body.terminalPolicy === 'done' || raw.body.terminalPolicy === 'finish' || raw.body.terminalPolicy === 'finish-or-done') {
        body.terminalPolicy = raw.body.terminalPolicy;
      }
      capabilities.body = body;
    }
  }

  if (errors.length) return { profile: null, errors };
  return { profile: { id, label, hosts, models, capabilities }, errors: [] };
}

export function validateProfiles(value: unknown): CustomProfileValidation {
  const limit = 20;
  const list = Array.isArray(value) ? value : [];
  if (list.length > limit) return { ok: false, profiles: [], errors: [`カスタムプロファイルは ${limit} 件までです。`] };
  const profiles: ProviderProfileInput[] = [];
  const errors: string[] = [];
  const ids = new Set<string>();
  list.forEach((entry, index) => {
    const result = validateProfile(entry, index);
    errors.push(...result.errors);
    if (!result.profile) return;
    if (ids.has(result.profile.id)) {
      errors.push(`profiles[${index}].id「${result.profile.id}」が重複しています。`);
      return;
    }
    ids.add(result.profile.id);
    profiles.push(result.profile);
  });
  return { ok: errors.length === 0, profiles, errors };
}

export interface ProfileStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): ProfileStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function readStoredProfiles(storage: ProfileStorage | null = defaultStorage()): ProviderProfileInput[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(CUSTOM_PROFILES_KEY);
    if (!raw) return [];
    return validateProfiles(JSON.parse(raw)).profiles;
  } catch {
    return [];
  }
}

export function writeStoredProfiles(
  profiles: ProviderProfileInput[],
  storage: ProfileStorage | null = defaultStorage(),
): { ok: boolean; error: string | null } {
  const validation = validateProfiles(profiles);
  if (!validation.ok) return { ok: false, error: validation.errors[0] ?? 'プロファイルを保存できません。' };
  if (!storage) return { ok: false, error: 'このブラウザにプロファイルを保存できません。' };
  try {
    storage.setItem(CUSTOM_PROFILES_KEY, JSON.stringify(validation.profiles));
    return { ok: true, error: null };
  } catch {
    return { ok: false, error: 'プロファイルを保存できませんでした。' };
  }
}

/** Registers the stored profiles into the app-wide registry (called at start). */
export function registerStoredProfiles(storage: ProfileStorage | null = defaultStorage()): ProviderProfileInput[] {
  const profiles = readStoredProfiles(storage);
  for (const profile of profiles) providerRegistry.register(profile);
  return profiles;
}

/** Limits a profile may not exceed; the same bounds the built-ins obey. */
export const PROFILE_BOUNDS = {
  maxContextTokens: { min: 1_024, max: hybridConfig.read().budget.charsPerToken > 0 ? 10_000_000 : 10_000_000 },
  maxOutputTokens: { min: 16, max: 2_000_000 },
} as const;

/** Pretty JSON for the settings panel. */
export function profilesToJson(profiles: ProviderProfileInput[]): string {
  return JSON.stringify(profiles, null, 2);
}
