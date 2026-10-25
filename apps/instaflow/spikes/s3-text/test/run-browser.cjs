// Drives index.html in Chromium: waits for the page's automatic measurements, then exercises the EditContext
// editor with real keyboard input (Playwright) and IME composition (CDP Input.imeSetComposition), and
// checks the bounds the page handed to EditContext. Serves the folder with the shared harness (--serve-only).
//   NODE_PATH=/opt/node-tools/node_modules node test/run-browser.cjs [--headed] [--real-gpu] [--no-lfa-grant]
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const flags = process.argv.slice(2);

function serve() {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [path.join(root, '../_harness/serve-and-run.cjs'), root, 'index.html', '--serve-only'], { stdio: ['ignore', 'pipe', 'inherit'] });
    p.stdout.on('data', (d) => { const m = /at (http\S+)/.exec(String(d)); if (m) res({ p, url: m[1] }); });
    p.on('exit', (c) => rej(new Error(`server exited ${c}`)));
  });
}

(async () => {
  const { p: server, url } = await serve();
  const swiftshader = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface'];
  const browser = await chromium.launch({ headless: !flags.includes('--headed'), args: flags.includes('--real-gpu') ? [] : swiftshader });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text()); });
  const cdp = await context.newCDPSession(page);
  const origin = new URL(url).origin;
  let lfaGrant = 'skipped';
  if (!flags.includes('--no-lfa-grant')) {
    try { await context.grantPermissions(['local-fonts'], { origin }); lfaGrant = "granted via Playwright context.grantPermissions(['local-fonts'])"; } catch (e) { lfaGrant = `CDP grant failed: ${e.message}`; }
  }
  await page.goto(url);
  await page.waitForFunction(() => window.__result !== undefined, null, { timeout: 600000, polling: 500 });
  const pageResult = await page.evaluate(() => window.__result);
  if (pageResult.error) { console.error(pageResult.error); process.exit(1); }
  pageResult.localFontAccess.grant = lfaGrant;
  // Local Font Access with a real (Playwright) click = transient user activation
  await page.click('#lfa');
  pageResult.localFontAccessWithClick = await page.waitForFunction(() => window.__lfa, null, { timeout: 60000 }).then((h) => h.jsonValue()).catch((e) => ({ error: String(e) }));
  await page.screenshot({ path: path.join(root, 'results/page.png'), fullPage: true });
  await page.locator('#specimen').screenshot({ path: path.join(root, 'results/specimen-parley.png') });
  await page.locator('#ref').screenshot({ path: path.join(root, 'results/specimen-chrome-dom.png') });

  // ---------------------------------------------------------------- EditContext tests
  const ed = {};
  const state = () => page.evaluate(() => { const e = window.__editor; return { text: e.text, selStart: e.selStart, selEnd: e.selEnd, comp: e.comp, caret: e.caret, formats: e.formats, ecText: e.ec?.text, lines: e.layout?.lines.length, log: e.log.slice(-6), events: e.events.slice(-8), rt: e.lastRoundTripMs }; });
  const settle = () => page.evaluate(async () => { for (let i = 0; i < 3; i++) { await window.__editor.relayout(); await new Promise((r) => setTimeout(r, 20)); } });
  const box = await page.locator('#editor').boundingBox();
  await page.locator('#editor').click({ position: { x: 20, y: 20 } });
  await page.waitForFunction(() => document.activeElement?.id === 'editor');

  // 1. typing (keydown/keypress -> EditContext beforeinput -> textupdate)
  await page.keyboard.type('Hello ');
  await settle();
  let s = await state();
  ed.typeLatin = { pass: s.text === 'Hello ' && s.selEnd === 6, text: s.text, caret: s.caret };

  // 2. insertText of complex scripts (what an IME commit or paste-like input produces)
  await page.keyboard.insertText('مرحبا ');
  await page.keyboard.insertText('नमस्ते ');
  await page.keyboard.insertText('😀');
  await settle();
  s = await state();
  const expect2 = 'Hello مرحبا नमस्ते 😀';
  ed.insertTextComplex = { pass: s.text === expect2 && s.selEnd === expect2.length, text: s.text, selEnd: s.selEnd, caret: s.caret };

  // 3. Backspace handled by EditContext (deleteContentBackward) — removes the surrogate pair as one unit?
  await page.keyboard.press('Backspace');
  await settle();
  s = await state();
  ed.backspaceEmoji = { pass: s.text === 'Hello مرحبا नमस्ते ', text: s.text, note: 'EditContext deletes the whole surrogate pair' };

  // 4. Caret geometry vs. what was given to updateSelectionBounds (client coords = canvas origin + pad + layout)
  const lastSel = s.log.filter((l) => l.fn === 'updateSelectionBounds').pop();
  ed.selectionBoundsMatchCaret = lastSel ? { pass: Math.abs(lastSel.args[0].x - (box.x + 12 + s.caret.x0)) < 1 && Math.abs(lastSel.args[0].y - (box.y + 12 + s.caret.y0)) < 1, given: lastSel.args[0], caretLayout: s.caret, canvasBox: box } : { pass: false, note: 'no updateSelectionBounds call' };

  // 5. IME composition via CDP (Japanese: かな -> 漢字 conversion), candidate positioning data
  await page.keyboard.press('End');
  const before = (await state()).text;
  await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 });
  await cdp.send('Input.imeSetComposition', { text: 'にほんご', selectionStart: 4, selectionEnd: 4 });
  await settle();
  const mid = await state();
  await cdp.send('Input.imeSetComposition', { text: '日本語', selectionStart: 3, selectionEnd: 3 });
  await settle();
  const conv = await state();
  const charBoundsCall = conv.log.filter((l) => l.fn === 'updateCharacterBounds').pop();
  await cdp.send('Input.insertText', { text: '日本語' }); // commit
  await settle();
  const committed = await state();
  ed.imeJapanese = {
    pass: mid.text === `${before}にほんご` && conv.text === `${before}日本語` && committed.text === `${before}日本語` && !committed.comp && !!charBoundsCall && charBoundsCall.args[1].length === 3,
    duringComposition: { text: mid.text, comp: mid.comp, formats: mid.formats },
    afterConversion: { text: conv.text, comp: conv.comp },
    updateCharacterBounds: charBoundsCall?.args,
    committed: committed.text,
    events: committed.events.map((e) => e.type),
  };
  // character bounds should sit left-to-right, contiguous, on the caret line
  if (charBoundsCall) {
    const r = charBoundsCall.args[1];
    ed.imeJapanese.boundsMonotonic = r.every((x, i) => i === 0 || Math.abs(x.x - (r[i - 1].x + r[i - 1].width)) < 1);
    ed.imeJapanese.boundsInsideCanvas = r.every((x) => x.x >= box.x && x.x + x.width <= box.x + box.width + 1 && x.y >= box.y && x.y + x.height <= box.y + box.height + 1);
  }

  // 6. Korean (Hangul syllable composition: ㅎ -> 하 -> 한) and Chinese (pinyin -> 中文)
  const b6 = (await state()).text;
  for (const t of ['ㅎ', '하', '한']) await cdp.send('Input.imeSetComposition', { text: t, selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.insertText', { text: '한' });
  for (const t of ['z', 'zh', 'zhong', 'zhongwen', '中文']) await cdp.send('Input.imeSetComposition', { text: t, selectionStart: t.length, selectionEnd: t.length });
  await cdp.send('Input.insertText', { text: '中文' });
  await settle();
  s = await state();
  ed.imeKoreanChinese = { pass: s.text === `${b6}한中文`, text: s.text };

  // 7. Click hit test: click on the first glyph's right half -> caret index 1
  await page.mouse.click(box.x + 12 + 2, box.y + 12 + 14);
  await settle();
  s = await state();
  ed.clickHitTest = { pass: s.selEnd === 0 || s.selEnd === 1, selEnd: s.selEnd };

  // 8. Enter key -> new line
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Line 2');
  await settle();
  s = await state();
  ed.enterNewLine = { pass: s.text.endsWith('\nLine 2') && s.lines >= 2, lines: s.lines };
  ed.lastEditRoundTripMs = s.rt;

  // 9. Arabic composition (RTL) char bounds: rects should run right-to-left
  await cdp.send('Input.imeSetComposition', { text: 'سلام', selectionStart: 4, selectionEnd: 4 });
  await settle();
  s = await state();
  const arCall = s.log.filter((l) => l.fn === 'updateCharacterBounds').pop();
  const ar = arCall?.args[1] ?? [];
  ed.imeArabicRtlBounds = { pass: ar.length === 4 && ar.every((x, i) => i === 0 || x.x <= ar[i - 1].x + 0.5), rects: ar.map((r) => [+r.x.toFixed(1), +r.width.toFixed(1)]) };
  await cdp.send('Input.insertText', { text: 'سلام' });
  await settle();

  await page.locator('#editor').screenshot({ path: path.join(root, 'results/editor.png') });
  const all = { page: pageResult, editContext: ed };
  fs.writeFileSync(path.join(root, 'results/browser.json'), JSON.stringify(all, null, 2));
  console.log(JSON.stringify(all, null, 2));
  await browser.close();
  server.kill();
})().catch((e) => { console.error(e); process.exit(1); });
