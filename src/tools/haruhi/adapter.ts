/**
 * Haruhi (春日) — code to test case forge.
 * Derives cases from signatures, guards, boundary values and error paths, then
 * emits runnable skeletons for Vitest/Jest, Pytest, JUnit 5 and Go testing.
 */

import type { EngineAdapter, EngineRequest, EngineResult, ProviderMode } from '../../adapters/types';
import { baseName, sha256Hex } from '../../lib/util';
import { parseSource, type FunctionInfo, type Param } from '../../lib/source';

export type Framework = 'vitest' | 'jest' | 'pytest' | 'junit5' | 'go';
export type CaseKind = 'happy' | 'boundary' | 'error' | 'guard';

export interface TestCase {
  id: string;
  fn: FunctionInfo;
  title: string;
  kind: CaseKind;
  given: string[];
  when: string;
  then: string;
  /** Line of the guard / error this case exercises, when applicable. */
  sourceLine?: number;
}

export interface BranchCheck {
  branch: string;
  function: string;
  line: number;
  covered: boolean;
  caseId?: string;
}

export interface HaruhiOptions {
  framework: Framework;
  className?: string;
}

export interface HaruhiOutput {
  cases: TestCase[];
  code: string;
  fileName: string;
  checklist: BranchCheck[];
  coverage: number;
  notes: string[];
}

export const FRAMEWORK_LABEL: Record<Framework, string> = {
  vitest: 'Vitest / Jest',
  jest: 'Jest',
  pytest: 'Pytest',
  junit5: 'JUnit 5',
  go: 'Go testing',
};

function sampleValue(param: Param): string {
  const type = (param.type ?? '').toLowerCase();
  if (type.includes('number') || type.includes('int') || type.includes('float') || type.includes('double') || type === 'long') return '42';
  if (type.includes('bool')) return 'true';
  if (type.includes('[]') || type.includes('array') || type.includes('list')) return '[]';
  if (type.includes('string')) return "'sample'";
  if (param.defaultValue !== undefined) return param.defaultValue;
  return 'undefined';
}

function boundaryValues(param: Param): { label: string; value: string }[] {
  const type = (param.type ?? '').toLowerCase();
  if (type.includes('number') || type.includes('int') || type.includes('float') || type.includes('double') || type === 'long') {
    return [
      { label: 'zero', value: '0' },
      { label: 'negative', value: '-1' },
    ];
  }
  if (type.includes('string')) {
    return [
      { label: 'empty string', value: "''" },
      { label: 'whitespace only', value: "'   '" },
    ];
  }
  if (type.includes('[]') || type.includes('array') || type.includes('list')) {
    return [{ label: 'empty collection', value: '[]' }];
  }
  return [{ label: 'null', value: 'null' }];
}

function pythonBoundary(param: Param): { label: string; value: string }[] {
  const type = (param.type ?? '').toLowerCase();
  if (type.includes('int') || type.includes('float')) return [{ label: 'zero', value: '0' }, { label: 'negative', value: '-1' }];
  if (type.includes('str')) return [{ label: 'empty string', value: "''" }, { label: 'whitespace only', value: "'   '" }];
  if (type.includes('list')) return [{ label: 'empty list', value: '[]' }];
  return [{ label: 'none', value: 'None' }];
}

function buildCases(mod: ReturnType<typeof parseSource>): TestCase[] {
  const cases: TestCase[] = [];
  let counter = 0;
  const nextId = () => `TC-${String((counter += 1)).padStart(2, '0')}`;

  for (const fn of mod.functions) {
    const label = fn.className ? `${fn.className}.${fn.name}` : fn.name;
    const args = fn.params.map(sampleValue).join(', ');
    cases.push({
      id: nextId(),
      fn,
      title: `${label} returns a result for valid input`,
      kind: 'happy',
      given: fn.params.length
        ? fn.params.map((p) => `a valid ${p.type ?? 'value'} for "${p.name}"`)
        : ['no arguments'],
      when: `${label}(${args}) is called`,
      then: fn.returnType && !fn.returnType.includes('void') ? `a ${fn.returnType} is returned` : 'the call completes without throwing',
    });

    for (const param of fn.params.slice(0, 2)) {
      for (const boundary of boundaryValues(param)) {
        cases.push({
          id: nextId(),
          fn,
          title: `${label} handles ${boundary.label} "${param.name}"`,
          kind: 'boundary',
          given: [`"${param.name}" is ${boundary.label}`],
          when: `${label}(${fn.params.map((p) => (p.name === param.name ? boundary.value : sampleValue(p))).join(', ')}) is called`,
          then: 'the result is defined and no unhandled exception escapes',
        });
      }
    }

    for (const guard of fn.guards) {
      cases.push({
        id: nextId(),
        fn,
        title: `${label} follows the guard "${guard.condition.slice(0, 48)}"`,
        kind: guard.action === 'return' ? 'guard' : 'error',
        given: [`the input makes "${guard.condition}" true`],
        when: `${label} is called`,
        then: guard.action === 'return' ? 'the function returns early without side effects' : 'the expected error is raised',
        sourceLine: guard.line,
      });
    }

    for (const error of fn.errors) {
      if (fn.guards.some((g) => g.line === error.line)) continue;
      cases.push({
        id: nextId(),
        fn,
        title: `${label} raises ${error.error} on the failure path`,
        kind: 'error',
        given: [error.message ? `the condition that triggers "${error.message}"` : 'an invalid state'],
        when: `${label} is called`,
        then: `${error.error} is thrown`,
        sourceLine: error.line,
      });
    }
  }

  return cases;
}

function buildChecklist(mod: ReturnType<typeof parseSource>, cases: TestCase[]): BranchCheck[] {
  const checks: BranchCheck[] = [];
  for (const fn of mod.functions) {
    for (const stmt of fn.body) {
      if (!['if', 'for', 'while', 'catch'].includes(stmt.kind)) continue;
      const match = cases.find((c) => c.fn.name === fn.name && c.sourceLine === stmt.line);
      checks.push({
        branch: stmt.text.slice(0, 70),
        function: fn.name,
        line: stmt.line,
        covered: Boolean(match),
        caseId: match?.id,
      });
    }
    for (const error of fn.errors) {
      const covered = cases.some((c) => c.fn.name === fn.name && (c.sourceLine === error.line || c.kind === 'error'));
      checks.push({
        branch: `throw ${error.error}`,
        function: fn.name,
        line: error.line,
        covered,
      });
    }
  }
  return checks;
}

function tsCase(testCase: TestCase, index: number): string {
  const call = `${testCase.fn.name}(${testCase.fn.params.map(sampleValue).join(', ')})`;
  const lines: string[] = [];
  lines.push(`  it('${escapeSingle(testCase.title)}', async () => {`);
  for (const given of testCase.given) lines.push(`    // Given ${given}`);
  lines.push(`    // When`);
  lines.push(`    // Then`);
  if (testCase.kind === 'error') {
    lines.push(`    await expect(async () => ${call}).rejects.toThrow();`);
  } else if (testCase.kind === 'guard') {
    lines.push(`    expect(() => ${call}).not.toThrow();`);
  } else if (testCase.kind === 'boundary') {
    lines.push(`    const result = ${call};`);
    lines.push('    expect(result).toBeDefined();');
  } else {
    lines.push(`    const result = ${call};`);
    lines.push(`    expect(result).toBeDefined();`);
  }
  if (index === 0) lines.push(`    // Skeleton only: assert real behaviour once the contract is confirmed.`);
  lines.push('  });');
  return lines.join('\n');
}

function escapeSingle(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function emitTs(framework: 'vitest' | 'jest', mod: ReturnType<typeof parseSource>, cases: TestCase[]): string {
  const modulePath = `./${baseName(mod.fileName)}`;
  const fnNames = [
    ...new Set(cases.filter((c) => c.fn.exported && !c.fn.isMethod).map((c) => c.fn.name)),
  ];
  const classNames = [...new Set(cases.filter((c) => c.fn.className).map((c) => c.fn.className as string))];
  const external = mod.imports.filter((i) => i.external);
  const head: string[] = [];
  head.push(`import { describe, it, expect, ${framework === 'vitest' ? 'vi' : 'jest'} } from '${framework}';`);
  const named = [...fnNames, ...classNames];
  if (named.length) head.push(`import { ${named.join(', ')} } from '${modulePath.replace(/\.(ts|js|tsx|jsx)$/, '')}';`);
  head.push('');
  for (const imp of external.slice(0, 3)) {
    head.push(`// Mock boundary: ${imp.module} (replace with a real stub before enabling)`);
    head.push(`${framework === 'vitest' ? 'vi' : 'jest'}.mock('${imp.module}', () => ({ default: ${framework === 'vitest' ? 'vi' : 'jest'}.fn() }));`);
  }
  if (external.length) head.push('');

  const body: string[] = [];
  const byFn = new Map<string, TestCase[]>();
  for (const c of cases) {
    const key = c.fn.className ?? c.fn.name;
    byFn.set(key, [...(byFn.get(key) ?? []), c]);
  }
  for (const [fnLabel, group] of byFn) {
    body.push(`describe('${escapeSingle(fnLabel)}', () => {`);
    group.forEach((testCase, index) => body.push(tsCase(testCase, index)));
    body.push('});');
    body.push('');
  }

  return `${head.join('\n')}\n${body.join('\n')}`.trimEnd() + '\n';
}

function emitPytest(mod: ReturnType<typeof parseSource>, cases: TestCase[]): string {
  const moduleName = baseName(mod.fileName);
  const fnNames = [...new Set(cases.filter((c) => !c.fn.isMethod).map((c) => c.fn.name))];
  const lines: string[] = [];
  lines.push('"""Generated by HD2Lab Aomatsukan - Haruhi. Skeleton tests: assert real behaviour."""', '');
  lines.push('import pytest', '');
  if (fnNames.length) lines.push(`from ${moduleName} import ${fnNames.join(', ')}`, '');

  const byFn = new Map<string, TestCase[]>();
  for (const c of cases) byFn.set(c.fn.name, [...(byFn.get(c.fn.name) ?? []), c]);
  for (const [fnName, group] of byFn) {
    lines.push(`class Test${fnName.charAt(0).toUpperCase()}${fnName.slice(1)}:`);
    for (const testCase of group) {
      const snake = testCase.title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60);
      lines.push(`    def test_${snake || 'case'}(self):`);
      for (const given of testCase.given) lines.push(`        # Given ${given}`);
      lines.push('        # When');
      const args = testCase.fn.params.map((p) => pythonArgValue(p, testCase.kind === 'boundary')).join(', ');
      if (testCase.kind === 'error') {
        lines.push('        with pytest.raises(Exception):');
        lines.push(`            ${fnName}(${args})`);
      } else {
        lines.push(`        result = ${fnName}(${args})`);
        lines.push('        # Then');
        lines.push('        assert result is not None');
      }
      lines.push('');
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function pythonArgValue(param: Param, boundary: boolean): string {
  const type = (param.type ?? '').toLowerCase();
  if (boundary) {
    const values = pythonBoundary(param);
    if (values.length) return values[0].value;
  }
  if (type.includes('int')) return '42';
  if (type.includes('float')) return '1.5';
  if (type.includes('str')) return "'sample'";
  if (type.includes('list')) return '[]';
  if (type.includes('bool')) return 'True';
  return 'None';
}

function emitJunit(mod: ReturnType<typeof parseSource>, cases: TestCase[], options: HaruhiOptions): string {
  const className = options.className ?? `${baseName(mod.fileName).replace(/[^A-Za-z0-9]/g, '') || 'Source'}Test`;
  const underTest = baseName(mod.fileName).replace(/[^A-Za-z0-9]/g, '') || 'Source';
  const lines: string[] = [];
  lines.push('import org.junit.jupiter.api.Test;');
  lines.push('import static org.junit.jupiter.api.Assertions.*;');
  lines.push('');
  lines.push(`class ${className} {`);
  lines.push('');
  lines.push('    @Test');
  const byFn = new Map<string, TestCase[]>();
  for (const c of cases) byFn.set(c.fn.name, [...(byFn.get(c.fn.name) ?? []), c]);
  let first = true;
  for (const [fnName, group] of byFn) {
    for (const testCase of group) {
      const method = testCase.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').slice(0, 5);
      const javaName = method.map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1))).join('') || 'case';
      if (!first) lines.push('', '    @Test');
      first = false;
      lines.push(`    void ${javaName}() throws Exception {`);
      for (const given of testCase.given) lines.push(`        // Given ${given}`);
      lines.push('        // When');
      if (testCase.kind === 'error') {
        lines.push(`        assertThrows(Exception.class, () -> new ${underTest}().${fnName}());`);
      } else {
        lines.push(`        // TODO: instantiate ${underTest} and invoke ${fnName}`);
        lines.push('        assertTrue(true);');
      }
      lines.push('        // Then');
      lines.push('    }');
    }
  }
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

function emitGo(mod: ReturnType<typeof parseSource>, cases: TestCase[]): string {
  const pkg = baseName(mod.fileName).replace(/[^A-Za-z0-9]/g, '').toLowerCase() || 'sample';
  const lines: string[] = [];
  lines.push(`package ${pkg}_test`, '');
  lines.push('import (', '\t"testing"', ')', '');
  for (const testCase of cases) {
    const fnName = testCase.fn.name;
    const goName = `Test${fnName.charAt(0).toUpperCase()}${fnName.slice(1)}_${testCase.kind}`;
    lines.push(`func ${goName}(t *testing.T) {`);
    for (const given of testCase.given) lines.push(`\t// Given ${given}`);
    lines.push('\t// When');
    const args = testCase.fn.params.map((p) => (p.type?.includes('string') ? '"sample"' : p.type?.includes('int') ? '42' : 'nil')).join(', ');
    lines.push(`\tgot := ${fnName}(${args})`);
    lines.push('\t// Then');
    if (testCase.kind === 'error') {
      lines.push('\tif got == nil {', `\t\tt.Fatal("expected an error from ${fnName}")`, '\t}');
    } else {
      lines.push('\t_ = got');
      lines.push('\tt.Log("assert the contract here")');
    }
    lines.push('}', '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

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
  const cases = buildCases(mod);
  const checklist = buildChecklist(mod, cases);
  const code = (() => {
    switch (options.framework) {
      case 'vitest': return emitTs('vitest', mod, cases);
      case 'jest': return emitTs('jest', mod, cases);
      case 'pytest': return emitPytest(mod, cases);
      case 'junit5': return emitJunit(mod, cases, options);
      case 'go': return emitGo(mod, cases);
    }
  })();
  const covered = checklist.filter((c) => c.covered).length;
  const coverage = checklist.length ? Math.round((covered / checklist.length) * 100) : 100;
  const notes: string[] = [];
  if (cases.length === 0) notes.push('No functions were detected, so no test cases could be derived.');
  if (cases.some((c) => c.kind === 'error')) notes.push('Error-path cases assert the error type only; tighten the assertion once messages are stable.');
  return { cases, code, fileName: outputFileName(options.framework, fileName), checklist, coverage, notes };
}

export class HaruhiAdapter implements EngineAdapter<HaruhiOutput, HaruhiOptions> {
  readonly id = 'haruhi' as const;
  readonly title = 'Test Case Forge';
  readonly japaneseTitle = '春日';
  readonly providerMode: ProviderMode = 'local-static';
  readonly capabilities = [
    'シグネチャ・ガード・境界値・エラー経路からケースを導出',
    'Vitest／Jest・Pytest・JUnit 5・Go testing への出力',
    'Given / When / Then 構造とアサーション雛形',
    '未カバー分岐チェックリストとカバレッジ推定',
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

export type { FunctionInfo };
