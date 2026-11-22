/**
 * DATA-001 — the built-in samples are working examples, not decoration.
 *
 * Every entry in `SAMPLE_BY_EXT` is pushed through the same engines the UI uses,
 * so a sample that the analyser cannot read, or that produces an unreadable
 * specification, fails here instead of in front of a user. Language detection is
 * checked against the file name as well: loading a sample must leave the footer
 * language and the sample's own syntax in step.
 */
import { describe, expect, it } from 'vitest';
import { SAMPLE_BY_EXT } from '../src/tools/samples';
import { detectLanguage, parseSource } from '../src/lib/source';
import { buildSpecModel, specToMarkdown } from '../src/tools/shiori/adapter';
import { forgeTests, type Framework } from '../src/tools/haruhi/adapter';

const EXPECTED_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  py: 'python',
  java: 'java',
  go: 'go',
};

const FRAMEWORKS: Framework[] = ['vitest', 'jest', 'pytest', 'junit5', 'go'];

function extensionOf(fileName: string): string {
  return fileName.slice(fileName.lastIndexOf('.') + 1);
}

describe('DATA-001 built-in samples', () => {
  it('offers several languages with unique labels and file names', () => {
    expect(SAMPLE_BY_EXT.length).toBeGreaterThanOrEqual(5);
    expect(new Set(SAMPLE_BY_EXT.map((sample) => sample.label)).size).toBe(SAMPLE_BY_EXT.length);
    expect(new Set(SAMPLE_BY_EXT.map((sample) => sample.fileName)).size).toBe(SAMPLE_BY_EXT.length);
    const languages = new Set(SAMPLE_BY_EXT.map((sample) => extensionOf(sample.fileName)));
    for (const language of ['ts', 'js', 'py', 'java', 'go']) {
      expect(languages.has(language), `no ${language} sample`).toBe(true);
    }
  });

  it('keeps every sample’s language in step with its file name', () => {
    for (const sample of SAMPLE_BY_EXT) {
      const expected = EXPECTED_LANGUAGE[extensionOf(sample.fileName)];
      expect(expected, `${sample.label} has an unknown extension`).toBeTruthy();
      expect(detectLanguage(sample.fileName, sample.code), sample.label).toBe(expected);

      const parsed = parseSource(sample.fileName, sample.code);
      expect(parsed.language, sample.label).toBe(expected);
      expect(parsed.functions.length, `${sample.label} exposes no function`).toBeGreaterThanOrEqual(2);
      // A sample that needs diagnostics to be understood is not a good example.
      expect(parsed.diagnostics, `${sample.label} is only partially parsed`).toEqual([]);
      expect(parsed.notes, `${sample.label} produced analysis notes`).toEqual([]);
    }
  });

  it('turns every sample into a full specification', () => {
    for (const sample of SAMPLE_BY_EXT) {
      const model = buildSpecModel(sample.fileName, sample.code);
      const markdown = specToMarkdown(model);
      expect(model.functionCount, sample.label).toBeGreaterThanOrEqual(2);
      expect(markdown, sample.label).toContain('## 2. Contract table');
      expect(markdown, sample.label).not.toMatch(/[\uac00-\ud7af]/);
      // The contract table must list a real member of the sample.
      for (const contract of model.contracts.slice(0, 3)) {
        expect(markdown, `${sample.label}: ${contract.name}`).toContain(contract.name);
      }
    }
  });

  it('forges runnable tests for every sample and framework', () => {
    for (const sample of SAMPLE_BY_EXT) {
      for (const framework of FRAMEWORKS) {
        const output = forgeTests(sample.fileName, sample.code, { framework });
        expect(output.cases.length, `${sample.label} / ${framework}`).toBeGreaterThan(0);
        expect(output.code.length, `${sample.label} / ${framework}`).toBeGreaterThan(200);
        expect(output.code, `${sample.label} / ${framework}`).not.toContain('assertTrue(true)');
        if (framework === 'go') {
          const names = [...output.code.matchAll(/^func (Test\w+)\(t \*testing\.T\)/gm)].map((match) => match[1]);
          expect(names.length, `${sample.label} / go`).toBeGreaterThan(0);
          expect(new Set(names).size, `${sample.label} / go duplicate test name`).toBe(names.length);
        }
      }
    }
  });

  it('keeps the generics-heavy TypeScript sample readable', () => {
    const sample = SAMPLE_BY_EXT.find((item) => item.fileName === 'result-pipeline.ts');
    expect(sample).toBeTruthy();
    const parsed = parseSource(sample!.fileName, sample!.code);
    const names = parsed.functions.map((fn) => (fn.className ? `${fn.className}.${fn.name}` : fn.name));
    expect(names).toContain('ResultPipeline.run');
    expect(names).toContain('ResultPipeline.attempt');
    const run = parsed.functions.find((fn) => fn.name === 'run');
    expect(run?.async).toBe(true);
    expect(run?.returnType).toContain('Promise');
  });

  it('keeps the asynchronous Python sample readable', () => {
    const sample = SAMPLE_BY_EXT.find((item) => item.fileName === 'async_repository.py');
    expect(sample).toBeTruthy();
    const parsed = parseSource(sample!.fileName, sample!.code);
    const names = parsed.functions.map((fn) => (fn.className ? `${fn.className}.${fn.name}` : fn.name));
    expect(names).toContain('AsyncRepository.fetch');
    expect(names).toContain('AsyncRepository.fetch_many');
    const fetch = parsed.functions.find((fn) => fn.name === 'fetch');
    expect(fetch?.async).toBe(true);
  });

  it('keeps the JavaScript sample free of TypeScript syntax', () => {
    const sample = SAMPLE_BY_EXT.find((item) => item.fileName === 'job-queue.js');
    expect(sample).toBeTruthy();
    const parsed = parseSource(sample!.fileName, sample!.code);
    expect(parsed.language).toBe('javascript');
    expect(sample!.code).not.toMatch(/:\s*(string|number|boolean)\b\s*[),=]/);
    expect(parsed.functions.some((fn) => fn.name === 'add')).toBe(true);
  });
});
