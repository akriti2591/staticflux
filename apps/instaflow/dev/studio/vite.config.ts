/**
 * Dev server for Home and Studio (B8, C0): `pnpm --filter @instaflow/app dev` (after `pnpm build`, which builds the
 * Wasm), then open http://localhost:5174/ (Home) or http://localhost:5174/dev/studio/ (Studio on the demo) in Chrome. Workspace packages resolve from source like the root Vitest
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
  // C0: the surfaces' routes (src/home/routes.ts) served by the two pages — Home at `/`, Studio at `/s/:asset` and `/new`.
  plugins: [
    {
      name: 'instaflow-surface-routes',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          const [path = '/', search = ''] = (req.url ?? '/').split('?');
          // B11c: Home's own pages (`/files`, `/p/:name`, `/templates`, `/trash`) are the Home page too.
          const home = path === '/' || path === '/index.html' || /^\/(files|templates|trash|settings(\/[^/]+)?|p\/[^/]+)\/?$/.test(path);
          const page = home ? '/dev/home/index.html' : /^\/(s\/[^/]+(\/d\/[^/]+)?|new)\/?$/.test(path) ? '/dev/studio/index.html' : undefined;
          if (page !== undefined) req.url = search.length > 0 ? `${page}?${search}` : page;
          next();
        });
      },
    },
  ],
  optimizeDeps: { entries: ['dev/studio/index.html', 'dev/home/index.html', 'src/workers/studio.worker.ts', 'src/export/export.worker.ts'], exclude: ['loro-crdt'] },
  logLevel: 'info',
});
