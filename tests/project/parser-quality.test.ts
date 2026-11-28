import { describe, expect, it } from 'vitest';
import { GROUND_TRUTH } from '../../src/engine/project/groundTruth';
import { evaluateParserQuality } from '../../src/features/project/parserQuality';

describe('WO-F01/F02 parser ground truth', () => {
  it('covers every supported language at least once', () => {
    const languages = new Set(GROUND_TRUTH.map((entry) => entry.language));
    for (const language of ['typescript', 'javascript', 'python', 'java', 'go', 'c', 'cpp', 'csharp'] as const) {
      expect(languages.has(language), `${language} has no ground-truth case`).toBe(true);
    }
  });

  it('reaches precision and recall of at least 0.9 per language', () => {
    const report = evaluateParserQuality();
    const failures = report.languages
      .filter((entry) => entry.precision < 0.9 || entry.recall < 0.9)
      .map((entry) => `${entry.language}: precision ${entry.precision}, recall ${entry.recall} (${JSON.stringify(entry.misses)})`);
    expect(failures).toEqual([]);
  });

  it('reaches F1 of at least 0.95 overall', () => {
    const report = evaluateParserQuality();
    expect(report.overall.f1).toBeGreaterThanOrEqual(0.95);
  });

  it('is deterministic across runs', () => {
    expect(evaluateParserQuality()).toEqual(evaluateParserQuality());
  });
});
