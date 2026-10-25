/**
 * Dev server for Studio (B8): `pnpm --filter @instaflow/app dev` (after `pnpm build`, which builds the Wasm), then
 * open http://localhost:5174/dev/studio/ in Chrome. Workspace packages resolve from source like the root Vitest
 * config; the root is `apps/instaflow`, so the engine's `dist` and the test fonts are served as they are.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const packagesDir = fileURLToPath(new URL('../../../../packages', import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  resolve: {
    // Production browser conditions (see bench/sequencing/vite.config.ts: loro-crdt's `development` entry fails in
    // the browser when Vitest or another tool sets NODE_ENV).
    conditions: ['module', 'browser', 'production'],
    alias: [
      { find: /^@staticflux\/([^/]+)\/(.+)$/, replacement: `${packagesDir}/$1/src/$2.ts` },
      { find: /^@staticflux\/([^/]+)$/, replacement: `${packagesDir}/$1/src/index.ts` },
    ],
  },
  server: {
    host: '127.0.0.1',
    port: Number(process.env['PORT'] ?? 5174),
    strictPort: false,
    fs: { allow: [fileURLToPath(new URL('../../../..', import.meta.url))] },
    // Cross-origin isolation (IF-2.8): the pipes between main and the workers use SharedArrayBuffer rings (B9).
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
  },
  // The editor and render workers are module workers (B9).
  worker: { format: 'es' },
  optimizeDeps: { entries: ['dev/studio/index.html', 'src/workers/studio.worker.ts'], exclude: ['loro-crdt'] },
  logLevel: 'info',
});
