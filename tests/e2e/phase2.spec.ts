import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import {
  imageDocx,
  mergedTableDocx,
  numberedListDocx,
  reportDocx,
} from '../fixtures/docx-fixtures';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOWNLOADS = path.resolve(HERE, '../../../../downloads');
const FIXTURES = path.join(DOWNLOADS, 'adop0001-fixtures');

const problems: string[] = [];

function watch(page: Page) {
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
}

async function documentXmlOf(filePath: string): Promise<string> {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  return zip.file('word/document.xml')!.async('string');
}

async function partOf(filePath: string, part: string): Promise<string> {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  return zip.file(part)!.async('string');
}

test.describe('Phase 2 — data integrity (KOT-001~004, APP-001)', () => {
  test.beforeAll(async () => {
    fs.mkdirSync(FIXTURES, { recursive: true });
    fs.writeFileSync(path.join(FIXTURES, 'report.docx'), await reportDocx());
    fs.writeFileSync(path.join(FIXTURES, 'merged.docx'), await mergedTableDocx());
    fs.writeFileSync(path.join(FIXTURES, 'photo.docx'), await imageDocx());
    fs.writeFileSync(path.join(FIXTURES, 'lists.docx'), await numberedListDocx());
    fs.writeFileSync(path.join(FIXTURES, 'too-big.docx'), Buffer.alloc(26 * 1024 * 1024));
  });

  test.afterAll(() => {
    if (problems.length) throw new Error(`Console problems were recorded:\n${problems.join('\n')}`);
  });

  /* REG-01 */
  test('REG-01: switching tools keeps the edited input', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('./#/shiori');
    await expect(page.getByTestId('source-editor')).toBeVisible();

    const marker = 'export function kohaku(value: number) { return value * 7; } // REG-01-MARKER';
    await page.getByTestId('source-editor').fill(marker);

    await page.getByTestId('tab-haruhi').click();
    await expect(page.getByTestId('haruhi-output')).toBeVisible();
    await expect(page.getByTestId('source-editor')).not.toHaveValue(/REG-01-MARKER/);

    await page.getByTestId('tab-shiori').click();
    await expect(page.getByTestId('source-editor')).toHaveValue(/REG-01-MARKER/);
    await expect(page.getByTestId('draft-state')).toContainText('下書き保存済み');
  });

  /* REG-02 */
  test('REG-02: a reload restores the draft of the last edit', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('./#/haruhi');
    await expect(page.getByTestId('source-editor')).toBeVisible();
    await page.getByTestId('source-editor').fill('export const reloaded = "REG-02-MARKER";');

    await page.reload();
    await expect(page.getByTestId('source-editor')).toHaveValue(/REG-02-MARKER/, { timeout: 15_000 });
    await expect(page.getByTestId('draft-state')).toContainText('下書き保存済み');
  });

  /* REG-07 */
  test('REG-07: a JPEG keeps its natural aspect ratio through the rebuild', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('./#/kotoha');
    await page.getByTestId('kotoha-file').setInputFiles(path.join(FIXTURES, 'photo.docx'));
    await expect(page.getByTestId('source-editor')).toHaveValue(/!\[photo\.jpg\]\(media\/photo\.jpg\)/, { timeout: 20_000 });

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('kotoha-rebuild').click(),
    ]);
    const rebuilt = path.join(DOWNLOADS, 'phase2-photo-rebuilt.docx');
    await download.saveAs(rebuilt);

    const xml = await documentXmlOf(rebuilt);
    // Placed at 2× the natural 320×200 px: 6,096,000 × 3,810,000 EMU, ratio still 320:200.
    const match = xml.match(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/);
    expect(match).toBeTruthy();
    const cx = Number(match![1]);
    const cy = Number(match![2]);
    expect(cx).toBe(320 * 9525 * 2);
    expect(cy).toBe(200 * 9525 * 2);
    expect((cx / cy).toFixed(4)).toBe((320 / 200).toFixed(4));
  });

  /* REG-08 */
  test('REG-08: a merged table warns first and is preserved verbatim', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('./#/kotoha');
    await page.getByTestId('kotoha-sample').click();
    await expect(page.getByTestId('source-editor')).toHaveValue(/# Kotoha Round-Trip Sample/);
    // Wait until the sample has been adopted (its bundle saved) before loading another file.
    await expect(page.getByTestId('kotoha-storage')).toContainText('保存', { timeout: 15_000 });

    await page.getByTestId('kotoha-file').setInputFiles(path.join(FIXTURES, 'merged.docx'));
    const dialog = page.getByTestId('kotoha-loss-dialog');
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await expect(dialog).toContainText('セル結合を含む表');

    // Cancelling keeps the previous document (KOT-004: a failed/rejected load changes nothing).
    await page.getByTestId('kotoha-loss-cancel').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('source-editor')).toHaveValue(/# Kotoha Round-Trip Sample/);

    await page.getByTestId('kotoha-file').setInputFiles(path.join(FIXTURES, 'merged.docx'));
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('kotoha-loss-continue').click();
    await expect(page.getByTestId('kotoha-warning-banner')).toContainText('原本のまま保持');
    await expect(page.getByTestId('source-editor')).toHaveValue(/kotoha:preserved/);
    await expect(page.getByTestId('kotoha-warnings')).toContainText('セル結合');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('kotoha-rebuild').click(),
    ]);
    const rebuilt = path.join(DOWNLOADS, 'phase2-merged-rebuilt.docx');
    await download.saveAs(rebuilt);
    const xml = await documentXmlOf(rebuilt);
    expect(xml).toContain('<w:gridSpan w:val="2"/>');
    expect(xml).toMatch(/<w:vMerge w:val="restart"\/>/);
    expect(xml).toContain('<w:vMerge/>');
    expect(await partOf(rebuilt, 'word/footnotes.xml')).toContain('A footnote kept outside the body');
  });

  /* REG-09 */
  test('REG-09: inspector edits reach the JSON bundle and survive a reload of that file', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('./#/kotoha');
    await page.getByTestId('kotoha-sample').click();
    await expect(page.getByTestId('source-editor')).toHaveValue(/# Kotoha Round-Trip Sample/);

    await page.getByTestId('attr-font').fill('Noto Serif KR');
    await page.getByTestId('attr-size').fill('13');
    await page.getByTestId('attr-line').fill('1.8');
    await page.getByTestId('attr-heading-1').fill('#AA1122');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('kotoha-export-bundle').click(),
    ]);
    const bundlePath = path.join(DOWNLOADS, 'phase2-roundtrip.kotoha.json');
    await download.saveAs(bundlePath);
    const payload = JSON.parse(fs.readFileSync(bundlePath, 'utf8')) as {
      bundle: { attributes: { baseFont: string; baseFontSizePt: number; lineSpacing: number; headingColors: Record<string, string> } };
    };
    expect(payload.bundle.attributes.baseFont).toBe('Noto Serif KR');
    expect(payload.bundle.attributes.baseFontSizePt).toBe(13);
    expect(payload.bundle.attributes.lineSpacing).toBe(1.8);
    expect(payload.bundle.attributes.headingColors.Heading1).toBe('AA1122');

    // Start from a clean app (explicit draft reset from the menu), then import the bundle.
    await page.reload();
    await page.getByTestId('kebab-button').click();
    await page.getByTestId('reset-drafts').click();
    await expect(page.getByTestId('kotoha-sample')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('kotoha-bundle-file').setInputFiles(bundlePath);
    await expect(page.getByTestId('attr-font')).toHaveValue('Noto Serif KR', { timeout: 15_000 });
    await expect(page.getByTestId('attr-size')).toHaveValue('13');
    await expect(page.getByTestId('attr-line')).toHaveValue('1.8');
    await expect(page.getByTestId('attr-heading-1')).toHaveValue('#AA1122');

    const [rebuiltDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('kotoha-rebuild').click(),
    ]);
    const rebuilt = path.join(DOWNLOADS, 'phase2-roundtrip-rebuilt.docx');
    await rebuiltDownload.saveAs(rebuilt);
    const styles = await partOf(rebuilt, 'word/styles.xml');
    expect(styles).toContain('w:ascii="Noto Serif KR"');
    expect(styles).toContain('w:sz w:val="26"');
    expect(styles).toContain('w:line="432"');
    expect(styles).toContain('w:color w:val="AA1122"');
  });

  /* REG-13 */
  test('REG-13: an oversized upload is refused and the current document stays', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('./#/kotoha');
    await page.getByTestId('kotoha-sample').click();
    await expect(page.getByTestId('source-editor')).toHaveValue(/# Kotoha Round-Trip Sample/);

    await page.getByTestId('kotoha-file').setInputFiles(path.join(FIXTURES, 'too-big.docx'));
    await expect(page.getByText('ファイルが大きすぎます。上限は 25 MB です。').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('source-editor')).toHaveValue(/# Kotoha Round-Trip Sample/);
    await expect(page.getByTestId('kotoha-storage')).not.toContainText('未保存');
  });

  /* KOT-002 / list numbering across two lists */
  test('a numbered list document keeps its own numbering definition per list', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('./#/kotoha');
    await page.getByTestId('kotoha-file').setInputFiles(path.join(FIXTURES, 'lists.docx'));
    await expect(page.getByTestId('source-editor')).toHaveValue(/kotoha:list numId=2/, { timeout: 20_000 });

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('kotoha-rebuild').click(),
    ]);
    const rebuilt = path.join(DOWNLOADS, 'phase2-lists-rebuilt.docx');
    await download.saveAs(rebuilt);
    const xml = await documentXmlOf(rebuilt);
    const count = (needle: string) => xml.split(needle).length - 1;
    expect(count('w:numId w:val="1"')).toBe(3);
    expect(count('w:numId w:val="2"')).toBe(2);
    expect(count('w:numId w:val="3"')).toBe(1);
  });
});
