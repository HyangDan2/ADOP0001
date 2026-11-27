/**
 * G1 closure — artifact capture → ExportGuard → registerExport → download E2E.
 *
 * G1-BL-05: no browser-level evidence existed for the six-tool artifact path.
 * These tests drive the real UI on the real preview build and then read the
 * artifact IndexedDB back, so the assertions come from stored records and the
 * written files instead of the implementation's own return values.
 *
 * CP03 attack (c037496, re-judged on the CP03-closed tip 5154035): Kotoha
 * `.kotoha.json` must stay exportable after an inspector edit (KOT-003), must
 * be refused as stale after a Markdown body edit, and must keep working after
 * a reload/import; the new `verifySnapshot` path must not disturb the other
 * tools' exports (ART-E2E-01..05).
 *
 * Supplementary checks requested by Qoder-00 on 5154035: ART-E2E-12 stalls the
 * Kotoha draft store and exports right after an inspector edit, and ART-E2E-13
 * switches documents through a bundle import and proves the previous document's
 * artifact cannot authorize the new one (adoption-token boundary).
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

interface ContentRow {
  contentId: string;
  revisionId: string;
  role: string;
  encoding: string;
  payload: string;
  contentHash: string;
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

/* ------------------------------------------------------------------ */
/* 5154035 supplementary checks (Qoder-00)                             */
/* ------------------------------------------------------------------ */

function primaryPayload(db: ArtifactDbDump, revisionId: string): string {
  const entry = rows<ContentRow>(db, 'contents').find(
    (item) => item.revisionId === revisionId && item.role === 'primary',
  );
  expect(entry, 'the revision must carry a primary content entry').toBeTruthy();
  return (entry as ContentRow).payload;
}

test('ART-E2E-12: a stalled draft store does not cancel the Kotoha capture — the immediate export after an inspector edit succeeds, a body edit is refused immediately', async ({
  page,
}) => {
  // Slow environment simulation: every connection opened for the Kotoha draft
  // database ('adop0001-kotoha') delivers `onsuccess` 1.5 s late, so the draft
  // write is still in flight while the user edits and exports. On the pre-fix
  // capture (tied to the request gate / draft save) this window cancelled the
  // capture; on 5154035 the capture belongs to the adoption token.
  await page.addInitScript(() => {
    const open = IDBFactory.prototype.open;
    const STALL_DB = 'adop0001-kotoha';
    const DELAY_MS = 1500;
    IDBFactory.prototype.open = function (name: string, version?: number) {
      const request = open.call(this, name, version);
      if (name !== STALL_DB) return request;
      const descriptor = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'onsuccess');
      if (!descriptor?.get || !descriptor.set) return request;
      Object.defineProperty(request, 'onsuccess', {
        configurable: true,
        get() {
          return descriptor.get?.call(this);
        },
        set(handler: ((this: IDBRequest, event: Event) => void) | null) {
          const wrapped = handler
            ? function (this: IDBRequest, event: Event) {
                setTimeout(() => handler.call(this, event), DELAY_MS);
              }
            : handler;
          descriptor.set?.call(this, wrapped);
        },
      });
      return request;
    };
  });

  const downloads: string[] = [];
  page.on('download', (download) => downloads.push(download.suggestedFilename()));

  await page.goto('#/kotoha');
  await page.getByTestId('kotoha-sample').click();
  await expect(page.getByTestId('source-editor')).toHaveValue(/# Kotoha Round-Trip Sample/, { timeout: 30_000 });

  // Edit the inspector and export at once — no settle, the draft save is stalled.
  await page.getByTestId('attr-font').fill('Meiryo');
  await page.getByTestId('attr-font').blur();
  await openExport(page, 'kotoha');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    page.getByTestId('export-bundle').click(),
  ]);
  await expect(page.getByTestId('export-feedback')).toHaveAttribute('data-kind', 'ok', { timeout: 20_000 });
  const stalledFile = path.join(OUT, 'g1-kotoha-stalled-draft.kotoha.json');
  await download.saveAs(stalledFile);
  const stalledPayload = JSON.parse(fs.readFileSync(stalledFile, 'utf8')) as {
    markdown: string;
    bundle: { attributes: { baseFont?: string } };
  };
  expect(stalledPayload.markdown, 'the capture survived the stalled draft write').toContain(
    '# Kotoha Round-Trip Sample',
  );
  expect(stalledPayload.bundle.attributes.baseFont, 'the live inspector value is merged').toBe('Meiryo');

  const stalledDump = await dump(page);
  const markdownArtifact = rows<ArtifactRow>(stalledDump, 'artifacts').find(
    (item) => item.artifactType === 'markdown-document',
  );
  expect(markdownArtifact, 'the stalled draft write did not prevent the capture').toBeTruthy();
  const stalledRow = rows<ExportRow>(stalledDump, 'exports')
    .filter((item) => item.fileName === download.suggestedFilename() && item.format === 'bundle')
    .reduce<ExportRow | null>((newest, item) => (!newest || item.createdAt >= newest.createdAt ? item : newest), null);
  expect(stalledRow).not.toBeNull();
  expect((stalledRow as ExportRow).exportByteHash).toBe(sha256File(stalledFile));

  // A body edit immediately afterwards is still refused as stale.
  const exportsAfterStall = rows<ExportRow>(stalledDump, 'exports').length;
  await closeExport(page);
  await page.getByTestId('source-editor').fill('# Body edited while the draft store is stalled.');
  await openExport(page, 'kotoha');
  await page.getByTestId('export-bundle').click();
  await expect(page.getByTestId('export-feedback')).toHaveAttribute('data-kind', 'error', { timeout: 20_000 });
  await expect(page.getByTestId('export-feedback')).toContainText(
    '入力が変更されています。再生成してから書き出してください。',
  );
  await page.waitForTimeout(300);
  expect(downloads.length, 'the stale refusal writes no file').toBe(1);
  expect(rows<ExportRow>(await dump(page), 'exports').length, 'the stale refusal writes no row').toBe(
    exportsAfterStall,
  );
  await closeExport(page);
});

test('ART-E2E-13: after a document switch the previous document artifact cannot authorize the export (adoption boundary)', async ({
  page,
}) => {
  await page.goto('#/kotoha');
  await page.getByTestId('kotoha-sample').click();
  await expect(page.getByTestId('source-editor')).toHaveValue(/# Kotoha Round-Trip Sample/, { timeout: 30_000 });
  await expectSlotReady(page, 'kotoha.markdown');

  await openExport(page, 'kotoha');
  const first = await exportAndVerify(page, {
    formatId: 'bundle',
    saveName: 'g1-kotoha-document-a.kotoha.json',
    format: 'bundle',
    derivation: 'rendered',
    artifactType: 'markdown-document',
  });
  await closeExport(page);

  const beforeSwitch = await dump(page);
  const artifactBefore = rows<ArtifactRow>(beforeSwitch, 'artifacts').find(
    (item) => item.artifactType === 'markdown-document',
  );
  expect(artifactBefore).toBeTruthy();
  const revisionBefore = rows<RevisionRow>(beforeSwitch, 'revisions').find(
    (item) => item.revisionId === artifactBefore?.currentRevisionId,
  );
  expect(revisionBefore, 'document A has a captured revision').toBeTruthy();
  expect(primaryPayload(beforeSwitch, revisionBefore?.revisionId ?? '')).toContain('# Kotoha Round-Trip Sample');

  // Document B: the exported bundle with a different body and file name.
  const payloadA = JSON.parse(fs.readFileSync(first.file, 'utf8')) as {
    version: number;
    tool: string;
    markdown: string;
    bundle: { fileName: string };
  };
  const docB = '# Second Document\n\nThis document was switched in through an import.';
  const switchFile = path.join(OUT, 'g1-kotoha-document-b.kotoha.json');
  fs.writeFileSync(
    switchFile,
    JSON.stringify(
      {
        ...payloadA,
        markdown: docB,
        bundle: { ...payloadA.bundle, fileName: 'second-document.docx' },
      },
      null,
      2,
    ),
  );

  const downloads: string[] = [];
  page.on('download', (download) => downloads.push(download.suggestedFilename()));
  await page.getByTestId('kotoha-bundle-file').setInputFiles(switchFile);
  await expect(page.getByTestId('source-editor')).toHaveValue(/# Second Document/, { timeout: 30_000 });

  // An export click that races the new capture must never emit document A.
  await openExport(page, 'kotoha');
  const racedDownload = page.waitForEvent('download', { timeout: 30_000 }).catch(() => null);
  await page.getByTestId('export-bundle').click();
  const feedback = page.getByTestId('export-feedback');
  await expect(feedback).toHaveAttribute('data-kind', /^(ok|error)$/, { timeout: 20_000 });
  if ((await feedback.getAttribute('data-kind')) === 'error') {
    await expect(feedback).toContainText('入力が変更されています。再生成してから書き出してください。');
    expect(downloads.length, 'the refused race writes no file').toBe(0);
  } else {
    const download = await racedDownload;
    expect(download, 'an ok feedback must come with the written file').not.toBeNull();
    const raced = path.join(OUT, 'g1-kotoha-switch-race.kotoha.json');
    await (download as NonNullable<typeof download>).saveAs(raced);
    const racedText = fs.readFileSync(raced, 'utf8');
    expect(racedText, 'a successful race must be authorized by document B').toContain('# Second Document');
    expect(racedText).not.toContain('# Kotoha Round-Trip Sample');
  }

  // Once document B is captured, the export binds to B's revision, not A's.
  await expectSlotReady(page, 'kotoha.markdown');
  const switched = await exportAndVerify(page, {
    formatId: 'bundle',
    saveName: 'g1-kotoha-document-b-export.kotoha.json',
    format: 'bundle',
    derivation: 'rendered',
    artifactType: 'markdown-document',
  });
  expect(switched.row.revisionId, 'the export names a new revision, not document A').not.toBe(
    revisionBefore?.revisionId,
  );
  expect(fs.readFileSync(switched.file, 'utf8')).toContain('# Second Document');
  expect(fs.readFileSync(switched.file, 'utf8')).not.toContain('# Kotoha Round-Trip Sample');

  const afterSwitch = await dump(page);
  const artifactAfter = rows<ArtifactRow>(afterSwitch, 'artifacts').find(
    (item) => item.artifactType === 'markdown-document',
  );
  expect(artifactAfter?.currentRevisionId).toBe(switched.row.revisionId);
  expect(primaryPayload(afterSwitch, switched.row.revisionId), 'the current revision holds document B').toBe(docB);
  const revisionAStillStored = rows<RevisionRow>(afterSwitch, 'revisions').some(
    (item) => item.revisionId === revisionBefore?.revisionId,
  );
  expect(revisionAStillStored, 'document A history is kept, but it is no longer current').toBe(true);

  const switchedExports = rows<ExportRow>(afterSwitch, 'exports').filter(
    (item) => item.fileName === 'second-document.kotoha.json',
  );
  expect(switchedExports.length).toBeGreaterThan(0);
  for (const row of switchedExports) {
    expect(
      row.revisionId === switched.row.revisionId,
      'no export of document B may be registered against document A',
    ).toBe(true);
  }
  await closeExport(page);
});

/**
 * G1-BL-13 (fixed in G2/WO-D07): the capture service now publishes the artifact,
 * revision and validation read *after* `appendRevision`, so a fresh capture's
 * badge and the export guard agree on the current pointer. This test was kept
 * as `test.fail` while the defect was open; it is un-marked now that the badge
 * is judged on the post-append state.
 */
test(
  'ART-E2E-11: the status badge reports the same export eligibility as the guard (G1-BL-13)',
  async ({ page }) => {
    await page.goto('#/shiori');
    await page.getByTestId('source-editor').fill(SOURCE);
    await expect(page.getByTestId('shiori-preview')).toContainText('addEntry', { timeout: 30_000 });
    const badge = await expectSlotReady(page, 'spec');
    await expect(badge).toHaveAttribute('data-export', 'allowed');
  },
);
