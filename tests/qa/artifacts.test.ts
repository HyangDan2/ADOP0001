/**
 * QA-B/QA-C artifact generation.
 *
 * This test does not assert behaviour: it writes the generated scaffolds to
 * `.qa-out/` (git-ignored, outside `tests/` so the project suite never picks
 * them up) so that `npm run qa:generated` can check them with an independent
 * toolchain (Python's compiler, a C/C++ compiler, a real Vitest project, Go,
 * a JDK). Failures here mean the generator itself could not produce an artifact.
 *
 * The matrix is the full work-order matrix: 7 built-in samples × 5 frameworks
 * (REG-03~06 in the QA plan). Only the pairs whose source language matches the
 * framework are executable; the manifest marks those, and the QA runner never
 * pretends the other pairs were run.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { forgeTests, outputFileName, type Framework } from '../../src/tools/haruhi/adapter';
import { SAMPLE_BY_EXT } from '../../src/tools/samples';
import { buildTakane, type TakaneLanguage } from '../../src/tools/takane/adapter';
import { PAYMENT_SPEC, ORDER_SPEC, CACHE_SPEC } from '../../src/tools/takane/samples';
import {
  HARUHI_RELIABILITY_GO,
  HARUHI_RELIABILITY_JAVA,
  HARUHI_RELIABILITY_PY,
  HARUHI_RELIABILITY_TS,
  TAKANE_ESCAPE_SPEC,
  TAKANE_ORDER_SPEC,
} from '../fixtures/haruhi-fixtures';

const OUT = path.join(process.cwd(), '.qa-out');
const FRAMEWORKS: Framework[] = ['vitest', 'jest', 'pytest', 'junit5', 'go'];

/** Source languages each framework can actually execute. */
const EXECUTABLE_LANGUAGES: Record<Framework, string[]> = {
  vitest: ['ts', 'js'],
  jest: ['ts', 'js'],
  pytest: ['py'],
  junit5: ['java'],
  go: ['go'],
};

const LANGUAGE_OF: Record<string, string> = { ts: 'ts', js: 'js', py: 'py', java: 'java', go: 'go' };

interface ManifestEntry {
  framework: Framework;
  sample: string;
  source: string;
  test: string;
  language: string;
  /** True when the framework can execute this source language. */
  executable: boolean;
  dir: string;
  /** Runner the QA script should use. */
  runner: 'vitest' | 'jest' | 'pytest' | 'junit5' | 'go';
}

function write(relative: string, contents: string) {
  const target = path.join(OUT, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

function baseName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}

/** Sibling modules the sample imports and the sandbox has to supply. */
function stubsFor(fileName: string): { name: string; code: string }[] {
  if (fileName === 'payment-service.ts') {
    return [
      {
        name: 'invoice-repository.ts',
        code: [
          'export interface Invoice { id: string; settled: boolean; }',
          'export class InvoiceRepository {',
          '  async find(_id: string): Promise<Invoice | null> { return null; }',
          '  async markSettled(_id: string): Promise<void> { /* stub */ }',
          '}',
          '',
        ].join('\n'),
      },
      {
        name: 'mailer.ts',
        code: 'export async function sendReceipt(_id: string, _amount: number): Promise<void> { /* stub */ }\n',
      },
    ];
  }
  if (fileName === 'result-pipeline.ts') {
    return [
      {
        name: 'cache-store.ts',
        code: 'export interface CacheStore<K, V> { get(key: K): V | undefined; set(key: K, value: V): void; }\n',
      },
    ];
  }
  if (fileName === 'InvoiceService.java') {
    return [
      {
        name: 'InvoiceRepository.java',
        code: [
          'package com.hd2lab.billing;',
          '',
          'import java.util.Optional;',
          '',
          'public interface InvoiceRepository {',
          '    void save(Invoice invoice);',
          '    Optional<Invoice> findById(String id);',
          '}',
          '',
        ].join('\n'),
      },
      {
        name: 'LineItem.java',
        code: ['package com.hd2lab.billing;', '', 'public record LineItem(String sku, double amount) {}', ''].join('\n'),
      },
      {
        name: 'Invoice.java',
        code: [
          'package com.hd2lab.billing;',
          '',
          'import java.util.List;',
          '',
          'public record Invoice(String customerId, List<LineItem> lines, double total) {}',
          '',
        ].join('\n'),
      },
    ];
  }
  if (fileName === 'billing_service.go') {
    return [
      {
        name: 'store.go',
        code: [
          'package billing',
          '',
          'type Store interface {',
          '\tSave(charge Charge) error',
          '\tMarkSettled(invoiceID string) error',
          '}',
          '',
        ].join('\n'),
      },
    ];
  }
  return [];
}

function sourceLanguage(fileName: string): string {
  const extension = fileName.split('.').pop() ?? '';
  return LANGUAGE_OF[extension] ?? extension;
}

describe('generated artifacts', () => {
  it('writes the full Haruhi matrix: 7 samples × 5 frameworks', () => {
    rmSync(OUT, { recursive: true, force: true });
    const manifest: ManifestEntry[] = [];

    for (const framework of FRAMEWORKS) {
      for (const sample of SAMPLE_BY_EXT) {
        const dirName = `${framework}/${baseName(sample.fileName)}`;
        const dir = path.join('haruhi', dirName);
        const test = outputFileName(framework, sample.fileName);
        const language = sourceLanguage(sample.fileName);
        const executable = EXECUTABLE_LANGUAGES[framework].includes(language);
        const output = forgeTests(sample.fileName, sample.code, { framework });
        write(path.join(dir, sample.fileName), sample.code);
        write(path.join(dir, test), output.code);
        if (executable) {
          for (const stub of stubsFor(sample.fileName)) write(path.join(dir, stub.name), stub.code);
          if (framework === 'vitest') {
            write(
              path.join(dir, 'vitest.config.ts'),
              [
                "import { defineConfig } from 'vitest/config';",
                '',
                'export default defineConfig({',
                "  test: { include: ['*.test.ts'], environment: 'node' },",
                '});',
                '',
              ].join('\n'),
            );
          }
        }
        manifest.push({
          framework,
          sample: sample.label,
          source: sample.fileName,
          test,
          language,
          executable,
          dir: path.join('haruhi', dirName),
          runner: framework,
        });
      }
    }

    // The reliability fixtures from Phase 1 stay in the matrix: they are the
    // only projects whose generated tests are expected to run without stubs.
    const vitestConfig = [
      "import { defineConfig } from 'vitest/config';",
      '',
      'export default defineConfig({',
      "  test: { include: ['*.test.ts'], environment: 'node' },",
      '});',
      '',
    ].join('\n');
    write('haruhi/vitest/reliability-account/reliability.ts', HARUHI_RELIABILITY_TS);
    write('haruhi/vitest/reliability-account/vitest.config.ts', vitestConfig);
    write(
      'haruhi/vitest/reliability-account/reliability.test.ts',
      forgeTests('reliability.ts', HARUHI_RELIABILITY_TS, { framework: 'vitest' }).code,
    );
    write('haruhi/pytest/reliability-account/reliability_account.py', HARUHI_RELIABILITY_PY);
    write(
      'haruhi/pytest/reliability-account/test_reliability_account.py',
      forgeTests('reliability_account.py', HARUHI_RELIABILITY_PY, { framework: 'pytest' }).code,
    );
    write('haruhi/go/reliability-ledger/ledger.go', HARUHI_RELIABILITY_GO);
    write(
      'haruhi/go/reliability-ledger/ledger_test.go',
      forgeTests('ledger.go', HARUHI_RELIABILITY_GO, { framework: 'go' }).code,
    );
    write('haruhi/junit5/reliability-ledger/LedgerService.java', HARUHI_RELIABILITY_JAVA);
    write(
      'haruhi/junit5/reliability-ledger/LedgerRepository.java',
      ['package com.hd2lab.billing;', '', 'public interface LedgerRepository {', '    void save();', '}', ''].join('\n'),
    );
    write(
      'haruhi/junit5/reliability-ledger/LedgerServiceTest.java',
      forgeTests('LedgerService.java', HARUHI_RELIABILITY_JAVA, { framework: 'junit5' }).code,
    );

    manifest.push(
      {
        framework: 'vitest',
        sample: 'Reliability fixture (TypeScript)',
        source: 'reliability.ts',
        test: 'reliability.test.ts',
        language: 'ts',
        executable: true,
        dir: 'haruhi/vitest/reliability-account',
        runner: 'vitest',
      },
      {
        framework: 'pytest',
        sample: 'Reliability fixture (Python)',
        source: 'reliability_account.py',
        test: 'test_reliability_account.py',
        language: 'py',
        executable: true,
        dir: 'haruhi/pytest/reliability-account',
        runner: 'pytest',
      },
      {
        framework: 'go',
        sample: 'Reliability fixture (Go)',
        source: 'ledger.go',
        test: 'ledger_test.go',
        language: 'go',
        executable: true,
        dir: 'haruhi/go/reliability-ledger',
        runner: 'go',
      },
      {
        framework: 'junit5',
        sample: 'Reliability fixture (Java)',
        source: 'LedgerService.java',
        test: 'LedgerServiceTest.java',
        language: 'java',
        executable: true,
        dir: 'haruhi/junit5/reliability-ledger',
        runner: 'junit5',
      },
    );

    write('manifest.json', JSON.stringify(manifest, null, 2));
    expect(manifest.length).toBe(SAMPLE_BY_EXT.length * FRAMEWORKS.length + 4);
  }, 30_000);

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
  }, 30_000);
});
