/**
 * G2 — artifact workspace E2E (WO-D05 traceability, WO-D06 package integrity,
 * WO-D07 history/validation/diff/restore, BL-15 debug gate).
 *
 * The workspace is driven on the real preview build; the ZIP is saved and then
 * re-read in Node so the manifest, the stored export row and the downloaded
 * bytes are compared against each other rather than against the code that
 * produced them.
 */
import { expect, test, type Page } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { PREVIEW_ORIGIN } from '../previewOrigin';
import { dumpArtifactDb, type ArtifactDbDump, type EvaluatorLike } from './helpers/idbDump';
import { createNetworkLog, type NetworkLog } from './helpers/networkLog';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const OUT = path.join(ROOT, '.playwright-artifacts', 'g2-workspace');

const SHA256_HEX = /^[0-9a-f]{64}$/;

const SOURCE = `export interface Ledger {
  id: string;
  amount: number;
}

export function addEntry(id: string, amount: number): Ledger {
  if (!id) throw new Error('id is required');
  if (amount < 0) throw new RangeError('amount must be positive');
  return { id, amount };
}
`;

const SOURCE_V2 = `${SOURCE}
export function removeEntry(ledger: Ledger): Ledger {
  return { ...ledger, id: '' };
}
`;

interface RevisionRow {
  revisionId: string;
  artifactId: string;
  ordinal: number;
  revisionHash: string;
  contentDigest: string;
  dependencies?: Array<{ artifactId: string; revisionId: string; relation: string }>;
}

interface ArtifactRow {
  artifactId: string;
  artifactType: string;
  toolId?: string;
  currentRevisionId: string;
}

interface ExportRow {
  exportId: string;
  artifactId: string;
  revisionId: string;
  format: string;
  kind: 'normal' | 'debug';
  fileName: string;
  exportByteHash: string;
  exportByteLength: number;
}

interface ValidationRow {
  status: string;
  validatedRevisionId: string;
}

interface PackageManifest {
  manifestVersion: string;
  artifact: { artifactId: string; artifactType: string };
  revision: { revisionId: string; ordinal: number; revisionHash: string; contentDigest: string };
  validation: { status: string } | null;
  files: Array<{ path: string; byteLength: number; sha256: string }>;
}

const problems: string[] = [];
let network: NetworkLog;

test.beforeEach(({ page, context }) => {
  problems.length = 0;
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  network = createNetworkLog(context, {
    allowedOrigins: [PREVIEW_ORIGIN],
    pageLabel: 'g2-workspace',
  });
});

test.afterEach(() => {
  network.assertNoExternalRequests();
  expect(problems, `Console problems were recorded:\n${problems.join('\n')}`).toEqual([]);
});

test.beforeAll(() => {
  fs.mkdirSync(OUT, { recursive: true });
});

async function dump(page: Page): Promise<ArtifactDbDump> {
  const result = await dumpArtifactDb(page as unknown as EvaluatorLike);
  expect(result, 'artifact IndexedDB must be readable').not.toBeNull();
  return result as ArtifactDbDump;
}

function rows<T>(dumpValue: ArtifactDbDump, store: string): T[] {
  return (dumpValue.stores[store] ?? []) as T[];
}

function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function openWorkspace(page: Page) {
  await page.getByTestId('kebab-button').click();
  await page.getByTestId('artifact-workspace-open').click();
  await expect(page.getByTestId('artifact-workspace')).toBeVisible();
  await expect(page.getByTestId('artifact-row').first()).toBeVisible();
}

/** Captures once through the real Shiori pane and waits for the slot badge. */
async function captureShiori(page: Page, source: string) {
  await page.goto('#/shiori');
  await page.getByTestId('source-editor').fill(source);
  await expect(page.getByTestId('shiori-preview')).toContainText('addEntry', {
    timeout: 30_000,
  });
  const badge = page.getByTestId('artifact-status-spec');
  await expect(badge).toHaveAttribute('data-state', 'current', { timeout: 30_000 });
  await expect(badge).toHaveAttribute('data-validation', /^(valid|warning)$/);
}

test('G2-E2E-01: workspace shows history/validation/traceability and writes a verified package', async ({
  page,
}) => {
  await captureShiori(page, SOURCE);
  await openWorkspace(page);

  const row = page.getByTestId('artifact-row').filter({ hasText: '枝織' });
  await expect(row).toHaveAttribute('data-artifact-type', 'specification');
  await expect(row).toHaveAttribute('data-lifecycle', 'ready');

  // Revision history and validation come from stored records, not props.
  const revisions = page.getByTestId('artifact-revision-row');
  await expect(revisions).toHaveCount(1);
  await expect(revisions.first()).toHaveAttribute('data-current', 'true');
  const before = await dump(page);
  const storedRevision = rows<RevisionRow>(before, 'revisions')[0];
  const storedArtifact = rows<ArtifactRow>(before, 'artifacts')[0];
  expect(storedRevision.ordinal).toBe(1);
  await expect(page.getByTestId('artifact-validation')).toHaveAttribute(
    'data-status',
    /^(valid|warning)$/,
  );
  await expect(page.getByTestId('artifact-validation-result').first()).toBeVisible();

  // WO-D05 traceability: the requirement rows are resolved from evidence.
  const shioriRequirement = page
    .getByTestId('trace-requirement')
    .filter({ hasText: 'REQ-SH-01' });
  await expect(shioriRequirement).toHaveAttribute('data-status', 'validated');
  const packageRequirement = page
    .getByTestId('trace-requirement')
    .filter({ hasText: 'REQ-G2-04' });
  await expect(packageRequirement).toHaveAttribute('data-status', 'captured');

  await expect(page.getByTestId('artifact-exports-none')).toBeVisible();
  await expect(page.getByTestId('artifact-diff')).toHaveAttribute('data-changed', '0');

  // WO-D06: the package download.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('artifact-package-export').click(),
  ]);
  await expect(page.getByTestId('artifact-workspace-notice')).toHaveAttribute(
    'data-kind',
    'ok',
  );
  const file = path.join(OUT, 'g2-shiori.package.zip');
  await download.saveAs(file);
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
  expect(fs.statSync(file).size).toBeGreaterThan(0);

  const after = await dump(page);
  const exportRows = rows<ExportRow>(after, 'exports');
  expect(exportRows).toHaveLength(1);
  const storedExport = exportRows[0];
  expect(storedExport.format).toBe('package');
  expect(storedExport.kind).toBe('normal');
  expect(storedExport.artifactId).toBe(storedArtifact.artifactId);
  expect(storedExport.revisionId).toBe(storedRevision.revisionId);
  expect(storedExport.exportByteHash).toBe(sha256File(file));
  expect(storedExport.exportByteLength).toBe(fs.statSync(file).size);
  expect(rows<RevisionRow>(after, 'revisions')).toHaveLength(1);

  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  expect(zip.file('manifest.json')).toBeTruthy();
  const manifest = JSON.parse(
    await zip.file('manifest.json')!.async('text'),
  ) as PackageManifest;
  expect(manifest.manifestVersion).toBe('adop0001.package.v1');
  expect(manifest.artifact.artifactId).toBe(storedArtifact.artifactId);
  expect(manifest.artifact.artifactType).toBe('specification');
  expect(manifest.revision.revisionId).toBe(storedRevision.revisionId);
  expect(manifest.revision.revisionHash).toBe(storedRevision.revisionHash);
  expect(manifest.revision.contentDigest).toBe(storedRevision.contentDigest);
  expect(manifest.validation?.status).toMatch(/^(valid|warning)$/);
  expect(manifest.files.length).toBeGreaterThan(0);
  const manifestPaths = new Set(manifest.files.map((entry) => entry.path));
  expect(Object.keys(zip.files).sort()).toEqual(
    ['manifest.json', 'SHA256SUMS.txt', ...manifest.files.map((entry) => entry.path)].sort(),
  );
  const sumsLines = (await zip.file('SHA256SUMS.txt')!.async('text')).trimEnd().split('\n').sort();
  expect(sumsLines).toEqual(
    [
      ...manifest.files.map((entry) => `${entry.sha256}  ${entry.path}`),
      `${crypto.createHash('sha256').update(await zip.file('manifest.json')!.async('uint8array')).digest('hex')}  manifest.json`,
    ].sort(),
  );
  for (const entry of manifest.files) {
    expect(entry.path).not.toContain('..');
    expect(entry.path.startsWith('/')).toBe(false);
    expect(entry.sha256).toMatch(SHA256_HEX);
    const bytes = await zip.file(entry.path)!.async('uint8array');
    expect(bytes.byteLength).toBe(entry.byteLength);
    expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256);
  }
  expect(manifestPaths.has('manifest.json')).toBe(false);

  // WO-D06 import: the written package verifies read-only, tampering is refused
  // and neither action changes a single stored row.
  const storedBeforeImport = await dump(page);
  const storedCount = (dumpValue: ArtifactDbDump) =>
    ['artifacts', 'revisions', 'validations', 'exports'].map(
      (store) => (dumpValue.stores[store] ?? []).length,
    );
  await page.getByTestId('artifact-package-import-input').setInputFiles(file);
  await expect(page.getByTestId('artifact-import-verdict')).toHaveAttribute('data-ok', 'true');
  await expect(page.getByTestId('artifact-import-verdict')).toContainText('整合性 OK');
  const tamperedFile = path.join(OUT, 'g2-shiori.tampered.package.zip');
  const tamperedZip = await JSZip.loadAsync(fs.readFileSync(file));
  await tamperedZip.file(manifest.files[0].path, '# Tampered\n');
  fs.writeFileSync(
    tamperedFile,
    await tamperedZip.generateAsync({ type: 'uint8array' }),
  );
  await page.getByTestId('artifact-package-import-input').setInputFiles(tamperedFile);
  const refusedImport = page.getByTestId('artifact-import-verdict');
  await expect(refusedImport).toHaveAttribute('data-ok', 'false');
  await expect(page.getByTestId('artifact-import-errors')).toContainText('hash does not match');
  expect(storedCount(await dump(page))).toEqual(storedCount(storedBeforeImport));

  // The refreshed workspace reflects the stored export and the lifted trace.
  await expect(page.getByTestId('artifact-export-row')).toHaveCount(1);
  await expect(page.getByTestId('artifact-export-row')).toHaveAttribute('data-kind', 'normal');
  await expect(page.getByTestId('artifact-export-row')).toHaveAttribute('data-format', 'package');
  await expect(
    page.getByTestId('trace-requirement').filter({ hasText: 'REQ-G2-04' }),
  ).toHaveAttribute('data-selected-status', 'exported');

  // BL-15: a debug request without a reason is refused and writes nothing.
  await page.getByTestId('artifact-debug-export').click();
  await expect(page.getByTestId('artifact-debug-panel')).toBeVisible();
  await page.getByTestId('artifact-debug-confirm').click();
  const refused = page.getByTestId('artifact-workspace-notice');
  await expect(refused).toHaveAttribute('data-kind', 'error');
  await expect(refused).toContainText('デバッグ理由');
  expect(rows<ExportRow>(await dump(page), 'exports')).toHaveLength(1);

  // Archive blocks the workspace export; unarchive restores it.
  await page.getByTestId('artifact-archive').click();
  await expect(page.getByTestId('artifact-workspace-notice')).toHaveAttribute('data-kind', 'ok');
  await expect(row).toHaveAttribute('data-lifecycle', 'archived');
  await page.getByTestId('artifact-package-export').click();
  await expect(page.getByTestId('artifact-workspace-notice')).toHaveAttribute(
    'data-kind',
    'error',
  );
  await expect(page.getByTestId('artifact-workspace-notice')).toContainText('アーカイブ');
  expect(rows<ExportRow>(await dump(page), 'exports')).toHaveLength(1);
  await page.getByTestId('artifact-archive').click();
  await expect(page.getByTestId('artifact-workspace-notice')).toContainText('解除');
  await expect(row).toHaveAttribute('data-lifecycle', 'ready');

  // Two-step delete removes the artifact from the list without dropping history.
  await page.getByTestId('artifact-delete').click();
  await page.getByTestId('artifact-delete-confirm').click();
  await expect(page.getByTestId('artifact-workspace-notice')).toContainText('削除');
  await expect(page.getByTestId('artifact-workspace-empty')).toBeVisible();
  const deleted = await dump(page);
  expect(rows<ArtifactRow>(deleted, 'artifacts')[0].currentRevisionId).toBe(
    storedRevision.revisionId,
  );
  expect(rows<RevisionRow>(deleted, 'revisions')).toHaveLength(1);
});

test('G2-E2E-02: diff compares revisions and restore appends a validated revision', async ({
  page,
}) => {
  await captureShiori(page, SOURCE);
  await page.getByTestId('source-editor').fill(SOURCE_V2);
  await expect
    .poll(async () => rows<RevisionRow>(await dump(page), 'revisions').length, {
      timeout: 30_000,
    })
    .toBe(2);

  await openWorkspace(page);
  const revisions = page.getByTestId('artifact-revision-row');
  await expect(revisions).toHaveCount(2);
  const current = page.locator(
    '[data-testid="artifact-revision-row"][data-current="true"]',
  );
  await expect(current).toHaveAttribute('data-ordinal', '2');

  // WO-D07 diff: rev 1 → rev 2 shows the added marker line.
  const diff = page.getByTestId('artifact-diff');
  await expect(diff).toBeVisible();
  expect(Number(await diff.getAttribute('data-changed'))).toBeGreaterThan(0);
  await expect(
    page.getByTestId('diff-pair').filter({ hasText: 'primary' }).first(),
  ).toContainText('removeEntry');

  // Restore rev 1: a new revision is appended and validated.
  await page.getByTestId('artifact-restore-1').click();
  await expect(page.getByTestId('artifact-workspace-notice')).toHaveAttribute('data-kind', 'ok');
  await expect(page.getByTestId('artifact-workspace-notice')).toContainText('復元');
  await expect(revisions).toHaveCount(3);
  const restored = revisions.filter({ hasText: '復元元 rev 1' });
  await expect(restored).toHaveAttribute('data-current', 'true');
  await expect(restored).toHaveAttribute('data-ordinal', '3');
  await expect(page.getByTestId('artifact-restore-3')).toBeDisabled();
  await expect(page.getByTestId('artifact-validation')).toHaveAttribute(
    'data-status',
    /^(valid|warning)$/,
  );

  const dumpValue = await dump(page);
  const storedRevisions = rows<RevisionRow>(dumpValue, 'revisions');
  expect(storedRevisions).toHaveLength(3);
  const restoredRow = rows<ValidationRow>(dumpValue, 'validations').find(
    (record) =>
      record.validatedRevisionId ===
      storedRevisions.find((revision) => revision.ordinal === 3)!.revisionId,
  );
  expect(restoredRow, 'the restored revision must be validated').toBeTruthy();
  expect(restoredRow!.status).toMatch(/^(valid|warning)$/);

  // rev 2 → rev 3 (restored to rev 1) brings back the rev 1 content.
  await expect(diff).toBeVisible();
  expect(Number(await diff.getAttribute('data-changed'))).toBeGreaterThan(0);
  const contents = (await dump(page)).stores.contents as Array<{
    revisionId: string;
    role: string;
    payload: string;
  }>;
  const primaryOf = (revisionId: string) =>
    contents.find((entry) => entry.revisionId === revisionId && entry.role === 'primary')!.payload;
  const rev1 = storedRevisions.find((revision) => revision.ordinal === 1)!;
  const rev3 = storedRevisions.find((revision) => revision.ordinal === 3)!;
  expect(primaryOf(rev3.revisionId)).toBe(primaryOf(rev1.revisionId));
});

test('G2-E2E-03: Haruhi and the Kotoha DOCX slot record revision-based dependency edges', async ({
  page,
}) => {
  // Takane captures the source revision Haruhi will validate.
  await page.goto('#/takane');
  await page.getByTestId('takane-sample-payment-service.spec.md').click();
  await page.getByTestId('takane-tab-code').click();
  await expect(page.getByTestId('takane-output')).toContainText('def ', { timeout: 30_000 });
  await expect(page.getByTestId('artifact-status-code')).toHaveAttribute('data-state', 'current', {
    timeout: 30_000,
  });

  await page.goto('#/haruhi');
  await page.getByTestId('source-editor').fill(SOURCE);
  await expect(page.getByTestId('haruhi-output')).toContainText('expect(', { timeout: 30_000 });
  await expect(page.getByTestId('artifact-status-tests')).toHaveAttribute('data-state', 'current', {
    timeout: 30_000,
  });

  // Kotoha: the DOCX slot follows the Markdown slot captured in the same run.
  await page.goto('#/kotoha');
  await page.getByTestId('kotoha-sample').click();
  await expect(page.getByTestId('source-editor')).toHaveValue(/# Kotoha Round-Trip Sample/, {
    timeout: 20_000,
  });
  await expect(page.getByTestId('artifact-status-kotoha.markdown')).toHaveAttribute(
    'data-state',
    'current',
    { timeout: 30_000 },
  );
  const [rebuilt] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('kotoha-rebuild').click(),
  ]);
  await rebuilt.cancel().catch(() => undefined);
  await expect(page.getByTestId('artifact-status-kotoha.docx')).toHaveAttribute(
    'data-state',
    'current',
    { timeout: 30_000 },
  );

  const stored = await dump(page);
  const artifacts = rows<ArtifactRow>(stored, 'artifacts');
  const source = artifacts.find((artifact) => artifact.artifactType === 'source-code')!;
  const tests = artifacts.find((artifact) => artifact.artifactType === 'test-suite')!;
  const markdown = artifacts.find((artifact) => artifact.artifactType === 'markdown-document')!;
  const docx = artifacts.find((artifact) => artifact.artifactType === 'docx-document')!;
  const revisions = rows<RevisionRow>(stored, 'revisions');
  const currentRevision = (artifact: ArtifactRow) =>
    revisions.find((revision) => revision.revisionId === artifact.currentRevisionId)!;

  expect(currentRevision(tests).dependencies).toEqual([
    { artifactId: source.artifactId, revisionId: source.currentRevisionId, relation: 'validates' },
  ]);
  expect(currentRevision(docx).dependencies).toEqual([
    { artifactId: markdown.artifactId, revisionId: markdown.currentRevisionId, relation: 'derived-from' },
  ]);

  // The workspace resolves the edge against the stored target revision.
  await openWorkspace(page);
  await page.getByTestId('artifact-row').filter({ hasText: '春日' }).click();
  const dependency = page.getByTestId('artifact-dependencies').locator('li').first();
  await expect(dependency).toHaveAttribute('data-dependency-status', 'current');
  await expect(dependency).toContainText('validates');
  await expect(dependency).toContainText('貴音');
  await expect(dependency).toContainText('現行リビジョン');
});
