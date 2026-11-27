/**
 * Browser origin of the preview under test, derived exactly as
 * `playwright.config.ts` derives `baseURL`. The default stays
 * `http://127.0.0.1:4173` so existing runs and expectations are unchanged.
 */
export const PREVIEW_ORIGIN = new URL(
  process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4173/ADOP0001/',
).origin;
