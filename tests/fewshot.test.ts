import { beforeEach, describe, expect, it } from 'vitest';
import {
  activeExampleCounts,
  assemblePromptPreview,
  budgetExamples,
  bundleFileName,
  clearExamples,
  deleteExample,
  estimateTokens,
  exampleTokenCost,
  importExamples,
  listExamples,
  parseBundle,
  renderPromptText,
  resetFewShotStore,
  saveExample,
  serializeBundle,
  setExampleEnabled,
  systemPromptFor,
  totalTokens,
  type FewShotDraft,
} from '../src/lib/fewShotStore';
import type { FewShotExample } from '../src/adapters/types';

const PYTHON_EXAMPLE = 'class PaymentRequest:\n    invoice_id: str\n';
const SPEC_EXAMPLE = '# Specification - payment-service\n\n## 2. Contract table\n';

const draft = (overrides: Partial<FewShotDraft> = {}): FewShotDraft => ({
  toolId: 'takane',
  title: 'payment example',
  inputText: SPEC_EXAMPLE,
  outputText: PYTHON_EXAMPLE,
  targetLanguage: 'python',
  enabled: true,
  ...overrides,
});

beforeEach(async () => {
  await resetFewShotStore();
});

describe('token estimation', () => {
  it('counts ASCII at four characters per token and CJK at ~1.6', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('hello world')).toBe(3);
    expect(estimateTokens('가'.repeat(8))).toBe(5);
    expect(estimateTokens('abcdefgh')).toBe(2);
  });

  it('sums the input and the output of an example', () => {
    expect(exampleTokenCost({ inputText: 'abcd', outputText: 'abcdefgh' })).toBe(3);
    expect(exampleTokenCost({ outputText: 'abcdefgh' })).toBe(2);
  });
});

describe('few-shot store', () => {
  it('saves an example with a derived role, token count and timestamp', async () => {
    const saved = await saveExample(draft());
    expect(saved.id).toBeTruthy();
    expect(saved.role).toBe('pair');
    expect(saved.title).toBe('payment example');
    expect(saved.targetLanguage).toBe('python');
    expect(saved.estimatedTokens).toBe(estimateTokens(SPEC_EXAMPLE) + estimateTokens(PYTHON_EXAMPLE));
    expect(saved.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await listExamples('takane')).toHaveLength(1);
    expect(await listExamples('shiori')).toHaveLength(0);
  });

  it('stores an output-only example when no input is given', async () => {
    const saved = await saveExample(draft({ inputText: undefined }));
    expect(saved.role).toBe('output');
    expect(saved.inputText).toBeUndefined();
  });

  it('requires output text', async () => {
    await expect(saveExample(draft({ outputText: '   ' }))).rejects.toThrow(/output text/i);
  });

  it('falls back to the output file name as the title', async () => {
    const saved = await saveExample(draft({ title: '', outputFileName: 'emitter.c' }));
    expect(saved.title).toBe('emitter.c');
  });

  it('updates, toggles, deletes and clears', async () => {
    const first = await saveExample(draft());
    const second = await saveExample(draft({ title: 'second', outputText: 'int main(void) { return 0; }\n' }));

    const disabled = await setExampleEnabled(first.id, false);
    expect(disabled?.enabled).toBe(false);
    expect((await activeExampleCounts()).takane).toBe(1);

    const edited = await saveExample(draft({ id: first.id, title: 'edited' }));
    expect(edited.title).toBe('edited');
    expect(await listExamples('takane')).toHaveLength(2);

    expect(await deleteExample(second.id)).toBe(true);
    expect(await listExamples('takane')).toHaveLength(1);

    expect(await clearExamples('takane')).toBe(1);
    expect(await listExamples()).toHaveLength(0);
  });

  it('keeps examples per tool', async () => {
    await saveExample(draft());
    await saveExample(draft({ toolId: 'haruhi', targetLanguage: 'vitest' }));
    expect((await listExamples('takane')).length).toBe(1);
    expect((await listExamples('haruhi')).length).toBe(1);
    const counts = await activeExampleCounts();
    expect(counts.takane).toBe(1);
    expect(counts.haruhi).toBe(1);
    expect(counts.shiori).toBe(0);
  });
});

describe('few-shot token budget', () => {
  const example = (id: string, tokens: number, enabled = true): FewShotExample => ({
    id,
    toolId: 'takane',
    title: id,
    role: 'output',
    outputText: 'x',
    enabled,
    estimatedTokens: tokens,
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  it('keeps the deterministic order and skips what does not fit', () => {
    const result = budgetExamples([example('a', 40), example('b', 90), example('c', 10)], 60);
    expect(result.selected.map((item) => item.id)).toEqual(['a', 'c']);
    expect(result.tokens).toBe(50);
    expect(result.skipped.map((item) => item.id)).toEqual(['b']);
  });

  it('ignores disabled examples', () => {
    const result = budgetExamples([example('a', 10), example('b', 10, false)], 100);
    expect(result.selected.map((item) => item.id)).toEqual(['a']);
  });
});

describe('few-shot bundle export and import', () => {
  it('round-trips through .fewshot.json', async () => {
    const saved = await saveExample(draft());
    const json = serializeBundle([saved], '2026-11-21T00:00:00.000Z');
    const bundle = JSON.parse(json) as { kind: string; version: number; examples: unknown[] };
    expect(bundle.kind).toBe('adop0001.fewshot');
    expect(bundle.version).toBe(1);
    expect(bundle.examples).toHaveLength(1);

    await resetFewShotStore();
    const parsed = parseBundle(json);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].outputText).toBe(PYTHON_EXAMPLE);
    expect(parsed[0].estimatedTokens).toBeGreaterThan(0);
    await importExamples(parsed);
    expect(await listExamples('takane')).toHaveLength(1);
  });

  it('rejects anything that is not a bundle', () => {
    expect(() => parseBundle('not json')).toThrow(/valid JSON/i);
    expect(() => parseBundle(JSON.stringify({ kind: 'other', version: 1, examples: [] }))).toThrow(/bundle/i);
    expect(() =>
      parseBundle(JSON.stringify({ kind: 'adop0001.fewshot', version: 1, examples: [{ toolId: 'takane', outputText: '' }] })),
    ).toThrow(/output text/i);
  });

  it('names the bundle per tool', () => {
    expect(bundleFileName('takane')).toBe('takane-fewshot.fewshot.json');
    expect(bundleFileName('all')).toBe('all-fewshot.fewshot.json');
  });
});

describe('Option B prompt assembly preview', () => {
  it('builds a few-shot prompt from the enabled examples only', async () => {
    const pair = await saveExample(draft());
    await saveExample(draft({ title: 'disabled one', enabled: false }));

    const assembly = assemblePromptPreview({
      toolId: 'takane',
      examples: await listExamples('takane'),
      source: SPEC_EXAMPLE,
      sourceName: 'payment-service.spec.md',
    });

    expect(assembly.strategy).toBe('few-shot');
    expect(assembly.shots).toHaveLength(1);
    expect(assembly.shots[0].title).toBe(pair.title);
    expect(assembly.shots[0].role).toBe('pair');
    expect(assembly.shots[0].content).toContain('INPUT:');
    expect(assembly.shots[0].content).toContain(PYTHON_EXAMPLE.trim());
    expect(assembly.system).toBe(systemPromptFor('takane'));
    expect(assembly.tokens.shots).toBe(pair.estimatedTokens);
    expect(assembly.tokens.total).toBe(
      assembly.tokens.system + assembly.tokens.shots + assembly.tokens.target,
    );

    const rendered = renderPromptText(assembly);
    expect(rendered).toContain('# strategy: few-shot');
    expect(rendered).toContain('## system');
    expect(rendered).toContain('## examples (1)');
    expect(rendered).toContain('## target source (payment-service.spec.md)');
    expect(rendered).toContain('Spec to Code');
  });

  it('falls back to zero-shot with no enabled example', () => {
    const assembly = assemblePromptPreview({ toolId: 'shiori', examples: [], source: '', sourceName: 'empty.ts' });
    expect(assembly.strategy).toBe('zero-shot');
    expect(assembly.shots).toHaveLength(0);
    expect(renderPromptText(assembly)).toContain('No enabled example is selected');
  });

  it('reports examples left out by the few-shot cap', () => {
    const examples: FewShotExample[] = [
      {
        id: 'huge',
        toolId: 'takane',
        title: 'huge example',
        role: 'output',
        outputText: 'x',
        enabled: true,
        estimatedTokens: 5000,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'small',
        toolId: 'takane',
        title: 'small example',
        role: 'output',
        outputText: 'y',
        enabled: true,
        estimatedTokens: 12,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    const assembly = assemblePromptPreview({ toolId: 'takane', examples, source: 's', sourceName: 's.md' });
    expect(assembly.shots.map((shot) => shot.title)).toEqual(['small example']);
    expect(assembly.skipped).toEqual(['huge example']);
    expect(renderPromptText(assembly)).toContain('skipped');
  });

  it('totals every enabled example for the counter', async () => {
    const one = await saveExample(draft());
    const two = await saveExample(draft({ title: 'two' }));
    const all = await listExamples('takane');
    expect(totalTokens(all)).toBe(one.estimatedTokens + two.estimatedTokens);
  });
});
