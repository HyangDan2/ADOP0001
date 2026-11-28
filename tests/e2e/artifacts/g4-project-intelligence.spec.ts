/**
 * G4 — project intelligence E2E (WO-E01/E05/E07/E08).
 *
 * The panel is driven on the real preview build with a ZIP produced in Node.
 * The bundle is downloaded and re-read in Node, so the UI result is compared
 * with the bytes it produced rather than with the code that produced them.
 */
import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '../../../.playwright-artifacts/g4-project');

const UTIL = 'export function double(x: number): number {\n  return x * 2;\n}\n';
const MAIN = "import { double } from './util';\nexport function run(x: number): number {\n  return double(x);\n}\n";
const CYCLE = "import './cycle';\nexport const c = 1;\n";

async function projectZip(util = UTIL): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('src/util.ts', util);
  zip.file('src/main.ts', MAIN);
  zip.file('src/cycle.ts', CYCLE);
  zip.file('src/logo.png', 'binary');
  return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

test('imports a project ZIP, explores symbols and dependencies, and exports the bundle', async ({ page }) => {
  await fs.mkdir(OUT, { recursive: true });
  await page.goto('/');
  await page.getByLabel('メニューを開く').click();
  await page.getByTestId('project-intelligence-open').click();

  const panel = page.getByTestId('project-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('project-empty')).toBeVisible();

  await page.getByTestId('project-import-zip').setInputFiles({
    name: 'project.zip',
    mimeType: 'application/zip',
    buffer: await projectZip(),
  });
  await expect(page.getByTestId('project-summary')).toContainText('ファイル 3');
  await expect(page.getByTestId('project-notice')).toContainText('スキップ 1');
  await expect(page.getByTestId('project-cycles')).toContainText('src/cycle.ts');

  const files = page.getByTestId('project-file');
  await expect(files).toHaveCount(3);
  await files.filter({ hasText: 'src/main.ts' }).click();
  await expect(page.getByTestId('project-dependencies')).toContainText('src/util.ts');
  await expect(page.getByTestId('project-dependencies')).toContainText('resolved');

  await page.getByTestId('project-symbol-query').fill('double');
  await expect(page.getByTestId('project-symbols')).toContainText('double');
  await expect(page.getByTestId('project-symbols')).toContainText('src/util.ts:1');

  await page.getByTestId('project-plan').click();
  await expect(page.getByTestId('project-plan-summary')).toContainText('ファイル');
  await expect(page.getByTestId('project-context-preview')).toContainText('src/main.ts');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('project-bundle-download').click(),
  ]);
  const saved = path.join(OUT, 'project-shiori.md');
  await download.saveAs(saved);
  const text = await fs.readFile(saved, 'utf8');
  expect(text).toContain('プロジェクト概要');
  expect(text).toContain('src/main.ts');
  expect(text).toContain('src/util.ts');
  expect(text).toContain('循環');

  // Re-importing the same paths with one changed file reuses the unchanged analyses.
  const update = await projectZip(`${UTIL}\nexport const version = 2;\n`);
  await page.getByTestId('project-import-zip').setInputFiles({
    name: 'project-v2.zip',
    mimeType: 'application/zip',
    buffer: update,
  });
  await expect(page.getByTestId('project-notice')).toContainText('再解析 1');
  await expect(page.getByTestId('project-notice')).toContainText('再利用 2');
});
