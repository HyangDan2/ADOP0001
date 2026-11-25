/**
 * WO-06 — redaction.
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
 */

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

const RULES: RedactionRule[] = [
  {
    id: 'private-key',
    kind: 'private-key',
    label: '秘密鍵ブロック',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },
  {
    id: 'connection-string',
    kind: 'connection-string',
    label: '接続文字列',
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|mssql|sqlserver):\/\/[^\s"'<>]+/gi,
    replacement: '[REDACTED_CONNECTION_STRING]',
  },
  {
    id: 'credential-url',
    kind: 'credential-url',
    label: '認証情報つき URL',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@<>"']+:[^\s/@<>"']+@[^\s"'<>]+/gi,
    replacement: '[REDACTED_CREDENTIAL_URL]',
  },
  {
    id: 'shared-key',
    kind: 'access-token',
    label: 'SharedAccessKey / AccountKey',
    pattern: /\b(?:AccountKey|SharedAccessKey|SharedAccessSignature|sig)=[A-Za-z0-9+/=%]{16,}/g,
    replacement: '[REDACTED_ACCESS_TOKEN]',
  },
  {
    id: 'openai-key',
    kind: 'api-key',
    label: 'API キー（sk-/pk-/rk-）',
    pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
    replacement: '[REDACTED_API_KEY]',
  },
  {
    id: 'aws-key',
    kind: 'api-key',
    label: 'AWS アクセスキー',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: '[REDACTED_API_KEY]',
  },
  {
    id: 'github-token',
    kind: 'access-token',
    label: 'GitHub トークン',
    pattern: /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/g,
    replacement: '[REDACTED_ACCESS_TOKEN]',
  },
  {
    id: 'slack-token',
    kind: 'access-token',
    label: 'Slack トークン',
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    replacement: '[REDACTED_ACCESS_TOKEN]',
  },
  {
    id: 'google-key',
    kind: 'api-key',
    label: 'Google API キー',
    pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g,
    replacement: '[REDACTED_API_KEY]',
  },
  {
    id: 'jwt',
    kind: 'jwt',
    label: 'JWT',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: '[REDACTED_JWT]',
  },
  {
    id: 'authorization-header',
    kind: 'authorization',
    label: 'Authorization ヘッダ',
    pattern: /\b(authorization|proxy-authorization)\b\s*["']?\s*[:=]\s*["']?(?:bearer|basic|token|digest)?\s*[A-Za-z0-9._~+/=-]{6,}/gi,
    replacement: 'Authorization: [REDACTED_AUTHORIZATION]',
  },
  {
    id: 'bearer-token',
    kind: 'access-token',
    label: 'Bearer トークン',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/g,
    replacement: 'Bearer [REDACTED_ACCESS_TOKEN]',
  },
  {
    id: 'password-assignment',
    kind: 'password',
    label: 'パスワード / シークレット代入',
    pattern:
      /\b(password|passwd|pwd|secret|client[_-]?secret|access[_-]?token|api[_-]?key|apikey|auth[_-]?token)\b\s*["']?\s*[:=]\s*["']?(?!\[REDACTED)[^\s"',;)}\]]{4,}/gi,
    replacement: '$1=[REDACTED_PASSWORD]',
  },
];

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

export const REDACTION_RULE_LABELS: ReadonlyArray<{ kind: RedactionKind; label: string }> = RULES.map((rule) => ({
  kind: rule.kind,
  label: rule.label,
}));

export interface CustomRedactionPattern {
  id: string;
  /** Regular expression source; flags come from `flags`. */
  pattern: string;
  flags?: string;
  label?: string;
}

export interface CompiledPatterns {
  ok: boolean;
  rules: RedactionRule[];
  errors: Array<{ id: string; message: string }>;
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
  /** Compiled patterns, when the caller already validated them. */
  compiled?: RedactionRule[];
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

/** Redacts one string. `counts` is the number of replacements, per kind. */
export function redactText(text: string, options: RedactionOptions = {}): RedactionResult {
  if (!text) return { text: '', counts: emptyCounts() };
  const custom = options.compiled ?? compileCustomPatterns(options.customPatterns ?? []).rules;
  const counts = emptyCounts();
  let output = text;

  for (const rule of RULES) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    output = output.replace(pattern, (...args) => {
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

  for (const rule of custom) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`);
    output = output.replace(pattern, () => {
      counts.total += 1;
      counts.byKind.custom = (counts.byKind.custom ?? 0) + 1;
      return rule.replacement;
    });
  }

  return { text: output, counts };
}

/** Applies redaction to every message, preserving roles and order. */
export function redactMessages(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  options: RedactionOptions = {},
): { messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>; counts: RedactionCounts } {
  const counts = emptyCounts();
  const compiled = options.compiled ?? compileCustomPatterns(options.customPatterns ?? []).rules;
  const next = messages.map((message) => {
    const redacted = redactText(message.content, { compiled });
    addCounts(counts, redacted.counts);
    return { role: message.role, content: redacted.text };
  });
  return { messages: next, counts };
}

/** True when a string still looks like it carries a secret (post-check). */
export function containsLikelySecret(text: string, options: RedactionOptions = {}): boolean {
  if (!text) return false;
  const compiled = options.compiled ?? compileCustomPatterns(options.customPatterns ?? []).rules;
  return [...RULES, ...compiled].some((rule) => new RegExp(rule.pattern.source, rule.pattern.flags).test(text));
}
