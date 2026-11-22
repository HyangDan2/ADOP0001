/**
 * QA-B/QA-C artifact generation.
 *
 * This test does not assert behaviour: it writes the generated scaffolds to
 * `.qa-out/` (git-ignored, outside `tests/` so the project suite never picks
 * them up) so that `npm run qa:generated` can check them with an independent
 * toolchain (Python's compiler, a C/C++ compiler, a real Vitest project).
 * Failures here mean the generator could not produce an artifact.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { forgeTests } from '../../src/tools/haruhi/adapter';
import { buildTakane, type TakaneLanguage } from '../../src/tools/takane/adapter';
import { PAYMENT_SPEC, ORDER_SPEC, CACHE_SPEC } from '../../src/tools/takane/samples';
import { TS_SAMPLE } from '../../src/tools/samples';
import {
  HARUHI_RELIABILITY_GO,
  HARUHI_RELIABILITY_JAVA,
  HARUHI_RELIABILITY_PY,
  HARUHI_RELIABILITY_TS,
  TAKANE_ESCAPE_SPEC,
  TAKANE_ORDER_SPEC,
} from '../fixtures/haruhi-fixtures';

const OUT = path.join(process.cwd(), '.qa-out');

function write(relative: string, contents: string) {
  const target = path.join(OUT, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

describe('generated artifacts', () => {
  it('writes Haruhi output for every framework', () => {
    rmSync(OUT, { recursive: true, force: true });

    // TypeScript: the module and the generated test live side by side.
    const vitestConfig = [
      "import { defineConfig } from 'vitest/config';",
      '',
      'export default defineConfig({',
      "  test: { include: ['*.test.ts'], environment: 'node' },",
      '});',
      '',
    ].join('\n');
    write('haruhi/ts-reliability/reliability.ts', HARUHI_RELIABILITY_TS);
    write('haruhi/ts-reliability/vitest.config.ts', vitestConfig);
    write(
      'haruhi/ts-reliability/reliability.test.ts',
      forgeTests('reliability.ts', HARUHI_RELIABILITY_TS, { framework: 'vitest' }).code,
    );
    write('haruhi/ts-payment/payment-service.ts', TS_SAMPLE);
    write('haruhi/ts-payment/vitest.config.ts', vitestConfig);
    // The sample imports two sibling modules; the sandbox provides minimal stubs
    // so that the generated test can be type-checked and run.
    write(
      'haruhi/ts-payment/invoice-repository.ts',
      [
        'export interface Invoice { id: string; settled: boolean; }',
        'export class InvoiceRepository {',
        '  async find(_id: string): Promise<Invoice | null> { return null; }',
        '  async markSettled(_id: string): Promise<void> { /* stub */ }',
        '}',
        '',
      ].join('\n'),
    );
    write('haruhi/ts-payment/mailer.ts', 'export async function sendReceipt(_id: string, _amount: number): Promise<void> { /* stub */ }\n');
    write(
      'haruhi/ts-payment/payment-service.test.ts',
      forgeTests('payment-service.ts', TS_SAMPLE, { framework: 'vitest' }).code,
    );

    // Python: the module name must match the import the generator writes.
    write('haruhi/py/reliability_account.py', HARUHI_RELIABILITY_PY);
    write(
      'haruhi/py/test_reliability_account.py',
      forgeTests('reliability_account.py', HARUHI_RELIABILITY_PY, { framework: 'pytest' }).code,
    );

    write('haruhi/go/ledger.go', HARUHI_RELIABILITY_GO);
    write('haruhi/go/ledger_test.go', forgeTests('ledger.go', HARUHI_RELIABILITY_GO, { framework: 'go' }).code);

    write('haruhi/java/LedgerService.java', HARUHI_RELIABILITY_JAVA);
    // The fixture depends on a repository type that lives in the same package.
    write(
      'haruhi/java/LedgerRepository.java',
      ['package com.hd2lab.billing;', '', 'public interface LedgerRepository {', '    void save();', '}', ''].join('\n'),
    );
    write(
      'haruhi/java/LedgerServiceTest.java',
      forgeTests('LedgerService.java', HARUHI_RELIABILITY_JAVA, { framework: 'junit5' }).code,
    );

    expect(true).toBe(true);
  });

  it('writes Takane output for every language and specification', () => {
    const specs: { name: string; markdown: string }[] = [
      { name: 'payment-service.spec.md', markdown: PAYMENT_SPEC },
      { name: 'order-workflow.spec.md', markdown: ORDER_SPEC },
      { name: 'cache-store.spec.md', markdown: CACHE_SPEC },
      { name: 'order-service.spec.md', markdown: TAKANE_ORDER_SPEC },
      { name: 'escape-service.spec.md', markdown: TAKANE_ESCAPE_SPEC },
    ];
    const languages: TakaneLanguage[] = ['python', 'c', 'cpp', 'mcu'];
    for (const spec of specs) {
      for (const language of languages) {
        const output = buildTakane(spec.name, spec.markdown, language);
        for (const file of output.files) {
          write(`takane/${language}/${file.name}`, file.code);
        }
      }
    }
    expect(true).toBe(true);
  });
});
