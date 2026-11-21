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

async function noHorizontalOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1);
}

const SPEC_FILE = {
  name: 'payment-service.spec.md',
  mimeType: 'text/markdown',
  buffer: Buffer.from(
    [
      '# Specification — payment-service',
      '',
      '## 2. Contract table',
      '',
      '| Contract | Returns |',
      '| --- | --- |',
      '| `charge(request: PaymentRequest)` | PaymentResult |',
      '',
      '## 3. Behaviour rules',
      '',
      '| Function | When | Then |',
      '| --- | --- | --- |',
      '| charge | `!request.invoiceId` | THROW — `invoiceId is required` |',
      '',
      '## 6. Data types',
      '',
      '### interface `PaymentRequest`',
      '',
      '- `invoiceId: string`',
      '',
    ].join('\n'),
  ),
};

const MCU_FILE = {
  name: 'gpio_emitter_mcu.c',
  mimeType: 'text/x-c',
  buffer: Buffer.from(
    [
      '#include <stdint.h>',
      '',
      'typedef enum { MCU_OK = 0, MCU_ERR_INVALID_ARG = -1 } McuStatus;',
      '',
      'typedef struct GpioConfig {',
      '    uint8_t port;',
      '    uint32_t pin_mask;',
      '} GpioConfig;',
      '',
      'McuStatus gpio_emit(const GpioConfig *config, uint16_t value);',
      '',
    ].join('\n'),
    'utf8',
  ),
};

test.describe('HD2Lab Aomatsukan live application', () => {
  test.beforeAll(() => {
    fs.mkdirSync(DOWNLOADS, { recursive: true });
  });

  test('loads with the full brand shell, workspace rail and few-shot trigger', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('./');
    await expect(page.locator('.topbar')).toBeVisible();
    await expect(page.getByText('HD2Lab 青松館')).toBeVisible();
    await expect(page.getByText('6-in-1 スイート')).toBeVisible();
    for (const tool of ['shiori', 'yayoi', 'kozue', 'haruhi', 'kotoha', 'takane']) {
      await expect(page.getByTestId(`tab-${tool}`)).toBeVisible();
    }
    await expect(page.getByTestId('tab-takane')).toContainText('仕様書→コード');
    await expect(page.getByTestId('workspace-toggle')).toBeVisible();
    await expect(page.getByTestId('workspace-rail')).toBeVisible();
    await expect(page.getByTestId('fewshot-button')).toContainText('Few-shot例');

    // PC studio: centre-top prompt pane with the bottom-right few-shot icon.
    const promptPane = page.getByTestId('prompt-pane');
    await expect(promptPane).toBeVisible();
    await expect(promptPane).toContainText('プロンプト · Few-shot例');
    await expect(page.getByTestId('prompt-attach')).toBeVisible();
    const attach = await page.getByTestId('prompt-attach').boundingBox();
    const box = await page.locator('.prompt-box').boundingBox();
    expect(attach && box).toBeTruthy();
    if (attach && box) {
      // Bottom-right corner of the instruction box.
      expect(attach.x + attach.width / 2).toBeGreaterThan(box.x + box.width / 2);
      expect(attach.y + attach.height / 2).toBeGreaterThan(box.y + box.height / 2);
    }

    // The three columns: rail left of the centre stack, output to the right.
    const rail = await page.getByTestId('workspace-rail').boundingBox();
    const input = await page.getByTestId('source-editor').boundingBox();
    const output = await page.locator('.pane').nth(1).boundingBox();
    expect(rail && input && output).toBeTruthy();
    if (rail && input && output) {
      expect(rail.x + rail.width).toBeLessThanOrEqual(input.x + 1);
      expect(output.x).toBeGreaterThan(input.x + input.width - 2);
    }

    await page.getByTestId('help-button').click();
    await expect(page.getByTestId('help-modal')).toBeVisible();
    await expect(page.getByTestId('help-modal')).toContainText('100% ブラウザ完結');
    await expect(page.getByTestId('help-modal')).toContainText('ワークスペース');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('help-modal')).toHaveCount(0);

    await page.getByTestId('kebab-button').click();
    await expect(page.getByTestId('kebab-menu')).toContainText('HD2Lab Web-HQ');
    await page.keyboard.press('Escape');
  });

  test('Shiori weaves a specification and exports it through the modal', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('./#/shiori');
    const preview = page.getByTestId('shiori-preview');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('Contract table');
    await expect(preview).toContainText('charge');
    await expect(page.locator('.pane-title').first()).toContainText('ソース入力');

    await page.getByTestId('shiori-export').click();
    await expect(page.getByTestId('export-modal')).toBeVisible();
    await expect(page.getByTestId('export-modal')).toContainText('.spec.md');
    await page.getByTestId('export-filename').fill('payment-spec');
    await expect(page.getByTestId('export-modal')).toContainText('payment-spec.spec.md');
    await page.screenshot({ path: path.join(DOWNLOADS, 'adop0001_export_modal.png') });
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export-markdown').click(),
    ]);
    expect(download.suggestedFilename()).toBe('payment-spec.spec.md');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('export-modal')).toHaveCount(0);

    await page.getByTestId('shiori-tab-markdown').click();
    await expect(page.getByTestId('shiori-markdown')).toContainText('# Specification');

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
    await page.getByRole('group', { name: '擬似コードのスタイル' }).getByRole('button', { name: '英語ナラティブ' }).click();
    await expect(page.getByTestId('yayoi-output')).toContainText('When ');
  });

  test('Kozue renders a real Mermaid diagram and exports SVG', async ({ page }) => {
    watch(page);
    await openTool(page, 'kozue');
    const diagram = page.getByTestId('kozue-diagram');
    await expect(diagram.locator('svg')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('group', { name: 'ダイアグラムの種類' }).getByRole('button', { name: 'シーケンス' }).click();
    await expect(diagram.locator('svg')).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('kozue-export').click();
    await expect(page.getByTestId('export-modal')).toContainText('.svg');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export-svg').click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.svg$/);
    await page.keyboard.press('Escape');
  });

  test('Haruhi forges tests for four frameworks', async ({ page }) => {
    watch(page);
    await openTool(page, 'haruhi');
    const output = page.getByTestId('haruhi-output');
    await expect(output).toContainText("from 'vitest'");

    for (const [value, marker] of [
      ['jest', 'jest.fn()'],
      ['pytest', 'import pytest'],
      ['junit5', 'org.junit.jupiter.api.Test'],
      ['go', 'func Test'],
    ] as const) {
      await page.getByTestId('haruhi-framework').selectOption(value);
      await expect(output).toContainText(marker, { timeout: 20_000 });
    }

    await page.getByRole('tab', { name: '分岐チェックリスト' }).click();
    await expect(page.locator('.checklist')).toBeVisible();

    await page.getByTestId('haruhi-export').click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export-test').click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/_test\.go$/);
    await page.keyboard.press('Escape');
  });

  test('Kotoha round-trips a sample docx through Markdown', async ({ page }) => {
    watch(page);
    await openTool(page, 'kotoha');
    await page.getByTestId('kotoha-sample').click();
    const editor = page.getByTestId('source-editor');
    await expect(editor).toHaveValue(/# Kotoha Round-Trip Sample/);
    const inspector = page.getByTestId('kotoha-panel');
    await expect(inspector).toContainText('見出し1の色');
    await expect(inspector).toContainText('ヘッダー保持済み');

    const [rebuildDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('kotoha-rebuild').click(),
    ]);
    expect(rebuildDownload.suggestedFilename()).toMatch(/\.docx$/);
    const rebuiltPath = path.join(DOWNLOADS, 'adop0001_kotoha_rebuilt.docx');
    await rebuildDownload.saveAs(rebuiltPath);
    expect(fs.statSync(rebuiltPath).size).toBeGreaterThan(2000);

    await page.getByTestId('kotoha-export').click();
    await expect(page.getByTestId('export-modal')).toContainText('.kotoha.json');
    const [bundleDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export-bundle').click(),
    ]);
    expect(bundleDownload.suggestedFilename()).toMatch(/\.kotoha\.json$/);
    await page.keyboard.press('Escape');
  });

  test('Takane offers Python, C, C++ and MCU and exports each', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openTool(page, 'takane');
    const segmented = page.getByRole('group', { name: '生成する言語' });
    for (const label of ['Python', 'C', 'C++', 'MCU']) {
      await expect(segmented.getByRole('button', { name: label, exact: true })).toBeVisible();
    }
    await expect(segmented.getByRole('button')).toHaveCount(4);
    for (const gone of ['TypeScript', 'Java', 'Go']) {
      await expect(segmented.getByRole('button', { name: gone, exact: true })).toHaveCount(0);
    }
    await expect(segmented.getByRole('button', { name: 'Python', exact: true })).toHaveAttribute('aria-pressed', 'true');

    const preview = page.getByTestId('takane-preview');
    await expect(preview).toContainText('PaymentService.charge');
    await page.getByTestId('takane-tab-code').click();
    const output = page.getByTestId('takane-output');
    await expect(output).toContainText('class PaymentService:');
    await expect(output).toContainText('@dataclass');

    await segmented.getByRole('button', { name: 'C', exact: true }).click();
    await expect(output).toContainText('#include <stdint.h>');
    await expect(output).toContainText('PAYMENT_SERVICE_ERR_INVALID_ARG');

    await segmented.getByRole('button', { name: 'C++', exact: true }).click();
    await expect(output).toContainText('enum class PaymentStatus {');
    await expect(output).toContainText('std::optional<std::string> currency{};');

    await segmented.getByRole('button', { name: 'MCU', exact: true }).click();
    await expect(output).toContainText('MCU_ERR_INVALID_ARG');
    await expect(output).toContainText('uint8_t McuStatusByte;');
    await expect(output).toContainText('char invoice_id[PAYMENT_REQUEST_TEXT_MAX];');
    await expect(output).toContainText('int32_t amount;');
    await page.screenshot({ path: path.join(DOWNLOADS, 'adop0001_takane_mcu.png') });

    await page.getByTestId('takane-export').click();
    const modal = page.getByTestId('export-modal');
    await expect(modal).toContainText('.py');
    await expect(modal).toContainText('.c（MCU）');
    const [mcuDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export-mcu').click(),
    ]);
    expect(mcuDownload.suggestedFilename()).toMatch(/_mcu\.c$/);
    await page.keyboard.press('Escape');
  });

  test('Takane loads the latest Shiori specification', async ({ page }) => {
    watch(page);
    await openTool(page, 'shiori');
    await expect(page.getByTestId('shiori-preview')).toBeVisible();
    await openTool(page, 'takane');
    await page.getByTestId('takane-load-shiori').click();
    await expect(page.locator('.toast')).toContainText('枝織の最新仕様書を読み込みました');
    await expect(page.getByTestId('takane-preview')).toContainText('PaymentService.charge');
  });

  test('Few-shot examples upload, count tokens, preview the prompt and persist', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openTool(page, 'takane');
    await expect(page.getByTestId('fewshot-count')).toHaveText('(0)');

    await page.getByTestId('fewshot-button').click();
    const modal = page.getByTestId('fewshot-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('ローカル保存のみ・送信なし');

    // Input + output pair through the multi-file picker.
    await page.getByTestId('fewshot-multi-files').setInputFiles([SPEC_FILE, MCU_FILE]);
    await expect(modal.getByTestId('fewshot-item')).toHaveCount(1);
    await expect(modal).toContainText('gpio_emitter_mcu');
    await expect(modal).toContainText('トークン');
    await expect(modal).toContainText('mcu');

    const items = modal.getByTestId('fewshot-item');
    await expect(items.first()).toContainText('入力＋出力');
    await page.screenshot({ path: path.join(DOWNLOADS, 'adop0001_fewshot_modal.png') });

    await modal.getByTestId('fewshot-tab-prompt').click();
    const prompt = modal.getByTestId('fewshot-prompt-text');
    await expect(prompt).toContainText('# strategy: few-shot');
    await expect(prompt).toContainText('## examples (1)');
    await expect(prompt).toContainText('Spec to Code');
    await expect(prompt).toContainText('gpio_emitter_mcu');

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('fewshot-count')).toHaveText('(1)');
    // The active example appears as a pill in the centre-top prompt pane.
    await expect(page.getByTestId('prompt-pills')).toContainText('gpio_emitter_mcu');

    await page.reload();
    await page.waitForTimeout(900);
    await expect(page.getByTestId('fewshot-count')).toHaveText('(1)');
    await expect(page.getByTestId('prompt-pills')).toContainText('gpio_emitter_mcu');

    // Toggle it off and back on from the manager.
    await page.getByTestId('fewshot-button').click();
    await page.getByTestId('fewshot-toggle').first().uncheck();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('fewshot-count')).toHaveText('(0)');
  });

  test('PC workspace opens a folder, filters and attaches a few-shot example', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openTool(page, 'shiori');
    const rail = page.getByTestId('workspace-rail');
    await expect(rail).toBeVisible();

    await expect(rail.getByTestId('workspace-open')).toBeVisible();
    await page.getByTestId('workspace-open-files').setInputFiles([MCU_FILE, SPEC_FILE]);
    await expect(rail.getByTestId('workspace-tree')).toContainText('gpio_emitter_mcu.c');
    await expect(rail.getByTestId('workspace-tree')).toContainText('payment-service.spec.md');

    await page.getByTestId('workspace-filter').fill('gpio');
    await expect(rail.getByTestId('workspace-file')).toHaveCount(1);
    await page.getByTestId('workspace-filter').fill('');

    // Attach as a few-shot example, then open it into the centre pane.
    await rail.getByTestId('workspace-attach').first().click();
    await expect(page.getByTestId('fewshot-count')).toHaveText('(1)');

    await rail.getByTestId('workspace-file').first().click();
    await expect(page.getByTestId('source-editor')).toHaveValue(/GpioConfig/);
    await page.screenshot({ path: path.join(DOWNLOADS, 'adop0001_workspace_pc.png') });
    await page.screenshot({ path: path.join(DOWNLOADS, 'adop0001_pc_studio_3col.png') });

    // The rail can be collapsed and reopened from the top bar.
    await page.getByTestId('workspace-collapse').click();
    await expect(page.getByTestId('workspace-rail')).toHaveCount(0);
    await page.getByTestId('workspace-toggle').click();
    await expect(page.getByTestId('workspace-rail')).toBeVisible();
  });

  test('holds the 390px mobile layout without horizontal overflow', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('./#/takane');
    await page.waitForTimeout(900);
    await noHorizontalOverflow(page);

    // The PC-only rail and centre-top pane are gone on a phone.
    await expect(page.getByTestId('workspace-rail')).toHaveCount(0);
    await expect(page.getByTestId('workspace-toggle')).toHaveCount(0);
    await expect(page.getByTestId('prompt-pane')).toHaveCount(0);
    await expect(page.getByTestId('fewshot-button')).toBeVisible();

    await page.screenshot({ path: path.join(DOWNLOADS, 'adop0001_takane_mobile.png') });

    for (const tool of ['shiori', 'yayoi', 'kozue', 'haruhi', 'kotoha']) {
      await page.goto(`./#/${tool}`);
      await page.waitForTimeout(600);
      await noHorizontalOverflow(page);
    }

    // The few-shot manager stays usable on a phone.
    await page.getByTestId('fewshot-button').click();
    await expect(page.getByTestId('fewshot-modal')).toBeVisible();
    await noHorizontalOverflow(page);
    await page.getByTestId('fewshot-tab-prompt').click();
    await noHorizontalOverflow(page);
    await page.keyboard.press('Escape');
  });

  test.afterAll(() => {
    if (problems.length) {
      throw new Error(`Console/network problems were recorded:\n${problems.join('\n')}`);
    }
  });
});
