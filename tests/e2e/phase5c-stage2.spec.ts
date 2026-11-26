/**
 * Phase 5C Stage 2 — the hybrid pass from the user's side.
 *
 * WO-08: the status line reports the stage, elapsed time, first token and usage,
 *        and the Stop control exists while a request is in flight.
 * WO-09: nothing is sent before the preview is approved; a failure falls back to
 *        the local result with its reason shown.
 * WO-10: a proposal is only applied to the artifact when the user ticks it.
 *
 * The endpoint is answered by Playwright, so no test opens a network connection.
 */
import { expect, test, type Page } from '@playwright/test';

const ENDPOINT = 'https://api.example.invalid/v1/chat/completions';

const ENVELOPE = {
  version: 1,
  summary: 'The contract rejects non-positive amounts before charging.',
  proposals: [
    {
      id: 'p1',
      kind: 'intent',
      title: 'Document the charge contract intent',
      detail: 'charge is the single entry point for settling an invoice and rejects a non-positive amount before it charges.',
      rationale: 'The guard on amount suggests the only invalid input the author considered is a non-positive value.',
      evidence: [{ symbol: 'charge' }],
      confidence: 'medium',
    },
  ],
  notes: [],
};

function sseBody(answer: string): string {
  const chunks = answer.match(/[\s\S]{1,20}/g) ?? [];
  const frames = chunks.map((chunk) => `data: ${JSON.stringify({ choices: [{ delta: { content: chunk }, index: 0 }] })}\n\n`);
  frames.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }], usage: { prompt_tokens: 900, completion_tokens: 120 } })}\n\n`);
  frames.push('data: [DONE]\n\n');
  return frames.join('');
}

async function configureConnection(page: Page) {
  await page.getByTestId('kebab-button').click();
  await page.getByTestId('connection-settings').click();
  await page.getByTestId('connection-base-url').fill('https://api.example.invalid/v1');
  await page.getByTestId('connection-model').fill('gpt-test');
  await page.getByTestId('connection-api-key').fill('sk-test-0123456789abcdef');
  await page.getByTestId('connection-save').click();
  await expect(page.getByTestId('connection-save-state')).toContainText('保存しました');
  await page.getByTestId('connection-close').click();
  // Stage 3 (WO-11): the AI bar only works in Mode B, which is an explicit
  // choice per tab. These tests exercise that path.
  await page.getByTestId('engine-mode-b').click();
  await expect(page.getByTestId('engine-mode-current')).toHaveAttribute('data-engine-mode', 'hybrid');
}

test.describe('Phase 5C Stage 2 — hybrid AI assist', () => {
  test('preview, consent, stream and apply a cited proposal', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('#/shiori');
    await configureConnection(page);

    // The local pass produces the artifact the hybrid pass cites.
    await expect(page.getByTestId('shiori-preview')).toBeVisible();

    await page.route(ENDPOINT, (route) =>
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: sseBody(JSON.stringify(ENVELOPE)),
      }),
    );

    await page.getByTestId('hybrid-open').click();
    const modal = page.getByTestId('hybrid-modal');
    await expect(modal).toBeVisible();
    await expect(page.getByTestId('hybrid-preview-destination')).toContainText('api.example.invalid');
    await expect(page.getByTestId('hybrid-preview-model')).toContainText('gpt-test');

    // Nothing is sent until the consent box is ticked.
    await expect(page.getByTestId('hybrid-send')).toBeDisabled();
    await page.getByTestId('hybrid-consent').check();
    await page.getByTestId('hybrid-send').click();

    await expect(page.getByTestId('hybrid-result')).toBeVisible();
    await expect(page.getByTestId('hybrid-provenance')).toHaveAttribute('data-provenance', 'hybrid-ai');
    await expect(page.getByTestId('hybrid-proposal-p1')).toContainText('Document the charge contract intent');
    await expect(page.getByTestId('hybrid-result-usage')).toContainText('900');
    await expect(page.getByTestId('hybrid-result-ttft')).not.toContainText('—');

    await page.getByTestId('hybrid-apply').click();
    await expect(modal).toHaveCount(0);

    // The artifact now carries the reviewed supplement, and the local facts stay.
    await page.getByTestId('shiori-tab-markdown').click();
    await expect(page.getByTestId('shiori-markdown')).toContainText('AI-assisted supplement (reviewed)');
    await expect(page.getByTestId('shiori-markdown')).toContainText('Document the charge contract intent');
  });

  test('a provider failure falls back to the local result with its reason', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('#/shiori');
    await configureConnection(page);
    await expect(page.getByTestId('shiori-preview')).toBeVisible();

    await page.route(ENDPOINT, (route) =>
      route.fulfill({
        status: 500,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: { message: 'upstream is down' } }),
      }),
    );

    await page.getByTestId('hybrid-open').click();
    await page.getByTestId('hybrid-consent').check();
    await page.getByTestId('hybrid-send').click();

    await expect(page.getByTestId('hybrid-result')).toBeVisible();
    await expect(page.getByTestId('hybrid-provenance')).toHaveAttribute('data-provenance', 'local-fallback');
    await expect(page.getByTestId('hybrid-fallback-note')).toContainText('ローカル静的解析');
    await expect(page.getByTestId('hybrid-reason')).toContainText('500');
    // The local artifact is still on screen and unchanged.
    await expect(page.getByTestId('shiori-preview')).toBeVisible();
  });

  test('the Stop control is present while a request is in flight', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('#/shiori');
    await configureConnection(page);
    await expect(page.getByTestId('shiori-preview')).toBeVisible();

    // Delay the answer so the run stays in the connecting stage long enough to
    // exercise the status line and the Stop control.
    await page.route(ENDPOINT, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      await route
        .fulfill({
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: sseBody(JSON.stringify(ENVELOPE)),
        })
        .catch(() => undefined);
    });

    await page.getByTestId('hybrid-open').click();
    await page.getByTestId('hybrid-consent').check();
    await page.getByTestId('hybrid-send').click();

    await expect(page.getByTestId('hybrid-run')).toBeVisible();
    await expect(page.getByTestId('hybrid-stage')).toContainText('接続中');
    await expect(page.getByTestId('hybrid-stop')).toBeEnabled();
    await page.getByTestId('hybrid-stop').click();
    await expect(page.getByTestId('hybrid-result')).toBeVisible();
    await expect(page.getByTestId('hybrid-provenance')).toHaveAttribute('data-provenance', 'local-static');
  });
});
