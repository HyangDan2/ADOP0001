/**
 * Haruhi (春日) — code to test case forge.
 *
 * The engine is split in three steps so that a generated test can never drift
 * from the case it came from:
 *   1. `ir.ts`  derives cases from the signature, guards, boundary values and
 *      error paths, storing the concrete inputs and the expectation (HAR-001).
 *   2. `emit.ts` renders one language from that single case list (HAR-002).
 *   3. this file assembles the result and reports the static branch mapping
 *      separately from executed coverage (HAR-003).
 */

import type { EngineAdapter, EngineRequest, EngineResult, ProviderMode } from '../../adapters/types';
import { baseName, sha256Hex } from '../../lib/util';
import { parseSource, type FunctionInfo } from '../../lib/source';
import {
  buildCases as buildCaseList,
  buildChecklist,
  type BranchCheck,
  type CaseKind,
  type CaseStatus,
  type Expectation,
  type TestCase,
  type TestInput,
} from './ir';
import { blockReason, emitGo, emitJunit, emitPytest, emitTs, type Framework } from './emit';

export type { BranchCheck, CaseKind, CaseStatus, Expectation, TestCase, TestInput, Framework };
export type { FunctionInfo };

export interface HaruhiOptions {
  framework: Framework;
  className?: string;
}

export interface StaticMappingSummary {
  /** Branches a generated (non-skipped) case targets. */
  mapped: number;
  /** Branches the generator could target but did not. */
  unmapped: number;
  /** Branches a unit test cannot reach (loops, catch blocks, unknown conditions). */
  unsupported: number;
  total: number;
}

export interface HaruhiOutput {
  cases: TestCase[];
  code: string;
  fileName: string;
  checklist: BranchCheck[];
  /**
   * Static branch mapping rate in percent. Kept for existing callers: this is
   * **not** executed code coverage. See `executedCoverage`.
   */
  coverage: number;
  staticMappingRate: number;
  staticMapping: StaticMappingSummary;
  /** Executed coverage is only known after the generated tests actually run. */
  executedCoverage: number | null;
  coverageLabel: string;
  executedCoverageLabel: string;
  notes: string[];
}

export const FRAMEWORK_LABEL: Record<Framework, string> = {
  vitest: 'Vitest',
  jest: 'Jest',
  pytest: 'Pytest',
  junit5: 'JUnit 5',
  go: 'Go testing',
};

/** Japanese label used by the UI for the static metric (HAR-003). */
export const STATIC_MAPPING_LABEL = '静的ブランチ対応率';
/** Japanese label used by the UI for executed coverage (HAR-003). */
export const EXECUTED_COVERAGE_LABEL = '実行カバレッジ';

export function outputFileName(framework: Framework, fileName: string): string {
  const base = baseName(fileName).replace(/[^A-Za-z0-9_-]/g, '') || 'source';
  switch (framework) {
    case 'vitest':
    case 'jest':
      return `${base}.test.ts`;
    case 'pytest':
      return `test_${base}.py`;
    case 'junit5':
      return `${base}Test.java`;
    case 'go':
      return `${base}_test.go`;
  }
}

export function forgeTests(fileName: string, source: string, options: HaruhiOptions): HaruhiOutput {
  const mod = parseSource(fileName, source);
  const cases = buildCaseList(mod);
  // A branch counts as mapped only when a test for it is really emitted, not skipped.
  const checklist = buildChecklist(mod, cases, (item) => blockReason(options.framework, mod, item) === null);
  const code = (() => {
    switch (options.framework) {
      case 'vitest':
        return emitTs('vitest', mod, cases);
      case 'jest':
        return emitTs('jest', mod, cases);
      case 'pytest':
        return emitPytest(mod, cases);
      case 'junit5':
        return emitJunit(mod, cases, { className: options.className });
      case 'go':
        return emitGo(mod, cases);
    }
  })();

  const mapped = checklist.filter((item) => item.status === 'mapped').length;
  const unsupported = checklist.filter((item) => item.status === 'unsupported').length;
  const unmapped = checklist.filter((item) => item.status === 'unmapped').length;
  const supported = mapped + unmapped;
  const staticMappingRate = supported ? Math.round((mapped / supported) * 100) : 0;

  const notes: string[] = [];
  if (cases.length === 0) notes.push('No functions were detected, so no test cases could be derived.');
  const skipped = cases.filter((item) => item.status === 'unsupported');
  if (skipped.length) {
    notes.push(`${skipped.length} case(s) are emitted as skipped with the reason written down; they do not verify anything yet.`);
  }
  const withValueTodo = cases.filter((item) => item.status === 'todo');
  if (withValueTodo.length) {
    notes.push(
      `${withValueTodo.length} case(s) assert the declared return type only; the exact value is left as a TODO.`,
    );
  }
  if (unsupported) {
    notes.push(
      `${unsupported} branch(es) cannot be reached by a generated unit test (loops, catch blocks or conditions with no derivable input).`,
    );
  }
  notes.push('The mapping rate is static: it counts targeted branches, not executed lines. Executed coverage is N/A until the generated tests run.');

  return {
    cases,
    code,
    fileName: outputFileName(options.framework, fileName),
    checklist,
    coverage: staticMappingRate,
    staticMappingRate,
    staticMapping: { mapped, unmapped, unsupported, total: checklist.length },
    executedCoverage: null,
    coverageLabel: `${STATIC_MAPPING_LABEL} ${staticMappingRate}%`,
    executedCoverageLabel: `${EXECUTED_COVERAGE_LABEL} N/A`,
    notes,
  };
}

export class HaruhiAdapter implements EngineAdapter<HaruhiOutput, HaruhiOptions> {
  readonly id = 'haruhi' as const;
  readonly title = 'Test Case Forge';
  readonly japaneseTitle = '春日';
  readonly providerMode: ProviderMode = 'local-static';
  readonly capabilities = [
    'シグネチャ・ガード・境界値・エラー経路からケースを導出',
    'Vitest／Jest・Pytest・JUnit 5・Go testing への出力',
    'Given / When / Then 構造と、生成コードと同じ入力値のテストケース',
    '静的ブランチ対応率と、未対応分岐の根拠（関数・行・ケース ID）',
  ] as const;

  async run(request: EngineRequest<HaruhiOptions>): Promise<EngineResult<HaruhiOutput>> {
    const started = performance.now();
    const options: HaruhiOptions = {
      framework: request.options?.framework ?? 'vitest',
      className: request.options?.className,
    };
    const output = forgeTests(request.sourceName, request.source, options);
    const cacheKey = await sha256Hex(`${this.id}|${request.mode}|${request.source}|${options.framework}`);
    return {
      output,
      providerMode: this.providerMode,
      diagnostics: output.notes.map((note) => ({ severity: 'info' as const, message: note })),
      elapsedMs: Math.round(performance.now() - started),
      cacheKey,
    };
  }
}
