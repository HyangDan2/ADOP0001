/**
 * The work-order regression matrix must stay complete.
 *
 * Every row REG-01~18 names the automated test that proves it. This guard fails
 * when a row loses its test file, when an id disappears from the test, or when
 * docs/QA.md stops documenting the same mapping — the matrix cannot quietly
 * shrink while the report still claims coverage.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const MATRIX: { id: string; file: string; evidence: string[] }[] = [
  { id: 'REG-01', file: 'tests/e2e/phase2.spec.ts', evidence: [] },
  { id: 'REG-02', file: 'tests/e2e/phase2.spec.ts', evidence: [] },
  { id: 'REG-03', file: 'tests/e2e/phase3.spec.ts', evidence: ['tools/qa/check-generated.mjs'] },
  { id: 'REG-04', file: 'tests/e2e/phase3.spec.ts', evidence: ['tests/generated-matrix.test.ts'] },
  { id: 'REG-05', file: 'tests/e2e/phase3.spec.ts', evidence: ['tests/generated-matrix.test.ts'] },
  { id: 'REG-06', file: 'tests/e2e/phase3.spec.ts', evidence: [] },
  { id: 'REG-07', file: 'tests/e2e/phase2.spec.ts', evidence: [] },
  { id: 'REG-08', file: 'tests/e2e/phase2.spec.ts', evidence: [] },
  { id: 'REG-09', file: 'tests/e2e/phase2.spec.ts', evidence: [] },
  { id: 'REG-10', file: 'tests/e2e/phase3.spec.ts', evidence: ['tools/qa/check-generated.mjs'] },
  { id: 'REG-11', file: 'tests/e2e/phase3.spec.ts', evidence: ['tools/qa/check-generated.mjs'] },
  { id: 'REG-12', file: 'tests/e2e/phase3.spec.ts', evidence: ['tests/source-ana.test.ts'] },
  { id: 'REG-13', file: 'tests/e2e/phase2.spec.ts', evidence: [] },
  { id: 'REG-14', file: 'tests/e2e/phase3.spec.ts', evidence: [] },
  { id: 'REG-15', file: 'tests/e2e/phase3.spec.ts', evidence: [] },
  { id: 'REG-16', file: 'tests/e2e/phase3.spec.ts', evidence: ['tests/e2e/phase4.spec.ts'] },
  { id: 'REG-17', file: 'tests/e2e/phase3.spec.ts', evidence: [] },
  { id: 'REG-18', file: 'tests/e2e/phase4.spec.ts', evidence: ['tests/generated-matrix.test.ts'] },
];

describe('regression matrix', () => {
  it('lists all 18 rows exactly once', () => {
    expect(MATRIX.map((row) => row.id)).toEqual(Array.from({ length: 18 }, (_, index) => `REG-${String(index + 1).padStart(2, '0')}`));
  });

  it('keeps every row attached to a named automated test', () => {
    for (const row of MATRIX) {
      const file = path.join(ROOT, row.file);
      expect(existsSync(file), `${row.id}: ${row.file} is missing`).toBe(true);
      const content = readFileSync(file, 'utf8');
      expect(content.includes(row.id), `${row.id} is not asserted in ${row.file}`).toBe(true);
      for (const evidence of row.evidence) {
        expect(existsSync(path.join(ROOT, evidence)), `${row.id}: ${evidence} is missing`).toBe(true);
      }
    }
  });

  it('documents the same mapping in docs/QA.md', () => {
    const doc = readFileSync(path.join(ROOT, 'docs/QA.md'), 'utf8');
    for (const row of MATRIX) {
      const line = doc.split('\n').find((entry) => entry.startsWith(`| ${row.id} |`));
      expect(line, `${row.id} is not in the matrix table`).toBeTruthy();
      expect(line, `${row.id} points at another file`).toContain(row.file);
    }
  });
});
