/**
 * INT-007 — the data boundary and evidence follow the approval.
 *
 * The session's own key is redacted even when it has no recognisable shape, a key
 * the provider echoes back never reaches the operator, an AI proposal cannot cite a
 * line that was not sent, and a dangerous custom expression is refused before it
 * runs.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { runEngine } from '../src/engine/core/runner';
import { runHybridPass } from '../src/engine/hybrid/orchestrator';
import { planHybridRequest } from '../src/engine/hybrid/requestPlan';
import { DEFAULT_CONNECTION_SETTINGS, type ConnectionSettings } from '../src/engine/hybrid/settings';
import { createMockTransport } from '../src/engine/hybrid/mock';
import { OpenAiCompatibleProvider } from '../src/engine/hybrid/openAiCompatible';
import { compileCustomPatterns, redactText } from '../src/engine/hybrid/redaction';
import { unappliedProposals } from '../src/engine/hybrid/orchestrator';
import type { AiProposal } from '../src/engine/hybrid/mergePolicy';
import { clearExamples } from '../src/lib/fewShotStore';
import { ALL_SECTIONS } from '../src/tools/shiori/adapter';

const SESSION_KEY = ['custom', 'secret', '42'].join('-');
const settings: ConnectionSettings = {
  ...DEFAULT_CONNECTION_SETTINGS,
  baseUrl: 'https://api.example.invalid/v1',
  model: 'gpt-test',
};

beforeEach(async () => {
  await clearExamples();
});

describe('INT-007 — data boundary & evidence', () => {
  it('redacts the session key even when it has no known key shape', async () => {
    const source = `const token = "${SESSION_KEY}";\nexport function pay() { return 1; }\n`;
    const plan = await planHybridRequest({
      toolId: 'shiori',
      source,
      sourceName: 'pay.ts',
      settings,
      secrets: [SESSION_KEY],
    });
    const payload = plan.preview.messages.map((message) => message.content).join('\n');
    expect(payload).not.toContain(SESSION_KEY);
    expect(payload).toContain('[REDACTED_API_KEY]');
    expect(plan.preview.redaction.total).toBeGreaterThan(0);
  });

  it('removes a key the provider echoes back in its own error message', async () => {
    const localResult = await runEngine('shiori', {
      sourceName: 'pay.ts',
      source: 'export function pay() { return 1; }\n',
      options: { sections: ALL_SECTIONS, includePrivate: true },
      mode: 'local-static',
    });
    // A 200 with an error envelope is a real gateway pattern, and the message can
    // quote the credential it was given.
    const transport = createMockTransport([
      { body: JSON.stringify({ error: { message: `Invalid credential ${SESSION_KEY}` } }) },
    ]);
    const provider = new OpenAiCompatibleProvider({ transport: transport.transport });
    const outcome = await runHybridPass({
      toolId: 'shiori',
      sourceName: 'pay.ts',
      source: 'export function pay() { return 1; }\n',
      options: { sections: ALL_SECTIONS, includePrivate: true },
      localResult,
      settings,
      apiKey: SESSION_KEY,
      approve: () => true,
      provider,
    });
    expect(outcome.reason ?? '').not.toContain(SESSION_KEY);
  });

  it('refuses evidence about a line that was not transmitted', async () => {
    const source = Array.from({ length: 80 }, (_, index) => `export function fn${index}() { return ${index}; }`).join('\n');
    const localResult = await runEngine('shiori', {
      sourceName: 'many.ts',
      source,
      options: { sections: ALL_SECTIONS, includePrivate: true },
      mode: 'local-static',
    });
    const tight: ConnectionSettings = {
      ...settings,
      contextLimit: 2048,
      maxInputTokens: 700,
      maxOutputTokens: 256,
      fewShotTokenBudget: 0,
    };
    const plan = await planHybridRequest({
      toolId: 'shiori',
      source,
      sourceName: 'many.ts',
      settings: tight,
      localAnalysis: 'contracts: 40',
      secrets: ['test-key-0123456789'],
    });
    expect(plan.budget.selection.truncated).toBe(true);
    const excluded = plan.budget.selection.excluded[0];
    const evidenceLine = excluded.startLine;
    const envelope = JSON.stringify({
      version: 1,
      summary: 'ok',
      proposals: [
        {
          id: 'p1',
          kind: 'intent',
          title: 'Late function intent',
          detail: 'The last function returns a value.',
          evidence: [{ file: 'many.ts', line: evidenceLine, symbol: `fn${evidenceLine - 1}` }],
          confidence: 'medium',
        },
      ],
      notes: [],
    });
    const transport = createMockTransport([
      { body: JSON.stringify({ choices: [{ message: { content: envelope }, finish_reason: 'stop' }] }) },
    ]);
    const provider = new OpenAiCompatibleProvider({ transport: transport.transport });
    const outcome = await runHybridPass({
      toolId: 'shiori',
      sourceName: 'many.ts',
      source,
      options: { sections: ALL_SECTIONS, includePrivate: true },
      localResult,
      settings: tight,
      apiKey: 'test-key-0123456789',
      plan,
      approve: () => true,
      provider,
    });
    expect(outcome.proposals).toHaveLength(0);
    expect(outcome.rejected.some((item) => item.reason === 'line-out-of-scope')).toBe(true);
  });

  it('never applies the same proposal id twice', () => {
    const proposal = (id: string) => ({ id, kind: 'intent', title: id, detail: 'd', evidence: [], confidence: 'medium' }) as AiProposal;
    const applied = new Set<string>(['p1']);
    expect(unappliedProposals([proposal('p1'), proposal('p2')], applied)).toHaveLength(1);
    expect(unappliedProposals([proposal('p1')], applied)).toHaveLength(0);
  });

  it('refuses a custom pattern that can hang the tab', () => {
    expect(compileCustomPatterns([{ id: 'evil', pattern: '(a+)+$' }]).ok).toBe(false);
    expect(compileCustomPatterns([{ id: 'backref', pattern: '(a)\\1' }]).ok).toBe(false);
    expect(compileCustomPatterns([{ id: 'long', pattern: 'x'.repeat(300) }]).ok).toBe(false);
    expect(compileCustomPatterns([{ id: 'ok', pattern: 'EMP-\\d{6}' }]).ok).toBe(true);
    expect(redactText('EMP-123456', { customPatterns: [{ id: 'emp', pattern: 'EMP-\\d{6}' }] }).counts.total).toBe(1);
  });
});
