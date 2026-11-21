import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// ADOP0001 is published under a GitHub Pages project sub-path.
export default defineConfig({
  base: '/ADOP0001/',
  plugins: [react()],
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
