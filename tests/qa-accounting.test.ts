/**
 * FIX-013 — the QA runner must account for executed cases, not just exit codes.
 *
 * An all-skipped project is an artifact SKIP, never PASS; environmental SKIPs
 * are reported separately; and the CI job declares the toolchains it installs
 * so a missing one fails the gate instead of shrinking silently.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(ROOT, relative), 'utf8');

describe('generated-code QA accounting (FIX-013)', () => {
  const script = read('tools/qa/check-generated.mjs');

  it('records executed case counts and refuses to call a zero-case run a pass', () => {
    expect(script).toContain('function testCounts');
    expect(script).toContain('function runStatus');
    expect(script).toContain("if (counts && counts.executed === 0) return 'SKIP'");
    expect(script).toContain('testCounts: counts ?? ZERO_COUNTS');
    expect(script).toContain('executedTests: executedTotals()');
    expect(script).toContain('skipBreakdown: skipBreakdown()');
  });

  it('separates environmental skips from artifact skips', () => {
    expect(script).toContain("skipKind: 'environment'");
    expect(script).toContain("skipKind: 'artifact'");
    expect(script).toContain("breakdown[item.skipKind === 'environment' || item.skipKind === 'artifact'");
  });

  it('counts Go and JUnit cases instead of trusting the exit code', () => {
    expect(script).toContain("['test', '-json', './...']");
    expect(script).toContain('function goCounts');
    expect(script).toContain('tests successful');
    expect(script).toContain('tests skipped');
  });

  it('fails the gate when a required toolchain is absent', () => {
    expect(script).toContain('QA_REQUIRED_TOOLCHAINS');
    expect(script).toContain("record('required-toolchain', name, 'FAIL'");
    const workflow = read('.github/workflows/deploy.yml');
    expect(workflow).toContain('QA_REQUIRED_TOOLCHAINS:');
    expect(workflow).toContain('golang-go');
    const reference = read('docs/ci-workflow.yml');
    expect(reference).toContain('QA_REQUIRED_TOOLCHAINS:');
    expect(reference).toContain('golang-go');
  });
});
