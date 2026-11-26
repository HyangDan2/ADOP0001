/**
 * INT-010 — the Phase 5C.2 runtime integration matrix.
 *
 * Every work item must have a regression file and a section in
 * `docs/PHASE5C_2_INTEGRATION_REPORT.md`, the modules it introduced must exist and
 * be reachable from the running path (not added beside it), the Phase 5C / 5C.1
 * matrices must still be intact, and the report must state the release status.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(ROOT, relative), 'utf8');
const REPORT = 'docs/PHASE5C_2_INTEGRATION_REPORT.md';

const ITEMS: Array<{ id: string; file: string; modules: string[] }> = [
  { id: 'INT-001', file: 'tests/int-001-request-snapshot.test.ts', modules: ['src/engine/hybrid/requestBody.ts', 'src/engine/hybrid/requestSnapshot.ts'] },
  { id: 'INT-002', file: 'tests/int-002-effective-allocation.test.ts', modules: ['src/engine/hybrid/tokenAccounting.ts', 'src/engine/hybrid/sourceScope.ts'] },
  { id: 'INT-003', file: 'tests/int-003-lifecycle.test.ts', modules: ['src/engine/hybrid/lifecycle.ts', 'src/engine/hybrid/requestPlan.ts'] },
  { id: 'INT-004', file: 'tests/int-004-stream-terminal.test.ts', modules: ['src/engine/hybrid/streamParser.ts'] },
  { id: 'INT-005', file: 'tests/int-005-bounded-read.test.ts', modules: ['src/engine/hybrid/boundedRead.ts'] },
  { id: 'INT-006', file: 'tests/int-006-capability-body.test.ts', modules: ['src/engine/hybrid/providerConfig.ts', 'src/engine/hybrid/providerProfiles.ts'] },
  { id: 'INT-007', file: 'tests/int-007-boundary-evidence.test.ts', modules: ['src/engine/hybrid/redactionPolicy.ts', 'src/engine/hybrid/dataBoundary.ts'] },
  { id: 'INT-008', file: 'tests/int-008-residual.test.ts', modules: ['src/lib/latestOnly.ts', 'src/lib/drafts.ts'] },
];

describe('Phase 5C.2 runtime integration matrix', () => {
  it('gives every work item a regression file and a report section', () => {
    const report = read(REPORT);
    for (const item of ITEMS) {
      expect(existsSync(path.join(ROOT, item.file)), `${item.id} has no regression file`).toBe(true);
      expect(report, `${item.id} is missing from ${REPORT}`).toContain(item.id);
    }
  });

  it('has every module the matrix names and wires the runtime path', () => {
    const orchestrator = read('src/engine/hybrid/orchestrator.ts');
    const requestPlan = read('src/engine/hybrid/requestPlan.ts');
    const provider = read('src/engine/hybrid/openAiCompatible.ts');
    const preflight = read('src/engine/hybrid/preflight.ts');
    const assist = read('src/components/HybridAssist.tsx');
    const panel = read('src/components/WorkspacePanel.tsx');
    for (const item of ITEMS) {
      for (const module of item.modules) {
        expect(existsSync(path.join(ROOT, module)), `${module} is missing`).toBe(true);
      }
    }
    expect(orchestrator).toContain("from './requestSnapshot'");
    expect(orchestrator).toContain("consumeRequestSnapshot");
    expect(orchestrator).toContain("from './dataBoundary'");
    expect(orchestrator).toContain('approvedRanges');
    expect(requestPlan).toContain("from './tokenAccounting'");
    expect(requestPlan).toContain("from './sourceScope'");
    expect(requestPlan).toContain("from './redactionPolicy'");
    expect(provider).toContain("from './requestBody'");
    expect(provider).toContain("from './boundedRead'");
    expect(preflight).toContain('countMessageTokens');
    expect(assist).toContain('inputsFingerprintFor');
    expect(assist).toContain('sectionSelection');
    expect(panel).toContain('createLatestGuard');
  });

  it('keeps the earlier matrices in place', () => {
    expect(existsSync(path.join(ROOT, 'tests/cfix-010-matrix.test.ts'))).toBe(true);
    expect(existsSync(path.join(ROOT, 'tests/reg-5c-matrix.test.ts'))).toBe(true);
    expect(existsSync(path.join(ROOT, 'docs/PHASE5C_1_CORRECTION_REPORT.md'))).toBe(true);
    expect(existsSync(path.join(ROOT, 'tests/e2e/phase5c2-int.spec.ts'))).toBe(true);
    expect(read('tests/cfix-010-matrix.test.ts')).toContain('C-FIX-010');
  });

  it('states the release status and the unverified items', () => {
    const report = read(REPORT);
    expect(report).toContain('not merged, not deployed');
    expect(report).toContain('No live gateway was called');
    expect(report).toContain('INT-001 ~ INT-008');
  });
});
