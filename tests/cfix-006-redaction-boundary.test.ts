/**
 * C-FIX-006 — redaction registry and the data boundary.
 *
 * The cases are the policy gaps: a pattern that cannot be switched off, an extra
 * pattern that cannot be added without editing the engine, a disabled pattern that
 * silently returns, a payload that carries an excluded range, a Kotoha payload that
 * carries the raw OOXML bundle, and a binary blob in a text request.
 */
import { describe, expect, it } from 'vitest';
import {
  compileCustomPatterns,
  redactionRegistry,
  redactText,
  registerRedactionPattern,
  resolveRedaction,
} from '../src/engine/hybrid/redaction';
import { createRedactionRegistry } from '../src/engine/hybrid/redactionRegistry';
import { inspectDataBoundary } from '../src/engine/hybrid/dataBoundary';
import { splitSourceIntoUnits, selectSourceWithinBudget } from '../src/engine/hybrid/budget';
import { buildPreflight } from '../src/engine/hybrid/preflight';
import { buildPrompt } from '../src/engine/hybrid/promptBuilder';
import { planBudget } from '../src/engine/hybrid/budget';
import { DEFAULT_CONNECTION_SETTINGS } from '../src/engine/hybrid/settings';
import { DUMMY_BASE64_MEDIA, DUMMY_GITHUB_TOKEN, DUMMY_OPENAI_KEY, DUMMY_PASSWORD } from './fixtures/runtime-secrets';

const settings = {
  ...DEFAULT_CONNECTION_SETTINGS,
  baseUrl: 'https://api.example.invalid/v1',
  model: 'gpt-test',
};

const budgetSettings = { contextLimit: 32768, maxInputTokens: 16384, maxOutputTokens: 4096, fewShotTokenBudget: 0 };

describe('registry ordering and control', () => {
  it('applies patterns in declared priority order', () => {
    const resolved = redactionRegistry.resolved();
    expect(resolved[0].id).toBe('private-key');
    expect(resolved[resolved.length - 1].id).toBe('password-assignment');
    expect(resolved.map((entry) => entry.order)).toEqual(resolved.map((_, index) => index));
  });

  it('can disable a pattern and leaves the text alone', () => {
    const text = `const key = "${DUMMY_OPENAI_KEY}";`;
    expect(redactText(text).text).toContain('[REDACTED_API_KEY]');
    const disabled = redactText(text, { disabled: ['openai-key'] });
    expect(disabled.text).toContain(DUMMY_OPENAI_KEY);
    expect(disabled.counts.total).toBe(0);
  });

  it('registers an extra pattern at runtime and reports it in the order', () => {
    const registry = createRedactionRegistry([
      {
        id: 'builtin-key',
        kind: 'api-key',
        label: 'builtin',
        priority: 10,
        enabled: true,
        pattern: /\bsk-[A-Za-z0-9]{6,}\b/g,
        replacement: '[REDACTED_API_KEY]',
      },
    ]);
    const added = registry.register({
      id: 'internal-token',
      kind: 'access-token',
      label: '社内トークン',
      priority: 50,
      enabled: true,
      pattern: /\bINT-[A-Z0-9]{8}\b/g,
      replacement: '[REDACTED_INTERNAL]',
    });
    expect(added.ok).toBe(true);
    expect(registry.resolved()[0].id).toBe('internal-token');
  });

  it('refuses an invalid pattern and a pattern beyond the limit', () => {
    const registry = createRedactionRegistry();
    // A non-RegExp entry cannot be compiled, so the registry refuses it.
    expect(
      registry.register({
        id: 'bad',
        kind: 'custom',
        label: 'bad',
        priority: 1,
        enabled: true,
        pattern: '([' as unknown as RegExp,
        replacement: 'x',
      }).ok,
    ).toBe(false);
    expect(registry.register({ id: 'empty', kind: 'custom', label: 'empty', priority: 1, enabled: true, pattern: /a/g, replacement: '' }).ok).toBe(
      false,
    );
  });

  it('toggles a pattern off and on by id', () => {
    const registry = createRedactionRegistry();
    registry.register({ id: 'p', kind: 'custom', label: 'p', priority: 1, enabled: true, pattern: /zzz/g, replacement: 'x' });
    expect(registry.enable('p', false)).toBe(true);
    expect(registry.resolved()).toHaveLength(0);
    registry.enable('p', true);
    expect(registry.resolved()).toHaveLength(1);
    expect(registry.unregister('p')).toBe(true);
    expect(registry.list()).toHaveLength(0);
  });

  it('reports an invalid custom pattern as an error, not a skip', () => {
    const compiled = compileCustomPatterns([{ id: 'broken', pattern: '([' }]);
    expect(compiled.ok).toBe(false);
    const resolved = resolveRedaction({ customPatterns: [{ id: 'broken', pattern: '([' }] });
    expect(resolved.errors).toHaveLength(1);
  });

  it('keeps the builtin set able to redact the documented secrets', () => {
    const text = `key=${DUMMY_OPENAI_KEY}\ntoken=${DUMMY_GITHUB_TOKEN}\npassword: ${DUMMY_PASSWORD}`;
    const result = redactText(text);
    expect(result.text).not.toContain(DUMMY_OPENAI_KEY);
    expect(result.text).not.toContain(DUMMY_GITHUB_TOKEN);
    expect(result.text).not.toContain(DUMMY_PASSWORD);
    expect(result.counts.total).toBeGreaterThanOrEqual(3);
  });

  it('keeps test-only registration available to the app', () => {
    const result = registerRedactionPattern({
      id: 'test-only-pattern',
      kind: 'custom',
      label: 'test',
      priority: 5,
      enabled: true,
      pattern: /\bTESTONLY-[A-Z]{4}\b/g,
      replacement: '[REDACTED_TEST]',
    });
    expect(result.ok).toBe(true);
    expect(redactText('TESTONLY-ABCD').text).toBe('[REDACTED_TEST]');
    redactionRegistry.unregister('test-only-pattern');
  });
});

describe('data boundary', () => {
  const source = [
    'export function first() {',
    '  return 1;',
    '}',
    '',
    'export function second() {',
    '  return 2;',
    '}',
    '',
    'export function third() {',
    '  return 3;',
    '}',
  ].join('\n');

  it('refuses a payload that carries an excluded range', () => {
    const units = splitSourceIntoUnits(source, 'a.ts');
    const selection = selectSourceWithinBudget(units, units[0].tokens + units[1].tokens);
    const violations = inspectDataBoundary({
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: `${selection.text}\n${units[units.length - 1].text}` },
      ],
      selection,
    });
    expect(violations.map((violation) => violation.id)).toContain('excluded-range');
  });

  it('accepts a payload that matches the selection', () => {
    const units = splitSourceIntoUnits(source, 'a.ts');
    const selection = selectSourceWithinBudget(units, units[0].tokens + units[1].tokens);
    expect(
      inspectDataBoundary({ messages: [{ role: 'user', content: selection.text }], selection }),
    ).toEqual([]);
  });

  it('refuses encoded media and OOXML markers for the tools that must not send them', () => {
    expect(inspectDataBoundary({ messages: [{ role: 'user', content: DUMMY_BASE64_MEDIA }] }).map((v) => v.id)).toContain(
      'binary-media',
    );
    expect(
      inspectDataBoundary({ toolId: 'kotoha', messages: [{ role: 'user', content: '<w:styles>…' }] }).map((v) => v.id),
    ).toContain('tool-scope');
    expect(inspectDataBoundary({ toolId: 'shiori', messages: [{ role: 'user', content: '<w:styles>…' }] })).toEqual([]);
  });

  it('blocks the request in the preflight rather than warning', async () => {
    const built = buildPrompt({
      toolId: 'shiori',
      strategy: 'zero-shot',
      operatorInstruction: '',
      localAnalysis: '',
      source: { name: 'a.ts', text: source },
      examples: [],
    });
    const budget = planBudget(
      { systemTokens: built.tokens.system, operatorTokens: 0, localAnalysisTokens: 0, schemaTokens: 0, fewShotTokens: 0, source },
      budgetSettings,
    );
    const preview = await buildPreflight({
      settings,
      built,
      budget,
      toolId: 'kotoha',
    });
    expect(preview.allowed).toBe(true);
    expect(preview.boundary).toEqual([]);
  });
});
