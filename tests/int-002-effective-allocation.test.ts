/**
 * INT-002 — the effective allocation reaches the wire.
 *
 * Phase 5C.1 computed an allocation and then sent the user's raw numbers, counted
 * the prompt before redaction, and described excluded source units in the local
 * analysis anyway. These cases check the payload and the preview, not the plan
 * object in isolation.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { runEngine } from '../src/engine/core/runner';
import { runHybridPass } from '../src/engine/hybrid/orchestrator';
import { planHybridRequest } from '../src/engine/hybrid/requestPlan';
import { buildPrompt } from '../src/engine/hybrid/promptBuilder';
import { DEFAULT_CONNECTION_SETTINGS, type ConnectionSettings } from '../src/engine/hybrid/settings';
import { createProviderProfile, providerRegistry } from '../src/engine/hybrid/providerProfiles';
import { OpenAiCompatibleProvider } from '../src/engine/hybrid/openAiCompatible';
import { createMockTransport } from '../src/engine/hybrid/mock';
import { clearExamples } from '../src/lib/fewShotStore';
import { ALL_SECTIONS } from '../src/tools/shiori/adapter';

const ENVELOPE = JSON.stringify({ version: 1, summary: 'ok', proposals: [], notes: [] });

beforeEach(async () => {
  await clearExamples();
});

describe('INT-002 — effective context allocation is what is sent', () => {
  it('uses the model ceiling as the output budget instead of the raw user number', async () => {
    providerRegistry.register(
      createProviderProfile({
        id: 'int-tiny-output',
        label: 'tiny output',
        hosts: ['tiny.example'],
        capabilities: { maxOutputTokens: 128 },
      }),
    );
    const settings: ConnectionSettings = {
      ...DEFAULT_CONNECTION_SETTINGS,
      baseUrl: 'https://tiny.example/v1',
      model: 'tiny-model',
      maxOutputTokens: 4096,
      maxInputTokens: 2048,
      contextLimit: 8192,
    };
    const source = 'export function pay(amount: number) {\n  return amount > 0;\n}\n';
    const localResult = await runEngine('shiori', {
      sourceName: 'payment.ts',
      source,
      options: { sections: ALL_SECTIONS, includePrivate: true },
      mode: 'local-static',
    });
    const transport = createMockTransport([
      { body: JSON.stringify({ choices: [{ message: { content: ENVELOPE }, finish_reason: 'stop' }] }) },
    ]);
    const provider = new OpenAiCompatibleProvider({ transport: transport.transport });
    const outcome = await runHybridPass({
      toolId: 'shiori',
      sourceName: 'payment.ts',
      source,
      options: { sections: ALL_SECTIONS, includePrivate: true },
      localResult,
      settings,
      apiKey: 'test-key-0123456789',
      approve: () => true,
      provider,
    });
    expect(outcome.snapshot).not.toBeNull();
    const body = JSON.parse(transport.calls[0].body);
    // The model can only answer 128 tokens; the request asks for 128, not 4096.
    expect(body.max_tokens).toBe(128);
    expect(outcome.plan!.preview.maxOutputTokens).toBe(128);
  });

  it('counts the final redacted messages, including protocol overhead', async () => {
    const settings: ConnectionSettings = {
      ...DEFAULT_CONNECTION_SETTINGS,
      baseUrl: 'https://api.example.invalid/v1',
      model: 'gpt-test',
    };
    const plan = await planHybridRequest({
      toolId: 'shiori',
      source: 'export function pay() {\n  return 1;\n}\n',
      sourceName: 'p.ts',
      settings,
      localAnalysis: 'contracts: 1',
    });
    expect(plan.preview.protocolTokens).toBeGreaterThan(0);
    // The number the gate compares against the allowance is the final payload's,
    // not the pre-assembly section estimate.
    expect(plan.preview.estimatedInputTokens).toBe(plan.preview.finalContentTokens + plan.preview.protocolTokens);
    expect(plan.preview.estimatedInputTokens).not.toBe(plan.budget.overheadTokens + plan.budget.selection.tokens);
  });

  it('does not describe excluded source units in the local analysis', async () => {
    const source = Array.from({ length: 80 }, (_, index) => `export function fn${index}() { return ${index}; }`).join('\n');
    const analysis = [
      'contracts:',
      '- fn0 (L1) returns number',
      '- fn40 (L41) returns number',
      '- fn79 (L80) returns number',
    ].join('\n');
    const settings: ConnectionSettings = {
      ...DEFAULT_CONNECTION_SETTINGS,
      baseUrl: 'https://api.example.invalid/v1',
      model: 'gpt-test',
      contextLimit: 2048,
      maxInputTokens: 700,
      maxOutputTokens: 256,
      fewShotTokenBudget: 0,
    };
    const plan = await planHybridRequest({
      toolId: 'shiori',
      source,
      sourceName: 'many.ts',
      settings,
      localAnalysis: analysis,
    });
    expect(plan.budget.selection.truncated).toBe(true);
    expect(plan.budget.selection.excluded.some((unit) => unit.startLine <= 80 && unit.endLine >= 80)).toBe(true);
    const payload = plan.preview.messages.map((message) => message.content).join('\n');
    // L40 was excluded, so a fact about it must not reach the model.
    expect(payload).not.toContain('fn79');
    // The included fact is still there.
    expect(payload).toContain('fn0');
  });

  it('recomputes a stale few-shot token estimate instead of trusting it', async () => {
    const longText = 'x'.repeat(4000);
    const built = buildPrompt({
      toolId: 'shiori',
      strategy: 'few-shot',
      operatorInstruction: 'Use snake_case.',
      localAnalysis: '',
      source: { name: 'a.ts', text: 'export function a() { return 1; }' },
      examples: [
        {
          id: 'stale',
          toolId: 'shiori',
          title: 'stale estimate',
          outputText: longText,
          enabled: true,
          role: 'example',
          createdAt: '2026-01-01T00:00:00.000Z',
          estimatedTokens: 1,
        } as never,
      ],
      fewShotTokenBudget: 50,
    });
    // The stored estimate says 1 token; the text is ~1000. The budget decision uses
    // the recomputed cost, so the example is not squeezed into the source budget.
    expect(built.selectedExamples).toHaveLength(0);
    expect(built.skippedExamples.some((entry) => entry.reason === 'budget')).toBe(true);
  });
});
