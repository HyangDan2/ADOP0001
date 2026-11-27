/**
 * Q05 E2E helper — port isolation.
 *
 * REG-G1 E2E runs must never share the main preview server on 4173. These
 * helpers make the dedicated port explicit so a spec cannot silently attach to a
 * second run.
 */
export const ARTIFACTS_E2E_PORT = 4273;
export const MAIN_PREVIEW_PORT = 4173;
export const APP_BASE_PATH = '/ADOP0001/';

const MIN_PORT = 1024;
const MAX_PORT = 65_535;

export function artifactsBaseUrl(port: number = ARTIFACTS_E2E_PORT): string {
  assertDedicatedE2EPort(port);
  return `http://127.0.0.1:${port}${APP_BASE_PATH}`;
}

export function assertDedicatedE2EPort(portOrUrl: number | string): number {
  const port = typeof portOrUrl === 'number' ? portOrUrl : portOf(portOrUrl);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(`E2E port must be an integer in ${MIN_PORT}..${MAX_PORT}, received ${portOrUrl}`);
  }
  if (port === MAIN_PREVIEW_PORT) {
    throw new Error(
      `Refusing to run artifact E2E on ${MAIN_PREVIEW_PORT}: the main preview server is not a dedicated run`,
    );
  }
  return port;
}

export function originOf(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

function portOf(baseUrl: string): number {
  const url = new URL(baseUrl);
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}
