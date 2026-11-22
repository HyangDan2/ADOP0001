/**
 * Phase 1 regression matrix — Haruhi (HAR-001, HAR-002, HAR-003).
 *
 * Every expectation below describes behaviour that the work order requires and
 * that the pre-fix engine did not provide: cases carried a sample value instead
 * of their own boundary input, and the emitters ignored the case data.
 */
import { describe, expect, it } from 'vitest';
import { forgeTests } from '../src/tools/haruhi/adapter';
import {
  HARUHI_RELIABILITY_GO,
  HARUHI_RELIABILITY_JAVA,
  HARUHI_RELIABILITY_PY,
  HARUHI_RELIABILITY_TS,
} from './fixtures/haruhi-fixtures';

const ts = (framework: 'vitest' | 'jest') =>
  forgeTests('reliability.ts', HARUHI_RELIABILITY_TS, { framework });

describe('HAR-001 test cases carry their own inputs', () => {
  it('structures every case with inputs and an expectation', () => {
    const output = ts('vitest');
    expect(output.cases.length).toBeGreaterThan(0);
    for (const testCase of output.cases) {
      expect(Array.isArray(testCase.inputs)).toBe(true);
      expect(testCase.inputs).toHaveLength(testCase.fn.params.length);
      expect(testCase.expectation).toBeTruthy();
      expect(['asserted', 'todo', 'unsupported']).toContain(testCase.status);
    }
  });

  it('passes 0, -1 and 42 to isPositive instead of the sample value', () => {
    const { code, cases } = ts('vitest');
    const cases42 = cases.filter((item) => item.fn.name === 'isPositive');
    const rendered = cases42.map((item) => item.when).join('\n');
    expect(rendered).toContain('isPositive(0)');
    expect(rendered).toContain('isPositive(-1)');
    expect(rendered).toContain('isPositive(42)');
    // The generated code must use the same inputs as the case.
    expect(code).toContain('isPositive(0)');
    expect(code).toContain('isPositive(-1)');
    expect(code).toContain('isPositive(42)');
    // ...and the case title must name the input it really uses.
    const zeroCase = cases42.find((item) => item.when.includes('isPositive(0)'));
    expect(zeroCase?.title).toMatch(/0/);
  });

  it('passes a zero divisor to divide and asserts the thrown range error', () => {
    const { code } = ts('vitest');
    expect(code).toContain('divide(42, 0)');
    expect(code).toMatch(/toThrow\(RangeError\)/);
  });

  it('separates async resolve and reject paths', () => {
    const { code } = ts('vitest');
    expect(code).toMatch(/await expect\(fetchData\('[^']*'\)\)\.rejects\.toThrow\(TypeError\)/);
    expect(code).toMatch(/const result = await fetchData\(/);
  });

  it('calls class methods on an instance and static methods on the class', () => {
    const { code } = ts('vitest');
    expect(code).toContain('new Calculator()');
    expect(code).toMatch(/subject\.add\(42, 42\)/);
    expect(code).toMatch(/Calculator\.subtract\(42, 42\)/);
  });

  it('does not invent a return value for a void function', () => {
    const { code, cases } = ts('vitest');
    const voidCases = cases.filter((item) => item.fn.name === 'voidFunction');
    expect(voidCases.length).toBeGreaterThan(0);
    expect(voidCases.every((item) => item.expectation.kind !== 'returns')).toBe(true);
    expect(code).not.toMatch(/const result = voidFunction\(/);
    expect(code).toMatch(/expect\(\(\) => voidFunction\(\)\)\.not\.toThrow\(\)/);
  });

  it('asserts the synchronous exception of throwsOnInvalid', () => {
    const { code } = ts('vitest');
    expect(code).toMatch(/toThrow\(TypeError\)/);
  });

  it('never falls back to a dummy toBeDefined assertion', () => {
    for (const framework of ['vitest', 'jest'] as const) {
      expect(ts(framework).code).not.toContain('toBeDefined()');
    }
  });

  it('marks a call shape it cannot build as skipped, with a reason', () => {
    const { code, cases } = ts('vitest');
    const runCases = cases.filter((item) => item.fn.name === 'run');
    expect(runCases.length).toBeGreaterThan(0);
    expect(runCases.every((item) => item.status === 'unsupported')).toBe(true);
    expect(code).toContain("it.skip(");
    expect(code).toContain('// TODO');
  });
});

describe('HAR-002 framework emitters', () => {
  it('imports Jest helpers from @jest/globals, not from jest', () => {
    const { code } = ts('jest');
    expect(code).toContain("from '@jest/globals'");
    expect(code).not.toMatch(/from 'jest'/);
  });

  it('uses the original module and package names', () => {
    const pytest = forgeTests('account_service.py', HARUHI_RELIABILITY_PY, { framework: 'pytest' });
    expect(pytest.code).toContain('from account_service import');
    const go = forgeTests('ledger.go', HARUHI_RELIABILITY_GO, { framework: 'go' });
    expect(go.code).toContain('package ledger');
    expect(go.code).not.toContain('package ledger_test');
  });

  it('instantiates a Python class whose constructor takes no arguments', () => {
    const { code, cases } = forgeTests('account_service.py', HARUHI_RELIABILITY_PY, { framework: 'pytest' });
    const registerCases = cases.filter((item) => item.fn.name === 'register');
    expect(registerCases.length).toBeGreaterThan(0);
    expect(registerCases.every((item) => item.status !== 'unsupported')).toBe(true);
    expect(code).toContain('subject = AccountService()');
    expect(code).toContain('subject.register(');
  });

  it('asserts None for a method annotated as returning None', () => {
    const { code } = forgeTests('account_service.py', HARUHI_RELIABILITY_PY, { framework: 'pytest' });
    expect(code).toContain('assert result is None');
    expect(code).not.toContain('assert result is not None');
  });

  it('uses a distinct boundary value per parameter in Pytest', () => {
    const { code } = forgeTests('account_service.py', HARUHI_RELIABILITY_PY, { framework: 'pytest' });
    // `clamp(value, low)` must exercise the low boundary on `low`, not on `value`.
    expect(code).toMatch(/clamp\(value=[^,]+, low=0(\.0)?\)/);
    expect(code).toMatch(/clamp\(value=0(\.0)?, low=/);
  });

  it('removes the dummy Java assertion and disables what it cannot construct', () => {
    const { code } = forgeTests('LedgerService.java', HARUHI_RELIABILITY_JAVA, { framework: 'junit5' });
    expect(code).not.toContain('assertTrue(true)');
    expect(code).toContain('assertThrows(IllegalArgumentException.class');
    expect(code).toContain('@Disabled');
    expect(code).toContain('LedgerService');
  });

  it('emits unique Go subtests, no got := for void functions and error checks', () => {
    const { code } = forgeTests('ledger.go', HARUHI_RELIABILITY_GO, { framework: 'go' });
    const funcNames = [...code.matchAll(/^func (\w+)\(t \*testing\.T\)/gm)].map((match) => match[1]);
    expect(funcNames.length).toBeGreaterThan(0);
    expect(new Set(funcNames).size).toBe(funcNames.length);
    expect(code).toContain('t.Run(');
    // Reset() returns nothing: never assign its result.
    expect(code).not.toMatch(/got[^:]*:= Reset\(/);
    // Settle returns (string, error): check err, not got == nil.
    expect(code).toContain('if err != nil {');
    expect(code).not.toContain('if got == nil');
  });

  it('never emits a Go test that ignores the error return', () => {
    const { code } = forgeTests('ledger.go', HARUHI_RELIABILITY_GO, { framework: 'go' });
    const settleBlock = code.slice(code.indexOf('func TestSettle'));
    expect(settleBlock).toContain('err');
  });
});

describe('HAR-003 static mapping versus executed coverage', () => {
  it('reports the static branch mapping separately from execution coverage', () => {
    const output = ts('vitest');
    expect(output.staticMappingRate).toBeGreaterThanOrEqual(0);
    expect(output.staticMappingRate).toBeLessThanOrEqual(100);
    expect(output.staticMapping).toMatchObject({
      mapped: expect.any(Number),
      unmapped: expect.any(Number),
      unsupported: expect.any(Number),
    });
    expect(output.executedCoverage).toBeNull();
  });

  it('labels every branch with a status and its evidence', () => {
    const output = ts('vitest');
    expect(output.checklist.length).toBeGreaterThan(0);
    for (const item of output.checklist) {
      expect(['mapped', 'unmapped', 'unsupported']).toContain(item.status);
      expect(item.function.length).toBeGreaterThan(0);
      expect(item.line).toBeGreaterThan(0);
      if (item.status === 'mapped') expect(item.caseId).toBeTruthy();
    }
    const mapped = output.checklist.find((item) => item.status === 'mapped');
    expect(mapped?.caseIds?.length).toBeGreaterThan(0);
  });

  it('marks loop branches it cannot derive a case for as unsupported', () => {
    const source = `export function every(ids: string[]): number {
  let seen = 0;
  for (const id of ids) {
    seen += 1;
  }
  return seen;
}
`;
    const output = forgeTests('every.ts', source, { framework: 'vitest' });
    const loop = output.checklist.find((item) => item.branch.startsWith('for'));
    expect(loop?.status).toBe('unsupported');
  });

  it('does not claim executed coverage without running the tests', () => {
    const output = ts('vitest');
    expect(output.executedCoverage).toBeNull();
    expect(output.coverageLabel).not.toMatch(/カバレッジ 100/);
  });
});
