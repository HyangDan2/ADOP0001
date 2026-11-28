import { GROUND_TRUTH, type GroundTruthCase } from '../../engine/project/groundTruth';
import { parseSource } from '../../engine/parser';

/**
 * WO-F02 — parser precision/recall over the hand-written ground truth.
 *
 * A case contributes three independent sets: function names, type name/kind
 * pairs and import module/external pairs. A prediction that the case does not
 * expect counts as a false positive, a missing expectation as a false negative.
 */

export interface QualityMiss {
  caseId: string;
  category: 'function' | 'type' | 'import';
  expected?: string;
  actual?: string;
}

export interface LanguageQuality {
  language: string;
  cases: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  misses: QualityMiss[];
}

export interface ParserQualityReport {
  languages: LanguageQuality[];
  overall: LanguageQuality;
  cases: number;
}

const ratio = (numerator: number, denominator: number): number =>
  denominator === 0 ? 1 : Math.round((numerator / denominator) * 10_000) / 10_000;

function scoreCase(testCase: GroundTruthCase): {
  tp: number;
  fp: number;
  fn: number;
  misses: QualityMiss[];
} {
  const module = parseSource(testCase.fileName, testCase.source);
  const misses: QualityMiss[] = [];
  let tp = 0;
  let fp = 0;
  let fn = 0;

  const names = new Set(module.functions.map((fnInfo) => fnInfo.name));
  const expectedFunctions = new Set(testCase.expected.functions);
  for (const name of expectedFunctions) {
    if (names.has(name)) tp += 1;
    else {
      fn += 1;
      misses.push({ caseId: testCase.id, category: 'function', expected: name });
    }
  }
  for (const name of names) {
    if (!expectedFunctions.has(name)) {
      fp += 1;
      misses.push({ caseId: testCase.id, category: 'function', actual: name });
    }
  }

  const typeKeys = new Set(module.types.map((type) => `${type.name}:${type.kind}`));
  const expectedTypes = new Set(testCase.expected.types.map((type) => `${type.name}:${type.kind}`));
  for (const key of expectedTypes) {
    if (typeKeys.has(key)) tp += 1;
    else {
      fn += 1;
      misses.push({ caseId: testCase.id, category: 'type', expected: key });
    }
  }
  for (const key of typeKeys) {
    if (!expectedTypes.has(key)) {
      fp += 1;
      misses.push({ caseId: testCase.id, category: 'type', actual: key });
    }
  }

  const importKeys = new Set(
    module.imports.map((entry) => `${entry.module}:${entry.external ? 'external' : 'internal'}`),
  );
  const expectedImports = new Set(
    testCase.expected.imports.map((entry) => `${entry.module}:${entry.external ? 'external' : 'internal'}`),
  );
  for (const key of expectedImports) {
    if (importKeys.has(key)) tp += 1;
    else {
      fn += 1;
      misses.push({ caseId: testCase.id, category: 'import', expected: key });
    }
  }
  for (const key of importKeys) {
    if (!expectedImports.has(key)) {
      fp += 1;
      misses.push({ caseId: testCase.id, category: 'import', actual: key });
    }
  }

  return { tp, fp, fn, misses };
}

function finish(language: string, cases: number, tp: number, fp: number, fn: number, misses: QualityMiss[]): LanguageQuality {
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const f1 = precision + recall === 0 ? 0 : Math.round(((2 * precision * recall) / (precision + recall)) * 10_000) / 10_000;
  return { language, cases, truePositives: tp, falsePositives: fp, falseNegatives: fn, precision, recall, f1, misses };
}

export function evaluateParserQuality(cases: readonly GroundTruthCase[] = GROUND_TRUTH): ParserQualityReport {
  const perLanguage = new Map<string, LanguageQuality>();
  let totalTp = 0;
  let totalFp = 0;
  let totalFn = 0;
  const allMisses: QualityMiss[] = [];

  for (const testCase of cases) {
    const result = scoreCase(testCase);
    totalTp += result.tp;
    totalFp += result.fp;
    totalFn += result.fn;
    allMisses.push(...result.misses);
    const key = testCase.language;
    const existing = perLanguage.get(key);
    const merged = existing
      ? { ...existing, truePositives: existing.truePositives + result.tp, falsePositives: existing.falsePositives + result.fp, falseNegatives: existing.falseNegatives + result.fn, misses: [...existing.misses, ...result.misses] }
      : finish(key, 1, result.tp, result.fp, result.fn, result.misses);
    perLanguage.set(key, { ...merged, cases: (existing?.cases ?? 0) + 1 });
  }

  const languages = [...perLanguage.values()].map((entry) =>
    finish(entry.language, entry.cases, entry.truePositives, entry.falsePositives, entry.falseNegatives, entry.misses),
  );
  return {
    languages,
    overall: finish('all', cases.length, totalTp, totalFp, totalFn, allMisses),
    cases: cases.length,
  };
}
