import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4173/ADOP0001/';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  outputDir: '.playwright-artifacts',
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    // A container with a pre-installed Chromium can point at it explicitly.
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run preview',
    url: 'http://127.0.0.1:4173/ADOP0001/',
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
