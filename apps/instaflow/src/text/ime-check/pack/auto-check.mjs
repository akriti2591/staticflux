// Automated part of the IME check: drives a composition through Chrome's IME path (CDP) on both text inputs and checks
// what the page tells the OS, which is what the OS uses to place its candidate window. It cannot see the native
// candidate window itself; AGENT-PROMPT.md covers that part.
//
// Usage: npm install   (once; installs Playwright)   then   node auto-check.mjs
// Writes results/results.json and one screenshot per step to results/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { serve } from './serve.mjs';

const OUT = new URL('./results/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const { server, url } = await serve();
// Installed Chrome, headed (real GPU). CHANNEL=chromium HEADLESS=1 uses Playwright's own browser (smoke tests only).
const browser = await chromium.launch({
  channel: process.env.CHANNEL === 'chromium' ? undefined : 'chrome',
  headless: process.env.HEADLESS === '1',
  args: ['--enable-unsafe-webgpu', ...(process.env.HEADLESS === '1' ? ['--use-angle=swiftshader', '--enable-features=Vulkan'] : [])],
});
const results = { url, chrome: browser.version(), when: new Date().toISOString(), runs: [] };

const near = (a, b, tolerance = 6) => Math.abs(a - b) <= tolerance;
const inside = (r, box) => r.x >= box.x - 2 && r.y >= box.y - 2 && r.x + r.width <= box.x + box.width + 2 && r.y + r.height <= box.y + box.height + 2;

async function step(page, cdp, name, variant) {
  const before = await page.evaluate(() => window.__imeCheck.log.length);
  const host = await page.locator('#host').boundingBox();
  await page.mouse.click(host.x + host.width - 8, host.y + host.height - 8); // click near the end: caret goes to the nearest offset
  await cdp.send('Input.imeSetComposition', { text: 'にほんご', selectionStart: 4, selectionEnd: 4 });
  await page.waitForTimeout(250);
  const during = await page.evaluate((n) => window.__imeCheck.log.slice(n), before);
  const textarea = await page.evaluate(() => {
    const t = document.querySelector('#host textarea, textarea');
    if (!t) return undefined;
    const r = t.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  await cdp.send('Input.insertText', { text: '日本語' });
  await page.waitForTimeout(250);
  const after = await page.evaluate((n) => window.__imeCheck.log.slice(n), before);
  await page.locator('#stage').screenshot({ path: new URL(`${variant}-${name}.png`, OUT).pathname });

  const box = await page.locator('#stage').boundingBox();
  const charBounds = during.filter((e) => e.call === 'setCharacterBounds').flatMap((e) => e.args[1].map(([x, y, width, height]) => ({ x, y, width, height })));
  const selection = during.filter((e) => e.call === 'setSelectionBounds').map((e) => { const [x, y, width, height] = e.args[0]; return { x, y, width, height }; });
  const lastSel = selection.at(-1);
  const sawComposition = during.some((e) => typeof e.intent === 'string' && /compos/i.test(e.intent));
  const committed = after.some((e) => typeof e.text === 'string' && e.text.includes('日本語'));
  const problems = after.filter((e) => e.problem).map((e) => e.problem);
  const checks = {
    compositionReachedThePage: sawComposition,
    committedText: committed,
    characterBoundsReported: charBounds.length > 0,
    characterBoundsInsideTheBox: charBounds.length > 0 && charBounds.every((r) => inside(r, box)),
    caretBoundsInsideTheBox: lastSel !== undefined && inside(lastSel, box),
    // The hidden textarea is what the OS anchors the candidate window to in the fallback.
    textareaAtTheCaret: variant !== 'textarea' ? 'n/a' : textarea !== undefined && lastSel !== undefined && near(textarea.x, lastSel.x, 12) && near(textarea.y, lastSel.y, 12),
    noProblems: problems.length === 0,
  };
  const pass = Object.values(checks).every((v) => v === true || v === 'n/a');
  results.runs.push({ variant, step: name, pass, checks, lastCaret: lastSel, textarea, problems, log: after.slice(-30) });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${variant.padEnd(12)} ${name.padEnd(14)} ${pass ? '' : JSON.stringify(checks)}`);
}

for (const variant of ['editcontext', 'textarea']) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await page.goto(variant === 'textarea' ? `${url}?input=textarea` : url);
  await page.waitForFunction(() => /Ready|Failed/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 60_000 });
  const status = await page.locator('#status').textContent();
  if (/Failed/.test(status ?? '')) {
    results.runs.push({ variant, step: 'load', pass: false, status });
    console.log(`FAIL  ${variant} load: ${status}`);
    continue;
  }
  const cdp = await page.context().newCDPSession(page);
  await step(page, cdp, 'base', variant);
  await page.click('#wrap');
  await step(page, cdp, 'long-line', variant);
  await page.click('#arabic');
  await step(page, cdp, 'after-arabic', variant);
  // Browser zoom (Cmd/Ctrl +) changes the device pixel ratio; emulate 150 %. (CSS `zoom` is a different mechanism the app
  // never uses.) The real Cmd + is also in AGENT-PROMPT.md.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1.5, mobile: false });
  await page.waitForTimeout(300);
  await step(page, cdp, 'zoomed', variant);
  await page.close();
}

results.pass = results.runs.every((r) => r.pass);
writeFileSync(new URL('results.json', OUT), JSON.stringify(results, null, 2));
console.log(`\n${results.pass ? 'ALL PASS' : 'SOME FAILED'} — results/results.json`);
await browser.close();
server.close();
