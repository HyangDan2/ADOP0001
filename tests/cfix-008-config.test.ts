/**
 * C-FIX-008 — configuration single source of truth.
 *
 * The cases are the drift the old constants allowed: a value with no validator, an
 * override nobody can make, an invalid value discovered halfway through a request,
 * and a fingerprint that cannot say which policy produced a snapshot.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  HYBRID_CONFIG_DESCRIPTORS,
  createHybridConfigStore,
  defaultConfigFlat,
  fingerprintValues,
  hybridConfig,
  runtimeKeyFor,
} from '../src/engine/hybrid/config';
import { safetyMarginFor, planBudget } from '../src/engine/hybrid/budget';
import { responseCharCapFor } from '../src/engine/hybrid/resourcePolicy';

const parts = { systemTokens: 100, operatorTokens: 0, localAnalysisTokens: 0, schemaTokens: 0, fewShotTokens: 0, source: 'export const a = 1;' };
const settings = { contextLimit: 32768, maxInputTokens: 16384, maxOutputTokens: 4096, fewShotTokenBudget: 0 };
void settings;

describe('configuration registry', () => {
  it('gives every key a default, a label and a validator', () => {
    expect(HYBRID_CONFIG_DESCRIPTORS.length).toBeGreaterThan(15);
    const keys = HYBRID_CONFIG_DESCRIPTORS.map((descriptor) => descriptor.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const descriptor of HYBRID_CONFIG_DESCRIPTORS) {
      expect(descriptor.label.length).toBeGreaterThan(0);
      expect(descriptor.validate(descriptor.defaultValue)).toBeNull();
    }
  });

  it('exposes the typed view the engine reads', () => {
    const values = hybridConfig.read();
    expect(values.provider.defaultTotalTimeoutMs).toBe(120_000);
    expect(values.stream.receiveCapSlack).toBe(1.5);
    expect(values.budget.safetyMarginRatio).toBe(0.05);
    expect(values.resource.responseBytesPerToken).toBe(64);
    expect(values.evidence.chainAlgorithm).toBe('sha256-fnv1a64');
  });

  it('accepts a valid override and rejects an invalid one with a readable message', () => {
    const store = createHybridConfigStore();
    expect(store.override('budget.safetyMarginRatio', 0.9)).toMatchObject({ ok: false });
    expect(store.override('unknown.key', 1)).toMatchObject({ ok: false });
    expect(store.override('provider.defaultTemperature', '1.4')).toMatchObject({ ok: true });
    expect(store.read().provider.defaultTemperature).toBe(1.4);
    expect(store.override('provider.defaultTemperature', -1)).toMatchObject({ ok: false });
    expect(store.read().provider.defaultTemperature).toBe(1.4);
    store.reset();
    expect(store.read().provider.defaultTemperature).toBe(0.2);
  });

  it('applies a batch only when every value is valid', () => {
    const store = createHybridConfigStore();
    const rejected = store.applyOverrides({ 'stream.receiveCapSlack': 2, 'stream.minReceiveCap': 10 });
    expect(rejected.ok).toBe(false);
    expect(store.read().stream.receiveCapSlack).toBe(1.5);
    const accepted = store.applyOverrides({ 'stream.receiveCapSlack': 2, 'stream.minReceiveCap': 2048 });
    expect(accepted.ok).toBe(true);
    expect(store.read().stream.minReceiveCap).toBe(2048);
  });

  it('maps deployment environment names onto keys', () => {
    expect(runtimeKeyFor('ADOP_HYBRID_PROVIDER_DEFAULT_TEMPERATURE')).toBe('provider.defaultTemperature');
    expect(runtimeKeyFor('ADOP_HYBRID_BUDGET_SAFETY_MARGIN_RATIO')).toBe('budget.safetyMarginRatio');
    expect(runtimeKeyFor('SOMETHING_ELSE')).toBeNull();
    const store = createHybridConfigStore();
    const applied = store.applyRuntimeOverrides({ ADOP_HYBRID_STREAM_MIN_RECEIVE_CAP: '8192' });
    expect(applied.ok).toBe(true);
    expect(store.read().stream.minReceiveCap).toBe(8192);
  });

  it('changes the fingerprint only when a value changes', () => {
    const store = createHybridConfigStore();
    const first = store.fingerprint();
    expect(store.fingerprint()).toBe(first);
    store.override('budget.safetyMarginRatio', 0.06);
    expect(store.fingerprint()).not.toBe(first);
    store.reset();
    expect(store.fingerprint()).toBe(first);
    expect(fingerprintValues(defaultConfigFlat())).toBe(first);
  });
});

describe('the engine reads the SSoT instead of constants', () => {
  beforeEach(() => {
    hybridConfig.reset();
  });

  it('derives the safety margin from the configuration', () => {
    const before = safetyMarginFor(20_000);
    hybridConfig.override('budget.safetyMarginRatio', 0.2);
    const after = safetyMarginFor(20_000);
    expect(after).toBeGreaterThan(before);
    hybridConfig.reset();
    expect(safetyMarginFor(20_000)).toBe(before);
  });

  it('derives the receive cap from the configuration', () => {
    const before = responseCharCapFor(4_096);
    hybridConfig.override('stream.receiveCapSlack', 2);
    expect(responseCharCapFor(4_096)).toBeGreaterThan(before);
    hybridConfig.reset();
    expect(responseCharCapFor(4_096)).toBe(before);
  });

  it('changes a plan when the margin changes', () => {
    // A window where the margin, not maxInputTokens, decides the allowance.
    const tight = { contextLimit: 8_192, maxInputTokens: 16_384, maxOutputTokens: 1_024, fewShotTokenBudget: 0 };
    const plan = planBudget(parts, tight);
    hybridConfig.override('budget.safetyMarginRatio', 0.02);
    const wider = planBudget(parts, tight);
    expect(wider.inputAllowance).toBeGreaterThan(plan.inputAllowance);
    hybridConfig.reset();
  });
});
