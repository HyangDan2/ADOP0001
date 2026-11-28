/**
 * G7 residual closure — G6-RES-004 (Mermaid first load / memory) and WO-G7-02
 * (six project tool bundles from one imported project).
 *
 * The Mermaid test observes the network and the heap from inside the browser;
 * it does not infer laziness from the source.
 */
import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '../../.playwright-artifacts/g7');

const SOURCE = `export function isPositive(x: number): boolean {
  return x > 0;
}

export async function fetchData(url: string): Promise<string> {
  if (!url) {
    throw new TypeError('url is required');
  }
  return 'payload';
}
`;

async function projectZip(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('src/util.ts', 'export function double(x: number): number {\n  return x * 2;\n}\n');
  zip.file('src/main.ts', "import { double } from './util';\nexport function run(x: number): number {\n  return double(x);\n}\n");
  return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

test('G6-RES-004: Mermaid is not requested until the diagram view opens, then loads once', async ({ page }) => {
  const mermaidRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('vendor/mermaid')) mermaidRequests.push(request.url());
  });

  await page.goto('/');
  await page.getByTestId('source-editor').fill(SOURCE);
  await page.waitForTimeout(1000);
  expect(mermaidRequests, 'the main bundle must not pull Mermaid on first paint').toEqual([]);

  const before = await page.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0);
  const started = Date.now();
  await page.getByTestId('tab-kozue').click();
  await expect(page.getByTestId('kozue-diagram').locator('svg')).toHaveCount(1, { timeout: 30_000 });
  const elapsed = Date.now() - started;
  const after = await page.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0);

  const resources = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .filter((entry) => entry.name.includes('vendor/mermaid'))
      .map((entry) => {
        const resource = entry as PerformanceResourceTiming;
        return { name: resource.name, duration: resource.duration, transferSize: resource.transferSize, decodedBodySize: resource.decodedBodySize };
      }),
  );

  console.log(
    `mermaid: requests=${mermaidRequests.length} resources=${JSON.stringify(resources)} view=${elapsed}ms heapDelta=${Math.round((after - before) / 1024)}KiB`,
  );
  expect(mermaidRequests).toHaveLength(1);
  expect(resources).toHaveLength(1);
  expect(resources[0].decodedBodySize).toBeGreaterThan(0);
  expect(resources[0].decodedBodySize).toBeLessThan(5 * 1024 * 1024);
  expect(elapsed).toBeLessThan(15_000);
  // Only meaningful when the browser exposes performance.memory (Chromium).
  if (after > 0 && before > 0) expect(after - before).toBeLessThan(128 * 1024 * 1024);
});

test('WO-G7-02: all six tools produce a project bundle from the imported ZIP', async ({ page }) => {
  await fs.mkdir(OUT, { recursive: true });
  await page.goto('/');
  await page.getByLabel('メニューを開く').click();
  await page.getByTestId('project-intelligence-open').click();
  await page.getByTestId('project-import-zip').setInputFiles({
    name: 'project.zip',
    mimeType: 'application/zip',
    buffer: await projectZip(),
  });
  await expect(page.getByTestId('project-summary')).toContainText('ファイル 2');

  const select = page.getByTestId('project-tool');
  const labels = await select.locator('option').allTextContents();
  expect(labels).toHaveLength(6);

  for (const [index, label] of labels.entries()) {
    await select.selectOption({ index });
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('project-bundle-download').click(),
    ]);
    const saved = path.join(OUT, `bundle-${index}.md`);
    await download.saveAs(saved);
    const text = await fs.readFile(saved, 'utf8');
    expect(text, label).toContain(label);
    expect(text, label).toContain('src/main.ts');
    expect(text, label).toContain('src/util.ts');
  }
});
