import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOWNLOADS = path.resolve(HERE, '../../../../downloads');

const problems: string[] = [];

function watch(page: Page) {
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText ?? '';
    if (!failure.includes('ERR_ABORTED')) problems.push(`requestfailed: ${request.url()} ${failure}`);
  });
}

async function openTool(page: Page, tool: string) {
  await page.goto(`#/${tool}`);
  await page.waitForTimeout(700);
}

test.describe('HD2Lab Aosongkan live application', () => {
  test.beforeAll(() => {
    fs.mkdirSync(DOWNLOADS, { recursive: true });
  });

  test('loads with the full brand shell and no errors', async ({ page }) => {
    watch(page);
    await page.goto('./');
    await expect(page.locator('.topbar')).toBeVisible();
    await expect(page.getByText('HD2Lab 青松館')).toBeVisible();
    for (const tool of ['shiori', 'yayoi', 'kozue', 'haruhi', 'kotoha']) {
      await expect(page.getByTestId(`tab-${tool}`)).toBeVisible();
    }
    await expect(page.getByTestId('theme-toggle')).toBeVisible();
    await expect(page.getByTestId('help-button')).toBeVisible();
    await expect(page.getByTestId('kebab-button')).toBeVisible();

    await page.getByTestId('help-button').click();
    await expect(page.getByTestId('help-modal')).toBeVisible();
    await expect(page.getByTestId('help-modal')).toContainText('100%');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('help-modal')).toHaveCount(0);

    await page.getByTestId('kebab-button').click();
    const menu = page.getByTestId('kebab-menu');
    await expect(menu).toBeVisible();
    await expect(menu).toContainText('HD2Lab Web-HQ');
    await expect(menu).toContainText('ApplicationHub');
    await page.keyboard.press('Escape');
  });

  test('Shiori weaves a specification and exports Markdown', async ({ page }) => {
    watch(page);
    await page.goto('/#/shiori');
    const preview = page.getByTestId('shiori-preview');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('Contract table');
    await expect(preview).toContainText('charge');
    await expect(preview).toContainText('Behaviour rules');

    await page.screenshot({ path: path.join(DOWNLOADS, 'adop0001_shiori_dark.png'), fullPage: false });

    await page.getByTestId('shiori-tab-markdown').click();
    const markdown = page.getByTestId('shiori-markdown');
    await expect(markdown).toContainText('# Specification');
    await expect(markdown).toContainText('## 2. Contract table');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '.md', exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.spec\.md$/);

    await page.getByTestId('theme-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.getByTestId('theme-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  });

  test('Yayoi translates code and links lines', async ({ page }) => {
    watch(page);
    await openTool(page, 'yayoi');
    const output = page.getByTestId('yayoi-output');
    await expect(output).toContainText('FUNCTION PaymentService.charge');
    await expect(output).toContainText('IF');

    const pseudoLine = page.locator('.pseudo-line').filter({ hasText: 'IF' }).first();
    await pseudoLine.click();
    await expect(page.locator('.statusbar')).toContainText('ready');

    await page.getByRole('group', { name: 'Pseudocode style' }).getByRole('button', { name: 'Narrative English' }).click();
    await expect(page.getByTestId('yayoi-output')).toContainText('When ');
  });

  test('Kozue renders a real Mermaid diagram and exports it', async ({ page }) => {
    watch(page);
    await openTool(page, 'kozue');
    await expect(page.getByTestId('kozue-detection')).toBeVisible();
    const diagram = page.getByTestId('kozue-diagram');
    await expect(diagram.locator('svg')).toBeVisible({ timeout: 30_000 });

    await page.getByRole('group', { name: 'Diagram kind' }).getByRole('button', { name: 'Sequence' }).click();
    await expect(diagram.locator('svg')).toBeVisible({ timeout: 30_000 });

    await page.getByRole('group', { name: 'Direction' }).getByRole('button', { name: 'LR' }).click();
    await expect(diagram.locator('svg')).toBeVisible({ timeout: 30_000 });

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'SVG' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.svg$/);

    await page.getByTestId('theme-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(diagram.locator('svg')).toBeVisible();
    await page.screenshot({ path: path.join(DOWNLOADS, 'adop0001_kozue_light.png'), fullPage: false });
    await page.getByTestId('theme-toggle').click();
  });

  test('Haruhi forges tests for four frameworks', async ({ page }) => {
    watch(page);
    await openTool(page, 'haruhi');
    const output = page.getByTestId('haruhi-output');
    await expect(output).toContainText('from \'vitest\'');
    await expect(output).toContainText('describe(');

    for (const [value, marker] of [
      ['jest', 'jest.fn()'],
      ['pytest', 'import pytest'],
      ['junit5', 'org.junit.jupiter.api.Test'],
      ['go', 'func Test'],
    ] as const) {
      await page.getByTestId('haruhi-framework').selectOption(value);
      await expect(output).toContainText(marker, { timeout: 20_000 });
    }

    await page.getByRole('tab', { name: 'Branch checklist' }).click();
    await expect(page.locator('.checklist')).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('haruhi-download').click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/_test\.go$/);
  });

  test('Kotoha round-trips a sample docx through Markdown', async ({ page }) => {
    watch(page);
    await openTool(page, 'kotoha');
    await page.getByTestId('kotoha-sample').click();
    const editor = page.getByTestId('source-editor');
    await expect(editor).toHaveValue(/# Kotoha Round-Trip Sample/);
    await expect(editor).toHaveValue(/\| Layer \| Kept in bundle/);

    const inspector = page.getByTestId('kotoha-panel');
    await expect(inspector).toContainText('Heading 1 colour');
    await expect(inspector).toContainText('Header preserved');
    await expect(inspector).toContainText('Footer preserved');

    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\n\n## Added in the live round trip\n\nThis heading was typed into the editor during the end-to-end check.\n');

    const [rebuildDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('kotoha-rebuild').click(),
    ]);
    expect(rebuildDownload.suggestedFilename()).toMatch(/\.docx$/);
    await page.screenshot({ path: path.join(DOWNLOADS, 'adop0001_kotoha_docx.png'), fullPage: false });
    const rebuiltPath = path.join(DOWNLOADS, 'adop0001_kotoha_rebuilt.docx');
    await rebuildDownload.saveAs(rebuiltPath);
    expect(fs.statSync(rebuiltPath).size).toBeGreaterThan(2000);

    await page.getByRole('tab', { name: 'Bundle' }).click();
    await expect(page.getByTestId('kotoha-panel')).toContainText('style records');
    const [bundleDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download .kotoha.json' }).first().click(),
    ]);
    expect(bundleDownload.suggestedFilename()).toMatch(/\.kotoha\.json$/);
    const bundlePath = path.join(DOWNLOADS, 'adop0001_kotoha_bundle.json');
    await bundleDownload.saveAs(bundlePath);
    const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8')) as { bundle: { ooxml: { headers: Record<string, string> } } };
    expect(Object.keys(bundle.bundle.ooxml.headers).length).toBeGreaterThan(0);

  });

  test('holds the 390px mobile layout without horizontal overflow', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#/shiori');
    await page.waitForTimeout(900);
    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1);

    await page.screenshot({ path: path.join(DOWNLOADS, 'adop0001_mobile.png'), fullPage: false });

    for (const tool of ['yayoi', 'kozue', 'haruhi', 'kotoha']) {
      await page.goto(`/#/${tool}`);
      await page.waitForTimeout(600);
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width).toBeLessThanOrEqual(391);
    }
  });

  test.afterAll(() => {
    if (problems.length) {
      throw new Error(`Console/network problems were recorded:\n${problems.join('\n')}`);
    }
  });
});
