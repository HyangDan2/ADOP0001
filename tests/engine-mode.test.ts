/**
 * WO-11 — one engine mode for every tool.
 *
 * Mode A is the default and means "nothing leaves the tab". These tests pin the
 * store (default, persistence, subscription) and, more importantly, that the
 * orchestrator refuses to build a payload or call a provider in Mode A even when
 * a screen hands it everything it would need.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ENGINE_MODE,
  ENGINE_MODE_KEY,
  ENGINE_MODE_LABEL,
  ENGINE_MODE_STATUS,
  getEngineMode,
  normalizeEngineMode,
  reloadEngineMode,
  setEngineMode,
  subscribeEngineMode,
} from '../src/lib/engineMode';
import { runHybridPass } from '../src/engine/hybrid/orchestrator';
import { runEngine } from '../src/engine/core/runner';
import { DEFAULT_CONNECTION_SETTINGS, type ConnectionSettings } from '../src/engine/hybrid/settings';
import { MockHybridProvider } from '../src/engine/hybrid/mock';
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

const GOOD = JSON.stringify({
  version: 1,
  summary: 'Interactive review.',
  proposals: [
    {
      id: 'p1',
      kind: 'intent',
      title: 'Name the charge contract',
      detail: 'charge is the entry point that rejects a non-positive amount before charging.',
      evidence: [{ file: 'payment.ts', line: 1, symbol: 'charge', quote: 'export function charge' }],
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
  localStorage.clear();
  reloadEngineMode();
});

describe('engine mode store', () => {
  it('starts in Mode A (local, fully offline)', () => {
    expect(DEFAULT_ENGINE_MODE).toBe('local');
    expect(getEngineMode()).toBe('local');
    expect(ENGINE_MODE_LABEL.local).toContain('ローカル解析');
    expect(ENGINE_MODE_LABEL.hybrid).toContain('ハイブリッド');
    expect(ENGINE_MODE_STATUS.local).toContain('外部送信なし');
  });

  it('normalizes anything that is not "hybrid" to local', () => {
    expect(normalizeEngineMode('hybrid')).toBe('hybrid');
    expect(normalizeEngineMode('HYBRID')).toBe('local');
    expect(normalizeEngineMode(null)).toBe('local');
    expect(normalizeEngineMode(undefined)).toBe('local');
    expect(normalizeEngineMode(1)).toBe('local');
  });

  it('remembers the mode as a preference and notifies subscribers', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeEngineMode(listener);
    setEngineMode('hybrid');
    expect(getEngineMode()).toBe('hybrid');
    expect(localStorage.getItem(ENGINE_MODE_KEY)).toBe('hybrid');
    expect(listener).toHaveBeenCalledTimes(1);

    // Setting the same mode is not a change and does not notify twice.
    setEngineMode('hybrid');
    expect(listener).toHaveBeenCalledTimes(1);

    setEngineMode('local');
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    setEngineMode('hybrid');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('re-reads the stored mode after a reload', () => {
    localStorage.setItem(ENGINE_MODE_KEY, 'hybrid');
    expect(reloadEngineMode()).toBe('hybrid');
    localStorage.removeItem(ENGINE_MODE_KEY);
    expect(reloadEngineMode()).toBe('local');
  });
});

describe('Mode A never reaches the gateway', () => {
  it('returns the local result without a preview, an approval or a provider call', async () => {
    const local = await localPass();
    const provider = new MockHybridProvider([GOOD]);
    const approve = vi.fn(() => true);

    const outcome = await runHybridPass({
      toolId: 'shiori',
      sourceName: 'payment.ts',
      source: SOURCE,
      options: { sections: ALL_SECTIONS, includePrivate: true },
      localResult: local,
      settings,
      apiKey: 'sk-test-0123456789abcdef',
      engineMode: 'local',
      approve,
      provider,
    });

    expect(outcome.provenance).toBe('local-static');
    expect(outcome.output).toBe(local.output);
    expect(outcome.reason).toContain('モードA');
    expect(outcome.preview).toBeNull();
    expect(outcome.plan).toBeNull();
    expect(approve).not.toHaveBeenCalled();
    expect(provider.requests).toHaveLength(0);
    expect(outcome.stage).toBe('completed');
    expect(outcome.status.reason).toContain('外部への送信は行いません');
  });

  it('reports Mode A telemetry without any usage or payload text', async () => {
    const local = await localPass();
    const outcome = await runHybridPass({
      toolId: 'shiori',
      sourceName: 'payment.ts',
      source: SOURCE,
      options: { sections: ALL_SECTIONS, includePrivate: true },
      localResult: local,
      settings,
      apiKey: 'sk-test-0123456789abcdef',
      engineMode: 'local',
      approve: () => true,
      provider: new MockHybridProvider([GOOD]),
    });

    expect(outcome.telemetry.engineMode).toBe('local');
    expect(outcome.telemetry.providerMode).toBe('local-static');
    expect(outcome.telemetry.usageSource).toBe('none');
    expect(outcome.telemetry.inputTokens).toBeNull();
    expect(outcome.telemetry.outputTokens).toBeNull();
    expect(outcome.telemetry.modelId).toBeNull();
    expect(outcome.telemetry.estimatedCostUsd).toBeNull();
    expect(outcome.telemetry.requestId).toMatch(/^req-/);
    const serialized = JSON.stringify(outcome.telemetry);
    expect(serialized).not.toContain('charge');
    expect(serialized).not.toContain(SOURCE.slice(0, 20));
    expect(serialized).not.toContain('sk-test');
  });

  it('still performs the call in Mode B (the guard is the mode, not the caller)', async () => {
    const local = await localPass();
    const provider = new MockHybridProvider([GOOD]);
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
      provider,
    });
    expect(provider.requests).toHaveLength(1);
    expect(outcome.provenance).toBe('hybrid-ai');
    expect(outcome.telemetry.engineMode).toBe('hybrid');
    expect(outcome.telemetry.providerMode).toBe('hybrid-ai');
    expect(outcome.telemetry.modelId).toBe('gpt-test');
    expect(outcome.telemetry.destinationHost).toBe('api.example.invalid');
  });
});
