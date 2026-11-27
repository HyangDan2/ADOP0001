/**
 * G1 closure — artifact capture → ExportGuard → registerExport → download E2E.
 *
 * G1-BL-05: no browser-level evidence existed for the six-tool artifact path.
 * These tests drive the real UI on the real preview build and then read the
 * artifact IndexedDB back, so the assertions come from stored records and the
 * written files instead of the implementation's own return values.
 *
 * CP03 attack (c037496): Kotoha `.kotoha.json` must stay exportable after an
 * inspector edit (KOT-003), must be refused as stale after a Markdown body
 * edit, and must keep working after a reload/import; the new `verifySnapshot`
 * path must not disturb the other tools' exports (ART-E2E-01..05).
 */
import { expect, test, type Page } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PREVIEW_ORIGIN } from '../previewOrigin';
import { dumpArtifactDb, type ArtifactDbDump, type EvaluatorLike } from './helpers/idbDump';
import { createNetworkLog, type NetworkLog } from './helpers/networkLog';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const OUT = path.join(ROOT, '.playwright-artifacts', 'g1-closure');

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

export async function loadLedger(id: string): Promise<Ledger> {
  const response = await fetch(\`/api/ledger/\${id}\`);
  if (!response.ok) throw new Error('load failed');
  return response.json();
}
`;

interface RevisionRow {
  revisionId: string;
  artifactId: string;
  revisionHash: string;
  contentDigest: string;
  ordinal: number;
}

interface ArtifactRow {
  artifactId: string;
  artifactType: string;
  currentRevisionId: string;
  historyEpoch: number;
}

interface ExportRow {
  exportId: string;
  artifactId: string;
  revisionId: string;
  revisionHash: string;
  contentDigest: string;
  format: string;
  exportContentType: string;
  exportByteHash: string;
  exportByteLength: number;
  derivation: { kind: 'direct' | 'rendered'; sourceContentId: string; sourceContentHash: string };
  fileName: string;
  kind: 'normal' | 'debug';
  createdAt: string;
}

interface ValidationRow {
  status: string;
  validatedRevisionId: string;
  validatedContentDigest: string;
  validatedRevisionHash: string;
}

const problems: string[] = [];
let network: NetworkLog;

test.beforeEach(({ page, context }) => {
  problems.length = 0;
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  network = createNetworkLog(context, { allowedOrigins: [PREVIEW_ORIGIN], pageLabel: 'g1-closure' });
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
  expect(result, 'artifact IndexedDB must be readable after capture').not.toBeNull();
  return result as ArtifactDbDump;
}

function rows<T>(dumpValue: ArtifactDbDump, store: string): T[] {
  return (dumpValue.stores[store] ?? []) as T[];
}

async function expectSlotReady(page: Page, slotId: string) {
  const badge = page.getByTestId(`artifact-status-${slotId}`);
  await expect(badge).toBeVisible({ timeout: 30_000 });
  await expect(badge).toHaveAttribute('data-state', 'current', { timeout: 30_000 });
  await expect(badge).toHaveAttribute('data-validation', /^(valid|warning)$/);
  return badge;
}

function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Saves the download, then proves the stored export row describes these exact
 * bytes and the revision that was current when the file was written.
 */
async function exportAndVerify(
  page: Page,
  options: {
    formatId: string;
    saveName: string;
    format: string;
    derivation: 'direct' | 'rendered';
    artifactType: string;
  },
): Promise<{ file: string; row: ExportRow }> {
  // Let any trailing debounce run and its capture land before the click, so the
  // test exercises the export path instead of a capture race.
  await page.waitForTimeout(400);
  const before = await dump(page);
  const beforeExports = rows<ExportRow>(before, 'exports').length;
  const beforeRevisions = rows<RevisionRow>(before, 'revisions').length;
  const beforeArtifacts = rows<ArtifactRow>(before, 'artifacts').length;

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId(`export-${options.formatId}`).click(),
  ]);
  const feedback = page.getByTestId('export-feedback');
  await expect(feedback).toHaveAttribute('data-kind', 'ok', { timeout: 20_000 });

  const file = path.join(OUT, options.saveName);
  await download.saveAs(file);
  expect(fs.statSync(file).size).toBeGreaterThan(0);

  const after = await dump(page);
  const exports = rows<ExportRow>(after, 'exports');
  expect(exports.length, 'registerExport writes exactly one row per saved file').toBe(beforeExports + 1);
  expect(rows<RevisionRow>(after, 'revisions').length, 'an export never creates a revision').toBe(beforeRevisions);
  expect(rows<ArtifactRow>(after, 'artifacts').length, 'an export never creates an artifact').toBe(beforeArtifacts);

  const row = exports
    .filter((item) => item.fileName === download.suggestedFilename() && item.format === options.format)
    .reduce<ExportRow | null>((newest, item) => (!newest || item.createdAt >= newest.createdAt ? item : newest), null);
  expect(row, 'the stored rows must contain the file just written').not.toBeNull();
  const saved = row as ExportRow;
  expect(saved.kind).toBe('normal');
  expect(saved.derivation.kind).toBe(options.derivation);
  expect(saved.derivation.sourceContentId).toMatch(/\S/);
  expect(saved.derivation.sourceContentHash).toMatch(SHA256_HEX);
  expect(saved.revisionHash).toMatch(SHA256_HEX);
  expect(saved.contentDigest).toMatch(SHA256_HEX);
  expect(saved.exportByteHash).toMatch(SHA256_HEX);
  expect(saved.exportByteLength).toBe(fs.statSync(file).size);
  expect(saved.exportByteHash, 'the export hash must describe the saved file').toBe(sha256File(file));

  const revision = rows<RevisionRow>(after, 'revisions').find((item) => item.revisionId === saved.revisionId);
  expect(revision, 'the export must name a stored revision').toBeTruthy();
  expect(revision?.revisionHash).toBe(saved.revisionHash);
  expect(revision?.contentDigest).toBe(saved.contentDigest);

  const artifact = rows<ArtifactRow>(after, 'artifacts').find((item) => item.artifactId === saved.artifactId);
  expect(artifact, 'the export must name a stored artifact').toBeTruthy();
  expect(artifact?.artifactType).toBe(options.artifactType);
  expect(artifact?.currentRevisionId, 'the exported revision is still the current one').toBe(saved.revisionId);
  expect(typeof artifact?.historyEpoch).toBe('number');

  const validations = rows<ValidationRow>(after, 'validations');
  const validation = validations.find((item) => item.validatedRevisionId === saved.revisionId);
  expect(validation, 'the exported revision carries its validation record').toBeTruthy();
  expect(['valid', 'warning']).toContain(validation?.status);
  expect(validation?.validatedContentDigest).toBe(saved.contentDigest);
  expect(validation?.validatedRevisionHash).toBe(saved.revisionHash);

  return { file, row: saved };
}

async function openExport(page: Page, tool: string) {
  await page.getByTestId(`${tool}-export`).click();
  await expect(page.getByTestId('export-modal')).toBeVisible();
}

async function closeExport(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('export-modal')).toHaveCount(0);
}

/* ------------------------------------------------------------------ */
/* Six tools: capture → guard → registerExport → download              */
/* ------------------------------------------------------------------ */

test('ART-E2E-01: Shiori captures a spec and the Markdown export is registered and written', async ({ page }) => {
  await page.goto('#/shiori');
  await page.getByTestId('source-editor').fill(SOURCE);
  await expect(page.getByTestId('shiori-preview')).toContainText('addEntry', { timeout: 30_000 });
  await expectSlotReady(page, 'spec');
  await openExport(page, 'shiori');
  const { file } = await exportAndVerify(page, {
    formatId: 'markdown',
    saveName: 'g1-shiori.spec.md',
    format: 'markdown',
    derivation: 'direct',
    artifactType: 'specification',
  });
  const markdown = fs.readFileSync(file, 'utf8');
  expect(markdown).toContain('addEntry');
  expect(markdown).toContain('loadLedger');
  await closeExport(page);
  await expectSlotReady(page, 'spec');
});

test('ART-E2E-02: Yayoi captures pseudocode and the Markdown export is registered and written', async ({ page }) => {
  await page.goto('#/yayoi');
  await page.getByTestId('source-editor').fill(SOURCE);
  await expect(page.getByTestId('yayoi-output')).toContainText('addEntry', { timeout: 30_000 });
  await expectSlotReady(page, 'pseudocode');
  await openExport(page, 'yayoi');
  const { file } = await exportAndVerify(page, {
    formatId: 'markdown',
    saveName: 'g1-yayoi.pseudo.md',
    format: 'markdown',
    derivation: 'direct',
    artifactType: 'pseudocode',
  });
  expect(fs.readFileSync(file, 'utf8')).toContain('addEntry');
  await closeExport(page);
});

test('ART-E2E-03: Kozue captures the diagram and the rendered SVG export is registered and written', async ({ page }) => {
  await page.goto('#/kozue');
  await page.getByTestId('source-editor').fill(SOURCE);
  await expect
    .poll(async () => (await page.getByTestId('kozue-diagram').innerText()).length, { timeout: 30_000 })
    .toBeGreaterThan(10);
  await expectSlotReady(page, 'uml');
  await openExport(page, 'kozue');
  const { file } = await exportAndVerify(page, {
    formatId: 'svg',
    saveName: 'g1-kozue.svg',
    format: 'svg',
    derivation: 'rendered',
    artifactType: 'uml-diagram',
  });
  const svg = fs.readFileSync(file, 'utf8');
  expect(svg).toContain('<svg');
  expect(svg).toContain('xmlns');
  await closeExport(page);
});

test('ART-E2E-04: Haruhi captures the test suite and the test export is registered and written', async ({ page }) => {
  await page.goto('#/haruhi');
  await page.getByTestId('source-editor').fill(SOURCE);
  await expect(page.getByTestId('haruhi-output')).toContainText('expect(', { timeout: 30_000 });
  await expectSlotReady(page, 'tests');
  await openExport(page, 'haruhi');
  const { file } = await exportAndVerify(page, {
    formatId: 'test',
    saveName: 'g1-haruhi.test.ts',
    format: 'test',
    derivation: 'direct',
    artifactType: 'test-suite',
  });
  expect(fs.readFileSync(file, 'utf8')).toContain('expect(');
  await closeExport(page);
});

test('ART-E2E-05: Takane captures a scaffold and the Python export is registered and written', async ({ page }) => {
  await page.goto('#/takane');
  await page.getByTestId('takane-sample-payment-service.spec.md').click();
  await page.getByTestId('takane-tab-code').click();
  await expect(page.getByTestId('takane-output')).toContainText('def ', { timeout: 30_000 });
  await expectSlotReady(page, 'code');
  await openExport(page, 'takane');
  const { file } = await exportAndVerify(page, {
    formatId: 'python',
    saveName: 'g1-takane.py',
    format: 'python',
    derivation: 'direct',
    artifactType: 'source-code',
  });
  expect(fs.readFileSync(file, 'utf8')).toContain('def ');
  await closeExport(page);
});

test('ART-E2E-06: Kotoha captures Markdown and DOCX slots and both exports are registered and written', async ({ page }) => {
  await page.goto('#/kotoha');
  await page.getByTestId('kotoha-sample').click();
  await expect(page.getByTestId('source-editor')).toHaveValue(/# Kotoha Round-Trip Sample/, { timeout: 20_000 });
  const [rebuilt] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('kotoha-rebuild').click(),
  ]);
  await rebuilt.cancel().catch(() => undefined);
  await expectSlotReady(page, 'kotoha.markdown');
  await expectSlotReady(page, 'kotoha.docx');

  await openExport(page, 'kotoha');
  const docx = await exportAndVerify(page, {
    formatId: 'docx',
    saveName: 'g1-kotoha.docx',
    format: 'docx',
    derivation: 'direct',
    artifactType: 'docx-document',
  });
  expect(fs.readFileSync(docx.file).subarray(0, 2).toString('latin1')).toBe('PK');

  const bundle = await exportAndVerify(page, {
    formatId: 'bundle',
    saveName: 'g1-kotoha.kotoha.json',
    format: 'bundle',
    derivation: 'rendered',
    artifactType: 'markdown-document',
  });
  const payload = JSON.parse(fs.readFileSync(bundle.file, 'utf8')) as {
    version: number;
    tool: string;
    markdown: string;
    bundle: { attributes?: unknown };
  };
  expect(payload.version).toBe(1);
  expect(payload.tool).toBe('kotoha');
  expect(payload.markdown).toContain('# Kotoha Round-Trip Sample');
  expect(payload.bundle.attributes).toBeTruthy();
  await closeExport(page);
});

/* ------------------------------------------------------------------ */
/* CP03 attack — Kotoha .kotoha.json                                   */
/* ------------------------------------------------------------------ */

test('ART-E2E-07: an attribute edit keeps the bundle exportable (KOT-003), a Markdown body edit is refused as stale', async ({
  page,
}) => {
  await page.goto('#/kotoha');
  await page.getByTestId('kotoha-sample').click();
  await expect(page.getByTestId('source-editor')).toHaveValue(/# Kotoha Round-Trip Sample/, { timeout: 20_000 });
  const [rebuilt] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('kotoha-rebuild').click(),
  ]);
  await rebuilt.cancel().catch(() => undefined);
  await expectSlotReady(page, 'kotoha.markdown');
  await expectSlotReady(page, 'kotoha.docx');

  // The "body edit supersedes the draft write but not the adopted document"
  // path: an inspector edit drops the .docx result, so both slot badges report
  // the pane as stale — yet the stored Markdown artifact still authorizes the
  // bundle export of the current document (KOT-003).
  await page.getByTestId('attr-font').fill('Meiryo');
  await page.getByTestId('attr-font').blur();
  const docxBadge = page.getByTestId('artifact-status-kotoha.docx');
  await expect(docxBadge).toHaveAttribute('data-state', 'stale');
  await expect(docxBadge).toHaveAttribute('data-export', 'blocked');
  const mdBadge = page.getByTestId('artifact-status-kotoha.markdown');
  await expect(mdBadge).toHaveAttribute('data-state', 'stale');
  await expect(mdBadge).toHaveAttribute('data-export', 'blocked');

  await openExport(page, 'kotoha');
  const { file } = await exportAndVerify(page, {
    formatId: 'bundle',
    saveName: 'g1-kotoha-attr.kotoha.json',
    format: 'bundle',
    derivation: 'rendered',
    artifactType: 'markdown-document',
  });
  const payload = JSON.parse(fs.readFileSync(file, 'utf8')) as { markdown: string; bundle: { attributes: { baseFont?: string } } };
  expect(payload.markdown).toContain('# Kotoha Round-Trip Sample');
  expect(payload.bundle.attributes.baseFont, 'the live inspector value is merged into the bundle').toBe('Meiryo');

  // The .docx of the previous build must not be written.
  const before = await dump(page);
  const beforeExports = rows<ExportRow>(before, 'exports').length;
  await page.getByTestId('export-docx').click();
  await expect(page.getByTestId('export-feedback')).toHaveAttribute('data-kind', 'error');
  await expect(page.getByTestId('export-feedback')).toContainText('再構築');
  await page.waitForTimeout(300);
  expect(rows<ExportRow>(await dump(page), 'exports').length, 'a refused export writes no row').toBe(beforeExports);

  // A Markdown body edit is refused by the new verifySnapshot path.
  await closeExport(page);
  await page.getByTestId('source-editor').fill('# Edited body\n\nThis body no longer matches the captured artifact.');
  await openExport(page, 'kotoha');
  await page.getByTestId('export-bundle').click();
  await expect(page.getByTestId('export-feedback')).toHaveAttribute('data-kind', 'error');
  await expect(page.getByTestId('export-feedback')).toContainText('入力が変更されています。再生成してから書き出してください。');
  expect(rows<ExportRow>(await dump(page), 'exports').length, 'the stale refusal writes no row').toBe(beforeExports);

  // Rebuilding adopts the edited body; the same modal exports it normally.
  await closeExport(page);
  const [rebuilt2] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('kotoha-rebuild').click(),
  ]);
  await rebuilt2.cancel().catch(() => undefined);
  await expect(page.getByTestId('artifact-status-kotoha.markdown')).toHaveAttribute('data-state', 'current', {
    timeout: 30_000,
  });
  await openExport(page, 'kotoha');
  await exportAndVerify(page, {
    formatId: 'bundle',
    saveName: 'g1-kotoha-rebuilt.kotoha.json',
    format: 'bundle',
    derivation: 'rendered',
    artifactType: 'markdown-document',
  });
  await closeExport(page);
});

test('ART-E2E-08: after a reload an imported bundle re-captures and exports normally', async ({ page }) => {
  await page.goto('#/kotoha');
  await page.getByTestId('kotoha-sample').click();
  await expect(page.getByTestId('source-editor')).toHaveValue(/# Kotoha Round-Trip Sample/, { timeout: 20_000 });
  const [rebuilt] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('kotoha-rebuild').click(),
  ]);
  await rebuilt.cancel().catch(() => undefined);
  await expectSlotReady(page, 'kotoha.markdown');

  await openExport(page, 'kotoha');
  const first = await exportAndVerify(page, {
    formatId: 'bundle',
    saveName: 'g1-kotoha-before-reload.kotoha.json',
    format: 'bundle',
    derivation: 'rendered',
    artifactType: 'markdown-document',
  });
  await closeExport(page);

  await page.reload();
  await page.getByTestId('kotoha-bundle-file').setInputFiles(first.file);
  await expect(page.getByTestId('source-editor')).toHaveValue(/# Kotoha Round-Trip Sample/, { timeout: 30_000 });
  await expectSlotReady(page, 'kotoha.markdown');

  const artifactRows = rows<ArtifactRow>(await dump(page), 'artifacts');
  const markdownArtifact = artifactRows.find((item) => item.artifactType === 'markdown-document');
  expect(markdownArtifact, 'reload keeps the markdown artifact').toBeTruthy();

  await openExport(page, 'kotoha');
  const second = await exportAndVerify(page, {
    formatId: 'bundle',
    saveName: 'g1-kotoha-after-reload.kotoha.json',
    format: 'bundle',
    derivation: 'rendered',
    artifactType: 'markdown-document',
  });
  expect(second.row.exportId).not.toBe(first.row.exportId);
  const exportsAfter = rows<ExportRow>(await dump(page), 'exports');
  expect(exportsAfter.length, 'both exports survive the reload').toBe(2);
  await closeExport(page);
});

test('ART-E2E-09: an edit followed by a re-run exports the newer artifact with a newer revision', async ({ page }) => {
  await page.goto('#/shiori');
  const editor = page.getByTestId('source-editor');
  await editor.fill(SOURCE);
  await expectSlotReady(page, 'spec');
  const firstRevision = rows<RevisionRow>(await dump(page), 'revisions')[0];

  await editor.fill(`${SOURCE}\nexport function newest(): string {\n  return "newest";\n}\n`);
  await expect(page.getByTestId('shiori-preview')).toContainText('newest', { timeout: 30_000 });
  const badge = await expectSlotReady(page, 'spec');
  await expect(badge).toContainText('rev 2');

  await openExport(page, 'shiori');
  const { file, row } = await exportAndVerify(page, {
    formatId: 'markdown',
    saveName: 'g1-shiori-edited.spec.md',
    format: 'markdown',
    derivation: 'direct',
    artifactType: 'specification',
  });
  expect(row.revisionId).not.toBe(firstRevision.revisionId);
  expect(fs.readFileSync(file, 'utf8')).toContain('newest');
  await closeExport(page);
});

/* ------------------------------------------------------------------ */
/* New status elements at the layout extremes                          */
/* ------------------------------------------------------------------ */

test('ART-E2E-10: the artifact status stays inside the layout at 320px and 1440px', async ({ page }) => {
  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [tool, slot] of [
      ['shiori', 'spec'],
      ['yayoi', 'pseudocode'],
      ['haruhi', 'tests'],
      ['takane', 'code'],
    ] as const) {
      await page.goto(`#/${tool}`);
      const badge = page.getByTestId(`artifact-status-${slot}`);
      await expect(badge).toBeVisible();
      const metrics = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(metrics.scrollWidth, `${tool} at ${width}px`).toBeLessThanOrEqual(metrics.innerWidth + 1);
    }
  }
});

/**
 * Proposed G1-BL-13 (P2, display only): the slot badge derives eligibility from
 * the capture snapshot's artifact record, which is the record read *before*
 * `appendRevision`. A fresh capture therefore always reports
 * "revision-not-current" (+ "artifact-not-ready" on the first revision) while
 * the export guard, reading the repository's current pointer, accepts the same
 * export — ART-E2E-01..09 prove the downloads and stored export rows are
 * correct. `test.fail` keeps the defect visible; once it is fixed this test
 * starts passing and must be un-marked.
 */
test.fail(
  'ART-E2E-11: the status badge reports the same export eligibility as the guard (G1-BL-13)',
  async ({ page }) => {
    await page.goto('#/shiori');
    await page.getByTestId('source-editor').fill(SOURCE);
    await expect(page.getByTestId('shiori-preview')).toContainText('addEntry', { timeout: 30_000 });
    const badge = await expectSlotReady(page, 'spec');
    await expect(badge).toHaveAttribute('data-export', 'allowed');
  },
);
