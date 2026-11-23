/**
 * QA-001 structural checks over the generated matrix.
 *
 * The compilers and runners live in `npm run qa:generated`; this suite keeps the
 * invariants that a compiler cannot see: the artifact language policy (REG-18),
 * unique test names (REG-04), no dummy assertion (REG-05), and the two defects
 * the QA matrix reproduced on 2026-11-23:
 *
 *  - a Pytest case disabled by a decorator had a comment-only body, which is an
 *    IndentationError in Python (`pytest.skip(...)` is now emitted);
 *  - a Python `@dataclass` with required fields was constructed as `Account()`
 *    because the generated `__init__` does not appear in the source.
 */
import { describe, expect, it } from 'vitest';
import { forgeTests, outputFileName, type Framework } from '../src/tools/haruhi/adapter';
import { SAMPLE_BY_EXT } from '../src/tools/samples';
import { HARUHI_RELIABILITY_GO, HARUHI_RELIABILITY_JAVA, HARUHI_RELIABILITY_PY, HARUHI_RELIABILITY_TS } from './fixtures/haruhi-fixtures';

const FRAMEWORKS: Framework[] = ['vitest', 'jest', 'pytest', 'junit5', 'go'];
const CJK = /[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/;

const SOURCES = [
  ...SAMPLE_BY_EXT.map((sample) => ({ name: sample.fileName, code: sample.code })),
  { name: 'reliability.ts', code: HARUHI_RELIABILITY_TS },
  { name: 'reliability_account.py', code: HARUHI_RELIABILITY_PY },
  { name: 'LedgerService.java', code: HARUHI_RELIABILITY_JAVA },
  { name: 'ledger.go', code: HARUHI_RELIABILITY_GO },
];

function testNames(code: string, framework: Framework): string[] {
  const patterns: Record<Framework, RegExp> = {
    vitest: /(?:it|test)\(\s*['"`]([^'"`]+)['"`]/g,
    jest: /(?:it|test)\(\s*['"`]([^'"`]+)['"`]/g,
    pytest: /def\s+(test_\w+)\s*\(/g,
    junit5: /void\s+(tc\w+)\s*\(/g,
    go: /func\s+(Test\w+)\s*\(/g,
  };
  return [...code.matchAll(patterns[framework])].map((match) => match[1]);
}

describe('QA-001 generated matrix', () => {
  it('generates every sample × framework with English artifacts and unique test names', () => {
    for (const framework of FRAMEWORKS) {
      for (const source of SOURCES) {
        const output = forgeTests(source.name, source.code, { framework });
        const label = `${framework}/${source.name}`;
        expect(output.code.length, label).toBeGreaterThan(20);
        expect(output.code, `${label} contains CJK`).not.toMatch(CJK);
        expect(output.fileName, label).toBe(outputFileName(framework, source.name));

        const names = testNames(output.code, framework);
        expect(new Set(names).size, `${label} duplicate test names: ${names.join(', ')}`).toBe(names.length);

        // REG-05: a test that cannot fail is not a test.
        expect(output.code, `${label} dummy assertion`).not.toMatch(/assertTrue\(\s*true\s*\)/);
        expect(output.code, `${label} dummy assertion`).not.toMatch(/expect\(\s*true\s*\)\.toBe\(\s*true\s*\)/);
        expect(output.code, `${label} dummy assertion`).not.toMatch(/assert\s+True\b/);
      }
    }
  });

  it('emits a statement, not a bare comment, for a Pytest case disabled by a decorator', () => {
    const output = forgeTests('account_service.py', SAMPLE_BY_EXT.find((sample) => sample.fileName === 'account_service.py')!.code, {
      framework: 'pytest',
    });
    const lines = output.code.split('\n');
    expect(output.code).toContain('pytest.skip(');
    for (let index = 0; index < lines.length; index += 1) {
      const definition = lines[index].match(/^(\s+)def\s+(test_\w+)\s*\(/);
      if (!definition) continue;
      const indent = definition[1].length;
      const body: string[] = [];
      for (let next = index + 1; next < lines.length; next += 1) {
        const line = lines[next];
        if (!line.trim()) continue;
        const leading = line.match(/^\s*/)![0].length;
        if (leading <= indent) break;
        body.push(line.trim());
      }
      expect(body.length, `empty body after ${definition[2]}`).toBeGreaterThan(0);
      expect(body.some((line) => !line.startsWith('#')), `comment-only body after ${definition[2]}`).toBe(true);
    }
  });

  it('does not construct a Python dataclass without its required fields', () => {
    const source = SAMPLE_BY_EXT.find((sample) => sample.fileName === 'async_repository.py')!.code;
    for (const framework of ['pytest', 'vitest'] as Framework[]) {
      const output = forgeTests('async_repository.py', source, { framework });
      expect(output.code, framework).not.toMatch(/subject\s*=\s*Account\(\)/);
      expect(output.code, framework).toContain('construct Account(email: str');
    }
  });

  it('keeps the Go package name and the Java class free of placeholder bodies', () => {
    const goSource = SAMPLE_BY_EXT.find((sample) => sample.fileName === 'billing_service.go')!.code;
    const go = forgeTests('billing_service.go', goSource, { framework: 'go' });
    expect(go.code.startsWith('package billing')).toBe(true);

    const java = forgeTests('InvoiceService.java', SAMPLE_BY_EXT.find((sample) => sample.fileName === 'InvoiceService.java')!.code, {
      framework: 'junit5',
    });
    expect(java.code).toContain('@Test');
    // Every @Test either asserts or is disabled with a reason.
    const tests = java.code.split('@Test').slice(1);
    for (const block of tests) {
      const hasAssertion = /assert[A-Za-z]+\(/.test(block);
      const disabled = /@Disabled\(/.test(block);
      expect(hasAssertion || disabled, 'a JUnit test neither asserts nor is disabled').toBe(true);
    }
  });
});
