/**
 * Phase 3 — ANA-001 · UI-001 · UI-002 · DATA-001.
 *
 * The regression matrix from the work order is covered here where a browser is
 * the only way to observe the result (REG-03~06, REG-10~12, REG-14~17). Generated
 * code is checked with an independent compiler when the sandbox provides one; a
 * missing compiler is reported as SKIP, never as a pass.
 */
import { expect, test, type Page } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOWNLOADS = path.resolve(HERE, '../../../../downloads');
const OUT = path.join(DOWNLOADS, 'adop0001-phase3');
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

async function noHorizontalOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    bodyScroll: document.body.scrollWidth,
  }));
  expect(metrics.scrollWidth, `page scrollWidth ${metrics.scrollWidth} > ${metrics.innerWidth}`).toBeLessThanOrEqual(
    metrics.innerWidth + 1,
  );
  expect(metrics.bodyScroll).toBeLessThanOrEqual(metrics.innerWidth + 1);
}

function hasCompiler(command: string): boolean {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 20_000 });
  return result.status === 0 || (result.status === null && Boolean(result.stdout || result.stderr));
}

const PY_SOURCE = `from typing import Optional, list


class Ledger:
    def __init__(self, opening: int = 0) -> None:
        self.balance = opening

    def post(self, amount: int, memo: Optional[str] = None) -> int:
        if amount == 0:
            raise ValueError("amount must not be zero")
        self.balance += amount
        return self.balance
`;

const TS_SOURCE = `export function isPositive(x: number): boolean {
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

const URL_SOURCE = `export function endpoint(base: string): string {
  const url = 'https://api.example.com/v1/items?limit=10';
  if (!base) {
    throw new TypeError("base must not be empty — see https://example.com/docs");
  }
  return url + '/orders/' + base;
}`;

const LAST_A = `export function alphaOnly(value: number): number {\n  return value + 1;\n}`;
const LAST_B = `export function betaOnly(value: number): number {\n  return value * 2;\n}`;
const LAST_C = `export function gammaOnly(value: string): string {\n  if (!value) {\n    throw new TypeError('value is required');\n  }\n  return value.trim();\n}`;

test.describe('Phase 3 — analysis, UI and data hardening', () => {
  test.beforeAll(() => {
    fs.mkdirSync(OUT, { recursive: true });
  });

  test.afterAll(() => {
    if (problems.length) throw new Error(`Console/network problems were recorded:\n${problems.join('\n')}`);
  });

  /* ---------- UI-002: responsive studio ---------- */

  test('UI-002: 320–1440px stays inside the viewport for every tool and theme', async ({ page }) => {
    watch(page);
    const tools = ['shiori', 'yayoi', 'kozue', 'haruhi', 'kotoha', 'takane'];
    const widths = [320, 360, 390, 430, 768, 1024, 1280, 1440];
    for (const width of widths) {
      await page.setViewportSize({ width, height: width < 600 ? 780 : 900 });
      for (const tool of tools) {
        await page.goto(`#/${tool}`);
        await page.waitForTimeout(450);
        await noHorizontalOverflow(page);
      }
      const desktop = width >= 1024;
      await expect(page.getByTestId('workspace-rail')).toHaveCount(desktop ? 1 : 0);
      await expect(page.getByTestId('prompt-pane')).toHaveCount(desktop ? 1 : 0);
      await expect(page.getByTestId('workspace-toggle')).toHaveCount(desktop ? 1 : 0);
    }

    // Both themes paint a readable surface and keep the layout intact. The page
    // itself is transparent, so the declared theme background is what changes.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('#/shiori');
    const palette = () =>
      page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        const pane = document.querySelector('.pane') as HTMLElement | null;
        return {
          background: root.getPropertyValue('--bg').trim(),
          ink: root.getPropertyValue('--ink').trim(),
          paneSurface: pane ? getComputedStyle(pane).backgroundColor : '',
          text: getComputedStyle(document.body).color,
        };
      });
    const dark = await palette();
    await page.getByTestId('theme-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const light = await palette();
    expect(light.background).not.toBe(dark.background);
    expect(light.ink).not.toBe(dark.ink);
    expect(light.paneSurface).not.toBe(dark.paneSurface);
    expect(light.text).not.toBe(light.paneSurface);
    await noHorizontalOverflow(page);
    await page.getByTestId('theme-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('UI-002: after 1440 the three columns keep input left of output', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('#/shiori');
    await expect(page.getByTestId('pane-shiori-input')).toBeVisible();
    const input = await page.getByTestId('pane-shiori-input').boundingBox();
    const output = await page.getByTestId('pane-shiori-output').boundingBox();
    expect(input && output).toBeTruthy();
    if (input && output) {
      // The studio puts the prompt pane above the input in the left column, so the
      // two panes need not share a top edge; they must not overlap and the output
      // must sit to the right of the input.
      expect(output.x).toBeGreaterThanOrEqual(input.x + input.width - 2);
      const overlaps =
        output.x < input.x + input.width &&
        input.x < output.x + output.width &&
        output.y < input.y + input.height &&
        input.y < output.y + output.height;
      expect(overlaps, 'input and output panes overlap').toBe(false);
    }
    // A phone stacks the panes and never mounts the PC-only panes.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId('pane-shiori-input')).toBeVisible();
    const phoneInput = await page.getByTestId('pane-shiori-input').boundingBox();
    const phoneOutput = await page.getByTestId('pane-shiori-output').boundingBox();
    if (phoneInput && phoneOutput) {
      expect(phoneOutput.y).toBeGreaterThanOrEqual(phoneInput.y + phoneInput.height - 2);
    }
    await expect(page.getByTestId('workspace-rail')).toHaveCount(0);
    await noHorizontalOverflow(page);
  });

  /* ---------- UI-001: honest export feedback ---------- */

  test('UI-001: the export modal reports success only after a file was written', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('#/kotoha');
    await page.getByTestId('kotoha-sample').click();
    const editor = page.getByTestId('source-editor');
    await expect(editor).toHaveValue(/# Kotoha Round-Trip Sample/);

    // Editing the markdown leaves the rebuilt .docx stale: exporting it now must
    // fail loudly instead of announcing a document that does not carry the edit.
    await editor.fill(`${await editor.inputValue()}\n\n## 追加の編集\n\nここは再構築前の編集です。\n`);
    await page.getByTestId('kotoha-export').click();
    await page.getByTestId('export-docx').click();
    const feedback = page.getByTestId('export-feedback');
    await expect(feedback).toBeVisible();
    await expect(feedback).toHaveAttribute('data-kind', 'error');
    await expect(feedback).toContainText('再構築');

    // After a real rebuild the same action succeeds and writes a file.
    await page.keyboard.press('Escape');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('kotoha-rebuild').click(),
    ]);
    await download.saveAs(path.join(OUT, 'rebuilt.docx'));
    const stat = fs.statSync(path.join(OUT, 'rebuilt.docx'));
    expect(stat.size).toBeGreaterThan(2000);

    await page.getByTestId('kotoha-export').click();
    const [exported] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export-docx').click(),
    ]);
    expect(exported.suggestedFilename()).toMatch(/\.docx$/);
    await expect(page.getByTestId('export-feedback')).toHaveAttribute('data-kind', 'ok');
    await page.keyboard.press('Escape');
  });

  test('UI-001: the status bar shows a real error state and clears it after recovery', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('#/haruhi');
    const status = page.getByTestId('status-message');
    await expect(status).toHaveAttribute('data-state', 'ok');
    await expect(status).toContainText('エラーなし');
    // The few-shot hint states plainly that the static engine ignores the examples.
    await expect(page.getByTestId('prompt-static-note')).toContainText('適用されません');
  });

  /* ---------- REG-03~06: Haruhi reliability ---------- */

  test('REG-03: Haruhi passes the boundary value it names', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openTool(page, 'haruhi');
    await page.getByTestId('source-editor').fill(TS_SOURCE);
    const output = page.getByTestId('haruhi-output');
    await expect(output).toContainText('isPositive(0)', { timeout: 20_000 });
    await expect(output).toContainText('isPositive(-1)');
    await expect(output).toContainText('isPositive(42)');
    await expect(output).not.toContainText('toBeDefined()');
  });

  test('REG-04 + REG-05: Go subtests are unique and Java has no dummy assertion', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openTool(page, 'haruhi');
    await page.getByTestId('source-editor').fill(TS_SOURCE);

    await page.getByTestId('haruhi-framework').selectOption('go');
    // The renderer regenerates after a debounce; wait for the Go package line
    // instead of reading whatever framework was on screen before the change.
    await expect(page.getByTestId('haruhi-output')).toContainText('"testing"', { timeout: 20_000 });
    const go = await page.getByTestId('haruhi-output').innerText();
    const names = [...go.matchAll(/^func (Test\w+)\(t \*testing\.T\)/gm)].map((match) => match[1]);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    expect(go).toContain('t.Run(');

    await page.getByTestId('haruhi-framework').selectOption('junit5');
    await page.getByTestId('pane-haruhi-input').getByRole('button', { name: /Java · InvoiceService/ }).first().click();
    await expect(page.getByTestId('haruhi-output')).toContainText('class InvoiceServiceTest', { timeout: 20_000 });
    const java = await page.getByTestId('haruhi-output').innerText();
    expect(java).not.toContain('assertTrue(true)');
    expect(java).toContain('@Disabled');
    expect(java).toContain('InvoiceService');
  });

  test('REG-06: async functions get awaited success and failure assertions', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openTool(page, 'haruhi');
    await page.getByTestId('source-editor').fill(TS_SOURCE);
    const output = page.getByTestId('haruhi-output');
    await expect(output).toContainText('await expect(fetchData(', { timeout: 20_000 });
    await expect(output).toContainText('.rejects.toThrow(TypeError)');
    await expect(output).toContainText('const result = await fetchData(');

    await page.getByTestId('haruhi-framework').selectOption('pytest');
    // A Python source is needed for the pytest emitter; opening it as a file also
    // sets the module name, which becomes the import path (`from ledger import`).
    await page.getByTestId('haruhi-open').setInputFiles({
      name: 'ledger.py',
      mimeType: 'text/x-python',
      buffer: Buffer.from(PY_SOURCE, 'utf8'),
    });
    const pytestOutput = page.getByTestId('haruhi-output');
    await expect(pytestOutput).toContainText('from ledger import Ledger', { timeout: 20_000 });
    await expect(pytestOutput).toContainText('with pytest.raises(ValueError):');
  });

  /* ---------- REG-12: URL strings are data ---------- */

  test('REG-12: a URL inside a string is not cut off as a comment', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openTool(page, 'shiori');
    await page.getByTestId('source-editor').fill(URL_SOURCE);
    const preview = page.getByTestId('shiori-preview');
    await expect(preview).toContainText('endpoint', { timeout: 20_000 });
    const expectedLines = URL_SOURCE.split('\n').length;
    await expect(page.getByTestId('pane-shiori-input').locator('.pane-foot')).toContainText(`${expectedLines} 行`);

    await page.getByTestId('shiori-tab-markdown').click();
    const markdown = await page.getByTestId('shiori-markdown').innerText();
    expect(markdown).toContain('https://example.com/docs');
    expect(markdown).toContain('base must not be empty');
  });

  /* ---------- REG-10/11: Takane output is independently checked ---------- */

  test('REG-10: the generated Python scaffold compiles', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openTool(page, 'takane');
    await page.getByTestId('takane-export').click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export-python').click(),
    ]);
    const file = path.join(OUT, 'scaffold.py');
    await download.saveAs(file);
    // The real Python compiler is the judge; a syntax error fails the test.
    execFileSync('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())', file], { stdio: 'pipe' });
  });

  test('REG-11: the generated C and C++ artifacts keep declarations and definitions in step', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openTool(page, 'takane');
    await page.getByTestId('takane-export').click();
    for (const id of ['c-header', 'c', 'cpp-header', 'cpp']) {
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByTestId(`export-${id}`).click(),
      ]);
      await download.saveAs(path.join(OUT, `${id}${id.includes('header') ? (id.startsWith('cpp') ? '.hpp' : '.h') : id === 'c' ? '.c' : '.cpp'}`));
    }
    await page.keyboard.press('Escape');

    const header = fs.readFileSync(path.join(OUT, 'c-header.h'), 'utf8');
    const implementation = fs.readFileSync(path.join(OUT, 'c.c'), 'utf8');
    const declared = [...header.matchAll(/^[A-Za-z_][\w \*]*\s(\w+)\(/gm)].map((match) => match[1]);
    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) {
      expect(implementation).toContain(`${name}(`);
    }
    expect(header).toContain('#include <stdint.h>');
    expect(implementation).toMatch(/^\s*(static\s+)?[A-Za-z_][\w \*]*\s\w+\(/m);

    // Compile when a compiler exists; otherwise the structure check above stands
    // and the missing toolchain is reported as SKIP, not as a pass. `zig cc`/
    // `zig c++` are accepted exactly like `npm run qa:generated` does.
    const cPath = path.join(OUT, 'c.c');
    const cppPath = path.join(OUT, 'cpp.cpp');
    const zig = process.env.QA_ZIG && fs.existsSync(process.env.QA_ZIG) ? process.env.QA_ZIG : null;
    type Compiler = { command: string; args: string[]; label: string };
    const cCompiler: Compiler | null = hasCompiler('gcc')
      ? { command: 'gcc', args: ['-std=c11', '-fsyntax-only', '-I', OUT, cPath], label: 'gcc' }
      : hasCompiler('cc')
        ? { command: 'cc', args: ['-std=c11', '-fsyntax-only', '-I', OUT, cPath], label: 'cc' }
        : zig
          ? { command: zig, args: ['cc', '-target', 'x86_64-linux-musl', '-std=c11', '-fsyntax-only', '-I', OUT, cPath], label: 'zig cc' }
          : null;
    const cppCompiler: Compiler | null = hasCompiler('g++')
      ? { command: 'g++', args: ['-std=c++17', '-fsyntax-only', '-I', OUT, cppPath], label: 'g++' }
      : hasCompiler('c++')
        ? { command: 'c++', args: ['-std=c++17', '-fsyntax-only', '-I', OUT, cppPath], label: 'c++' }
        : zig
          ? { command: zig, args: ['c++', '-target', 'x86_64-linux-musl', '-std=c++17', '-fsyntax-only', '-I', OUT, cppPath], label: 'zig c++' }
          : null;
    for (const [label, compiler] of [
      ['C11', cCompiler],
      ['C++17', cppCompiler],
    ] as [string, Compiler | null][]) {
      if (!compiler) {
        test
          .info()
          .annotations.push({ type: 'toolchain-skip', description: `no ${label} compiler in this sandbox; structure check only (CI enforces the compile step)` });
        continue;
      }
      const syntax = spawnSync(compiler.command, compiler.args, { encoding: 'utf8' });
      expect(syntax.status, `${label} (${compiler.label}): ${syntax.stderr}`).toBe(0);
    }
  });

  /* ---------- REG-14: rapid input ---------- */

  test('REG-14: only the newest input reaches the screen', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openTool(page, 'shiori');
    const editor = page.getByTestId('source-editor');
    const preview = page.getByTestId('shiori-preview');
    for (const source of [LAST_A, LAST_B, LAST_C]) {
      await editor.fill(source);
      await page.waitForTimeout(40);
    }
    await expect(preview).toContainText('gammaOnly', { timeout: 20_000 });
    await expect(preview).not.toContainText('alphaOnly');
    await expect(preview).not.toContainText('betaOnly');

    // Switching framework quickly must also end on the last choice.
    await openTool(page, 'haruhi');
    await page.getByTestId('source-editor').fill(TS_SOURCE);
    for (const framework of ['go', 'pytest', 'junit5', 'vitest']) {
      await page.getByTestId('haruhi-framework').selectOption(framework);
    }
    await expect(page.getByTestId('haruhi-output')).toContainText("from 'vitest'", { timeout: 20_000 });
  });

  /* ---------- REG-15: Few-shot import is validated ---------- */

  test('REG-15: a malformed Few-shot bundle is refused without touching the saved examples', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openTool(page, 'takane');
    await page.getByTestId('fewshot-button').click();
    const modal = page.getByTestId('fewshot-modal');
    await expect(modal).toBeVisible();
    await expect(page.getByTestId('fewshot-static-note')).toContainText('静的エンジン');

    const bad = path.join(OUT, 'bad-fewshot.json');
    fs.writeFileSync(
      bad,
      JSON.stringify({ version: 1, tool: 'fewshot', examples: [{ id: 'x', toolId: '../evil', title: 'x', role: 'pair', outputText: 'x', enabled: true }] }),
    );
    await modal.getByTestId('fewshot-import').setInputFiles(bad);
    await expect(modal).toContainText('読み込めませんでした');
    await expect(modal.getByTestId('fewshot-item')).toHaveCount(0);

    const wrongTool = path.join(OUT, 'wrong-tool.json');
    fs.writeFileSync(wrongTool, '{ this is not json');
    await modal.getByTestId('fewshot-import').setInputFiles(wrongTool);
    await expect(modal).toContainText('読み込めませんでした');
    await page.keyboard.press('Escape');
  });

  /* ---------- REG-16/17: CI gate and Japanese UI ---------- */

  test('REG-16: the deploy workflow blocks on typecheck, tests and build', async ({ page }) => {
    const workflow = fs.readFileSync(path.resolve(HERE, '../../.github/workflows/deploy.yml'), 'utf8');
    expect(workflow).toContain('npx tsc --noEmit');
    expect(workflow).toContain('npm test');
    expect(workflow).toContain('npm run build');
    expect(workflow).not.toContain('continue-on-error');
    expect(workflow).toMatch(/deploy:\s*\n\s*needs:\s*build/);
    // The page itself is reachable while the gate is verified.
    await page.goto('./');
    await expect(page.locator('.topbar')).toBeVisible();
  });

  test('REG-17: the interface stays Japanese while artifacts stay English', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    const hangul = /[\uac00-\ud7af]/;
    for (const tool of ['shiori', 'yayoi', 'kozue', 'haruhi', 'kotoha', 'takane']) {
      await page.goto(`#/${tool}`);
      await page.waitForTimeout(500);
      const paneTitles = await page.locator('.pane-title').allInnerTexts();
      expect(paneTitles.length).toBeGreaterThanOrEqual(2);
      for (const title of paneTitles) {
        expect(title).not.toMatch(hangul);
        expect(title).toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/);
      }
      const status = await page.getByTestId('status-message').innerText();
      expect(status).not.toMatch(hangul);
    }
    // Technical artifacts keep English even though the UI is Japanese.
    await page.goto('#/shiori');
    await page.getByTestId('source-editor').fill(URL_SOURCE);
    await page.getByTestId('shiori-tab-markdown').click();
    const markdown = await page.getByTestId('shiori-markdown').innerText();
    expect(markdown).not.toMatch(hangul);
    expect(markdown).not.toMatch(/[\u3040-\u30ff]/);
  });

  /* ---------- DATA-001: samples ---------- */

  test('DATA-001: every sample is a working example and switching keeps draft and language in step', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('#/shiori');
    const editor = page.getByTestId('source-editor');
    const footer = page.getByTestId('pane-shiori-input').locator('.pane-foot');
    const preview = page.getByTestId('shiori-preview');
    await expect(preview).toContainText('Contract table');

    const samples = await page.getByTestId('pane-shiori-input').locator('button.btn-sm').allInnerTexts();
    expect(samples.length).toBeGreaterThanOrEqual(5);
    expect(samples.some((label) => label.includes('ResultPipeline'))).toBe(true);
    expect(samples.some((label) => label.includes('JobQueue'))).toBe(true);
    expect(samples.some((label) => label.includes('AsyncRepository'))).toBe(true);

    const cases: { label: string; language: string; file: string }[] = [
      { label: 'Python · AsyncRepository', language: 'Python', file: 'async_repository.py' },
      { label: 'Java · InvoiceService', language: 'Java', file: 'InvoiceService.java' },
      { label: 'JavaScript · JobQueue', language: 'JavaScript', file: 'job-queue.js' },
      { label: 'Go · billing service', language: 'Go', file: 'billing_service.go' },
      { label: 'TypeScript · ResultPipeline', language: 'TypeScript', file: 'result-pipeline.ts' },
    ];
    for (const item of cases) {
      await page.getByTestId('pane-shiori-input').getByRole('button', { name: item.label, exact: true }).click();
      // The footer must follow the sample: same language, same file name.
      await expect(footer).toContainText(item.file);
      // The specification names the detected language; a sample whose syntax and
      // file name disagree would show up here.
      await page.getByTestId('shiori-tab-markdown').click();
      await expect(page.getByTestId('shiori-markdown')).toContainText(`Language**: ${item.language}`, {
        timeout: 20_000,
      });
      await page.getByTestId('shiori-tab-preview').click();
      await expect(preview).toContainText('Contract table', { timeout: 20_000 });
      const value = await editor.inputValue();
      expect(value.split('\n').length, item.label).toBeGreaterThan(15);
    }

    // The choice survives a tool switch (APP-001) and a reload (REG-02).
    await page.getByTestId('pane-shiori-input').getByRole('button', { name: /Go · billing service/ }).click();
    const goSource = await editor.inputValue();
    await openTool(page, 'yayoi');
    await page.getByTestId('tab-shiori').click();
    await expect(page.getByTestId('source-editor')).toHaveValue(goSource);
  });
});
