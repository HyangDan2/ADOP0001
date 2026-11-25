/**
 * Phase 5C Stage 3 — the release gate from the user's side (WO-11 ~ WO-15).
 *
 * Rows proven here (the unit matrix in `tests/reg-5c-matrix.test.ts` names them):
 *
 * REG-5C-08  the shared engine mode and the provenance of a run are on screen
 * REG-5C-09  typing and the local debounce cause zero external requests
 * REG-5C-12  320 / 390 / 1440 px in both themes without overflow
 * REG-5C-15  the API key never reaches the console, storage or an export
 * REG-5C-24  the local artifact hash is unchanged and no request is made before approval
 *
 * The gateway is a real HTTP server on 127.0.0.1 that streams SSE frames, so the
 * streaming view, the first-token time, the usage block and the CORS path are
 * exercised for real. It is not a public gateway: no external connection is made.
 */
import { expect, test, type Page } from '@playwright/test';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOWNLOADS = process.env.E2E_DOWNLOADS ?? path.resolve(HERE, '../../../../downloads');

const PORT = 43117;
const BASE_URL = `http://127.0.0.1:${PORT}/v1`;
const ENDPOINT = `http://127.0.0.1:${PORT}/v1/chat/completions`;
const API_KEY = 'sk-test-0123456789abcdef';

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

type Behaviour = 'ok' | 'fail' | 'slow';
let behaviour: Behaviour = 'ok';
let hits = 0;
let server: http.Server;

function sseBody(answer: string): string {
  const chunks = answer.match(/[\s\S]{1,20}/g) ?? [];
  const frames = chunks.map((chunk) => `data: ${JSON.stringify({ choices: [{ delta: { content: chunk }, index: 0 }] })}\n\n`);
  frames.push(
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }], usage: { prompt_tokens: 912, completion_tokens: 134 } })}\n\n`,
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
      if (behaviour === 'fail') {
        response.writeHead(500, { ...cors, 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'upstream is down', key: API_KEY } }));
        return;
      }
      const answer = JSON.stringify(ENVELOPE);
      const frames = sseBody(answer).match(/data: [\s\S]*?\n\n/g) ?? [];
      response.writeHead(200, { ...cors, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      let index = 0;
      const step = () => {
        if (index < frames.length) {
          response.write(frames[index]);
          index += 1;
          setTimeout(step, behaviour === 'slow' ? 160 : 40);
        } else {
          response.end();
        }
      };
      // `body` is only read so the request is fully consumed; its content is
      // never logged, stored or echoed.
      void body;
      step();
    });
  });
  await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve));
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test.beforeEach(() => {
  behaviour = 'ok';
  hits = 0;
});

async function switchToHybrid(page: Page) {
  await page.getByTestId('engine-mode-b').click();
  await expect(page.getByTestId('engine-mode-current')).toHaveAttribute('data-engine-mode', 'hybrid');
}

async function configureConnection(page: Page, options: { screenshot?: string } = {}) {
  await page.getByTestId('kebab-button').click();
  await page.getByTestId('connection-settings').click();
  await page.getByTestId('connection-base-url').fill(BASE_URL);
  await page.getByTestId('connection-model').fill('gpt-test');
  await page.getByTestId('connection-api-key').fill(API_KEY);
  await expect(page.getByTestId('connection-api-key')).toHaveAttribute('type', 'password');
  await page.getByTestId('connection-save').click();
  await expect(page.getByTestId('connection-save-state')).toContainText('保存しました');
  if (options.screenshot) {
    fs.mkdirSync(DOWNLOADS, { recursive: true });
    await page.screenshot({ path: path.join(DOWNLOADS, options.screenshot) });
  }
  await page.getByTestId('connection-close').click();
}

async function openPreflight(page: Page) {
  await page.getByTestId('hybrid-open').click();
  await expect(page.getByTestId('hybrid-preview')).toBeVisible();
}

test.describe('Phase 5C Stage 3 — release gate', () => {
  test('REG-5C-08 the mode and the provenance are both on screen', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('./#/shiori');
    await expect(page.getByTestId('shiori-preview')).toBeVisible();

    // Mode A is the default: the bar states it and cannot send.
    await expect(page.getByTestId('engine-mode-current')).toHaveAttribute('data-engine-mode', 'local');
    await expect(page.getByTestId('hybrid-bar')).toHaveAttribute('data-engine-mode', 'local');
    await expect(page.getByTestId('hybrid-mode-label')).toContainText('Mode A');
    await expect(page.getByTestId('hybrid-open')).toBeDisabled();

    await switchToHybrid(page);
    await expect(page.getByTestId('hybrid-bar')).toHaveAttribute('data-engine-mode', 'hybrid');
    await expect(page.getByTestId('hybrid-mode-label')).toContainText('Mode B');
    await expect(page.getByTestId('hybrid-open')).toBeEnabled();

    await configureConnection(page, { screenshot: 'adop0001-5c-settings.png' });

    await openPreflight(page);
    // The cost is unknown, and says so instead of printing zero.
    await expect(page.getByTestId('hybrid-preview-cost')).toContainText('N/A');
    fs.mkdirSync(DOWNLOADS, { recursive: true });
    await page.screenshot({ path: path.join(DOWNLOADS, 'adop0001-5c-preflight.png') });

    behaviour = 'slow';
    await page.getByTestId('hybrid-consent').check();
    await page.getByTestId('hybrid-send').click();
    await expect(page.getByTestId('hybrid-run')).toBeVisible();
    await expect(page.getByTestId('hybrid-stage')).toContainText('受信中');
    await page.screenshot({ path: path.join(DOWNLOADS, 'adop0001-5c-streaming.png') });

    await expect(page.getByTestId('hybrid-result')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('hybrid-provenance')).toHaveAttribute('data-provenance', 'hybrid-ai');
    await expect(page.getByTestId('hybrid-result-mode')).toContainText('B ハイブリッド');
    await expect(page.getByTestId('hybrid-telemetry')).toBeVisible();
    await expect(page.getByTestId('telemetry-request-id')).toContainText('req-');
    await expect(page.getByTestId('telemetry-tool-id')).toHaveText('shiori');
    await expect(page.getByTestId('telemetry-provider-mode')).toContainText('hybrid-ai');
    await expect(page.getByTestId('telemetry-model-id')).toContainText('gpt-test');
    await expect(page.getByTestId('telemetry-input-tokens')).toContainText('912');
    await expect(page.getByTestId('telemetry-finish-reason')).toContainText('stop');
    await expect(page.getByTestId('telemetry-cost')).toContainText('N/A');
  });

  test('REG-5C-09 typing and the debounce cause zero external requests', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('./#/shiori');
    await switchToHybrid(page);
    await configureConnection(page);
    await expect(page.getByTestId('shiori-preview')).toBeVisible();

    const input = page.getByTestId('pane-shiori-input').locator('textarea');
    await input.fill('export function charge(amount: number): boolean {\n  return amount > 0;\n}\n');
    await page.waitForTimeout(500);
    await input.fill('export function charge(amount: number): boolean {\n  if (amount <= 0) throw new Error("amount");\n  return true;\n}\n');
    await page.waitForTimeout(500);
    await input.press('End');
    await input.type('// operator note');
    await page.waitForTimeout(900);

    // The local pass re-ran (the preview is live) but the gateway was never called.
    await expect(page.getByTestId('shiori-preview')).toBeVisible();
    expect(hits).toBe(0);

    // Opening the preflight is local work too.
    await openPreflight(page);
    expect(hits).toBe(0);
  });

  test('REG-5C-12 320 / 390 / 1440 px in both themes without overflow', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    fs.mkdirSync(DOWNLOADS, { recursive: true });

    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('./#/shiori');
      await expect(page.getByTestId('shiori-preview')).toBeVisible();
      for (const theme of ['dark', 'light'] as const) {
        const current = await page.locator('html').getAttribute('data-theme');
        if (current !== theme) await page.getByTestId('theme-toggle').click();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, `overflow at ${width}px in ${theme}`).toBeLessThanOrEqual(1);
        await expect(page.getByTestId('engine-mode-a')).toBeVisible();
        await expect(page.getByTestId('engine-mode-b')).toBeVisible();
        await expect(page.getByTestId('engine-mode-current')).toBeVisible();
        await expect(page.getByTestId('hybrid-bar')).toBeVisible();
        await page.getByTestId('engine-mode-b').click();
        await expect(page.getByTestId('engine-mode-current')).toHaveAttribute('data-engine-mode', 'hybrid');
        await page.getByTestId('engine-mode-a').click();
        await expect(page.getByTestId('engine-mode-current')).toHaveAttribute('data-engine-mode', 'local');
      }
      await page.screenshot({ path: path.join(DOWNLOADS, `adop0001-5c-layout-${width}.png`) });
    }
    expect(errors).toEqual([]);
  });

  test('REG-5C-15 the key never reaches the console, storage or an export', async ({ page }) => {
    const consoleText: string[] = [];
    page.on('console', (message) => consoleText.push(message.text()));
    page.on('pageerror', (error) => consoleText.push(String(error)));

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('./#/shiori');
    await switchToHybrid(page);
    await configureConnection(page);
    await expect(page.getByTestId('shiori-preview')).toBeVisible();

    await openPreflight(page);
    await page.getByTestId('hybrid-consent').check();
    await page.getByTestId('hybrid-send').click();
    await expect(page.getByTestId('hybrid-result')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('hybrid-apply').click();

    // Storage: no key, in any draft or connection record.
    const stored = await page.evaluate(() => {
      const out: string[] = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index) ?? '';
        out.push(key, localStorage.getItem(key) ?? '');
      }
      for (let index = 0; index < sessionStorage.length; index += 1) {
        const key = sessionStorage.key(index) ?? '';
        out.push(key, sessionStorage.getItem(key) ?? '');
      }
      return out.join('\n');
    });
    expect(stored).not.toContain(API_KEY);
    expect(stored).not.toContain('sk-test-');

    // Console: nothing printed the key during connect, stream or apply.
    expect(consoleText.join('\n')).not.toContain(API_KEY);

    // Export: the downloaded artifact carries the reviewed note, not the key.
    await page.getByTestId('shiori-export').click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export-markdown').click(),
    ]);
    const file = await download.path();
    const exported = file ? fs.readFileSync(file, 'utf8') : '';
    expect(exported).toContain('AI-assisted supplement (reviewed)');
    expect(exported).not.toContain(API_KEY);
    expect(exported).not.toContain('sk-test-');
  });

  test('REG-5C-24 the local artifact hash is unchanged and no request is made before approval', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('./#/shiori');
    await switchToHybrid(page);
    await configureConnection(page);
    await expect(page.getByTestId('shiori-preview')).toBeVisible();

    await page.getByTestId('shiori-tab-markdown').click();
    const before = await page.getByTestId('shiori-markdown').innerText();
    const beforeHash = crypto.createHash('sha256').update(before).digest('hex');

    // Opening the preview sends nothing.
    await openPreflight(page);
    expect(hits).toBe(0);

    // A failed request keeps exactly the same artifact, and sends exactly once.
    behaviour = 'fail';
    await page.getByTestId('hybrid-consent').check();
    await page.getByTestId('hybrid-send').click();
    await expect(page.getByTestId('hybrid-result')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('hybrid-provenance')).toHaveAttribute('data-provenance', 'local-fallback');
    await expect(page.getByTestId('hybrid-fallback-note')).toContainText('ローカル静的解析');
    expect(hits).toBe(1);
    fs.mkdirSync(DOWNLOADS, { recursive: true });
    await page.screenshot({ path: path.join(DOWNLOADS, 'adop0001-5c-fallback.png') });
    await page.getByTestId('hybrid-close').click();

    await page.getByTestId('shiori-tab-markdown').click();
    const after = await page.getByTestId('shiori-markdown').innerText();
    const afterHash = crypto.createHash('sha256').update(after).digest('hex');
    expect(afterHash).toBe(beforeHash);

    // The record of the comparison is written next to the screenshots.
    fs.writeFileSync(
      path.join(DOWNLOADS, 'adop0001-5c-hash.txt'),
      [
        `local artifact sha256 before: ${beforeHash}`,
        `local artifact sha256 after fallback: ${afterHash}`,
        `identical: ${beforeHash === afterHash}`,
        `gateway requests before approval: 0`,
        `gateway requests for the approved run: ${hits}`,
        `endpoint: ${ENDPOINT} (local test server, not a live gateway)`,
        '',
      ].join('\n'),
    );
  });

  test('the built page carries the CSP meta tag with the documented connect-src', async ({ page }) => {
    await page.goto('./#/shiori');
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    expect(csp).toBeTruthy();
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain('connect-src https:');
    expect(csp).toContain('http://127.0.0.1:');
    expect(csp).not.toContain('unsafe-eval');
    const inlineScripts = await page.evaluate(() => document.querySelectorAll('script:not([src])').length);
    expect(inlineScripts).toBe(0);
  });
});
