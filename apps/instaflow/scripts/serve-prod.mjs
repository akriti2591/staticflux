// Local production server for dist-prod (scripts/build-prod.mjs): serves precompressed .br / .gz by Accept-Encoding,
// the cross-origin isolation headers the workers need (IF-2.8: COOP + COEP, SharedArrayBuffer rings), the surface
// routes (same rewrites as the dev server), application/wasm, and long caching for hashed assets.
// Usage: pnpm --filter @instaflow/app preview:prod   (PORT=4174 by default) → http://127.0.0.1:4174/
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dist-prod', import.meta.url));
const port = Number(process.env.PORT ?? 4174);

if (!existsSync(join(root, 'dev/studio/index.html'))) {
  console.error('dist-prod is missing — run `pnpm --filter @instaflow/app build:prod` first.');
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
};

/** The dev server's surface routes (dev/studio/vite.config.ts): Home pages and Studio routes map to their pages. */
function route(path) {
  if (path === '/' || /^\/(files|templates|trash|settings(\/[^/]+)?|p\/[^/]+)\/?$/.test(path)) return '/dev/home/index.html';
  if (/^\/(s\/[^/]+(\/d\/[^/]+)?|new)\/?$/.test(path)) return '/dev/studio/index.html';
  return path;
}

createServer((req, res) => {
  const [rawPath = '/'] = (req.url ?? '/').split('?');
  const path = route(decodeURIComponent(rawPath));
  const file = normalize(join(root, path));
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }
  const accept = String(req.headers['accept-encoding'] ?? '');
  let served = file;
  const headers = {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Vary': 'Accept-Encoding',
    'Cache-Control': /\/assets\//.test(path) || /\.[0-9a-f]{8,}\./.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
  if (/\bbr\b/.test(accept) && existsSync(`${file}.br`)) {
    served = `${file}.br`;
    headers['Content-Encoding'] = 'br';
  } else if (/\bgzip\b/.test(accept) && existsSync(`${file}.gz`)) {
    served = `${file}.gz`;
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = statSync(served).size;
  res.writeHead(200, headers);
  createReadStream(served).pipe(res);
}).listen(port, '127.0.0.1', () => {
  console.log(`Instaflow (production build) on http://127.0.0.1:${port}/  — Home at /, Studio via New design or /new`);
});
