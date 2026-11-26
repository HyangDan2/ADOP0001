/**
 * C-FIX-007 — provider registry and capability profiles.
 *
 * Phase 5C had one provider class and one set of defaults. Every model was
 * treated as if it accepted streaming, reported usage, had the same context
 * window, the same timeout and the same response ceiling. The only per-provider
 * knowledge lived in comments.
 *
 * Here a provider is a *declarative profile*:
 *
 *   { id, label, hosts, models, capabilities }
 *
 * and the registry resolves a profile from the configured Base URL / model id
 * (explicit id > exact host > model prefix > generic fallback). The provider
 * factory then builds the client from the profile's capabilities, so adding a
 * model family — or correcting its context window — is a data change in one
 * table, not an edit scattered through the transport.
 *
 * Everything left unspecified falls back to the Phase 5C behaviour (streaming on,
 * usage reported, unknown context, no phase timeout), so a custom gateway keeps
 * working exactly as before.
 */

import type { ContextProfile } from './contextAllocator';
import { NEUTRAL_BODY_POLICY, type ProviderBodyPolicy } from './requestBody';

export interface ProviderTimeoutPolicy {
  /** Time until response headers arrive. `null` = bounded by the total only. */
  connectMs: number | null;
  /** Time to the first token. `null` = bounded by the total only. */
  ttfbMs: number | null;
  /** Maximum silence between two chunks. `null` = bounded by the total only. */
  idleChunkMs: number | null;
  /** Whole-request ceiling. `null` = the configured request timeout. */
  totalMs: number | null;
}

export interface ProviderResponsePolicy {
  /** Answer characters accepted before the run is stopped. `null` = derived. */
  maxResponseChars: number | null;
  /** Answer bytes accepted before the run is stopped. `null` = derived. */
  maxResponseBytes: number | null;
}

export interface ProviderCapabilities {
  streaming: boolean;
  usageReporting: boolean;
  /** INT-006: how the HTTP body is built for this model family. */
  body: ProviderBodyPolicy;
  /** Real context ceiling; `Number.POSITIVE_INFINITY` when unknown. */
  maxContextTokens: number;
  /** Real output ceiling; `Number.POSITIVE_INFINITY` when unknown. */
  maxOutputTokens: number;
  /** Characters per token this family averages; used by the budget estimate. */
  charsPerToken: number;
  timeout: ProviderTimeoutPolicy;
  response: ProviderResponsePolicy;
  endpoints: { chatCompletions: string };
}

export const NEUTRAL_TIMEOUT: ProviderTimeoutPolicy = {
  connectMs: null,
  ttfbMs: null,
  idleChunkMs: null,
  totalMs: null,
};

export const NEUTRAL_RESPONSE: ProviderResponsePolicy = {
  maxResponseChars: null,
  maxResponseBytes: null,
};

export interface ModelCapabilityOverride {
  /** A model id prefix, e.g. `gpt-4.1`. */
  prefix: string;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  streaming?: boolean;
  charsPerToken?: number;
  /** Partial body policy for this family (parameter spelling, temperature, terminal). */
  body?: Partial<ProviderBodyPolicy>;
}

export interface ProviderProfileInput {
  id: string;
  label: string;
  /** Hostnames this profile owns. `*` matches any host (the fallback profile). */
  hosts: string[];
  models?: ModelCapabilityOverride[];
  capabilities?: Partial<Omit<ProviderCapabilities, 'timeout' | 'response' | 'endpoints' | 'body'>> & {
    timeout?: Partial<ProviderTimeoutPolicy>;
    response?: Partial<ProviderResponsePolicy>;
    endpoints?: Partial<ProviderCapabilities['endpoints']>;
    body?: Partial<ProviderBodyPolicy>;
  };
}

export interface ProviderProfile {
  id: string;
  label: string;
  hosts: string[];
  models: ModelCapabilityOverride[];
  capabilities: ProviderCapabilities;
  /** Applies a model override to the profile's base capabilities. */
  capabilitiesFor(model: string): ProviderCapabilities;
}

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  usageReporting: true,
  body: { ...NEUTRAL_BODY_POLICY },
  maxContextTokens: Number.POSITIVE_INFINITY,
  maxOutputTokens: Number.POSITIVE_INFINITY,
  charsPerToken: 4,
  timeout: { ...NEUTRAL_TIMEOUT },
  response: { ...NEUTRAL_RESPONSE },
  endpoints: { chatCompletions: '/chat/completions' },
};

/** Merges a declarative input into the neutral baseline, once. */
export function createProviderProfile(input: ProviderProfileInput): ProviderProfile {
  const capabilities: ProviderCapabilities = {
    ...DEFAULT_CAPABILITIES,
    ...input.capabilities,
    timeout: { ...NEUTRAL_TIMEOUT, ...(input.capabilities?.timeout ?? {}) },
    response: { ...NEUTRAL_RESPONSE, ...(input.capabilities?.response ?? {}) },
    endpoints: { ...DEFAULT_CAPABILITIES.endpoints, ...(input.capabilities?.endpoints ?? {}) },
    body: { ...NEUTRAL_BODY_POLICY, ...(input.capabilities?.body ?? {}) },
  };
  const models = [...(input.models ?? [])].sort((left, right) => right.prefix.length - left.prefix.length);

  return {
    id: input.id,
    label: input.label,
    hosts: [...input.hosts],
    models,
    capabilities,
    capabilitiesFor(model: string) {
      const matched = models.find((entry) => model.toLowerCase().startsWith(entry.prefix.toLowerCase()));
      if (!matched) return capabilities;
      return {
        ...capabilities,
        maxContextTokens: matched.maxContextTokens ?? capabilities.maxContextTokens,
        maxOutputTokens: matched.maxOutputTokens ?? capabilities.maxOutputTokens,
        streaming: matched.streaming ?? capabilities.streaming,
        charsPerToken: matched.charsPerToken ?? capabilities.charsPerToken,
        body: matched.body ? { ...capabilities.body, ...matched.body } : capabilities.body,
      };
    },
  };
}

/**
 * The profiles this build ships with. They are data: a deployment registers one
 * more through `providerRegistry.register(...)`.
 */
export const BUILTIN_PROVIDER_PROFILES: readonly ProviderProfileInput[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    hosts: ['api.openai.com'],
    models: [
      { prefix: 'gpt-4.1', maxContextTokens: 1_000_000, maxOutputTokens: 32_768 },
      { prefix: 'gpt-4o', maxContextTokens: 128_000, maxOutputTokens: 16_384 },
      {
        prefix: 'o4',
        maxContextTokens: 200_000,
        maxOutputTokens: 100_000,
        body: { outputTokenParameter: 'max_completion_tokens', temperature: false },
      },
      {
        prefix: 'o3',
        maxContextTokens: 200_000,
        maxOutputTokens: 100_000,
        body: { outputTokenParameter: 'max_completion_tokens', temperature: false },
      },
      { prefix: 'gpt-3.5', maxContextTokens: 16_385, maxOutputTokens: 4_096 },
    ],
    capabilities: {
      charsPerToken: 4,
      timeout: { connectMs: 15_000, ttfbMs: 90_000, idleChunkMs: 45_000 },
      response: {},
    },
  },
  {
    id: 'local-gateway',
    label: 'ローカルゲートウェイ',
    hosts: ['localhost', '127.0.0.1', '[::1]', '::1'],
    models: [],
    capabilities: {
      // A local model is fast to fail and often has a small window; the operator's
      // own numbers still win because the allocator takes the smaller value.
      maxContextTokens: Number.POSITIVE_INFINITY,
      timeout: { connectMs: 10_000, ttfbMs: null, idleChunkMs: null },
    },
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI 互換（汎用）',
    hosts: ['*'],
    models: [],
    capabilities: {},
  },
];

export interface ProviderTarget {
  baseUrl: string;
  model: string;
  /** Optional explicit profile id; the registry trusts it when it exists. */
  providerId?: string;
}

export type ProviderResolutionReason = 'explicit' | 'host' | 'model' | 'fallback';

export interface ProviderResolution {
  profile: ProviderProfile;
  reason: ProviderResolutionReason;
  capabilities: ProviderCapabilities;
}

export interface ProviderRegistry {
  register(profile: ProviderProfile | ProviderProfileInput): ProviderProfile;
  get(id: string): ProviderProfile | undefined;
  list(): ProviderProfile[];
  /** Explicit id, then exact host, then model prefix, then the `*` fallback. */
  resolve(target: ProviderTarget): ProviderResolution;
  /** The profile a real model id resolves to inside an already-chosen profile. */
  capabilitiesFor(id: string, model: string): ProviderCapabilities;
}

function hostnameOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

export function createProviderRegistry(profiles: readonly ProviderProfileInput[] = []): ProviderRegistry {
  const entries = new Map<string, ProviderProfile>();
  const registry: ProviderRegistry = {
    register(profile) {
      const normalized = 'capabilities' in profile && 'capabilitiesFor' in profile
        ? (profile as ProviderProfile)
        : createProviderProfile(profile as ProviderProfileInput);
      entries.set(normalized.id, normalized);
      return normalized;
    },
    get: (id) => entries.get(id),
    list: () => [...entries.values()],
    resolve(target) {
      const fallback = [...entries.values()].find((profile) => profile.hosts.includes('*'));
      if (target.providerId) {
        const explicit = entries.get(target.providerId);
        if (explicit) {
          return {
            profile: explicit,
            reason: 'explicit',
            capabilities: explicit.capabilitiesFor(target.model),
          };
        }
      }
      const host = hostnameOf(target.baseUrl);
      if (host) {
        const byHost = [...entries.values()].find((profile) =>
          profile.hosts.some((entry) => entry !== '*' && entry.toLowerCase().replace(/^\[|\]$/g, '') === host),
        );
        if (byHost) {
          return { profile: byHost, reason: 'host', capabilities: byHost.capabilitiesFor(target.model) };
        }
      }
      const byModel = [...entries.values()].find((profile) =>
        profile.models.some((entry) => target.model.toLowerCase().startsWith(entry.prefix.toLowerCase())),
      );
      if (byModel) {
        return { profile: byModel, reason: 'model', capabilities: byModel.capabilitiesFor(target.model) };
      }
      const profile = fallback ?? createProviderProfile({
        id: 'unspecified',
        label: '未指定',
        hosts: ['*'],
      });
      return { profile, reason: 'fallback', capabilities: profile.capabilitiesFor(target.model) };
    },
    capabilitiesFor(id, model) {
      const profile = entries.get(id);
      return (profile ?? createProviderProfile({ id, label: id, hosts: ['*'] })).capabilitiesFor(model);
    },
  };
  for (const profile of profiles) registry.register(profile);
  return registry;
}

/** App-wide registry, seeded with the builtin profiles. */
export const providerRegistry: ProviderRegistry = createProviderRegistry(BUILTIN_PROVIDER_PROFILES);

/**
 * A capability profile as the context allocator consumes it. The user's own
 * numbers still win: the allocator takes `min(setting, profile)`.
 */
export function contextProfileFor(
  profile: ProviderProfile,
  capabilities: ProviderCapabilities,
  settings?: { fewShotShare?: number },
): ContextProfile {
  return {
    id: profile.id,
    label: profile.label,
    maxContextTokens: capabilities.maxContextTokens,
    maxOutputTokens: capabilities.maxOutputTokens,
    charsPerToken: capabilities.charsPerToken,
    // A model with a small window benefits from a guaranteed floor for the file;
    // an unknown window keeps the Phase 5C residual allocation.
    sourceShare: Number.isFinite(capabilities.maxContextTokens) ? (settings?.fewShotShare ?? 0) : undefined,
  };
}
