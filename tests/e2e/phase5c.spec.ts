/**
 * Phase 5C Stage 1 — the two user-visible additions.
 *
 * WO-02: typing while a picked file is still being read wins; the late read is
 *        dropped instead of replacing what the user wrote.
 * WO-04: the AI connection settings panel opens from the menu, validates its
 *        fields, saves the non-secret connection and forgets the API key on reload.
 */
import { expect, test } from '@playwright/test';

test.describe('Phase 5C Stage 1', () => {
  test('WO-02: a late file read does not overwrite what the user typed', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    // Slow the read down so the test can type while it is still in flight.
    await page.addInitScript(() => {
      const original = File.prototype.text;
      File.prototype.text = function slowText(this: File) {
        return new Promise((resolve) => setTimeout(() => resolve(original.call(this)), 700));
      } as File['text'];
    });
    await page.goto('#/shiori');

    const input = page.getByTestId('pane-shiori-input').locator('textarea');
    await page.getByTestId('pane-shiori-input').locator('input[type="file"]').setInputFiles({
      name: 'picked.ts',
      mimeType: 'text/plain',
      buffer: Buffer.from('export const fromFile = 1;\n'),
    });
    // The read needs 700 ms; type immediately.
    await input.fill('export const typedByHand = 2;');
    await page.waitForTimeout(1200);

    await expect(input).toHaveValue('export const typedByHand = 2;');
    await expect(page.getByTestId('pane-shiori-input')).not.toContainText('picked.ts');
  });

  test('WO-04: the connection panel validates, saves and never keeps the key', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('#/shiori');

    await page.getByTestId('kebab-button').click();
    await page.getByTestId('connection-settings').click();
    const modal = page.getByTestId('connection-modal');
    await expect(modal).toBeVisible();

    // An http endpoint is refused by the shared endpoint policy.
    await page.getByTestId('connection-base-url').fill('http://api.example.invalid/v1');
    await page.getByTestId('connection-model').fill('gpt-test');
    await expect(page.getByTestId('connection-validation')).toContainText('https');

    await page.getByTestId('connection-base-url').fill('https://api.example.invalid/v1');
    await expect(page.getByTestId('connection-validation')).toHaveCount(0);

    // The key is masked and only kept for this tab.
    await page.getByTestId('connection-api-key').fill('sk-test-0123456789abcdef');
    await expect(page.getByTestId('connection-api-key')).toHaveAttribute('type', 'password');
    await page.getByTestId('connection-key-reveal').click();
    await expect(page.getByTestId('connection-api-key')).toHaveAttribute('type', 'text');

    await page.getByTestId('connection-save').click();
    await expect(page.getByTestId('connection-save-state')).toContainText('保存しました');

    const stored = await page.evaluate(() => localStorage.getItem('adop0001.hybrid.connection'));
    expect(stored).toContain('https://api.example.invalid/v1');
    expect(stored).not.toContain('sk-test');

    await page.getByTestId('connection-close').click();
    await expect(modal).toHaveCount(0);

    // A reload keeps the connection and forgets the key.
    await page.reload();
    await page.getByTestId('kebab-button').click();
    await page.getByTestId('connection-settings').click();
    await expect(page.getByTestId('connection-base-url')).toHaveValue('https://api.example.invalid/v1');
    await expect(page.getByTestId('connection-api-key')).toHaveValue('');
  });
});
