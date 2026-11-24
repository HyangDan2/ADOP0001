/**
 * Phase 5A — stabilization regressions.
 *
 * FIX-001: the workflow that actually runs is the full gate, and it runs for
 *          pull requests as well as main.
 * FIX-002: a refused prompt write is reported, and the text stays on screen.
 * FIX-003: clearing the input invalidates the request; no stale output returns.
 */
import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

const problems: string[] = [];

function watch(page: Page) {
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
}

test.describe('Phase 5A — stabilization', () => {
  test.beforeAll(() => {
    // The navigation is enough; the phase writes no screenshots of its own.
    fs.mkdirSync(path.join(ROOT, '.playwright-artifacts'), { recursive: true });
  });

  test.afterAll(() => {
    if (problems.length) throw new Error(`Console problems were recorded:\n${problems.join('\n')}`);
  });

  test('FIX-001: the live workflow is the full gate and also runs on pull requests', () => {
    const live = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
    for (const step of ['npm ci', 'npx tsc --noEmit', 'npm test', 'npm run qa:generated', 'npm run build']) {
      expect(live, step).toContain(step);
    }
    expect(live).toContain('npx playwright install');
    expect(live).toContain('npm run test:e2e');
    expect(live).toContain('pull_request');
    expect(live).toContain('upload-artifact');
    expect(live).not.toContain('continue-on-error');
    expect(live).not.toMatch(/\|\|\s*true/);
    expect(live).toMatch(/deploy:\s*\n\s*(if:[^\n]*\n\s*)?needs:\s*build/);

    const reference = fs.readFileSync(path.join(ROOT, 'docs/ci-workflow.yml'), 'utf8');
    expect(reference).toContain('npm run qa:generated');
    expect(reference).toContain('pull_request');

    const qa = fs.readFileSync(path.join(ROOT, 'tools/qa/check-generated.mjs'), 'utf8');
    expect(qa).toContain('Jest run');
    expect(qa).toContain('ts-jest');
    expect(qa).toContain('qa-report.json');
  });

  test('FIX-002: a refused prompt write is reported and the text is kept', async ({ page }) => {
    watch(page);
    await page.addInitScript(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function setItem(this: Storage, key: string, value: string) {
        if (String(key).startsWith('adop0001.prompt.')) {
          throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        }
        return original.call(this, key, value);
      } as typeof Storage.prototype.setItem;
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('#/shiori');

    const instruction = page.getByTestId('prompt-instruction');
    await instruction.fill('常に snake_case を使う。');
    await expect(page.getByTestId('prompt-save-state')).toHaveAttribute('data-state', 'error');
    await expect(page.getByTestId('prompt-save-error')).toContainText('容量');
    // The input is not dropped or reverted by the failed write.
    await expect(instruction).toHaveValue('常に snake_case を使う。');
    await page.getByTestId('tab-yayoi').click();
    await page.getByTestId('tab-shiori').click();
    // The prompt pane is still usable after the failure.
    await expect(page.getByTestId('prompt-instruction')).toBeVisible();
  });

  test('FIX-002: a normal prompt write reports saved', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('#/yayoi');
    const instruction = page.getByTestId('prompt-instruction');
    await instruction.fill('Keep the numbering stable.');
    await expect(page.getByTestId('prompt-save-state')).toHaveAttribute('data-state', 'saved');
    await page.reload();
    await expect(page.getByTestId('prompt-instruction')).toHaveValue('Keep the numbering stable.');
  });

  test('FIX-003: clearing the input cancels the pending run and no stale output returns', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('#/shiori');

    const editor = page.getByTestId('source-editor');
    await editor.fill(`export function clearMe(value: number): number {
  if (value < 0) {
    throw new RangeError('negative');
  }
  return value * 2;
}`);
    await expect(page.getByTestId('shiori-preview')).toBeVisible({ timeout: 20_000 });

    await page.getByTestId('pane-shiori-input').getByRole('button', { name: 'クリア' }).click();
    await expect(page.getByTestId('pane-shiori-output')).toContainText('まだ仕様書がありません');
    // Wait past the debounce and any in-flight run: the stale result must not land.
    await page.waitForTimeout(1_200);
    await expect(page.getByTestId('pane-shiori-output')).toContainText('まだ仕様書がありません');
    await expect(page.getByTestId('pane-shiori-output').getByTestId('shiori-preview')).toHaveCount(0);
  });
});
