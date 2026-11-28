import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { CSP_META_HTTP_EQUIV, CSP_POLICY } from './src/lib/cspPolicy';

/**
 * WO-12 — inject the CSP meta tag into the built index.html only.
 *
 * `apply: 'build'` keeps the dev server usable (React Fast Refresh needs an
 * inline preamble, which a strict `script-src 'self'` would block); `npm run
 * preview` and GitHub Pages serve the built file, so what the E2E suite and the
 * deployed site see is the same policy.
 */
function cspMetaPlugin(): Plugin {
  return {
    name: 'adop0001-csp-meta',
    apply: 'build',
    transformIndexHtml(html) {
      return {
        html,
        tags: [
          {
            tag: 'meta',
            attrs: { 'http-equiv': CSP_META_HTTP_EQUIV, content: CSP_POLICY },
            injectTo: 'head-prepend',
          },
        ],
      };
    },
  };
}

// ADOP0001 is published under a GitHub Pages project sub-path. WO-OPS-01A adds
// a second channel under /ADOP0001/beta/; the base is the only difference.
const channel = process.env.ADOP_CHANNEL === 'beta' ? 'beta' : 'production';
const base = channel === 'beta' ? '/ADOP0001/beta/' : '/ADOP0001/';

function resolveCommit(): string {
  if (process.env.ADOP_COMMIT) return process.env.ADOP_COMMIT;
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

const buildInfo = {
  'import.meta.env.VITE_ADOP_CHANNEL': JSON.stringify(channel),
  'import.meta.env.VITE_ADOP_VERSION': JSON.stringify(
    JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version,
  ),
  'import.meta.env.VITE_ADOP_COMMIT': JSON.stringify(resolveCommit()),
  'import.meta.env.VITE_ADOP_BUILD_TIME': JSON.stringify(process.env.ADOP_BUILD_TIME ?? new Date().toISOString()),
};

export default defineConfig({
  base,
  define: buildInfo,
  plugins: [react(), cspMetaPlugin()],
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1200,
  },
  server: { port: 5173, host: true },
  preview: { port: 4173, host: true, strictPort: true },
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
  },
});
