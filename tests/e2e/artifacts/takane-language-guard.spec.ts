/**
 * G1 correction (BL-09) — Takane non-current-language export E2E.
 *
 * Before the correction, exporting any language other than the pane's current
 * output wrote the file directly and skipped the artifact guard. These tests
 * prove every supported language now becomes its own captured revision and that
 * the written file matches the stored content, revision and export row.
 */
import { expect, test, type Page } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dumpArtifactDb, type ArtifactDbDump, type EvaluatorLike } from './helpers/idbDump';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const OUT = path.join(ROOT, '.playwright-artifacts', 'takane-language-guard');

const SHA256_HEX = /^[0-9a-f]{64}$/;

interface ContentRow {
  revisionId: string;
  role: string;
  contentType: string;
  encoding: string;
  payload: string;
  contentHash: string;
}

interface ExportRow {
  artifactId: string;
  revisionId: string;
  revisionHash: string;
  format: string;
  exportByteHash: string;
  exportByteLength: number;
  derivation: { kind: 'direct' | 'rendered' };
  fileName: string;
  kind: 'normal' | 'debug';
  createdAt: string;
}

interface ArtifactRow {
  artifactId: string;
  currentRevisionId: string;
  artifactType: string;
}

interface ValidationRow {
  validatedRevisionId: string;
  status: string;
}

function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function dump(page: Page): Promise<ArtifactDbDump> {
  const result = await dumpArtifactDb(page as unknown as EvaluatorLike);
  expect(result, 'artifact IndexedDB must be readable after capture').not.toBeNull();
  return result as ArtifactDbDump;
}

function rows<T>(dumpValue: ArtifactDbDump, store: string): T[] {
  return (dumpValue.stores[store] ?? []) as T[];
}

test.beforeAll(() => {
  fs.mkdirSync(OUT, { recursive: true });
});

async function waitForScaffold(page: Page) {
  await page.goto('#/takane');
  await page.getByTestId('takane-sample-payment-service.spec.md').click();
  await page.getByTestId('takane-tab-code').click();
  await expect(page.getByTestId('takane-output')).toContainText('def ', { timeout: 30_000 });
  const badge = page.getByTestId('artifact-status-code');
  await expect(badge).toHaveAttribute('data-state', 'current', { timeout: 30_000 });
}

async function exportAndVerify(
  page: Page,
  options: { formatId: string; saveName: string; format: string; extension: string },
): Promise<{ file: string; row: ExportRow; revisionId: string }> {
  await page.getByTestId('takane-export').click();
  await expect(page.getByTestId('export-modal')).toBeVisible();
  const before = await dump(page);
  const beforeExports = rows<ExportRow>(before, 'exports').length;

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId(`export-${options.formatId}`).click(),
  ]);
  await expect(page.getByTestId('export-feedback')).toHaveAttribute('data-kind', 'ok', { timeout: 20_000 });
  const file = path.join(OUT, options.saveName);
  await download.saveAs(file);
  expect(download.suggestedFilename().endsWith(options.extension)).toBe(true);

  const after = await dump(page);
  const exports = rows<ExportRow>(after, 'exports');
  expect(exports.length, 'the guarded export registers exactly one row').toBe(beforeExports + 1);
  const row = exports
    .filter((item) => item.fileName === download.suggestedFilename() && item.format === options.format)
    .reduce<ExportRow | null>((newest, item) => (!newest || item.createdAt >= newest.createdAt ? item : newest), null);
  expect(row, 'the stored rows must contain the file just written').not.toBeNull();
  const saved = row as ExportRow;
  expect(saved.kind).toBe('normal');
  expect(saved.derivation.kind).toBe('direct');
  expect(saved.revisionHash).toMatch(SHA256_HEX);
  expect(saved.exportByteLength).toBe(fs.statSync(file).size);
  expect(saved.exportByteHash, 'the export hash must describe the saved file').toBe(sha256File(file));

  const artifact = rows<ArtifactRow>(after, 'artifacts').find((item) => item.artifactId === saved.artifactId);
  expect(artifact?.artifactType).toBe('source-code');
  expect(artifact?.currentRevisionId, 'the exported language is the stored current revision').toBe(saved.revisionId);

  const validation = rows<ValidationRow>(after, 'validations').find(
    (item) => item.validatedRevisionId === saved.revisionId,
  );
  expect(validation, 'the exported language revision carries a validation record').toBeTruthy();
  expect(['valid', 'warning']).toContain(validation?.status);

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('export-modal')).toHaveCount(0);
  return { file, row: saved, revisionId: saved.revisionId };
}

test('ART-E2E-14: a non-current language export is captured, validated and guarded', async ({ page }) => {
  await waitForScaffold(page);
  const before = await dump(page);
  const pythonRevisions = rows<ExportRow>(before, 'exports').filter((item) => item.format === 'python');
  expect(pythonRevisions).toHaveLength(0);

  // C is not the pane's current output: before the correction this wrote the
  // file without a revision, validation or export row.
  const c = await exportAndVerify(page, {
    formatId: 'c',
    saveName: 'g1-takane-lang.c',
    format: 'c',
    extension: '.c',
  });
  expect(fs.readFileSync(c.file, 'utf8')).toContain('#include');

  const cContents = rows<ContentRow>(await dump(page), 'contents').filter(
    (item) => item.revisionId === c.revisionId,
  );
  const cEntry = cContents.find((item) => item.contentType === 'text/x-c' && item.role === 'implementation');
  expect(cEntry, 'the C export names a stored text/x-c implementation entry').toBeTruthy();
  expect(cEntry?.encoding).toBe('utf8');
  expect(cEntry?.payload, 'the stored entry is exactly the written file').toBe(fs.readFileSync(c.file, 'utf8'));

  // A header of the same language uses the same captured revision.
  const header = await exportAndVerify(page, {
    formatId: 'c-header',
    saveName: 'g1-takane-lang.h',
    format: 'c-header',
    extension: '.h',
  });
  expect(header.revisionId).toBe(c.revisionId);

  // Switching back to Python is itself a guarded export of its own revision.
  const python = await exportAndVerify(page, {
    formatId: 'python',
    saveName: 'g1-takane-lang.py',
    format: 'python',
    extension: '.py',
  });
  expect(python.revisionId).not.toBe(c.revisionId);
  expect(fs.readFileSync(python.file, 'utf8')).toContain('def ');
});

test('ART-E2E-15: a stale input refuses a non-current-language export without writing', async ({ page }) => {
  // A paused fake clock keeps the 240 ms debounce from regenerating between the
  // edit and the click, so the stale window is deterministic.
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:00:00Z'));
  await page.goto('#/takane');
  await page.getByTestId('takane-sample-payment-service.spec.md').click();
  await page.getByTestId('takane-tab-code').click();
  await page.clock.runFor(2_000);
  await expect(page.getByTestId('takane-output')).toContainText('def ', { timeout: 30_000 });
  await expect(page.getByTestId('artifact-status-code')).toHaveAttribute('data-state', 'current', {
    timeout: 30_000,
  });
  await page.getByTestId('takane-export').click();
  await expect(page.getByTestId('export-modal')).toBeVisible();

  const before = await dump(page);
  const beforeExports = rows<ExportRow>(before, 'exports').length;

  // The modal is open; editing the source bumps the input revision.
  await page.getByTestId('source-editor').fill('# Changed\n\nNo contract body.');
  let downloaded = false;
  page.once('download', () => {
    downloaded = true;
  });
  await page.getByTestId(`export-${'cpp-header'}`).click();
  const feedback = page.getByTestId('export-feedback');
  await expect(feedback).toHaveAttribute('data-kind', 'error', { timeout: 20_000 });
  await expect(feedback).toContainText('入力が変更されています');
  expect(downloaded, 'a refused export must not write a file').toBe(false);

  const after = await dump(page);
  expect(rows<ExportRow>(after, 'exports').length, 'a refused export must not register a row').toBe(beforeExports);
});
