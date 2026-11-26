/**
 * WO-13 — telemetry that stays in the tab.
 *
 * The record is built from numbers the run already has, states whether a token
 * count is measured or estimated, and carries no message text, no key and no
 * source. Nothing is written to storage and nothing is sent.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  NO_PRICE_LABEL,
  buildTelemetry,
  estimateTokensFromChars,
  formatTelemetryDuration,
  newRequestId,
  telemetryRows,
  type HybridTelemetry,
} from '../src/engine/hybrid/telemetry';
import { runHybridPass } from '../src/engine/hybrid/orchestrator';
import { runEngine } from '../src/engine/core/runner';
import { DEFAULT_CONNECTION_SETTINGS, type ConnectionSettings } from '../src/engine/hybrid/settings';
import { OpenAiCompatibleProvider } from '../src/engine/hybrid/openAiCompatible';
import { MockHybridProvider, createMockTransport, sseFrames } from '../src/engine/hybrid/mock';
import { ALL_SECTIONS } from '../src/tools/shiori/adapter';
import { clearExamples } from '../src/lib/fewShotStore';

const SOURCE = [
  'export function charge(amount: number): boolean {',
  '  if (amount <= 0) throw new Error("amount must be positive");',
  '  return true;',
  '}',
  '',
].join('\n');

const settings: ConnectionSettings = {
  ...DEFAULT_CONNECTION_SETTINGS,
  baseUrl: 'https://api.example.invalid/v1',
  model: 'gpt-test',
  streaming: true,
};

const ANSWER = JSON.stringify({
  version: 1,
  summary: 'Reviewed.',
  proposals: [
    {
      id: 'p1',
      kind: 'intent',
      title: 'Name the charge contract',
      detail: 'charge rejects a non-positive amount before charging.',
      evidence: [{ file: 'payment.ts', line: 1, symbol: 'charge' }],
      confidence: 'medium',
    },
  ],
  notes: [],
});

async function localPass() {
  return runEngine('shiori', {
    sourceName: 'payment.ts',
    source: SOURCE,
    options: { sections: ALL_SECTIONS, includePrivate: true },
    mode: 'local-static',
  });
}

beforeEach(async () => {
  await clearExamples();
});

describe('telemetry record', () => {
  it('estimates tokens at about four characters each', () => {
    expect(estimateTokensFromChars(0)).toBe(0);
    expect(estimateTokensFromChars(-10)).toBe(0);
    expect(estimateTokensFromChars(4)).toBe(1);
    expect(estimateTokensFromChars(5)).toBe(2);
    expect(estimateTokensFromChars(4000)).toBe(1000);
  });

  it('marks provider-reported usage as measured', () => {
    const telemetry = buildTelemetry({
      requestId: 'req-1',
      toolId: 'shiori',
      engineMode: 'hybrid',
      providerMode: 'hybrid-ai',
      modelId: 'gpt-test',
      destinationHost: 'api.example.invalid',
      stage: 'completed',
      elapsedMs: 1234.6,
      ttftMs: 321.4,
      usage: { inputTokens: 900, outputTokens: 120 },
      estimatedInputTokens: 1000,
      outputChars: 480,
      finishReason: 'stop',
      redactionCount: 3,
      retryCount: 0,
      fallbackReason: null,
      proposalCount: 1,
      rejectedCount: 0,
    });
    expect(telemetry.usageSource).toBe('provider');
    expect(telemetry.inputTokens).toBe(900);
    expect(telemetry.outputTokens).toBe(120);
    expect(telemetry.elapsedMs).toBe(1235);
    expect(telemetry.ttftMs).toBe(321);
    expect(telemetry.redactionCount).toBe(3);
    expect(telemetry.estimatedCostUsd).toBeNull();
  });

  it('marks a missing usage block as an estimate instead of pretending', () => {
    const telemetry = buildTelemetry({
      requestId: 'req-2',
      toolId: 'shiori',
      engineMode: 'hybrid',
      providerMode: 'local-fallback',
      stage: 'local-fallback',
      elapsedMs: 40,
      estimatedInputTokens: 1200,
      outputChars: 400,
      fallbackReason: 'timeout',
    });
    expect(telemetry.usageSource).toBe('estimated');
    expect(telemetry.inputTokens).toBe(1200);
    expect(telemetry.outputTokens).toBe(100);
    expect(telemetry.fallbackReason).toBe('timeout');
  });

  it('records nothing about tokens in Mode A', () => {
    const telemetry = buildTelemetry({
      requestId: 'req-3',
      toolId: 'takane',
      engineMode: 'local',
      providerMode: 'local-static',
      stage: 'completed',
      elapsedMs: 5,
    });
    expect(telemetry.usageSource).toBe('none');
    expect(telemetry.inputTokens).toBeNull();
    expect(telemetry.outputTokens).toBeNull();
    expect(telemetry.modelId).toBeNull();
    expect(telemetry.destinationHost).toBeNull();
  });

  it('gives each run its own id without user data in it', () => {
    const first = newRequestId(1_700_000_000_000, () => 0.5);
    const second = newRequestId(1_700_000_000_000, () => 0.5);
    expect(first).toMatch(/^req-[a-z0-9]+-[a-z0-9]+-[a-z0-9]{6}$/);
    expect(first).not.toBe(second);
  });

  it('renders every field the work order asks for, with cost as N/A', () => {
    const telemetry: HybridTelemetry = buildTelemetry({
      requestId: 'req-4',
      toolId: 'yayoi',
      engineMode: 'hybrid',
      providerMode: 'hybrid-ai',
      modelId: 'gpt-mini',
      destinationHost: 'api.example.invalid',
      stage: 'completed',
      elapsedMs: 2500,
      ttftMs: 400,
      usage: { inputTokens: 1000, outputTokens: 200 },
      finishReason: 'stop',
      redactionCount: 0,
      retryCount: 1,
      proposalCount: 2,
      rejectedCount: 1,
    });
    const rows = telemetryRows(telemetry);
    const ids = rows.map((row) => row.testId);
    expect(ids).toEqual([
      'telemetry-request-id',
      'telemetry-tool-id',
      'telemetry-provider-mode',
      'telemetry-model-id',
      'telemetry-elapsed',
      'telemetry-ttft',
      'telemetry-input-tokens',
      'telemetry-output-tokens',
      'telemetry-finish-reason',
      'telemetry-redactions',
      'telemetry-retries',
      'telemetry-fallback',
      'telemetry-cost',
    ]);
    expect(rows.find((row) => row.testId === 'telemetry-cost')?.value).toBe(NO_PRICE_LABEL);
    expect(rows.find((row) => row.testId === 'telemetry-input-tokens')?.value).toContain('実測');
    expect(formatTelemetryDuration(null)).toBe('—');
    expect(formatTelemetryDuration(2400)).toBe('2.4 s');
  });

  it('carries counts and reasons only — no prompt, source, answer or key', async () => {
    const local = await localPass();
    const usage = { prompt_tokens: 700, completion_tokens: 90 };
    const { transport } = createMockTransport([{ stream: sseFrames(ANSWER, { usage }) }]);
    const outcome = await runHybridPass({
      toolId: 'shiori',
      sourceName: 'payment.ts',
      source: SOURCE,
      options: { sections: ALL_SECTIONS, includePrivate: true },
      localResult: local,
      settings,
      apiKey: 'sk-test-0123456789abcdef',
      engineMode: 'hybrid',
      approve: () => true,
      provider: new OpenAiCompatibleProvider({ transport }),
    });

    expect(outcome.usage).toEqual({ inputTokens: 700, outputTokens: 90 });
    expect(outcome.telemetry.usageSource).toBe('provider');
    expect(outcome.telemetry.finishReason).toBe('stop');
    expect(outcome.telemetry.proposalCount).toBe(1);
    expect(outcome.telemetry.requestId).toBe(outcome.requestId);

    const serialized = JSON.stringify(outcome.telemetry);
    expect(serialized).not.toContain(SOURCE.split('\n')[0]);
    expect(serialized).not.toContain('sk-test');
    expect(serialized).not.toContain('amount must be positive');
    expect(serialized).not.toContain('Name the charge contract');
    expect(Object.keys(outcome.telemetry)).not.toContain('messages');
    expect(Object.keys(outcome.telemetry)).not.toContain('source');
    expect(Object.keys(outcome.telemetry)).not.toContain('aiText');

    // Nothing was persisted: telemetry lives in the returned record only.
    const stored = Object.keys(localStorage).filter((key) => key.includes('telemetry') || key.includes('adop0001.hybrid'));
    expect(stored).toEqual([]);
  });

  it('records the fallback reason and the redaction count on a failed run', async () => {
    const local = await localPass();
    const outcome = await runHybridPass({
      toolId: 'shiori',
      sourceName: 'payment.ts',
      source: SOURCE,
      options: { sections: ALL_SECTIONS, includePrivate: true },
      localResult: local,
      settings,
      apiKey: 'sk-test-0123456789abcdef',
      engineMode: 'hybrid',
      approve: () => true,
      // No queued answer: the provider fails before any usage is reported.
      provider: new MockHybridProvider([]),
    });
    expect(outcome.provenance).toBe('local-fallback');
    expect(outcome.telemetry.providerMode).toBe('local-fallback');
    expect(outcome.telemetry.usageSource).toBe('estimated');
    expect(outcome.telemetry.fallbackReason).toBeTruthy();
    expect(outcome.telemetry.rejectedCount).toBe(0);
    expect(outcome.telemetry.destinationHost).toBe('api.example.invalid');
  });
});
