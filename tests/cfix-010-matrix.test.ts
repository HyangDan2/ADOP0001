/**
 * C-FIX-010 — the Phase 5C.1 correction matrix.
 *
 * Every correction in the work order must have a regression file and a section in
 * `docs/PHASE5C_1_CORRECTION_REPORT.md`; the modules it introduced must exist and be
 * wired into the orchestrator (not just added beside it); the Phase 5C matrix must
 * still be intact, and the new tests must not carry key-shaped literals.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(ROOT, relative), 'utf8');
const REPORT = 'docs/PHASE5C_1_CORRECTION_REPORT.md';

const CORRECTIONS: Array<{ id: string; file: string; modules: string[] }> = [
  { id: 'C-FIX-001', file: 'tests/cfix-001-snapshot.test.ts', modules: ['src/engine/hybrid/requestSnapshot.ts'] },
  { id: 'C-FIX-002', file: 'tests/cfix-002-allocation.test.ts', modules: ['src/engine/hybrid/contextAllocator.ts'] },
  { id: 'C-FIX-003', file: 'tests/cfix-003-lifecycle.test.ts', modules: ['src/engine/hybrid/lifecycle.ts'] },
  { id: 'C-FIX-004', file: 'tests/cfix-004-stream.test.ts', modules: ['src/engine/hybrid/streamCodec.ts'] },
  { id: 'C-FIX-005', file: 'tests/cfix-005-resource.test.ts', modules: ['src/engine/hybrid/resourcePolicy.ts'] },
  { id: 'C-FIX-006', file: 'tests/cfix-006-redaction-boundary.test.ts', modules: ['src/engine/hybrid/redactionRegistry.ts', 'src/engine/hybrid/dataBoundary.ts'] },
  { id: 'C-FIX-007', file: 'tests/cfix-007-providers.test.ts', modules: ['src/engine/hybrid/providerProfiles.ts'] },
  { id: 'C-FIX-008', file: 'tests/cfix-008-config.test.ts', modules: ['src/engine/hybrid/config.ts'] },
  { id: 'C-FIX-009', file: 'tests/cfix-009-evidence.test.ts', modules: ['src/engine/hybrid/evidence.ts'] },
  { id: 'C-FIX-010', file: 'tests/e2e/phase5c1.spec.ts', modules: [] },
];

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const absolute = path.join(directory, entry);
    if (statSync(absolute).isDirectory()) return entry === 'node_modules' ? [] : walk(absolute);
    return [absolute];
  });
}

describe('Phase 5C.1 correction matrix', () => {
  it('gives every correction a regression file and a report section', () => {
    const report = read(REPORT);
    for (const correction of CORRECTIONS) {
      expect(existsSync(path.join(ROOT, correction.file)), `${correction.id} has no regression file`).toBe(true);
      expect(report, `${correction.id} is missing from ${REPORT}`).toContain(correction.id);
      expect(read(correction.file), `${correction.id} is not named in its test file`).toContain(correction.id.split('-')[1]);
    }
  });

  it('has every module the matrix names, and wires each into the engine', () => {
    const orchestrator = read('src/engine/hybrid/orchestrator.ts');
    const requestPlan = read('src/engine/hybrid/requestPlan.ts');
    const openAi = read('src/engine/hybrid/openAiCompatible.ts');
    const budget = read('src/engine/hybrid/budget.ts');
    for (const correction of CORRECTIONS) {
      for (const module of correction.modules) {
        expect(existsSync(path.join(ROOT, module)), `${module} is missing`).toBe(true);
      }
    }
    expect(orchestrator).toContain("from './lifecycle'");
    expect(orchestrator).toContain("from './requestSnapshot'");
    expect(orchestrator).toContain("from './evidence'");
    expect(orchestrator).toContain("from './providerProfiles'");
    expect(requestPlan).toContain("from './contextAllocator'");
    expect(openAi).toContain("from './streamCodec'");
    expect(openAi).toContain("from './resourcePolicy'");
    expect(openAi).toContain("from './config'");
    expect(budget).toContain("from './contextAllocator'");
  });

  it('keeps the Phase 5C matrix and its evidence in place', () => {
    const matrix = read('tests/reg-5c-matrix.test.ts');
    const qa = read('docs/PHASE5C_QA_REPORT.md');
    for (let index = 1; index <= 25; index += 1) {
      const id = `REG-5C-${String(index).padStart(2, '0')}`;
      expect(matrix, `${id} lost its matrix row`).toContain(id);
      expect(qa, `${id} lost its report row`).toContain(id);
    }
  });

  it('adds no key-shaped literal to the new tests', () => {
    const files = walk(path.join(ROOT, 'tests')).filter((file) => /cfix-|phase5c1|runtime-secrets/.test(file));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      // A real key-shaped literal would be at least 20 characters after the prefix.
      expect(text, `${path.relative(ROOT, file)} carries a key-shaped literal`).not.toMatch(/\bsk-[A-Za-z0-9_-]{20,}/);
      expect(text, `${path.relative(ROOT, file)} carries a token-shaped literal`).not.toMatch(/\bghp_[A-Za-z0-9]{30,}/);
    }
  });

  it('reports the correction as not merged and not deployed', () => {
    const report = read(REPORT);
    expect(report).toContain('not merged, not deployed');
  });
});
