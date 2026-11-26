/**
 * Phase 5A — stabilization regressions.
 *
 * FIX-001: the workflow that actually runs is the full gate, and it runs for
 *          pull requests as well as main.
 * FIX-002: a refused prompt write is reported, and the text stays on screen.
 * FIX-003: clearing the input invalidates the request; no stale output returns.
 * FIX-015: an inspector edit makes the rebuilt .docx stale until the next rebuild.
 * FIX-020: a picked file is consumed, so the same file can be picked again.
 *
 * PATCH-001: an edit drops a pending approval, diagnostics and the old artifact.
 * PATCH-002: a refused reset is reported and never reloads the page.
 * PATCH-006: the newest file pick wins, and an export modal opened before an
 *            edit refuses to write the older artifact.
 */
import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergedTableDocx } from '../fixtures/docx-fixtures';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const FIXTURES = path.join(ROOT, '.playwright-artifacts', 'phase5-fixtures');

const problems: string[] = [];

function watch(page: Page) {
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
}

test.describe('Phase 5A — stabilization', () => {
  test.beforeAll(async () => {
    // The navigation is enough; the phase writes no screenshots of its own.
    fs.mkdirSync(path.join(ROOT, '.playwright-artifacts'), { recursive: true });
    fs.mkdirSync(FIXTURES, { recursive: true });
    fs.writeFileSync(path.join(FIXTURES, 'merged.docx'), await mergedTableDocx());
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

  test('FIX-012: a few-shot change keeps an unsaved prompt after a failed save', async ({ page }) => {
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
    await instruction.fill('未保存の指示を保持する。');
    await expect(page.getByTestId('prompt-save-state')).toHaveAttribute('data-state', 'error');

    // Adding a few-shot example bumps the shell's version; that must refresh the
    // pills only, never re-read (and blank) the instruction that failed to save.
    await page.getByTestId('prompt-manage').click();
    await page.getByTestId('fewshot-add').click();
    await page.getByTestId('fewshot-title').fill('Example A');
    await page.getByTestId('fewshot-output-text').fill('export function example(): void {}');
    await page.getByTestId('fewshot-save').click();
    await expect(page.getByTestId('fewshot-item')).toHaveCount(1);
    await page.getByRole('button', { name: 'Few-shot 例の管理を閉じる' }).click();
    await expect(page.getByTestId('fewshot-modal')).toHaveCount(0);

    await expect(instruction).toHaveValue('未保存の指示を保持する。');
    await expect(page.getByTestId('prompt-save-state')).toHaveAttribute('data-state', 'error');
  });

  test('FIX-009: the 2 MB warning is visible and an 8 MB source is refused', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('#/shiori');
    const input = page.getByTestId('shiori-open').locator('input[type="file"]');

    await input.setInputFiles({
      name: 'large.ts',
      mimeType: 'text/plain',
      buffer: Buffer.from(`// ${'x'.repeat(2 * 1024 * 1024 + 1024)}`),
    });
    const diagnostics = page.getByTestId('engine-diagnostics');
    await expect(diagnostics).toBeVisible({ timeout: 30_000 });
    await expect(diagnostics).toContainText('警告');
    await expect(diagnostics).toContainText('MB');
    await expect(page.getByTestId('status-message')).toHaveAttribute('data-state', 'ok');

    await input.setInputFiles({
      name: 'huge.ts',
      mimeType: 'text/plain',
      buffer: Buffer.from('y'.repeat(8 * 1024 * 1024 + 1)),
    });
    await expect(page.getByTestId('pane-shiori-output')).toContainText('大きすぎます', { timeout: 30_000 });
    await expect(page.getByTestId('status-message')).toHaveAttribute('data-state', 'error');
  });

  test('FIX-005: a Markdown edit supersedes the previous rebuild and reset drops the draft', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('#/kotoha');
    await page.getByTestId('kotoha-sample').click();
    await expect(page.getByTestId('source-editor')).toHaveValue(/# Kotoha Round-Trip Sample/, { timeout: 20_000 });
    await expect(page.getByTestId('kotoha-storage')).toContainText('保存', { timeout: 15_000 });

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('kotoha-rebuild').click(),
    ]);
    await download.cancel().catch(() => undefined);
    await expect(page.getByTestId('kotoha-roundtrip')).toBeVisible({ timeout: 20_000 });

    // The newer edit owns the document: the old rebuild result and its download
    // affordance must not come back, even after the persistence work settles.
    await page.getByTestId('source-editor').fill('# Edited after rebuild\n\nNew paragraph.');
    await expect(page.getByTestId('kotoha-roundtrip')).toHaveCount(0);
    await page.waitForTimeout(800);
    await expect(page.getByTestId('kotoha-roundtrip')).toHaveCount(0);
    await expect(page.getByTestId('status-message')).toHaveAttribute('data-state', 'ok');

    await page.getByTestId('kotoha-reset').click();
    await expect(page.getByTestId('kotoha-panel')).toContainText('テンプレートが読み込まれていません');
    await expect(page.getByTestId('kotoha-storage')).toContainText('未保存');
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
    // Clearing is the newest state: it releases busy without waiting for the run (FIX-006).
    await expect(page.getByTestId('status-message')).toHaveAttribute('data-state', 'ok');
    await expect(page.getByTestId('pane-shiori-output')).toContainText('まだ仕様書がありません');
    // Wait past the debounce and any in-flight run: the stale result must not land.
    await page.waitForTimeout(1_200);
    await expect(page.getByTestId('pane-shiori-output')).toContainText('まだ仕様書がありません');
    await expect(page.getByTestId('pane-shiori-output').getByTestId('shiori-preview')).toHaveCount(0);
  });

  test('FIX-015: an inspector edit invalidates the rebuilt .docx until the next rebuild', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('#/kotoha');
    await page.getByTestId('kotoha-sample').click();
    await expect(page.getByTestId('source-editor')).toHaveValue(/# Kotoha Round-Trip Sample/, { timeout: 20_000 });

    const [built] = await Promise.all([page.waitForEvent('download'), page.getByTestId('kotoha-rebuild').click()]);
    await built.cancel().catch(() => undefined);
    await expect(page.getByTestId('kotoha-roundtrip')).toBeVisible({ timeout: 20_000 });

    // The fresh build is exportable.
    await page.getByTestId('kotoha-export').click();
    const [exported] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-docx').click()]);
    expect(exported.suggestedFilename()).toMatch(/\.docx$/);
    await expect(page.getByTestId('export-feedback')).toHaveAttribute('data-kind', 'ok');
    await page.keyboard.press('Escape');

    // Changing only an inspector attribute makes the downloaded .docx stale.
    await page.getByTestId('attr-font').fill('Yu Mincho');
    await page.getByTestId('kotoha-export').click();
    await page.getByTestId('export-docx').click();
    const feedback = page.getByTestId('export-feedback');
    await expect(feedback).toHaveAttribute('data-kind', 'error');
    await expect(feedback).toContainText('再構築');
    await page.keyboard.press('Escape');

    // Rebuilding with the new attributes makes it exportable again.
    const [rebuilt] = await Promise.all([page.waitForEvent('download'), page.getByTestId('kotoha-rebuild').click()]);
    await rebuilt.cancel().catch(() => undefined);
    await page.getByTestId('kotoha-export').click();
    const [fresh] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-docx').click()]);
    expect(fresh.suggestedFilename()).toMatch(/\.docx$/);
    await expect(page.getByTestId('export-feedback')).toHaveAttribute('data-kind', 'ok');
  });

  test('FIX-020: a picked file is consumed so the same file can be picked again', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('#/shiori');
    const input = page.getByTestId('shiori-open').locator('input[type="file"]');
    const editor = page.getByTestId('source-editor');

    await input.setInputFiles({
      name: 'retry.ts',
      mimeType: 'text/plain',
      buffer: Buffer.from('export function first(): number {\n  return 1;\n}\n'),
    });
    await expect(editor).toHaveValue(/export function first/);
    await expect(input).toHaveValue('');

    await input.setInputFiles({
      name: 'retry.ts',
      mimeType: 'text/plain',
      buffer: Buffer.from('export function second(): string {\n  return "two";\n}\n'),
    });
    await expect(editor).toHaveValue(/export function second/);
    await expect(input).toHaveValue('');
  });

  test('PATCH-001: an edit drops a pending approval and the previous artifact', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('#/kotoha');
    await page.getByTestId('kotoha-sample').click();
    await expect(page.getByTestId('source-editor')).toHaveValue(/# Kotoha Round-Trip Sample/, { timeout: 20_000 });
    await expect(page.getByTestId('kotoha-storage')).toContainText('保存', { timeout: 15_000 });

    const [built] = await Promise.all([page.waitForEvent('download'), page.getByTestId('kotoha-rebuild').click()]);
    await built.cancel().catch(() => undefined);
    await expect(page.getByTestId('kotoha-roundtrip')).toBeVisible({ timeout: 20_000 });

    // A document with preserved content asks for approval before replacing this one.
    await page.getByTestId('kotoha-file').setInputFiles(path.join(FIXTURES, 'merged.docx'));
    await expect(page.getByTestId('kotoha-loss-dialog')).toBeVisible({ timeout: 20_000 });

    // A human edit starts a new epoch: the approval, the rebuilt .docx and the
    // diagnostics of the previous document must all go (PATCH-001).
    await page.getByTestId('source-editor').fill('# Edited while approval was open');
    await expect(page.getByTestId('kotoha-loss-dialog')).toHaveCount(0);
    await expect(page.getByTestId('kotoha-roundtrip')).toHaveCount(0);
    await expect(page.getByTestId('kotoha-download')).toHaveCount(0);
    await expect(page.getByTestId('engine-diagnostics')).toHaveCount(0);

    // Nothing comes back after the in-flight load settles.
    await page.waitForTimeout(1_200);
    await expect(page.getByTestId('kotoha-loss-dialog')).toHaveCount(0);
    await expect(page.getByTestId('kotoha-roundtrip')).toHaveCount(0);
    await expect(page.getByTestId('source-editor')).toHaveValue('# Edited while approval was open');
  });

  test('PATCH-002: a refused reset is reported and the drafts are kept', async ({ page }) => {
    watch(page);
    await page.addInitScript(() => {
      const scope = window as unknown as { __failIdb?: boolean };
      scope.__failIdb = false;
      const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (this: IDBDatabase, storeNames: string, mode?: IDBTransactionMode) {
        if (scope.__failIdb) throw new DOMException('forced failure', 'InvalidStateError');
        return original.call(this, storeNames, mode);
      };
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('#/kotoha');
    await page.getByTestId('kotoha-sample').click();
    await expect(page.getByTestId('source-editor')).toHaveValue(/# Kotoha Round-Trip Sample/, { timeout: 20_000 });
    await expect(page.getByTestId('kotoha-storage')).toContainText('保存', { timeout: 15_000 });

    await page.evaluate(() => {
      (window as unknown as { __failIdb?: boolean }).__failIdb = true;
    });
    await page.getByTestId('kebab-button').click();
    await page.getByTestId('reset-drafts').click();

    // A refused IndexedDB clear must not look like a reset and must not reload.
    const resetError = page.getByTestId('reset-error');
    await expect(resetError).toBeVisible();
    await expect(resetError).toContainText('保存領域の削除を確認できませんでした');
    await expect(resetError).toContainText('他の下書きは変更していません');
    await expect(page.getByTestId('reset-drafts')).toContainText('下書きの破棄を再試行');
    await expect(page.getByTestId('source-editor')).toHaveValue(/# Kotoha Round-Trip Sample/);
    await expect(page.getByTestId('kebab-menu')).toBeVisible();
  });

  test('PATCH-002: a partial global reset leaves the remounted draft autosave working', async ({ page }) => {
    watch(page);
    await page.addInitScript(() => {
      const scope = window as unknown as { __failDrafts?: boolean };
      scope.__failDrafts = false;
      const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (this: IDBDatabase, storeNames: string, mode?: IDBTransactionMode) {
        if (scope.__failDrafts && storeNames === 'drafts') throw new DOMException('forced draft failure', 'InvalidStateError');
        return original.call(this, storeNames, mode);
      };
    });
    await page.goto('#/shiori');
    const source = page.getByTestId('source-editor');
    await source.fill('export function beforeReset() { return 1; }');
    await expect.poll(() => page.evaluate(() => {
      const raw = localStorage.getItem('adop0001.draft.shiori');
      return raw ? (JSON.parse(raw) as { data?: { source?: string } }).data?.source : null;
    })).toContain('beforeReset');

    await page.evaluate(() => {
      (window as unknown as { __failDrafts?: boolean }).__failDrafts = true;
    });
    await page.getByTestId('kebab-button').click();
    await page.getByTestId('reset-drafts').click();
    await expect(page.getByTestId('reset-error')).toBeVisible();
    await expect(page.getByTestId('reset-error')).toContainText('Kotoha 文書は削除済みです');
    await expect(page.getByTestId('reset-error')).toContainText('下書きの一部');

    await page.evaluate(() => {
      (window as unknown as { __failDrafts?: boolean }).__failDrafts = false;
    });
    await source.fill('export function afterReset() { return 2; }');
    await expect.poll(() => page.evaluate(() => {
      const raw = localStorage.getItem('adop0001.draft.shiori');
      return raw ? (JSON.parse(raw) as { data?: { source?: string } }).data?.source : null;
    })).toContain('afterReset');
    await page.reload();
    await expect(source).toHaveValue('export function afterReset() { return 2; }');
  });

  test('PATCH-002: a failed bundle save keeps the failure message, not a success one', async ({ page }) => {
    watch(page);
    await page.addInitScript(() => {
      const scope = window as unknown as { __failIdb?: boolean };
      scope.__failIdb = false;
      const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (this: IDBDatabase, storeNames: string, mode?: IDBTransactionMode) {
        if (scope.__failIdb) throw new DOMException('forced failure', 'InvalidStateError');
        return original.call(this, storeNames, mode);
      };
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('#/kotoha');
    await page.getByTestId('kotoha-sample').click();
    await expect(page.getByTestId('kotoha-storage')).toContainText('保存', { timeout: 20_000 });

    const [bundle] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('kotoha-export-bundle').click(),
    ]);
    const bundlePath = path.join(FIXTURES, 'exported.kotoha.json');
    await bundle.saveAs(bundlePath);
    expect(bundle.suggestedFilename()).toMatch(/\.kotoha\.json$/);

    await page.evaluate(() => {
      (window as unknown as { __failIdb?: boolean }).__failIdb = true;
    });
    await page.getByTestId('kotoha-bundle-file').setInputFiles(bundlePath);

    // The import works from memory, but the failed persistence must survive the
    // success toast instead of being overwritten (PATCH-002).
    await expect(page.getByTestId('kotoha-storage')).toContainText('メモリのみ', { timeout: 20_000 });
    await expect(page.getByTestId('kotoha-storage')).not.toContainText('保存しました');
    await expect(page.getByTestId('source-editor')).toHaveValue(/# Kotoha Round-Trip Sample/);
  });

  test('PATCH-006: an export modal opened before an edit refuses the older artifact', async ({ page }) => {
    watch(page);
    // The fake clock keeps the debounce from regenerating during the assertions,
    // so the stale state is held deterministically instead of for ~260 ms.
    await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
    // Pausing keeps the 260 ms debounce from firing between two clicks, so the
    // stale window is held for the assertions instead of racing the next paint
    // (this test flaked once per few runs while the clock was merely installed).
    await page.clock.pauseAt(new Date('2026-01-01T00:00:00Z'));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('#/shiori');
    await page.clock.runFor(2_000);
    const editor = page.getByTestId('source-editor');
    await editor.fill(`export function before(value: number): number {
  if (value < 0) throw new RangeError('negative');
  return value;
}`);
    await page.clock.runFor(2_000);
    await expect(page.getByTestId('shiori-preview')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('shiori-export').click();
    await expect(page.getByTestId('export-modal')).toBeVisible();

    // The modal is already open; the edit makes the visible artifact stale.
    await editor.fill('export function after(): string {\n  return "after";\n}\n');
    const feedback = page.getByTestId('export-feedback');
    await page.getByTestId('export-copy-markdown').click();
    await expect(feedback).toHaveAttribute('data-kind', 'error');
    await expect(feedback).toContainText('コピーできませんでした');
    await page.getByTestId('export-markdown').click();
    await expect(feedback).toHaveAttribute('data-kind', 'error');
    await expect(feedback).toContainText('入力が変更されています');

    // After the debounce regenerates the artifact, the same modal exports it.
    await page.clock.runFor(3_000);
    await page.getByTestId('export-markdown').click();
    await expect(feedback).toHaveAttribute('data-kind', 'ok', { timeout: 20_000 });
  });

  test('PATCH-006: the last picked file wins over a slower earlier read', async ({ page }) => {
    watch(page);
    await page.addInitScript(() => {
      const original = File.prototype.text;
      File.prototype.text = function (this: File) {
        const delay = this.name.startsWith('slow') ? 600 : 0;
        return new Promise<string>((resolve, reject) => {
          setTimeout(() => void original.call(this).then(resolve, reject), delay);
        });
      };
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('#/shiori');
    const input = page.getByTestId('shiori-open').locator('input[type="file"]');
    const editor = page.getByTestId('source-editor');

    await input.setInputFiles({
      name: 'slow-first.ts',
      mimeType: 'text/plain',
      buffer: Buffer.from('export function slowFirst(): string {\n  return "slow";\n}\n'),
    });
    await input.setInputFiles({
      name: 'fast-second.ts',
      mimeType: 'text/plain',
      buffer: Buffer.from('export function fastSecond(): string {\n  return "fast";\n}\n'),
    });

    await expect(editor).toHaveValue(/export function fastSecond/);
    // The slower first read resolves later and must be dropped.
    await page.waitForTimeout(1_200);
    await expect(editor).toHaveValue(/export function fastSecond/);
    await expect(editor).not.toHaveValue(/slowFirst/);
    await expect(page.getByTestId('shiori-preview')).toContainText('fastSecond', { timeout: 20_000 });
  });
});
