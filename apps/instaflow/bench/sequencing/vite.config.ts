/**
 * Build of the sequencing bench page (`pnpm --filter @instaflow/app bench:build`). Workspace
 * packages resolve from source, like the root Vitest config. Output: `bench/sequencing/dist`, served
 * cross-origin isolated by testkit's GPU runner (`sf-gpu-run … --real-gpu --headed`).
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const packagesDir = fileURLToPath(new URL('../../../../packages', import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  resolve: {
    // Pin the production browser conditions. Vite derives `development|production` from process.env.NODE_ENV,
    // and Vitest (the GPU test builds this page in-process) sets it to "test": loro-crdt then resolves its
    // `development` entry (the bundler build with an ESM-integrated .wasm import), whose worker chunk fails to
    // load in the browser, so the sequencing worker never answered `start`.
    conditions: ['module', 'browser', 'production'],
    alias: [
      { find: /^@staticflux\/([^/]+)\/(.+)$/, replacement: `${packagesDir}/$1/src/$2.ts` },
      { find: /^@staticflux\/([^/]+)$/, replacement: `${packagesDir}/$1/src/index.ts` },
    ],
  },
  worker: { format: 'es' },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true, sourcemap: false, minify: false },
  logLevel: 'warn',
});
