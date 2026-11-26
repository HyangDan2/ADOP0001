/**
 * C-FIX-006 — a redaction registry instead of a frozen array.
 *
 * Phase 5C had one module-level `RULES` array: adding a pattern meant editing the
 * engine, disabling one was impossible, and the order was whatever the array
 * happened to be. A deployment that needs an extra pattern (an internal token
 * prefix, a customer's account id) had no way to register it, so it either
 * patched the source or accepted the leak.
 *
 * This registry keeps the *policy* data:
 *
 * - every pattern has an explicit `priority`, so the order is a declared
 *   property and not an accident of insertion
 * - a pattern can be disabled (or a new one registered) at runtime, per tab
 * - builtin, custom and runtime patterns resolve through one deterministic path
 * - a registry that cannot compile a pattern reports it and the caller refuses
 *   to send, exactly like an invalid custom pattern did before
 *
 * The default registry is seeded with the Phase 5C patterns in the same order and
 * with the same replacements, so the existing redaction behaviour is unchanged.
 */

import { hybridConfig } from './config';

export type RedactionKind =
  | 'api-key'
  | 'access-token'
  | 'authorization'
  | 'password'
  | 'private-key'
  | 'connection-string'
  | 'credential-url'
  | 'jwt'
  | 'custom';

export interface RedactionRule {
  id: string;
  kind: RedactionKind;
  label: string;
  pattern: RegExp;
  /** Keeps the matched key name and replaces only the value. */
  replacement: string;
}

export interface RedactionPattern extends RedactionRule {
  /** Higher runs first. Ties keep registration order. */
  priority: number;
  enabled: boolean;
  origin: 'builtin' | 'custom' | 'runtime';
}

export type RedactionPatternInput = Omit<RedactionPattern, 'origin'> & { origin?: RedactionPattern['origin'] };

export interface RegisteredRedactionPattern extends RedactionPattern {
  /** Position in the resolved order (0 = first applied). */
  order: number;
}

export interface RegisterResult {
  ok: boolean;
  message: string | null;
}

export interface ResolveOptions {
  /** Pattern ids the operator switched off for this request. */
  disabled?: string[];
  /** Patterns registered just for this request (custom user patterns). */
  extra?: RedactionPatternInput[];
  /** Registry to read; defaults to this one. */
  registry?: RedactionRegistry;
}

export interface ResolvedPatterns {
  rules: RedactionRule[];
  /** Patterns that were deliberately skipped (disabled or shadowed). */
  skipped: Array<{ id: string; reason: 'disabled' | 'limit' }>;
  errors: Array<{ id: string; message: string }>;
}

export interface RedactionRegistry {
  register(pattern: RedactionPatternInput): RegisterResult;
  unregister(id: string): boolean;
  enable(id: string, enabled: boolean): boolean;
  list(): RedactionPattern[];
  /** Enabled patterns in application order, highest priority first. */
  resolved(disabled?: string[]): RegisteredRedactionPattern[];
  resolve(options?: ResolveOptions): ResolvedPatterns;
  ids(): string[];
  fingerprint(): string;
}

const FLAGS_ALLOWED = /^[dgimsuy]*$/;

function normalizePattern(pattern: RegExp, id: string): { ok: true; pattern: RegExp } | { ok: false; message: string } {
  if (!(pattern instanceof RegExp)) return { ok: false, message: `${id}: 正規表現ではありません。` };
  const flags = [...new Set(`${pattern.flags.replace(/[gy]/g, '')}g`)].join('');
  if (!FLAGS_ALLOWED.test(flags)) return { ok: false, message: `${id}: 未対応のフラグです。` };
  try {
    return { ok: true, pattern: new RegExp(pattern.source, flags) };
  } catch {
    return { ok: false, message: `${id}: 正規表現として解釈できません。` };
  }
}

export function createRedactionRegistry(seed: RedactionPatternInput[] = []): RedactionRegistry {
  let counter = 0;
  const entries = new Map<string, RegisteredRedactionPattern & { sequence: number }>();

  const sorted = (): Array<RegisteredRedactionPattern & { sequence: number }> =>
    [...entries.values()].sort((left, right) =>
      left.priority === right.priority ? left.sequence - right.sequence : right.priority - left.priority,
    );

  const registry: RedactionRegistry = {
    register(input) {
      const limit = hybridConfig.read().redaction.maxPatterns;
      if (!input?.id || typeof input.id !== 'string') return { ok: false, message: '伏字パターンに ID がありません。' };
      const normalized = normalizePattern(input.pattern, input.id);
      if (!normalized.ok) return { ok: false, message: normalized.message };
      if (!input.replacement) return { ok: false, message: `${input.id}: 置換文字列がありません。` };
      const replacing = entries.has(input.id);
      if (!replacing && entries.size >= limit) {
        return { ok: false, message: `伏字パターンは ${limit} 件までです。` };
      }
      counter += 1;
      const existing = entries.get(input.id);
      entries.set(input.id, {
        id: input.id,
        kind: input.kind,
        label: input.label,
        pattern: normalized.pattern,
        replacement: input.replacement,
        priority: input.priority,
        enabled: input.enabled,
        origin: input.origin ?? existing?.origin ?? 'runtime',
        order: 0,
        sequence: existing?.sequence ?? counter,
      });
      return { ok: true, message: null };
    },
    unregister(id) {
      return entries.delete(id);
    },
    enable(id, enabled) {
      const entry = entries.get(id);
      if (!entry) return false;
      entry.enabled = enabled;
      return true;
    },
    list() {
      return sorted().map(({ sequence: _sequence, ...pattern }) => ({ ...pattern, pattern: pattern.pattern }));
    },
    resolved(disabled = []) {
      const off = new Set(disabled);
      return sorted()
        .filter((entry) => entry.enabled && !off.has(entry.id))
        .map((entry, order) => ({ ...entry, order }));
    },
    resolve(options = {}) {
      const errors: ResolvedPatterns['errors'] = [];
      const skipped: ResolvedPatterns['skipped'] = [];
      const disabled = new Set(options.disabled ?? []);
      const limit = hybridConfig.read().redaction.maxPatterns;
      const resolved = sorted().filter((entry) => {
        if (disabled.has(entry.id)) {
          skipped.push({ id: entry.id, reason: 'disabled' });
          return false;
        }
        if (!entry.enabled) {
          skipped.push({ id: entry.id, reason: 'disabled' });
          return false;
        }
        return true;
      });

      const rules: RedactionRule[] = resolved.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        label: entry.label,
        pattern: entry.pattern,
        replacement: entry.replacement,
      }));

      for (const extra of options.extra ?? []) {
        if (rules.length >= limit) {
          skipped.push({ id: extra.id, reason: 'limit' });
          continue;
        }
        const normalized = normalizePattern(extra.pattern, extra.id);
        if (!normalized.ok) {
          errors.push({ id: extra.id, message: normalized.message });
          continue;
        }
        if (!extra.replacement) {
          errors.push({ id: extra.id, message: `${extra.id}: 置換文字列がありません。` });
          continue;
        }
        rules.push({
          id: `${extra.origin ?? 'custom'}:${extra.id}`,
          kind: extra.kind,
          label: extra.label,
          pattern: normalized.pattern,
          replacement: extra.replacement,
        });
      }

      return { rules, skipped, errors };
    },
    ids: () => sorted().map((entry) => entry.id),
    fingerprint() {
      const material = sorted()
        .map((entry) => `${entry.id}:${entry.priority}:${entry.enabled ? 1 : 0}:${entry.pattern.source}:${entry.replacement}`)
        .join('|');
      let hash = 0xcbf29ce484222325n;
      const prime = 0x100000001b3n;
      const mask = 0xffffffffffffffffn;
      for (let index = 0; index < material.length; index += 1) {
        hash ^= BigInt(material.charCodeAt(index));
        hash = (hash * prime) & mask;
      }
      return hash.toString(16).padStart(16, '0');
    },
  };

  for (const pattern of seed) registry.register({ ...pattern, origin: pattern.origin ?? 'builtin' });
  return registry;
}
