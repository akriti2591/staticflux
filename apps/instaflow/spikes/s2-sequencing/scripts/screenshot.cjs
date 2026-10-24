// Visual check that frames drawn outside rAF (present=eager) actually reach the screen.
// Serves web/ with COOP/COEP (same headers and flags as ../_harness), runs a short script, screenshots mid-run.
//   NODE_PATH=/opt/node-tools/node_modules node scripts/screenshot.cjs '<query>' out.png [--real-gpu]
const http = require('http'), fs = require('fs'), path = require('path');
const [query = 'gestures=400&present=eager&eagerDelay=1&gfx=2d', outPng = 'results/shot.png', ...flags] = process.argv.slice(2);
const root = path.resolve(__dirname, '../web');
const port = 5800 + Math.floor(Math.random() * 100);
const server = http.createServer((req, res) => {
  const f = path.join(root, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
}).listen(port);
(async () => {
  const { chromium } = require('playwright');
  const sw = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  const browser = await chromium.launch({ headless: true, args: flags.includes('--real-gpu') ? ['--enable-unsafe-webgpu'] : sw });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://localhost:${port}/index.html?${query}`);
  await page.waitForTimeout(2500);
  const shots = [];
  for (let i = 0; i < 3; i++) { const b = await page.screenshot({ clip: { x: 0, y: 0, width: 1280, height: 720 } }); shots.push(b); await page.waitForTimeout(400); }
  fs.writeFileSync(outPng, shots[2]);
  const distinct = new Set(shots.map((b) => require('crypto').createHash('md5').update(b).digest('hex'))).size;
  await page.waitForFunction(() => window.__result !== undefined, null, { timeout: 120000 });
  const r = await page.evaluate(() => ({ pass: window.__result.correctness?.pass, draws: window.__result.correctness?.render.draws, eagerWakes: window.__result.correctness?.render.eagerWakes }));
  console.log(JSON.stringify({ query, distinctScreenshotsOf3: distinct, bytes: shots.map((b) => b.length), ...r }));
  await browser.close(); server.close();
})().catch((e) => { console.error(e); server.close(); process.exit(1); });
