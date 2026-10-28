/**
 * Production build of Home and Studio for local performance testing: `pnpm --filter @instaflow/app build:prod`
 * (after the root `pnpm build`, which builds the Wasm), then `pnpm --filter @instaflow/app preview:prod`.
 * Same entries and resolution as the dev server (dev/studio/vite.config.ts), minified, source maps written but not
 * referenced (`hidden`), no obfuscation. scripts/build-prod.mjs copies the runtime assets and precompresses.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { studioPreloadPlugin } from '../dev/studio/preload-plugin.js';

const packagesDir = fileURLToPath(new URL('../../../packages', import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  base: '/',
  resolve: {
    conditions: ['module', 'browser', 'production'],
    alias: [
      { find: /^@staticflux\/([^/]+)\/(.+)$/, replacement: `${packagesDir}/$1/src/$2.ts` },
      { find: /^@staticflux\/([^/]+)$/, replacement: `${packagesDir}/$1/src/index.ts` },
    ],
  },
  worker: { format: 'es' },
  // #62: the Studio page preloads the boot Wasm and the worker chunk by their hashed names.
  plugins: [studioPreloadPlugin()],
  build: {
    outDir: fileURLToPath(new URL('../dist-prod', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    minify: true,
    sourcemap: 'hidden',
    reportCompressedSize: false,
    rollupOptions: {
      input: {
        home: fileURLToPath(new URL('../dev/home/index.html', import.meta.url)),
        studio: fileURLToPath(new URL('../dev/studio/index.html', import.meta.url)),
      },
    },
  },
  logLevel: 'info',
});
