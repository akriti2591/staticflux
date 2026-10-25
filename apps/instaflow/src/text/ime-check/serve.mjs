// Serve-only static server for the human IME check page (B2). No dependencies.
// Usage (repo root): pnpm ime-check   (builds, then serves; already built: node apps/instaflow/src/text/ime-check/serve.mjs)
// Then open the printed URL in desktop Chrome. Ctrl+C stops it. Serves the repo read-only on localhost.
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../../../../', import.meta.url)));
const port = Number(process.env.PORT ?? 4174);
const PAGE = '/apps/instaflow/src/text/ime-check/index.html';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.otf': 'font/otf', '.css': 'text/css', '.map': 'application/json' };

createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname));
  const file = join(root, path === '/' ? PAGE : path);
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if (!statSync(file).isFile()) throw new Error('not a file');
  } catch {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => {
  console.log(`IME check: http://localhost:${port}${PAGE}  (hidden-textarea variant: add ?input=textarea)`);
});
