/**
 * The StaticFlux documentation site (GitHub Pages, base `/staticflux/`).
 *
 * - Pages are TypeScript modules rendered to static HTML at build time (`src/build/`), served
 *   as virtual HTML entries — one `index.html` per route, readable without JavaScript.
 * - Interactive parts are `@staticflux/hydrate` islands. Their code lives in logical chunks
 *   (`src/client/chunks.ts`) that the StaticFlux Vite plugin names, budgets and lists in
 *   `sf-manifest.json`; the client loads them through `virtual:sf-chunks`.
 * - Workspace packages resolve from source (same aliases as the root vitest config), so the
 *   browser bundle never needs a package build. The build-time renderer (Node) imports the
 *   built `dist` of `@staticflux/hydrate` / `loader` / `vite-plugin`: run `pnpm build` first.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import { staticflux } from '@staticflux/vite-plugin';
import { islandChunks } from './src/client/chunks.js';
import { renderPage } from './src/build/layout.js';
import { pages } from './src/build/pages.js';
import { BASE } from './src/build/site.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const packagesDir = fileURLToPath(new URL('../packages', import.meta.url));

/** Output file of a page: '' → index.html, 'guides/' → guides/index.html, '404' → 404.html. */
function fileOf(path: string): string {
  if (path === '404') return '404.html';
  return `${path}index.html`;
}

const pageByFile = new Map(pages.map((page) => [fileOf(page.path), page] as const));

/** Virtual multi-page HTML: each page is an entry `<root>/<path>/index.html` that never exists on disk. */
function staticPages(): Plugin {
  return {
    name: 'site:static-pages',
    enforce: 'pre',
    resolveId(id) {
      const rel = id.startsWith(root) ? id.slice(root.length) : id.replace(/^\//, '');
      return pageByFile.has(rel) ? `${root}${rel}` : undefined;
    },
    load(id) {
      if (!id.startsWith(root)) return undefined;
      const page = pageByFile.get(id.slice(root.length));
      return page === undefined ? undefined : renderPage(page);
    },
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        const url = (req.url ?? '/').split('?')[0] ?? '/';
        if (!url.startsWith(BASE)) return next();
        let rel = decodeURIComponent(url.slice(BASE.length));
        if (rel === '' || rel.endsWith('/')) rel = `${rel}index.html`;
        const page = pageByFile.get(rel) ?? (rel.endsWith('.html') || !rel.includes('.') ? pageByFile.get('404.html') : undefined);
        if (page === undefined) return next();
        const htmlText = await server.transformIndexHtml(url, renderPage(page));
        res.statusCode = pageByFile.has(rel) ? 200 : 404;
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(htmlText);
      });
    },
  };
}

export default defineConfig({
  base: BASE,
  appType: 'mpa',
  plugins: [
    staticPages(),
    // Logical chunk names, sf-manifest.json, build report + budget check for the island chunks.
    staticflux({ chunks: islandChunks, budgets: { onViolation: 'warn', bootKb: 60 } }),
  ],
  resolve: {
    alias: [
      { find: /^@staticflux\/([^/]+)\/(.+)$/, replacement: `${packagesDir}/$1/src/$2.ts` },
      { find: /^@staticflux\/([^/]+)$/, replacement: `${packagesDir}/$1/src/index.ts` },
    ],
  },
  server: { fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] } },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    reportCompressedSize: true,
    rollupOptions: { input: [...pageByFile.keys()].map((file) => `${root}${file}`) },
  },
  publicDir: existsSync(`${root}public`) ? 'public' : false,
});
