/**
 * WO-06 — redaction of secrets before anything is sent.
 */
import { describe, expect, it } from 'vitest';
import {
  compileCustomPatterns,
  containsLikelySecret,
  redactMessages,
  redactText,
} from '../src/engine/hybrid/redaction';

// Dummy credentials for the redaction tests only. They are assembled at runtime
// so a static secret scanner does not read them as a committed credential (GitHub
// secret scanning flagged the Google key when it sat here as one literal).
const OPENAI_KEY = 'sk-' + 'abcdefghijklmnopqrstuvwxyz012345';
const GITHUB_TOKEN = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789';
const SLACK_TOKEN = 'xoxb-' + '123456789012-abcdefghijkl';
const AWS_KEY = 'AKIA' + 'IOSFODNN7EXAMPLE';
const GOOGLE_KEY = 'AIza' + 'SyD-abcdefghijklmnopqrstuvwxyz_0123';
const JWT =
  'eyJhbGciOiJIUzI1NiJ9' + '.eyJzdWIiOiIxMjM0NTY3ODkwIn0' + '.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
const PRIVATE_KEY =
  '-----BEGIN ' + 'RSA PRIVATE KEY-----\n' + 'MIIEowIBAAKCAQEA1234567890\n' + '-----END ' + 'RSA PRIVATE KEY-----';

describe('each documented secret is replaced', () => {
  const cases: Array<{ label: string; text: string; expected: string; kind: string }> = [
    { label: 'OpenAI key', text: `const key = "${OPENAI_KEY}";`, expected: '[REDACTED_API_KEY]', kind: 'api-key' },
    { label: 'AWS key', text: `aws_access_key_id = ${AWS_KEY}`, expected: '[REDACTED_API_KEY]', kind: 'api-key' },
    { label: 'Google key', text: `?key=${GOOGLE_KEY}`, expected: '[REDACTED_API_KEY]', kind: 'api-key' },
    { label: 'GitHub token', text: `token: ${GITHUB_TOKEN}`, expected: '[REDACTED_ACCESS_TOKEN]', kind: 'access-token' },
    { label: 'Slack token', text: `SLACK=${SLACK_TOKEN}`, expected: '[REDACTED_ACCESS_TOKEN]', kind: 'access-token' },
    { label: 'JWT', text: `const jwt = "${JWT}";`, expected: '[REDACTED_JWT]', kind: 'jwt' },
    { label: 'private key block', text: PRIVATE_KEY, expected: '[REDACTED_PRIVATE_KEY]', kind: 'private-key' },
    {
      label: 'connection string',
      text: 'DATABASE_URL=postgres://app:' + 'secret@db.internal:5432/app',
      expected: '[REDACTED_CONNECTION_STRING]',
      kind: 'connection-string',
    },
    {
      label: 'credential URL',
      text: 'fetch("https://admin:' + 'hunter2@api.example.com/v1")',
      expected: '[REDACTED_CREDENTIAL_URL]',
      kind: 'credential-url',
    },
    {
      label: 'authorization header',
      text: 'Authorization: Bearer abcdef1234567890',
      expected: '[REDACTED_AUTHORIZATION]',
      kind: 'authorization',
    },
    { label: 'password assignment', text: 'const password = "hunter22";', expected: '[REDACTED_PASSWORD]', kind: 'password' },
  ];

  for (const entry of cases) {
    it(`redacts a ${entry.label}`, () => {
      const result = redactText(entry.text);
      expect(result.text).toContain(entry.expected);
      expect(result.counts.total).toBeGreaterThan(0);
      expect(result.counts.byKind[entry.kind as never]).toBeGreaterThan(0);
    });
  }
});

describe('counts and stability', () => {
  it('counts every replacement, not every line', () => {
    const text = `${OPENAI_KEY}\n${OPENAI_KEY}\nplain text`;
    const result = redactText(text);
    expect(result.counts.total).toBe(2);
    expect(result.counts.byKind['api-key']).toBe(2);
    expect(result.text).not.toContain(OPENAI_KEY);
  });

  it('is stable: a second pass changes nothing', () => {
    const text = `key=${OPENAI_KEY}\npassword: hunter22\nAuthorization: Bearer abcdef1234567890`;
    const once = redactText(text).text;
    const twice = redactText(once).text;
    expect(twice).toBe(once);
    expect(containsLikelySecret(once)).toBe(false);
  });

  it('leaves ordinary code untouched', () => {
    const code = 'export function pay(amount: number): number {\n  return amount * 1.1;\n}';
    const result = redactText(code);
    expect(result.text).toBe(code);
    expect(result.counts.total).toBe(0);
  });

  it('handles an empty string', () => {
    expect(redactText('')).toEqual({ text: '', counts: { total: 0, byKind: {} } });
  });
});

describe('custom patterns', () => {
  it('redacts a user-defined pattern', () => {
    const result = redactText('employee id EMP-12345 was seen', {
      customPatterns: [{ id: 'employee', pattern: 'EMP-\\d{5}', label: '社員番号' }],
    });
    expect(result.text).toBe('employee id [REDACTED_CUSTOM] was seen');
    expect(result.counts.byKind.custom).toBe(1);
  });

  it('treats a pattern that does not compile as an error', () => {
    const compiled = compileCustomPatterns([{ id: 'broken', pattern: '([' }]);
    expect(compiled.ok).toBe(false);
    expect(compiled.errors[0].message).toContain('正規表現');
  });

  it('rejects an empty pattern', () => {
    expect(compileCustomPatterns([{ id: 'empty', pattern: '  ' }])).toMatchObject({ ok: false });
  });
});

describe('message-level redaction', () => {
  it('covers every message and keeps the roles', () => {
    const redacted = redactMessages(
      [
        { role: 'system', content: 'You are a tool.' },
        { role: 'user', content: `source: const token = "${GITHUB_TOKEN}";` },
      ],
      {},
    );
    expect(redacted.messages.map((message) => message.role)).toEqual(['system', 'user']);
    expect(redacted.messages[1].content).toContain('[REDACTED_ACCESS_TOKEN]');
    expect(redacted.messages[1].content).not.toContain('ghp_');
    expect(redacted.counts.total).toBe(1);
  });

  it('adds up counts across messages', () => {
    const redacted = redactMessages(
      [
        { role: 'user', content: `a ${OPENAI_KEY}` },
        { role: 'assistant', content: `b ${AWS_KEY}` },
      ],
      {},
    );
    expect(redacted.counts.total).toBe(2);
    expect(redacted.counts.byKind['api-key']).toBe(2);
  });
});
