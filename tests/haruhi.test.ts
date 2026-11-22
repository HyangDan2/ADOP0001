import { describe, expect, it } from 'vitest';
import { forgeTests, outputFileName } from '../src/tools/haruhi/adapter';
import { GO_SAMPLE, JAVA_SAMPLE, PY_SAMPLE, TS_SAMPLE } from '../src/tools/samples';
import { HARUHI_RELIABILITY_JAVA, HARUHI_RELIABILITY_PY } from './fixtures/haruhi-fixtures';

describe('Haruhi test case forge', () => {
  it('derives happy, boundary, guard and error cases', () => {
    const output = forgeTests('payment-service.ts', TS_SAMPLE, { framework: 'vitest' });
    const kinds = new Set(output.cases.map((c) => c.kind));
    expect(kinds.has('happy')).toBe(true);
    expect(kinds.has('boundary')).toBe(true);
    expect(kinds.has('guard') || kinds.has('error')).toBe(true);
    expect(output.cases.every((c) => c.given.length > 0)).toBe(true);
    expect(output.cases.every((c) => c.when.length > 0 && c.then.length > 0)).toBe(true);
  });

  it('emits Vitest and Jest skeletons', () => {
    const vitest = forgeTests('payment-service.ts', TS_SAMPLE, { framework: 'vitest' });
    expect(vitest.code).toContain("from 'vitest'");
    expect(vitest.code).toContain('describe(');
    expect(vitest.code).toContain('expect(');
    expect(vitest.code).toContain('// Given');

    const jest = forgeTests('payment-service.ts', TS_SAMPLE, { framework: 'jest' });
    // HAR-002: Jest globals come from @jest/globals, not from the `jest` package.
    expect(jest.code).toContain("from '@jest/globals'");
    expect(jest.code).not.toContain("from 'jest'");
    expect(jest.code).toContain('jest.fn()');
  });

  it('emits Pytest, JUnit 5 and Go skeletons', () => {
    const pytest = forgeTests('account_service.py', PY_SAMPLE, { framework: 'pytest' });
    expect(pytest.code).toContain('import pytest');
    expect(pytest.code).toContain('def test_');
    expect(pytest.code).toContain('from account_service import');
    // HAR-002: a class whose constructor needs dependencies is skipped, with the reason.
    expect(pytest.code).toContain('@pytest.mark.skip(reason=');
    const pytestRaises = forgeTests('account_service.py', HARUHI_RELIABILITY_PY, { framework: 'pytest' });
    expect(pytestRaises.code).toContain('pytest.raises(ValueError)');

    const junit = forgeTests('InvoiceService.java', JAVA_SAMPLE, { framework: 'junit5' });
    expect(junit.code).toContain('org.junit.jupiter.api.Test');
    expect(junit.code).toContain('class InvoiceServiceTest');
    // HAR-002: no dummy assertion; what cannot be constructed is disabled with a reason.
    expect(junit.code).not.toContain('assertTrue(true)');
    expect(junit.code).toContain('@Disabled');
    const junitThrows = forgeTests('LedgerService.java', HARUHI_RELIABILITY_JAVA, { framework: 'junit5' });
    expect(junitThrows.code).toContain('assertThrows(IllegalArgumentException.class');

    const go = forgeTests('billing_service.go', GO_SAMPLE, { framework: 'go' });
    expect(go.code).toContain('func Test');
    expect(go.code).toContain('*testing.T');
    expect(go.code).toContain('package ');
  });

  it('names the test file for each framework', () => {
    expect(outputFileName('vitest', 'payment-service.ts')).toBe('payment-service.test.ts');
    expect(outputFileName('jest', 'payment-service.ts')).toBe('payment-service.test.ts');
    expect(outputFileName('pytest', 'account_service.py')).toBe('test_account_service.py');
    expect(outputFileName('junit5', 'InvoiceService.java')).toBe('InvoiceServiceTest.java');
    expect(outputFileName('go', 'billing_service.go')).toBe('billing_service_test.go');
  });

  it('reports an uncovered-branch checklist and a coverage estimate', () => {
    const output = forgeTests('payment-service.ts', TS_SAMPLE, { framework: 'vitest' });
    expect(output.checklist.length).toBeGreaterThan(0);
    expect(output.checklist.some((c) => c.covered)).toBe(true);
    expect(output.coverage).toBeGreaterThanOrEqual(0);
    expect(output.coverage).toBeLessThanOrEqual(100);
  });

  it('is stable across runs', () => {
    const first = forgeTests('a.py', PY_SAMPLE, { framework: 'pytest' });
    const second = forgeTests('a.py', PY_SAMPLE, { framework: 'pytest' });
    expect(first.code).toBe(second.code);
    expect(first.cases.length).toBe(second.cases.length);
  });
});
