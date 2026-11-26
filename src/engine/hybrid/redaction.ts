/**
 * WO-06 / C-FIX-006 — redaction.
 *
 * The prompt is redacted after it is built and before it is shown to the user for
 * approval, so the preflight preview and the request body are the same text. Every
 * part is covered: source, local analysis, operator instruction, few-shot examples
 * and the schema.
 *
 * Each rule names what it removes so a replacement is unambiguous in the preview
 * (`[REDACTED_API_KEY]`, `[REDACTED_PRIVATE_KEY]`, …) and countable per kind. A
 * custom pattern that does not compile is an error, not a silent skip: the caller
 * must refuse to send rather than believe it was redacted.
 *
 * The builtin patterns are data (`BUILTIN_REDACTION_PATTERNS`) held in the
 * redaction registry (C-FIX-006), so a deployment can disable one or register an
 * extra pattern at runtime without editing the engine.
 */

import { hybridConfig } from './config';
import {
  createRedactionRegistry,
  type RedactionKind,
  type RedactionPatternInput,
  type RedactionRegistry,
  type RedactionRule,
  type ResolvedPatterns,
} from './redactionRegistry';

export type { RedactionKind, RedactionRule, RedactionRegistry } from './redactionRegistry';

export interface CustomRedactionPattern {
  id: string;
  /** Regular expression source; flags come from `flags`. */
  pattern: string;
  flags?: string;
  label?: string;
}

const REPLACEMENT_FOR: Record<RedactionKind, string> = {
  'api-key': '[REDACTED_API_KEY]',
  'access-token': '[REDACTED_ACCESS_TOKEN]',
  authorization: '[REDACTED_AUTHORIZATION]',
  password: '[REDACTED_PASSWORD]',
  'private-key': '[REDACTED_PRIVATE_KEY]',
  'connection-string': '[REDACTED_CONNECTION_STRING]',
  'credential-url': '[REDACTED_CREDENTIAL_URL]',
  jwt: '[REDACTED_JWT]',
  custom: '[REDACTED_CUSTOM]',
};

/**
 * The Phase 5C pattern set, in the same application order as before, now with a
 * declared priority. A higher priority runs first so a specific pattern (a PEM
 * block) always wins over a general one (a password assignment inside it).
 */
export const BUILTIN_REDACTION_PATTERNS: readonly RedactionPatternInput[] = [
  {
    id: 'private-key',
    kind: 'private-key',
    label: '秘密鍵ブロック',
    priority: 120,
    enabled: true,
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },
  {
    id: 'connection-string',
    kind: 'connection-string',
    label: '接続文字列',
    priority: 110,
    enabled: true,
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|mssql|sqlserver):\/\/[^\s"'<>]+/gi,
    replacement: '[REDACTED_CONNECTION_STRING]',
  },
  {
    id: 'credential-url',
    kind: 'credential-url',
    label: '認証情報つき URL',
    priority: 100,
    enabled: true,
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@<>"']+:[^\s/@<>"']+@[^\s"'<>]+/gi,
    replacement: '[REDACTED_CREDENTIAL_URL]',
  },
  {
    id: 'shared-key',
    kind: 'access-token',
    label: 'SharedAccessKey / AccountKey',
    priority: 90,
    enabled: true,
    pattern: /\b(?:AccountKey|SharedAccessKey|SharedAccessSignature|sig)=[A-Za-z0-9+/=%]{16,}/g,
    replacement: '[REDACTED_ACCESS_TOKEN]',
  },
  {
    id: 'openai-key',
    kind: 'api-key',
    label: 'API キー（sk-/pk-/rk-）',
    priority: 85,
    enabled: true,
    pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
    replacement: '[REDACTED_API_KEY]',
  },
  {
    id: 'aws-key',
    kind: 'api-key',
    label: 'AWS アクセスキー',
    priority: 84,
    enabled: true,
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: '[REDACTED_API_KEY]',
  },
  {
    id: 'github-token',
    kind: 'access-token',
    label: 'GitHub トークン',
    priority: 80,
    enabled: true,
    pattern: /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/g,
    replacement: '[REDACTED_ACCESS_TOKEN]',
  },
  {
    id: 'slack-token',
    kind: 'access-token',
    label: 'Slack トークン',
    priority: 70,
    enabled: true,
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    replacement: '[REDACTED_ACCESS_TOKEN]',
  },
  {
    id: 'google-key',
    kind: 'api-key',
    label: 'Google API キー',
    priority: 60,
    enabled: true,
    pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g,
    replacement: '[REDACTED_API_KEY]',
  },
  {
    id: 'jwt',
    kind: 'jwt',
    label: 'JWT',
    priority: 55,
    enabled: true,
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: '[REDACTED_JWT]',
  },
  {
    id: 'authorization-header',
    kind: 'authorization',
    label: 'Authorization ヘッダ',
    priority: 40,
    enabled: true,
    pattern:
      /\b(authorization|proxy-authorization)\b\s*["']?\s*[:=]\s*["']?(?:bearer|basic|token|digest)?\s*[A-Za-z0-9._~+/=-]{6,}/gi,
    replacement: 'Authorization: [REDACTED_AUTHORIZATION]',
  },
  {
    id: 'bearer-token',
    kind: 'access-token',
    label: 'Bearer トークン',
    priority: 30,
    enabled: true,
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/g,
    replacement: 'Bearer [REDACTED_ACCESS_TOKEN]',
  },
  {
    id: 'password-assignment',
    kind: 'password',
    label: 'パスワード / シークレット代入',
    priority: 10,
    enabled: true,
    pattern:
      /\b(password|passwd|pwd|secret|client[_-]?secret|access[_-]?token|api[_-]?key|apikey|auth[_-]?token)\b\s*["']?\s*[:=]\s*["']?(?!\[REDACTED)[^\s"',;)}\] ]{4,}/gi,
    replacement: '$1=[REDACTED_PASSWORD]',
  },
];

/** App-wide registry, seeded with the builtin patterns. */
export const redactionRegistry: RedactionRegistry = createRedactionRegistry([...BUILTIN_REDACTION_PATTERNS]);

/** The enabled builtin rules, in application order (back-compatible export). */
export const RULES: RedactionRule[] = redactionRegistry.resolved().map((entry) => ({
  id: entry.id,
  kind: entry.kind,
  label: entry.label,
  pattern: entry.pattern,
  replacement: entry.replacement,
}));

export const REDACTION_RULE_LABELS: ReadonlyArray<{ kind: RedactionKind; label: string }> = RULES.map((rule) => ({
  kind: rule.kind,
  label: rule.label,
}));

/** Registers an extra pattern for this tab (C-FIX-006 runtime extension). */
export function registerRedactionPattern(pattern: RedactionPatternInput): { ok: boolean; message: string | null } {
  return redactionRegistry.register({ ...pattern, origin: pattern.origin ?? 'runtime' });
}

export interface CompiledPatterns {
  ok: boolean;
  rules: RedactionRule[];
  errors: Array<{ id: string; message: string }>;
}

/**
 * INT-007 — a custom pattern is executed against every payload, in the tab, on
 * the operator's own text. A pattern that backtracks catastrophically would hang
 * the tab before a request is even made, so dangerous shapes are refused before
 * the expression is compiled.
 */
export function unsafePatternReason(source: string): string | null {
  if (!source.trim()) return 'カスタム伏字パターンが空です。';
  if (source.length > 200) return 'カスタム伏字パターンが長すぎます（200 文字まで）。';
  // Nested quantifiers — (a+)+, (.*)* , (\s+){2,} — are the classic
  // catastrophic-backtracking shape and have no place in a redaction rule.
  if (/\([^)]*[+*][^)]*\)\s*(?:[+*]|\{\d*,\d*\})/.test(source)) {
    return '入れ子の量指定子を含む正規表現は使用できません（伏字処理が停止する恐れがあります）。';
  }
  // Backreferences make the match depend on capture state and are hard to bound.
  if (/\\[1-9]/.test(source)) return '後方参照を含む正規表現は使用できません。';
  // An unanchored unbounded wildcard over the whole payload is a memory hazard.
  if (/^\.\*$/.test(source)) return '全一致のワイルドカードだけのパターンは使用できません。';
  return null;
}

/**
 * A custom pattern that cannot be compiled must block the request: the user asked
 * for that text to be removed, and it would otherwise be sent verbatim.
 */
export function compileCustomPatterns(patterns: CustomRedactionPattern[] = []): CompiledPatterns {
  const rules: RedactionRule[] = [];
  const errors: CompiledPatterns['errors'] = [];
  for (const entry of patterns) {
    if (!entry || typeof entry.pattern !== 'string' || !entry.pattern.trim()) {
      errors.push({ id: entry?.id ?? '(no id)', message: 'カスタム伏字パターンが空です。' });
      continue;
    }
    const unsafe = unsafePatternReason(entry.pattern);
    if (unsafe) {
      errors.push({ id: entry.id, message: unsafe });
      continue;
    }
    try {
      const flags = [...new Set((entry.flags ?? 'g').replace(/[gy]/g, '') + 'g')].join('');
      rules.push({
        id: `custom:${entry.id}`,
        kind: 'custom',
        label: entry.label ?? 'カスタム',
        pattern: new RegExp(entry.pattern, flags),
        replacement: REPLACEMENT_FOR.custom,
      });
    } catch {
      errors.push({ id: entry.id, message: 'カスタム伏字パターンを正規表現として解釈できません。' });
    }
  }
  return { ok: errors.length === 0, rules, errors };
}

export interface RedactionCounts {
  total: number;
  byKind: Partial<Record<RedactionKind, number>>;
}

export interface RedactionResult {
  text: string;
  counts: RedactionCounts;
}

export interface RedactionOptions {
  customPatterns?: CustomRedactionPattern[];
  /** Compiled custom patterns, when the caller already validated them. */
  compiled?: RedactionRule[];
  /** Pattern ids the operator switched off (C-FIX-006). */
  disabled?: string[];
  /** Registry to use instead of the app-wide one (tests, per-request policy). */
  registry?: RedactionRegistry;
  /**
   * INT-007: literal secrets held by this session (the API key in memory). They
   * are removed even when they do not look like a known key format, because the
   * tab knows the exact string it was given.
   */
  secrets?: Array<string | null | undefined>;
}

/**
 * Builds an exact-match rule for a session secret. Short or empty values are
 * ignored (redacting a 3-character string would shred the payload), and the
 * replacement never contains the value.
 */
export function secretRule(secret: string): RedactionRule | null {
  const value = secret.trim();
  if (value.length < 8) return null;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    id: 'runtime:session-secret',
    kind: 'api-key',
    label: 'セッションの認証情報',
    pattern: new RegExp(escaped, 'g'),
    replacement: '[REDACTED_API_KEY]',
  };
}

export interface ResolvedRedaction {
  /** Session secrets, then builtin rules in priority order, then custom rules. */
  rules: RedactionRule[];
  custom: RedactionRule[];
  errors: CompiledPatterns['errors'];
  skipped: ResolvedPatterns['skipped'];
  registryFingerprint: string;
}

export function resolveRedaction(options: RedactionOptions = {}): ResolvedRedaction {
  const registry = options.registry ?? redactionRegistry;
  const builtin = registry.resolve({ disabled: options.disabled });
  const compiledCustom = options.compiled ? { ok: true, rules: options.compiled, errors: [] } : compileCustomPatterns(options.customPatterns ?? []);
  const secrets: RedactionRule[] = [];
  const seen = new Set<string>();
  for (const value of options.secrets ?? []) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    const rule = secretRule(trimmed);
    if (rule) secrets.push(rule);
  }
  return {
    // The session's own secrets run before every generic pattern, so a key that
    // also looks like a password assignment is replaced as one whole value.
    rules: [...secrets, ...builtin.rules, ...compiledCustom.rules],
    custom: compiledCustom.rules,
    // A custom pattern that cannot compile is an error the caller must handle, not
    // a silent skip (Phase 5C rule, kept by C-FIX-006).
    errors: [...builtin.errors, ...compiledCustom.errors],
    skipped: builtin.skipped,
    registryFingerprint: registry.fingerprint(),
  };
}

function emptyCounts(): RedactionCounts {
  return { total: 0, byKind: {} };
}

function addCounts(target: RedactionCounts, source: RedactionCounts): void {
  target.total += source.total;
  for (const [kind, count] of Object.entries(source.byKind) as Array<[RedactionKind, number]>) {
    target.byKind[kind] = (target.byKind[kind] ?? 0) + count;
  }
}

/** Applies an already-resolved rule list to one string. */
function applyRules(text: string, rules: RedactionRule[]): RedactionResult {
  const counts = emptyCounts();
  let output = text;
  for (const rule of rules) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    output = output.replace(pattern, (...args: unknown[]) => {
      counts.total += 1;
      counts.byKind[rule.kind] = (counts.byKind[rule.kind] ?? 0) + 1;
      if (rule.replacement.includes('$1')) {
        // Keep the field name; drop the value.
        const groups = args.slice(1, -2) as string[];
        return rule.replacement.replace('$1', groups[0] ?? 'secret');
      }
      return rule.replacement;
    });
  }

  return { text: output, counts };
}

/** Redacts one string. `counts` is the number of replacements, per kind. */
export function redactText(text: string, options: RedactionOptions = {}): RedactionResult {
  if (!text) return { text: '', counts: emptyCounts() };
  const limit = hybridConfig.read().redaction.maxScanChars;
  // A scan is bounded so a pathological file cannot lock the tab (C-FIX-005/006).
  const scanned = text.length > limit ? text.slice(0, limit) : text;
  return applyRules(scanned, resolveRedaction(options).rules);
}

/** Applies redaction to every message, preserving roles and order. */
export function redactMessages(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  options: RedactionOptions = {},
): { messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>; counts: RedactionCounts } {
  const counts = emptyCounts();
  const resolved = resolveRedaction(options);
  const next = messages.map((message) => {
    const redacted = applyRules(message.content, resolved.rules);
    addCounts(counts, redacted.counts);
    return { role: message.role, content: redacted.text };
  });
  return { messages: next, counts };
}

/** True when a string still looks like it carries a secret (post-check). */
export function containsLikelySecret(text: string, options: RedactionOptions = {}): boolean {
  if (!text) return false;
  const { rules } = resolveRedaction(options);
  return rules.some((rule) => new RegExp(rule.pattern.source, rule.pattern.flags).test(text));
}
