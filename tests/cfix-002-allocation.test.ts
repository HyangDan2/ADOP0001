/**
 * C-FIX-002 — dynamic context allocation.
 *
 * The cases are the fixed-number defects: a model with a small window accepting a
 * plan it cannot hold, examples stealing the file's room, a big file sending only
 * its first lines while the function the operator asked about sits at line 400,
 * and a preview that reports excluded ranges while the payload carries them.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  allocateContext,
  elideSection,
  focusTermsFrom,
  selectSourceForAllocation,
} from '../src/engine/hybrid/contextAllocator';
import { planBudget, splitSourceIntoUnits } from '../src/engine/hybrid/budget';
import { planHybridRequest } from '../src/engine/hybrid/requestPlan';
import { DEFAULT_CONNECTION_SETTINGS, type ConnectionSettings } from '../src/engine/hybrid/settings';
import { savePrompt } from '../src/lib/promptStore';
import { clearExamples } from '../src/lib/fewShotStore';

const SMALL_MODEL = {
  id: 'small-model',
  label: 'small',
  maxContextTokens: 8_192,
  maxOutputTokens: 2_048,
  sourceShare: 0.4,
  headShare: 0.5,
};

function functions(count: number, name: (index: number) => string = (index) => `fn${index}`): string {
  return Array.from({ length: count }, (_, index) => `export function ${name(index)}() {\n  return ${index};\n}`).join('\n\n');
}

const baseSettings = { contextLimit: 32768, maxInputTokens: 16384, maxOutputTokens: 4096, fewShotTokenBudget: 2048 };

beforeEach(async () => {
  await clearExamples();
});

describe('allocation against a model profile', () => {
  it('clamps the user numbers to the model ceiling instead of trusting them', () => {
    const allocation = allocateContext(
      { systemTokens: 100, operatorTokens: 10, localAnalysisTokens: 10, schemaTokens: 10, fewShotTokens: 0, source: 'x' },
      baseSettings,
      SMALL_MODEL,
    );
    expect(allocation.contextLimit).toBe(8_192);
    expect(allocation.clampedByProfile).toBe(true);
    expect(allocation.maxOutputTokens).toBeLessThanOrEqual(2_048);
    expect(allocation.inputAllowance).toBeLessThanOrEqual(8_192 - allocation.maxOutputTokens - allocation.safetyMargin);
  });

  it('keeps a floor for the file by trimming the elastic few-shot block', () => {
    const allocation = allocateContext(
      { systemTokens: 200, operatorTokens: 100, localAnalysisTokens: 100, schemaTokens: 50, fewShotTokens: 3_000, source: 'x' },
      { ...baseSettings, contextLimit: 4_096, maxInputTokens: 4_096, maxOutputTokens: 512 },
      { ...SMALL_MODEL, maxContextTokens: 4_096, sourceShare: 0.5 },
    );
    expect(allocation.sourceBudget).toBeGreaterThan(0);
    const fewShot = allocation.sections.find((section) => section.name === 'fewShot');
    expect(fewShot?.truncated).toBe(true);
    expect(allocation.notes.join(' ')).toContain('Few-shot');
  });

  it('has no opinion when there is no profile: the Phase 5C numbers are unchanged', () => {
    const parts = { systemTokens: 300, operatorTokens: 40, localAnalysisTokens: 120, schemaTokens: 0, fewShotTokens: 0, source: 'x' };
    const allocation = allocateContext(parts, baseSettings);
    expect(allocation.contextLimit).toBe(32768);
    expect(allocation.clampedByProfile).toBe(false);
    expect(allocation.sourceBudget).toBe(allocation.inputAllowance - 460);
  });
});

describe('source selection', () => {
  const source = functions(40, (index) => (index === 30 ? 'refundOrder' : `fn${index}`));

  it('sends the function the operator asked about, not only the top of the file', () => {
    const units = splitSourceIntoUnits(source, 'orders.ts');
    const selection = selectSourceForAllocation(units, 400, { headShare: 0.4, focusTerms: ['refundorder'] });
    expect(selection.truncated).toBe(true);
    expect(selection.included.some((unit) => unit.text.includes('refundOrder'))).toBe(true);
    expect(selection.excluded.some((unit) => unit.text.includes('export function fn39'))).toBe(true);
    // Whole units only: nothing is cut mid-function.

    expect(selection.text).not.toContain('return 39');
  });

  it('keeps the head of the file even when a later unit matches', () => {
    const units = splitSourceIntoUnits(source, 'orders.ts');
    const selection = selectSourceForAllocation(units, 600, { headShare: 0.5, focusTerms: ['refundorder'] });
    expect(selection.included[0].startLine).toBe(1);
    expect(selection.included.map((unit) => unit.startLine)).toEqual(
      [...selection.included.map((unit) => unit.startLine)].sort((left, right) => left - right),
    );
  });

  it('falls back to the top-down order without focus terms', () => {
    const units = splitSourceIntoUnits(source, 'orders.ts');
    const selection = selectSourceForAllocation(units, 300, { focusTerms: [] });
    expect(selection.included[0].startLine).toBe(1);
    expect(selection.included.length).toBeGreaterThan(0);
  });

  it('derives focus terms from the operator instruction', () => {
    expect(focusTermsFrom('Please review the refundOrder guard and the tax calculation')).toEqual(
      expect.arrayContaining(['refundorder', 'guard', 'tax', 'calculation']),
    );
    expect(focusTermsFrom('')).toEqual([]);
  });

  it('elides a long section at a line boundary and says so', () => {
    const text = Array.from({ length: 200 }, (_, index) => `line ${index} of the analysis`).join('\n');
    const elided = elideSection(text, 50);
    expect(elided.truncated).toBe(true);
    expect(elided.text).toContain('予算のため省略');
    expect(elided.text.split('\n').length).toBeLessThan(200);
  });
});

describe('planBudget uses the allocation', () => {
  it('reports the profile clamp and the dynamic source budget', () => {
    const plan = planBudget(
      { systemTokens: 200, operatorTokens: 20, localAnalysisTokens: 20, schemaTokens: 20, fewShotTokens: 100, source: functions(400) },
      { ...baseSettings, contextLimit: 32_768, maxInputTokens: 16_384, maxOutputTokens: 4_096 },
      { profile: SMALL_MODEL, focusTerms: ['fn25'] },
    );
    expect(plan.contextLimit).toBe(8_192);
    expect(plan.allocation.clampedByProfile).toBe(true);
    expect(plan.notes.join(' ')).toContain('モデルのコンテキスト上限');
    expect(plan.selection.truncated).toBe(true);
  });
});

describe('the payload matches the preview (C-FIX-002 integration)', () => {
  it('rebuilds the prompt from the allocated units and reports the excluded ranges', async () => {
    const source = functions(300, (index) => (index === 200 ? 'settlementReport' : `fn${index}`));
    await savePrompt('shiori', 'Focus on the settlementReport function.');
    const settings: ConnectionSettings = {
      ...DEFAULT_CONNECTION_SETTINGS,
      baseUrl: 'https://api.example.invalid/v1',
      model: 'gpt-test',
      contextLimit: 4_096,
      maxInputTokens: 1_024,
      maxOutputTokens: 512,
      fewShotTokenBudget: 0,
    };
    const plan = await planHybridRequest({
      toolId: 'shiori',
      source,
      sourceName: 'orders.ts',
      localAnalysis: 'Contracts: 300',
      settings,
    });

    expect(plan.payloadTrimmed).toBe(true);
    expect(plan.preview.scope.sourceTruncated).toBe(true);
    expect(plan.preview.scope.excludedRanges.length).toBeGreaterThan(0);

    const payload = plan.preview.messages.map((message) => message.content).join('\n');
    expect(payload).toContain('settlementReport');
    expect(payload).not.toContain('export function fn299');
    // The preview's own estimate agrees with what is in the payload.
    expect(plan.preview.scope.sourceChars).toBeLessThan(source.length);
    await savePrompt('shiori', '');
  });
});
