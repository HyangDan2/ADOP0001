import { defineConfig, devices } from '@playwright/test';

/** Beta-channel verification: same build, base /ADOP0001/beta/. WO-OPS-01A/F. */
export default defineConfig({
  testDir: 'tests/e2e/beta',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4174/ADOP0001/beta/',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium-beta', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build:beta && node tools/release/preview-beta.mjs',
    url: 'http://127.0.0.1:4174/ADOP0001/beta/',
    reuseExistingServer: false,
    timeout: 240_000,
  },
  outputDir: '.playwright-artifacts/beta',
});