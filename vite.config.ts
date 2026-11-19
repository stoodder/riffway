/**
 * Vite (web app) config, also the base of vitest.config.ts.
 * - Aliases `@shared/*` → `shared/*`, `@core/*` → `src/core/*` (mirrors tsconfig.base.json paths;
 *   tsx and esbuild read the tsconfig directly).
 * - Dev server 127.0.0.1:5173, `/api` proxied to the companion server on 5174 (D7).
 * - Worklets: `import url from './x.worklet.ts?worker&url'` → `audioWorklet.addModule(url)`.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export const alias = {
  '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
  '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
};

const apiProxy = {
  '/api': { target: `http://127.0.0.1:${process.env.RIFFWAY_PORT || 5174}`, changeOrigin: false },
};

export default defineConfig({
  resolve: { alias },
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: apiProxy },
  preview: { host: '127.0.0.1', port: 4173, proxy: apiProxy },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2023', sourcemap: true },
  worker: { format: 'es' },
});
