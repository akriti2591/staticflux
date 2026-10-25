/**
 * S9 runner = the shared harness (_harness/serve-and-run.cjs: same COOP/COEP server + same Chromium flags) plus:
 *  - streams the page log to stdout (progress for long ML runs)
 *  - samples peak RSS of the Chromium process tree from /proc (Linux only; includes the GPU process, where
 *    SwiftShader keeps "GPU" buffers) and writes results/<name>.json
 *
 *   node scripts/run.cjs '<query>' [--name=x] [--timeout=s] [--real-gpu] [--headed] [--chrome] [--serve-only] [--port=n]
 *   --chrome = drive the installed Google Chrome (channel 'chrome') instead of Playwright's Chromium
 *   e.g. node scripts/run.cjs 'preset=cloud' --name=cloud
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const query = args.find((a) => !a.startsWith('--')) ?? 'preset=owner';
const flag = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const name = flag('name', 'run'), timeout = Number(flag('timeout', 3600)) * 1000;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.onnx': 'application/octet-stream', '.tflite': 'application/octet-stream' };
const port = Number(flag('port', 5200 + Math.floor(Math.random() * 500)));

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const file = path.join(root, url === '/' ? 'web/index.html' : url);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'content-length': fs.statSync(file).size, 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(port);
const url = `http://localhost:${port}/web/index.html${query ? '?' + query : ''}`;
if (args.includes('--serve-only')) { console.log(`serving ${root}\n  buttons:  http://localhost:${port}/web/index.html\n  auto-run: http://localhost:${port}/web/index.html?preset=owner\n  (Ctrl+C to stop)`); return; }

function treeRssMB(pid) { // sum RSS of pid + descendants
  let total = 0; const kids = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try { const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8'); const ppid = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]); if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(Number(d)); } catch {}
  }
  const per = {};
  const walk = (p) => {
    try {
      const s = fs.readFileSync(`/proc/${p}/status`, 'utf8'); const kb = Number((s.match(/VmRSS:\s+(\d+)/) ?? [0, 0])[1]); total += kb;
      const cmd = fs.readFileSync(`/proc/${p}/cmdline`, 'utf8'); const type = (cmd.match(/--type=([a-z-]+)/) ?? [0, 'browser'])[1]; per[type] = (per[type] ?? 0) + kb / 1024;
    } catch {}
    for (const k of kids.get(p) ?? []) walk(k);
  };
  for (const k of kids.get(pid) ?? []) walk(k); // exclude the node runner itself
  return { total: total / 1024, per };
}

(async () => {
  const { chromium } = require('playwright');
  const swiftshader = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  const launchArgs = args.includes('--real-gpu') ? ['--enable-unsafe-webgpu'] : swiftshader;
  const browser = await chromium.launch({ ...(args.includes('--chrome') && { channel: 'chrome' }), headless: !args.includes('--headed'), args: [...launchArgs, '--js-flags=--expose-gc', '--enable-precise-memory-info'] });
  let peak = { total: 0 }; const samples = [];
  const page = await (await browser.newContext()).newPage();
  page.on('console', (m) => { const t = m.text(); if (m.type() === 'log' || m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}] ${t.length > 600 ? t.slice(0, 600) + '…' : t}`); });
  page.on('pageerror', (e) => console.log(`[page error] ${e.message}`));
  page.on('crash', () => console.log(`[page CRASHED] renderer crashed; peak tree RSS so far ${Math.round(peak.total)} MB ${JSON.stringify(peak.per)}`));
  const bpid = process.pid; // walk our own descendants (Chromium is spawned by Playwright under this node process)
  const timer = bpid && fs.existsSync('/proc') ? setInterval(() => { const r = treeRssMB(bpid); samples.push({ t: Date.now(), mb: Math.round(r.total) }); if (r.total > peak.total) peak = r; }, 500) : null;
  console.log(`open ${url}`);
  await page.goto(url);
  await page.waitForFunction(() => window.__result !== undefined, null, { timeout, polling: 500 });
  const result = await page.evaluate(() => window.__result);
  if (timer) clearInterval(timer);
  result.processMemory = timer ? { peakTotalMB: Math.round(peak.total), peakByProcessTypeMB: Object.fromEntries(Object.entries(peak.per ?? {}).map(([k, v]) => [k, Math.round(v)])), note: 'Chromium tree RSS from /proc (Linux); with SwiftShader the GPU process RSS includes "GPU" memory' } : 'unavailable (not Linux)';
  fs.mkdirSync(path.join(root, 'results'), { recursive: true });
  const out = path.join(root, 'results', `${name}.json`);
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(`wrote ${out}`);
  if (args.includes('--screenshot')) { const png = path.join(root, 'results', `${name}.png`); await page.screenshot({ path: png, fullPage: true }); console.log(`wrote ${png}`); }
  await browser.close(); server.close();
})().catch((e) => { console.error(e); server.close(); process.exit(1); });
