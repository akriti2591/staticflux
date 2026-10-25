// Static server for the Instaflow IME check. No dependencies. Usage: node serve.mjs   (Ctrl+C stops it)
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('./web/', import.meta.url)));
const port = Number(process.env.PORT ?? 4174);
export const PAGE = '/apps/instaflow/src/text/ime-check/index.html';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.otf': 'font/otf', '.css': 'text/css' };

export function serve() {
  return new Promise((done) => {
    const server = createServer((req, res) => {
      const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname));
      const file = join(root, path === '/' ? PAGE : path);
      if (!file.startsWith(root)) return void res.writeHead(403).end();
      try {
        if (!statSync(file).isFile()) throw new Error('not a file');
      } catch {
        return void res.writeHead(404).end('not found');
      }
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      createReadStream(file).pipe(res);
    });
    server.listen(port, '127.0.0.1', () => done({ server, url: `http://localhost:${port}${PAGE}` }));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { url } = await serve();
  console.log(`IME check: ${url}\nHidden-textarea variant: ${url}?input=textarea`);
}
