import { expect, test } from '@playwright/test';
import { execSync } from 'node:child_process';

const HEAD = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();

/**
 * WO-OPS-01A/B — the beta channel is the same product under /ADOP0001/beta/:
 * identifiable as BETA, served entirely from its own base path, and storing
 * preferences under its own namespace. No deploy is involved.
 */
test('beta build is identified and serves assets from its own base', async ({ page }) => {
  const problems: string[] = [];
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`${response.status()} ${response.url()}`);
  });

  await page.goto('/ADOP0001/beta/');
  const badge = page.getByTestId('beta-badge');
  await expect(badge).toBeVisible();
  await expect(badge).toContainText('BETA');
  await expect(badge).toContainText(HEAD.slice(0, 7));
  expect(await badge.getAttribute('title')).toContain(HEAD);
  expect(await page.title()).toContain('[BETA]');

  const sources = await page.locator('script[src], link[rel="stylesheet"][href]').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('src') ?? node.getAttribute('href') ?? ''),
  );
  expect(sources.length).toBeGreaterThan(0);
  expect(sources.every((source) => source.startsWith('/ADOP0001/beta/')), JSON.stringify(sources)).toBe(true);
  expect(problems).toEqual([]);
});

test('beta preferences stay in the beta namespace', async ({ page }) => {
  await page.goto('/ADOP0001/beta/');
  await expect(page.getByTestId('beta-badge')).toBeVisible();
  await page.getByTestId('theme-toggle').click();

  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys.length).toBeGreaterThan(0);
  expect(keys.every((key) => key.startsWith('adop0001.beta.'))).toBe(true);
  expect(keys).not.toContain('adop0001.theme');
  expect(keys).not.toContain('adop0001.workspace.open');
});

test('dynamic vendor import resolves under the beta base', async ({ page }) => {
  const mermaid: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('vendor/mermaid')) mermaid.push(request.url());
  });

  await page.goto('/ADOP0001/beta/');
  await expect(page.getByTestId('beta-badge')).toBeVisible();
  expect(mermaid).toEqual([]);

  await page.getByTestId('tab-kozue').click();
  await expect(page.getByTestId('kozue-diagram').locator('svg')).toHaveCount(1, { timeout: 30_000 });
  expect(mermaid).toHaveLength(1);
  expect(mermaid[0]).toContain('/ADOP0001/beta/vendor/mermaid.min.js');
});