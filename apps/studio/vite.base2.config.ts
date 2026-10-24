/**
 * Dev server + production build for the Studio example. Workspace packages resolve
 * from source (like the root vitest config), so no package build is needed.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { staticflux } from '@staticflux/vite-plugin';
import { chunkDeclarations } from './src/app/chunks.js';

const packagesDir = fileURLToPath(new URL('../../packages', import.meta.url));

export default defineConfig({
  // Logical chunk names, sf-manifest.json, SW precache list, build report + budget check (R12.7).
  // `bootEntries`: main.ts import()s the boot module right after the inline mode detector, so its
  // closure is boot code (boot cost, and feature chunk budgets count only bytes beyond it).
  plugins: [staticflux({ chunks: chunkDeclarations, bootEntries: ['src/boot-browser.ts'], emitEntryChunks: process.env.EMIT !== '0', budgets: { onViolation: 'warn', bootKb: 150 } })],
  resolve: {
    alias: [
      { find: /^@staticflux\/([^/]+)\/(.+)$/, replacement: `${packagesDir}/$1/src/$2.ts` },
      { find: /^@staticflux\/([^/]+)$/, replacement: `${packagesDir}/$1/src/index.ts` },
    ],
  },
  server: { port: 5173, strictPort: false, fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] } },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: true,
    reportCompressedSize: true,
  },
});
