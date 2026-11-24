/**
 * Phase 4 — final QA gate (QA-001 · QA-002, REG-18).
 *
 * REG-18 is the one matrix row no earlier phase covered: the interface is
 * Japanese, but every generated artifact is English. REG-01~17 live in
 * `phase2.spec.ts` / `phase3.spec.ts`; `tests/reg-matrix.test.ts` keeps that
 * mapping from drifting.
 *
 * QA-002 closes the release gate: the deploy workflow must block on every
 * required step, and the three reference widths must render in both themes with
 * no console or page error. The full pipeline (typecheck → Vitest → generated
 * code QA → build → Playwright → artifacts → Pages) is kept in
 * `docs/ci-workflow.yml` because a GitHub App token cannot write a workflow
 * file (the push is refused with `without workflows permission`).
 */
import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const DOWNLOADS = process.env.E2E_DOWNLOADS ?? path.resolve(HERE, '../../../../downloads');
const OUT = path.join(DOWNLOADS, 'adop0001-phase4');
const problems: string[] = [];

const CJK = /[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/;
const JAPANESE = /[\u3040-\u30ff\u4e00-\u9fff]/;

const SPEC_SOURCE = `export function isPositive(x: number): boolean {
  return x > 0;
}

export async function fetchData(url: string): Promise<string> {
  if (!url) {
    throw new TypeError('url is required');
  }
  return 'payload';
}

export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }
}`;

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

async function noHorizontalOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    bodyScroll: document.body.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1);
  expect(metrics.bodyScroll).toBeLessThanOrEqual(metrics.innerWidth + 1);
}

test.describe('Phase 4 — final QA gate', () => {
  test.beforeAll(() => {
    fs.mkdirSync(OUT, { recursive: true });
  });

  test.afterAll(() => {
    if (problems.length) throw new Error(`Console/network problems were recorded:\n${problems.join('\n')}`);
  });

  test('REG-18: every generated artifact is English while the UI stays Japanese', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    // Shiori: the specification markdown.
    await page.goto('#/shiori');
    await page.getByTestId('source-editor').fill(SPEC_SOURCE);
    await page.getByTestId('shiori-tab-markdown').click();
    const spec = await page.getByTestId('shiori-markdown').innerText();
    expect(spec.length).toBeGreaterThan(200);
    expect(spec).not.toMatch(CJK);

    // Yayoi: the pseudocode.
    await page.getByTestId('tab-yayoi').click();
    await expect
      .poll(async () => (await page.getByTestId('yayoi-output').innerText()).length, { timeout: 30_000 })
      .toBeGreaterThan(100);
    const pseudocode = await page.getByTestId('yayoi-output').innerText();
    expect(pseudocode).not.toMatch(CJK);

    // Kozue: the diagram text (rendered mermaid SVG).
    await page.getByTestId('tab-kozue').click();
    await expect(page.getByTestId('kozue-diagram').locator('svg')).toHaveCount(1, { timeout: 30_000 });
    const diagram = await page.getByTestId('kozue-diagram').innerText();
    expect(diagram.length).toBeGreaterThan(10);
    expect(diagram).not.toMatch(CJK);

    // Haruhi: the generated test code, for every framework the UI offers.
    await page.getByTestId('tab-haruhi').click();
    const frameworks = ['Vitest', 'Jest', 'Pytest', 'JUnit 5', 'Go testing'];
    for (const framework of frameworks) {
      await page.getByTestId('haruhi-framework').selectOption({ label: framework });
      const codeView = page.getByTestId('haruhi-output').locator('pre.code-view');
      await expect.poll(async () => (await codeView.innerText()).length, { timeout: 30_000 }).toBeGreaterThan(50);
      const code = await codeView.innerText();
      expect(code, framework).not.toMatch(CJK);
    }

    // Takane: the generated source for each target, from a specification.
    await page.getByTestId('tab-takane').click();
    await page.getByTestId('takane-sample-payment-service.spec.md').click();
    await page.getByTestId('takane-tab-code').click();
    const takaneCode = page.getByTestId('takane-output').locator('pre.code-view');
    await expect.poll(async () => (await takaneCode.innerText()).length, { timeout: 30_000 }).toBeGreaterThan(50);
    const python = await takaneCode.innerText();
    expect(python).toContain('def ');
    expect(python).not.toMatch(CJK);
    const languageGroup = page.getByRole('group', { name: '生成する言語' });
    for (const label of ['C', 'C++', 'MCU']) {
      await languageGroup.getByRole('button', { name: label, exact: true }).click();
      await page.waitForTimeout(500);
      const code = await takaneCode.innerText();
      expect(code.length, label).toBeGreaterThan(50);
      expect(code, label).not.toMatch(CJK);
    }

    // The interface around those artifacts is Japanese, not English-only.
    const titles = await page.locator('.pane-title').allInnerTexts();
    expect(titles.some((title) => JAPANESE.test(title))).toBe(true);
  });

  test('QA-002: the deploy gate blocks on typecheck, tests and build, and the full pipeline is defined', async () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
    expect(workflow).toContain('npx tsc --noEmit');
    expect(workflow).toContain('npm test');
    expect(workflow).toContain('npm run build');
    expect(workflow).not.toContain('continue-on-error');
    expect(workflow).toMatch(/deploy:\s*\n(?:\s*if:[^\n]*\n)?\s*needs:\s*build/);

    // The full gate (generated-code QA + Playwright) cannot be pushed to
    // .github/workflows with this installation's permissions, so its definition
    // lives in docs/ for the repository owner to copy across.
    const full = fs.readFileSync(path.join(ROOT, 'docs/ci-workflow.yml'), 'utf8');
    const steps = ['npm ci', 'npx tsc --noEmit', 'npm test', 'npm run qa:generated', 'npm run build'];
    for (const step of steps) expect(full, step).toContain(step);
    expect(full).toContain('npx playwright install');
    expect(full).toContain('npm run test:e2e');
    expect(full).toContain('upload-artifact');
    expect(full).toContain('deploy-pages');
    // No step is allowed to swallow a failure.
    expect(full).not.toMatch(/continue-on-error:\s*true/);
    expect(full).not.toMatch(/\|\|\s*true/);
  });

  test('QA-002: 320/390/1440 in both themes render with no console or page errors', async ({ page }) => {
    watch(page);
    const tools = ['shiori', 'yayoi', 'kozue', 'haruhi', 'kotoha', 'takane'];
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: width < 600 ? 780 : 900 });
      for (const theme of ['dark', 'light'] as const) {
        await page.goto('./#/shiori');
        const current = await page.locator('html').getAttribute('data-theme');
        if (current !== theme) await page.getByTestId('theme-toggle').click();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        for (const tool of tools) {
          await page.goto(`#/${tool}`);
          await page.waitForTimeout(350);
          await expect(page.getByTestId('status-message')).toHaveAttribute('data-state', 'ok');
          await noHorizontalOverflow(page);
        }
      }
    }

    // Reference screenshots for the release report.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('./#/shiori');
    const theme = await page.locator('html').getAttribute('data-theme');
    if (theme !== 'dark') await page.getByTestId('theme-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    // Let the swap settle: a capture taken in the same tick as the toggle
    // recorded the mid-transition frame instead of the real palette.
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, 'final-pc.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('./#/shiori');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, 'final-mobile.png') });
  });

  test('QA-002: a theme switch never paints a light fill under the dark ink', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('./#/shiori');
    if ((await page.locator('html').getAttribute('data-theme')) !== 'light') {
      await page.getByTestId('theme-toggle').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      await page.waitForTimeout(300);
    }

    // Watch every frame across the switch. In the dark palette no button or
    // chip may be filled with a light surface: that is exactly the frame the
    // 2026-11-23 reference capture froze (white labels on white chips).
    await page.evaluate(() => {
      const state = { worst: 0 };
      (window as unknown as { __themeProbe: typeof state }).__themeProbe = state;
      const linear = (value: number) => {
        const channel = value / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      };
      const read = () => {
        if (document.documentElement.dataset.theme !== 'dark') return;
        for (const element of document.querySelectorAll<HTMLElement>(
          '.btn:not(.btn-primary):not(.btn-danger), .icon-btn, .chip-btn',
        )) {
          const parts = getComputedStyle(element).backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [];
          if (parts.length < 3) continue;
          if (parts.length > 3 && parts[3] < 0.5) continue;
          const luminance = 0.2126 * linear(parts[0]) + 0.7152 * linear(parts[1]) + 0.0722 * linear(parts[2]);
          state.worst = Math.max(state.worst, luminance);
        }
      };
      const deadline = performance.now() + 600;
      const tick = () => {
        read();
        if (performance.now() < deadline) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    await page.getByTestId('theme-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.waitForTimeout(500);

    const worst = await page.evaluate(
      () => (window as unknown as { __themeProbe: { worst: number } }).__themeProbe.worst,
    );
    expect(worst).toBeLessThan(0.2);
  });
});
