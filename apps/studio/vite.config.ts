/**
 * Dev server + production build for the Studio example. Workspace packages resolve
 * from source (like the root vitest config), so no package build is needed.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { staticflux } from '@staticflux/vite-plugin';
import { chunkDeclarations } from './src/app/chunks.js';
import { bootChunk } from './build/boot-chunk.js';

const packagesDir = fileURLToPath(new URL('../../packages', import.meta.url));

// One boot chunk: everything boot-browser.ts statically uses (fetched at boot anyway) in a
// single file instead of ~18 shared fragments; the inline detector (main.ts) stays separate.
const boot = bootChunk({ bootEntry: (id) => id.endsWith('/src/boot-browser.ts'), initialEntry: (id) => id.endsWith('/src/main.ts') });

export default defineConfig({
  // Logical chunk names, sf-manifest.json, SW precache list, build report + budget check (R12.7).
  // `bootEntries`: main.ts import()s the boot module right after the inline mode detector, so its
  // closure is boot code (boot cost, and feature chunk budgets count only bytes beyond it).
  plugins: [staticflux({ chunks: chunkDeclarations, bootEntries: ['src/boot-browser.ts'], budgets: { onViolation: 'warn', bootKb: 150 } }), boot.plugin],
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
    rolldownOptions: {
      // Captured modules' own deps are captured by the binding-level walk; never pull more in.
      output: { codeSplitting: { groups: [{ ...boot.group, includeDependenciesRecursively: false }] } },
    },
  },
});
