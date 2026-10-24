/**
 * Shared Phase 0 harness: serves a spike directory with cross-origin isolation
 * (COOP/COEP, so SharedArrayBuffer/OPFS/WebGPU/WebCodecs are available) and runs
 * a page in Chromium, printing the JSON result the page posts to window.__result.
 *
 *   node ../_harness/serve-and-run.cjs <dir> <page.html> [--timeout=300] [--headed] [--real-gpu]
 *
 * In this cloud container WebGPU runs on SwiftShader (CPU): correctness is real,
 * GPU timings are NOT representative. On your machine use --real-gpu (no SwiftShader
 * flags) or just open the printed URL in Chrome and read the on-page results.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.css': 'text/css', '.mp4': 'video/mp4', '.webm': 'video/webm', '.png': 'image/png', '.onnx': 'application/octet-stream', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };

const [dir, page = 'index.html', ...flags] = process.argv.slice(2);
if (!dir) { console.error('usage: serve-and-run.cjs <dir> [page.html] [--timeout=s] [--headed] [--real-gpu] [--serve-only]'); process.exit(2); }
const root = path.resolve(dir);
const timeout = Number((flags.find((f) => f.startsWith('--timeout=')) ?? '--timeout=300').split('=')[1]) * 1000;
const port = 5200 + Math.floor(Math.random() * 500);

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  let file = path.join(root, url === '/' ? page : url);
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  // allow ../node_modules for spikes that npm-install locally
  if (!fs.existsSync(file)) { res.writeHead(404).end('not found'); return; }
  if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'cache-control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}).listen(port);

const url = `http://localhost:${port}/${page}`;
if (flags.includes('--serve-only')) { console.log(`serving ${root} at ${url} (Ctrl+C to stop)`); return; }

(async () => {
  const { chromium } = require('playwright');
  // S1 change vs _harness: WebGPU *canvas presentation* loses the device (reason 'destroyed') unless the
  // compositor has a working GL: add ANGLE-on-SwiftShader. Without these two flags any getCurrentTexture()+submit kills the device.
  const swiftshader = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  const args = flags.includes('--real-gpu') ? ['--enable-unsafe-webgpu'] : swiftshader;
  const browser = await chromium.launch({ headless: !flags.includes('--headed'), args: [...args, '--js-flags=--expose-gc', '--enable-precise-memory-info'] });
  const context = await browser.newContext();
  const pageHandle = await context.newPage();
  pageHandle.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.error(`[page ${m.type()}] ${m.text()}`); });
  pageHandle.on('pageerror', (e) => console.error(`[page error] ${e.message}`));
  await pageHandle.goto(url);
  await pageHandle.waitForFunction(() => window.__result !== undefined, null, { timeout, polling: 250 });
  const result = await pageHandle.evaluate(() => window.__result);
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  server.close();
})().catch((e) => { console.error(e); server.close(); process.exit(1); });
