import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';
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

// ADOP0001 is published under a GitHub Pages project sub-path.
export default defineConfig({
  base: '/ADOP0001/',
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
