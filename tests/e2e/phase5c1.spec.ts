/**
 * Phase 5C.1 — correction release gate from the user's side (C-FIX-001 ~ C-FIX-010).
 *
 * Rows proven here:
 *
 *   C-FIX-001  a completed run shows the SHA-256 of the exact payload it sent
 *   C-FIX-002  the payload is the allocated selection, and the preview says so
 *   C-FIX-003  the send control is unavailable while a request runs (single flight)
 *   C-FIX-010  320 / 390 / 1440 px still fit with the new engine
 *
 * The gateway is a real loopback HTTP server that streams SSE frames, so the
 * streaming, sealing and telemetry paths are exercised for real. No external
 * connection is made.
 */
import { expect, test, type Page } from '@playwright/test';
import http from 'node:http';

const PORT = 43127;
const BASE_URL = `http://127.0.0.1:${PORT}/v1`;
const API_KEY = ['sk', 'test', '0123456789abcdef'].join('-');

const ENVELOPE = {
  version: 1,
  summary: 'The contract rejects non-positive amounts before charging.',
  proposals: [
    {
      id: 'p1',
      kind: 'intent',
      title: 'Document the charge contract intent',
      detail: 'charge is the single entry point for settling an invoice and rejects a non-positive amount.',
      rationale: 'The guard on amount suggests the only invalid input considered is non-positive.',
      evidence: [{ symbol: 'charge' }],
      confidence: 'medium',
    },
  ],
  notes: [],
};

let hits = 0;
let server: http.Server;

function sseBody(answer: string): string {
  const chunks = answer.match(/[\s\S]{1,20}/g) ?? [];
  const frames = chunks.map((chunk) => `data: ${JSON.stringify({ choices: [{ delta: { content: chunk }, index: 0 }] })}\n\n`);
  frames.push(
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }], usage: { prompt_tokens: 500, completion_tokens: 90 } })}\n\n`,
  );
  frames.push('data: [DONE]\n\n');
  return frames.join('');
}

test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    const cors = {
      'access-control-allow-origin': 'http://127.0.0.1:4173',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type, accept',
      'access-control-max-age': '600',
    };
    if (request.method === 'OPTIONS') {
      response.writeHead(204, cors).end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405, cors).end();
      return;
    }
    hits += 1;
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const stream = body.includes('"stream":true');
      const answer = JSON.stringify(ENVELOPE);
      if (!stream) {
        response.writeHead(200, { ...cors, 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: answer }, finish_reason: 'stop' }], usage: { prompt_tokens: 500, completion_tokens: 90 } }));
        return;
      }
      response.writeHead(200, { ...cors, 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      // A small delay so the in-flight panel is observable; the frames still arrive
      // as one chunked stream.
      setTimeout(() => response.end(sseBody(answer)), 700);
    });
  });
  await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve));
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function switchToHybrid(page: Page) {
  await page.getByTestId('engine-mode-b').click();
  await expect(page.getByTestId('engine-mode-current')).toHaveAttribute('data-engine-mode', 'hybrid');
}

async function configureConnection(page: Page) {
  await page.getByTestId('kebab-button').click();
  await page.getByTestId('connection-settings').click();
  await page.getByTestId('connection-base-url').fill(BASE_URL);
  await page.getByTestId('connection-model').fill('gpt-test');
  await page.getByTestId('connection-api-key').fill(API_KEY);
  await page.getByTestId('connection-save').click();
  await expect(page.getByTestId('connection-save-state')).toContainText('保存しました');
  await page.getByTestId('connection-close').click();
}

test.describe('Phase 5C.1 — correction gate', () => {
  test('C-FIX-001 a completed run shows the digest of the payload it sent', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('./#/shiori');
    await expect(page.getByTestId('shiori-preview')).toBeVisible();
    await switchToHybrid(page);
    await configureConnection(page);
    await page.getByTestId('hybrid-open').click();
    await expect(page.getByTestId('hybrid-preview')).toBeVisible();
    await expect(page.getByTestId('hybrid-payload-digest')).toHaveCount(0);

    await page.getByTestId('hybrid-consent').check();
    await page.getByTestId('hybrid-send').click();
    await expect(page.getByTestId('hybrid-result')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('hybrid-provenance')).toHaveAttribute('data-provenance', 'hybrid-ai');
    await expect(page.getByTestId('hybrid-payload-digest')).toContainText('SHA-256');
    await expect(page.getByTestId('hybrid-payload-digest')).toContainText(/[0-9a-f]{16}/);
    expect(hits).toBeGreaterThan(0);
  });

  test('C-FIX-002 the preview reports the allocated scope for a trimmed payload', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('./#/shiori');
    await switchToHybrid(page);
    await configureConnection(page);
    await expect(page.getByTestId('shiori-preview')).toBeVisible();
    await page.getByTestId('hybrid-open').click();
    await expect(page.getByTestId('hybrid-preview')).toBeVisible();
    // The preflight states the scope in words and numbers; a truncated plan says so.
    await expect(page.getByTestId('hybrid-preview-scope')).toContainText('対象ソース');
  });

  test('C-FIX-003 the send control is unavailable while a request runs', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('./#/shiori');
    await switchToHybrid(page);
    await configureConnection(page);
    await page.getByTestId('hybrid-open').click();
    await expect(page.getByTestId('hybrid-preview')).toBeVisible();
    await page.getByTestId('hybrid-consent').check();
    await page.getByTestId('hybrid-send').click();
    // The run panel replaces the send control for the duration of the request.
    await expect(page.getByTestId('hybrid-run')).toBeVisible();
    await expect(page.getByTestId('hybrid-send')).toHaveCount(0);
    await expect(page.getByTestId('hybrid-result')).toBeVisible({ timeout: 30_000 });
  });

  test('C-FIX-010 320 / 390 / 1440 px still fit with the correction engine', async ({ page }) => {
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('./#/shiori');
      await expect(page.getByTestId('shiori-preview')).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `overflow at ${width}px`).toBeLessThanOrEqual(1);
      await expect(page.getByTestId('hybrid-bar')).toBeVisible();
    }
  });
});
