/**
 * Phase 5C.2 — runtime integration, from the user's side.
 *
 * - the preview shows the exact body parameters that will be sent;
 * - an operator-defined redaction pattern is applied to the payload;
 * - a Kotoha send scope drops the sections that were not ticked;
 * - switching to Mode A while a request is running cancels it.
 *
 * The endpoint is answered by Playwright; no test opens a network connection.
 */
import { expect, test, type Page } from '@playwright/test';

const ENDPOINT = 'https://api.example.invalid/v1/chat/completions';
const ENVELOPE = { version: 1, summary: 'ok', proposals: [], notes: [] };

function sseBody(answer: string): string {
  const chunks = answer.match(/[\s\S]{1,40}/g) ?? [];
  const frames = chunks.map((chunk) => `data: ${JSON.stringify({ choices: [{ delta: { content: chunk }, index: 0 }] })}\n\n`);
  frames.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }], usage: { prompt_tokens: 100, completion_tokens: 10 } })}\n\n`);
  frames.push('data: [DONE]\n\n');
  return frames.join('');
}

async function configure(page: Page, options: { redaction?: string } = {}) {
  await page.getByTestId('kebab-button').click();
  await page.getByTestId('connection-settings').click();
  await page.getByTestId('connection-base-url').fill('https://api.example.invalid/v1');
  await page.getByTestId('connection-model').fill('gpt-test');
  await page.getByTestId('connection-api-key').fill('sk-test-0123456789abcdef');
  if (options.redaction) {
    await page.getByTestId('connection-redaction-policy').fill(options.redaction);
  }
  await page.getByTestId('connection-save').click();
  await expect(page.getByTestId('connection-save-state')).toContainText('保存しました');
  await page.getByTestId('connection-close').click();
  await page.getByTestId('engine-mode-b').click();
  await expect(page.getByTestId('engine-mode-current')).toHaveAttribute('data-engine-mode', 'hybrid');
}

test.describe('Phase 5C.2 — runtime integration', () => {
  test('the preview names the body parameters and sends the operator redaction', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('#/shiori');
    await configure(page, { redaction: 'emp=EMP-\\d{6}' });
    await page.getByTestId('source-editor').fill(
      ['export function charge(amount: number) {', '  // employee EMP-123456 approved this', '  return amount > 0;', '}', ''].join('\n'),
    );
    await expect(page.getByTestId('shiori-preview')).toBeVisible();

    let sent: { temperature?: number; max_tokens?: number; messages?: Array<{ content: string }> } | null = null;
    await page.route(ENDPOINT, async (route) => {
      sent = route.request().postDataJSON();
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: sseBody(JSON.stringify(ENVELOPE)) });
    });

    await page.getByTestId('hybrid-open').click();
    await expect(page.getByTestId('hybrid-body-params')).toContainText('送信パラメータ');
    await expect(page.getByTestId('hybrid-body-params')).toContainText('Temperature 0.2');
    await expect(page.getByTestId('hybrid-body-params')).toContainText('max_tokens');
    await expect(page.getByTestId('hybrid-preview-redactions')).not.toContainText('0 件');

    await page.getByTestId('hybrid-consent').check();
    await page.getByTestId('hybrid-send').click();
    await expect(page.getByTestId('hybrid-result')).toBeVisible();

    expect(sent).not.toBeNull();
    expect(sent!.temperature).toBe(0.2);
    expect(sent!.max_tokens).toBe(4096);
    const payload = (sent!.messages ?? []).map((message) => message.content).join('\n');
    expect(payload).toContain('[REDACTED_CUSTOM]');
    expect(payload).not.toContain('EMP-123456');
  });

  test('a Kotoha send scope leaves the unticked section out of the payload', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('#/kotoha');
    await page.getByTestId('kotoha-sample').click();
    await expect(page.getByTestId('kotoha-download')).toBeVisible({ timeout: 30_000 });
    await configure(page);
    await page.getByRole('tab', { name: 'MD プレビュー' }).click();
    await expect(page.getByTestId('kotoha-markdown')).toContainText('Kotoha Round-Trip Sample');

    let sent: { messages?: Array<{ content: string }> } | null = null;
    await page.route(ENDPOINT, async (route) => {
      sent = route.request().postDataJSON();
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: sseBody(JSON.stringify(ENVELOPE)) });
    });

    await page.getByTestId('hybrid-open').click();
    await expect(page.getByTestId('hybrid-sections')).toBeVisible();
    // Untick the section titled "A small table".
    const row = page.locator('.hybrid-section-row', { hasText: 'A small table' });
    await expect(row).toBeVisible();
    await row.locator('input[type="checkbox"]').uncheck();
    await expect(page.getByTestId('hybrid-send-scope')).toContainText('送信しない範囲');

    await page.getByTestId('hybrid-consent').check();
    await expect(page.getByTestId('hybrid-send')).toBeEnabled();
    await page.getByTestId('hybrid-send').click();
    await expect(page.getByTestId('hybrid-result')).toBeVisible();

    const payload = (sent!.messages ?? []).map((message) => message.content).join('\n');
    expect(payload).toContain('Kotoha Round-Trip Sample');
    expect(payload).not.toContain('A small table');
  });

  test('switching to Mode A while a request runs cancels it', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('#/shiori');
    await configure(page);
    await expect(page.getByTestId('shiori-preview')).toBeVisible();

    await page.route(ENDPOINT, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: sseBody(JSON.stringify(ENVELOPE)) });
    });

    await page.getByTestId('hybrid-open').click();
    await page.getByTestId('hybrid-consent').check();
    await page.getByTestId('hybrid-send').click();
    await expect(page.getByTestId('hybrid-run')).toBeVisible();

    // The mode switch lives behind the modal backdrop; dispatch the click the user
    // would make on the engine mode control.
    await page.getByTestId('engine-mode-a').dispatchEvent('click');
    await expect(page.getByTestId('hybrid-bar-error')).toContainText('モードA', { timeout: 10_000 });
  });
});
