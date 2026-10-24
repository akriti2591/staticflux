// Repeats index.html (probe, CAS, fault injection, milestones, .iflow, GC) R times in fresh browsers,
// saves each run, and checks the exported .iflow with external zip tools (unzip -t, python zipfile).
//   NODE_PATH=/opt/node-tools/node_modules node run-bench.cjs [--runs=3] [--iters=20] [--gcRuns=5] [--backends=sync,async] [--headed]
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const RUNS = Number(arg('runs', 3)), ITERS = arg('iters', '20'), GCR = arg('gcRuns', '5'), BACKENDS = arg('backends', 'sync,async');

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '../_harness/serve-and-run.cjs'), __dirname, 'index.html', '--serve-only']);
  const base = await new Promise((res) => srv.stdout.on('data', (d) => { const m = /at (http:\/\/\S+)\/index\.html/.exec(String(d)); if (m) res(m[1]); }));
  const dir = path.join(__dirname, 'results'); fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < RUNS; i++) {
    const browser = await chromium.launch({ headless: !process.argv.includes('--headed') });
    const page = await (await browser.newContext()).newPage();
    page.on('console', (m) => { if (m.type() === 'error') console.error(`[page] ${m.text()}`); });
    await page.goto(`${base}/index.html?backends=${BACKENDS}&iters=${ITERS}&gcRuns=${GCR}&bundle=1`);
    await page.waitForFunction(() => window.__result !== undefined, null, { timeout: 1800e3, polling: 500 });
    const result = await page.evaluate(() => window.__result);
    const b64 = await page.evaluate(() => window.__bundle);
    if (b64) {
      const f = path.join(dir, 'sample.iflow'); fs.writeFileSync(f, Buffer.from(b64, 'base64'));
      const ext = {};
      try { ext.unzipT = execFileSync('unzip', ['-tq', f]).toString().trim(); } catch (e) { ext.unzipT = `FAIL ${e.stdout}`; }
      try { ext.pythonZipfile = execFileSync('python3', ['-I', '-c', 'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);print(z.testzip() or "ok", len(z.namelist()), z.namelist()[0], z.getinfo("mimetype").compress_type)', f]).toString().trim(); } catch (e) { ext.pythonZipfile = `FAIL ${e}`; }
      result.externalZipCheck = ext;
    }
    fs.writeFileSync(path.join(dir, `bench-run${i + 1}.json`), JSON.stringify(result, null, 2));
    console.error(`run ${i + 1}/${RUNS} done${result.error ? ' ERROR ' + result.error : ''}`);
    await browser.close();
  }
  srv.kill();
})().catch((e) => { console.error(e); process.exit(1); });
