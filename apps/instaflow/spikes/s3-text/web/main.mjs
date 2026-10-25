// Main thread: font blob registry stand-in, EditContext on a canvas, worker RPC, benchmarks.
import { arabic, devanagari } from '../test/corpus.mjs';

const qs = new URLSearchParams(location.search);
const FONT_FILES = ['NotoSans.ttf', 'NotoSansArabic.ttf', 'NotoSansDevanagari.ttf', 'NotoSansJP.ttf', 'NotoSansKR.ttf', 'NotoColorEmoji.ttf'];
const STACK = '"Noto Sans", "Noto Sans Arabic", "Noto Sans Devanagari", "Noto Sans JP", "Noto Sans KR", "Noto Color Emoji"';
const out = document.getElementById('out');
const result = { userAgent: navigator.userAgent, crossOriginIsolated, notes: 'timings are from a shared 4-core container; medians/p95 over repeated runs' };
const stats = (a) => { const s = [...a].sort((x, y) => x - y); const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]; return { n: s.length, median: +q(0.5).toFixed(3), p95: +q(0.95).toFixed(3), min: +s[0].toFixed(3), max: +s[s.length - 1].toFixed(3) }; };

// ---- worker RPC -------------------------------------------------------------------------------------
function spawn(variant) {
  const w = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
  let seq = 0;
  const pending = new Map();
  w.onmessage = (e) => { const p = pending.get(e.data.id); pending.delete(e.data.id); e.data.error ? p.rej(new Error(e.data.error)) : p.res(e.data); };
  const call = (op, msg = {}, transfer = []) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); w.postMessage({ id, op, ...msg }, transfer); });
  return { w, call, variant, wasmUrl: new URL(`./wasm/s3_text.${variant}.wasm`, import.meta.url).href };
}
async function fetchFonts() { return Promise.all(FONT_FILES.map(async (f) => (await fetch(`fonts/${f}`)).arrayBuffer())); }
async function startWorker(variant, fonts) {
  const t0 = performance.now();
  const wk = spawn(variant);
  const init = await wk.call('init', { wasmUrl: wk.wasmUrl });
  const tInit = performance.now() - t0;
  const copies = fonts.map((b) => b.slice(0));
  const tf = performance.now();
  const added = await wk.call('addFonts', { fonts: copies }, copies);
  const tFonts = performance.now() - tf;
  await wk.call('setFamily', { css: STACK });
  return { wk, init, tInit, added, tFonts };
}

// ---- rendering --------------------------------------------------------------------------------------
const pathCache = new Map();
const EMOJI_FONT = FONT_FILES.indexOf('NotoColorEmoji.ttf');
function absorbPaths(paths) { for (const [k, d] of Object.entries(paths ?? {})) pathCache.set(k, d ? new Path2D(d) : null); }
function drawLayout(ctx, L, ox, oy, color = '#111') {
  for (const line of L.lines) for (const run of line.runs) {
    const s = run.fontSize / 1000;
    for (const g of run.glyphs) {
      const p = pathCache.get(`${run.font}:${run.coords}:${g.id}`);
      if (p) { ctx.save(); ctx.translate(ox + g.x, oy + g.y); ctx.scale(s, s); ctx.fillStyle = color; ctx.fill(p); ctx.restore(); }
      else if (run.font === EMOJI_FONT) { // CBDT bitmap emoji: no outline; placeholder box (Vello would draw the bitmap)
        ctx.fillStyle = '#f5c518'; ctx.beginPath(); ctx.roundRect(ox + g.x + 1, oy + g.y - run.fontSize * 0.85, g.advance - 2, run.fontSize * 0.95, 4); ctx.fill();
      }
    }
  }
}

// ---- specimen ---------------------------------------------------------------------------------------
const SPECIMEN = [
  { t: 'The quick brown fox jumps over the lazy dog. Typography with “quotes”, ligatures fi fl, and wrapping.', align: 3, css: 'justify' },
  { t: 'اللغة العربية جميلة، وهذا نص طويل للتجربة يلتف على عدة أسطر.', align: 0, css: 'start' },
  { t: 'हिन्दी भाषा में संयुक्ताक्षर: क्ष त्र ज्ञ श्र, कर्म, प्रकाश, राष्ट्र।', align: 2, css: 'center' },
  { t: '日本語の文章は単語の間にスペースがありません。한국어 문장도 함께 테스트합니다.', align: 0, css: 'start' },
  { t: 'Mixed bidi: The word مرحبا means hello, and 123 stays LTR. هذا English في الوسط.', align: 0, css: 'start' },
  { t: 'Emoji 😀👍🏽 👨‍👩‍👧 🇯🇵 inline with text.', align: 1, css: 'end' },
];
async function specimen(wk) {
  const cv = document.getElementById('specimen'), ctx = cv.getContext('2d');
  const ref = document.getElementById('ref');
  ref.textContent = '';
  ctx.clearRect(0, 0, cv.width, cv.height);
  let y = 12;
  const runsInfo = [];
  for (const p of SPECIMEN) {
    const r = await wk.call('edit', { text: p.t, fontSize: 20, width: 456, align: p.align, selStart: 0, selEnd: 0 });
    absorbPaths(r.paths);
    drawLayout(ctx, r.layout, 12, y);
    ctx.strokeStyle = '#eee'; ctx.strokeRect(12, y, 456, r.layout.height);
    y += r.layout.height + 8;
    runsInfo.push({ text: p.t.slice(0, 24), lines: r.layout.lines.length, runs: r.layout.lines.map((l) => l.runs.map((x) => `${FONT_FILES[x.font]?.replace('.ttf', '') ?? x.font}${x.rtl ? '(rtl)' : ''}`).join(' | ')) });
    const el = document.createElement('p'); el.dir = 'auto'; el.style.textAlign = p.css; el.textContent = p.t; ref.appendChild(el);
  }
  return runsInfo;
}

// ---- EditContext editor -----------------------------------------------------------------------------
const PAD = 12, FS = 24, W = 640 - 2 * PAD;
const ed = { text: '', selStart: 0, selEnd: 0, comp: null, formats: [], layout: null, caret: null, selection: [], log: [], events: [], lastRoundTripMs: null };
window.__editor = ed;
function setupEditor(wk) {
  const cv = document.getElementById('editor'), ctx = cv.getContext('2d');
  if (!('EditContext' in window)) { ed.unsupported = true; return null; }
  const ec = new EditContext({ text: '', selectionStart: 0, selectionEnd: 0 });
  cv.editContext = ec;
  ed.ec = ec;
  const toClient = (r) => { const b = cv.getBoundingClientRect(); return new DOMRect(b.left + PAD + r.x0, b.top + PAD + r.y0, Math.max(1, r.x1 - r.x0), r.y1 - r.y0); };
  const logCall = (fn, args) => { ed.log.push({ fn, args }); if (ed.log.length > 200) ed.log.shift(); };
  let inflight = null, dirty = false;
  async function relayout() {
    if (inflight) { dirty = true; return inflight; }
    inflight = (async () => {
      do {
        dirty = false;
        const t0 = performance.now();
        const r = await wk.call('edit', { text: ed.text, fontSize: FS, width: W, selStart: ed.selStart, selEnd: ed.selEnd, charRange: ed.comp ? [ed.comp[0], ed.comp[1]] : null });
        ed.lastRoundTripMs = performance.now() - t0;
        absorbPaths(r.paths);
        Object.assign(ed, { layout: r.layout, caret: r.caret, selection: r.selection });
        const ctl = cv.getBoundingClientRect();
        ec.updateControlBounds(ctl); logCall('updateControlBounds', [ctl.toJSON()]);
        const sel = toClient(r.caret);
        ec.updateSelectionBounds(sel); logCall('updateSelectionBounds', [sel.toJSON()]);
        if (ed.comp && r.charBounds) {
          const rects = r.charBounds.map(toClient);
          ec.updateCharacterBounds(ed.comp[0], rects); logCall('updateCharacterBounds', [ed.comp[0], rects.map((x) => x.toJSON())]);
        }
        draw();
      } while (dirty);
      inflight = null;
    })();
    return inflight;
  }
  ed.relayout = relayout;
  function draw() {
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = 'rgba(74,124,255,0.25)';
    for (const r of ed.selection) ctx.fillRect(PAD + r.x0, PAD + r.y0, r.x1 - r.x0, r.y1 - r.y0);
    if (ed.layout) drawLayout(ctx, ed.layout, PAD, PAD);
    for (const f of ed.formats) { // composition underline from textformatupdate, positioned with Parley char bounds
      for (const r of ed.compRects ?? []) { ctx.fillStyle = '#333'; ctx.fillRect(PAD + r.x0, PAD + r.y1 - 2, r.x1 - r.x0, f.underlineThickness === 'thick' ? 2 : 1); }
    }
    if (ed.caret && document.activeElement === cv) { ctx.fillStyle = '#d00'; ctx.fillRect(PAD + ed.caret.x0, PAD + ed.caret.y0, Math.max(1.5, ed.caret.x1 - ed.caret.x0), ed.caret.y1 - ed.caret.y0); }
    document.getElementById('edstate').textContent = `text: ${JSON.stringify(ed.text)}\nselection: ${ed.selStart}..${ed.selEnd}  composition: ${JSON.stringify(ed.comp)}\nround trip: ${ed.lastRoundTripMs?.toFixed(2)} ms`;
  }
  ec.addEventListener('textupdate', (e) => {
    ed.events.push({ type: 'textupdate', start: e.updateRangeStart, end: e.updateRangeEnd, text: e.text, selStart: e.selectionStart, selEnd: e.selectionEnd });
    ed.text = ec.text; ed.selStart = e.selectionStart; ed.selEnd = e.selectionEnd;
    if (ed.composing) ed.comp = [e.updateRangeStart, e.updateRangeStart + e.text.length];
    relayout();
  });
  ec.addEventListener('compositionstart', () => { ed.composing = true; ed.events.push({ type: 'compositionstart' }); });
  ec.addEventListener('compositionend', () => { ed.composing = false; ed.comp = null; ed.formats = []; ed.events.push({ type: 'compositionend' }); relayout(); });
  ec.addEventListener('textformatupdate', (e) => {
    ed.formats = e.getTextFormats().map((f) => ({ rangeStart: f.rangeStart, rangeEnd: f.rangeEnd, underlineStyle: f.underlineStyle, underlineThickness: f.underlineThickness }));
    ed.events.push({ type: 'textformatupdate', formats: ed.formats });
  });
  ec.addEventListener('characterboundsupdate', async (e) => {
    ed.events.push({ type: 'characterboundsupdate', start: e.rangeStart, end: e.rangeEnd });
    const r = await wk.call('charBounds', { text: ed.text, fontSize: FS, width: W, start: e.rangeStart, end: e.rangeEnd });
    ed.compRects = r.rects;
    const rects = r.rects.map(toClient);
    ec.updateCharacterBounds(e.rangeStart, rects); logCall('updateCharacterBounds', [e.rangeStart, rects.map((x) => x.toJSON())]);
    draw();
  });
  const setSel = (a, b = a) => { ed.selStart = a; ed.selEnd = b; ec.updateSelection(a, b); relayout(); };
  cv.addEventListener('keydown', (e) => {
    if (ed.composing) return;
    const n = ed.text.length;
    const step = (i, d) => { let j = Math.max(0, Math.min(n, i + d)); if (j > 0 && j < n && (ed.text.charCodeAt(j) & 0xfc00) === 0xdc00) j += d; return j; };
    if (e.key === 'Enter') { e.preventDefault(); const a = Math.min(ed.selStart, ed.selEnd), b = Math.max(ed.selStart, ed.selEnd); ec.updateText(a, b, '\n'); ed.text = ec.text; setSel(a + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); setSel(step(ed.selEnd, -1)); } // logical movement (visual bidi movement: Parley Cursor::next_visual, not wired in the spike)
    else if (e.key === 'ArrowRight') { e.preventDefault(); setSel(step(ed.selEnd, 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setSel(0); }
    else if (e.key === 'End') { e.preventDefault(); setSel(n); }
  });
  cv.addEventListener('mousedown', async (e) => {
    const b = cv.getBoundingClientRect();
    const r = await wk.call('hitTest', { text: ed.text, fontSize: FS, width: W, x: e.clientX - b.left - PAD, y: e.clientY - b.top - PAD });
    setSel(r.index);
  });
  cv.addEventListener('focus', () => draw()); cv.addEventListener('blur', () => draw());
  relayout();
  return ec;
}

// ---- Local Font Access ------------------------------------------------------------------------------
async function localFontAccess(wk) {
  const r = { queryLocalFontsPresent: 'queryLocalFonts' in window, FontDataPresent: 'FontData' in window };
  try { r.permissionState = (await navigator.permissions.query({ name: 'local-fonts' })).state; } catch (e) { r.permissionState = `query failed: ${e.name}`; }
  if (!r.queryLocalFontsPresent) return r;
  try {
    const t0 = performance.now();
    const fonts = await window.queryLocalFonts();
    r.queryMs = +(performance.now() - t0).toFixed(1);
    r.fontCount = fonts.length;
    r.sample = fonts.slice(0, 5).map((f) => f.postscriptName);
    const pick = fonts.find((f) => f.postscriptName === 'DejaVuSans') ?? fonts.find((f) => /Regular$|^[A-Za-z]+$/.test(f.postscriptName)) ?? fonts[0];
    if (pick) {
      const t1 = performance.now();
      const buf = await (await pick.blob()).arrayBuffer();
      r.blobMs = +(performance.now() - t1).toFixed(1);
      const byteLength = buf.byteLength;
      const added = await wk.call('addFonts', { fonts: [buf] }, [buf]);
      r.picked = { postscriptName: pick.postscriptName, family: pick.family, bytes: byteLength, parleyFamilies: added.families[0].families };
      await wk.call('setFamily', { css: `"${added.families[0].families[0]}"` });
      const lay = await wk.call('edit', { text: 'Local font bytes → Parley', fontSize: 20, width: 0, selStart: 0, selEnd: 0 });
      r.picked.layoutFontIndex = lay.layout.lines[0]?.runs.map((x) => x.font);
      r.picked.expectedFontIndex = `>= ${FONT_FILES.length} (appended after bundled fonts)`;
      r.endToEnd = r.picked.layoutFontIndex?.every((i) => i >= FONT_FILES.length) ? 'PASS' : 'FAIL';
      await wk.call('setFamily', { css: STACK });
    }
  } catch (e) { r.error = `${e.name}: ${e.message}`; }
  return r;
}

// ---- benchmark corpus -------------------------------------------------------------------------------
function paragraphs(n) {
  const latin = 'Instaflow lays out rich text in a worker with Parley, which shapes with HarfRust and breaks lines with ICU4X. ';
  const cjk = '日本語の文章は単語の間にスペースがありません。中文文本也需要正确换行。한국어 문장도 함께 테스트합니다. ';
  const pools = [
    (i) => latin.repeat(2) + `#${i}`,
    (i) => arabic.slice(i % 30, (i % 30) + 6).join('، '),
    (i) => devanagari.slice(i % 30, (i % 30) + 6).join(' '),
    () => cjk,
    (i) => `${latin}${arabic[i % arabic.length]} ${devanagari[i % devanagari.length]} 😀 ${cjk.slice(0, 20)}`,
  ];
  return Array.from({ length: n }, (_, i) => pools[i % pools.length](i));
}

// ---- run --------------------------------------------------------------------------------------------
async function main() {
  const tf = performance.now();
  const fonts = await fetchFonts();
  result.fonts = { files: FONT_FILES, totalBytes: fonts.reduce((a, b) => a + b.byteLength, 0), fetchMs: +(performance.now() - tf).toFixed(1) };

  // primary worker (outlines build, so the canvas can draw glyphs)
  const main = await startWorker(qs.get('v') ?? 'outlines', fonts);
  result.primary = { variant: main.wk.variant, workerReadyMs: +main.tInit.toFixed(1), init: main.init, addFontsMsInWorker: +main.added.ms.toFixed(1), addFontsRoundTripMs: +main.tFonts.toFixed(1), families: main.added.families.map((f) => f.families) };
  result.primary.init = { ...main.init, warmInstantiateMs: stats(main.init.warmInstantiateMs) };
  const ec = setupEditor(main.wk);
  result.editContext = { present: 'EditContext' in window, attached: !!ec };
  result.specimen = await specimen(main.wk);

  // caret <-> hit-test round trip over every index of mixed-script paragraphs
  const rt = [];
  for (const p of SPECIMEN) rt.push({ text: p.t.slice(0, 20), ...(await main.wk.call('caretRoundTrip', { text: p.t, len: p.t.length, fontSize: 20, width: 456, align: p.align })) });
  result.caretHitTest = { perParagraph: rt.map(({ text, total, exact, samePlace }) => ({ text, total, exact, samePlace })), totals: rt.reduce((a, r) => ({ total: a.total + r.total, exact: a.exact + r.exact, samePlace: a.samePlace + r.samePlace }), { total: 0, exact: 0, samePlace: 0 }), samplesBad: rt.flatMap((r) => r.bad).slice(0, 5) };

  // worker round trip: edit intent -> layout -> caret/selection/char bounds -> back (includes structured clone)
  const para = `${SPECIMEN[0].t} ${SPECIMEN[1].t}`;
  const ping = [], edit = [], wl = [], wt = [];
  for (let i = 0; i < 30; i++) await main.wk.call('edit', { text: para, fontSize: 20, width: 456, selStart: 5, selEnd: 5 });
  for (let i = 0; i < 300; i++) { const t = performance.now(); await main.wk.call('ping'); ping.push(performance.now() - t); }
  for (let i = 0; i < 300; i++) {
    const text = para.slice(0, para.length - (i % 7)); // vary the text like typing
    const t = performance.now();
    const r = await main.wk.call('edit', { text, fontSize: 20, width: 456, selStart: text.length, selEnd: text.length, charRange: [Math.max(0, text.length - 4), text.length] });
    edit.push(performance.now() - t); wl.push(r.workerLayoutMs); wt.push(r.workerTotalMs);
  }
  result.roundTrip = { paragraphChars: para.length, pingMs: stats(ping), editRoundTripMs: stats(edit), workerLayoutMs: stats(wl), workerLayoutPlusGeometryMs: stats(wt) };

  // 1k paragraphs, per variant (fresh worker per variant for size/instantiate comparison)
  const paras = paragraphs(1000);
  result.bench = { paragraphs: paras.length, avgChars: Math.round(paras.reduce((a, p) => a + p.length, 0) / paras.length), width: 360, variants: {} };
  for (const v of ['base', 'complex', 'outlines']) {
    const s = v === main.wk.variant ? main : await startWorker(v, fonts);
    const noDump = await s.wk.call('bench', { paragraphs: paras, width: 360, reps: 7, dump: false });
    const dump = await s.wk.call('bench', { paragraphs: paras, width: 360, reps: 5, dump: true });
    result.bench.variants[v] = { wasmBytes: s.init.wasmBytes, compileMs: +s.init.compileMs.toFixed(1), firstInstantiateMs: +s.init.instantiateMs.toFixed(2), warmInstantiateMs: stats(s.init.warmInstantiateMs), workerReadyMs: +s.tInit.toFixed(1), layout1kMs: stats(noDump.runs.slice(1)), layout1kWithGlyphDumpMs: stats(dump.runs.slice(1)), firstRunMs: +noDump.runs[0].toFixed(1), lines: noDump.lines };
    if (s !== main) s.wk.w.terminate();
  }

  result.localFontAccess = await localFontAccess(main.wk); // without a user gesture
  document.getElementById('lfa').onclick = async () => { // with a user gesture
    window.__lfa = await localFontAccess(main.wk);
    document.getElementById('lfaout').textContent = JSON.stringify(window.__lfa);
    await specimen(main.wk); // re-draw (family stack restored)
  };
  out.textContent = JSON.stringify(result, null, 2);
  window.__result = result;
}
main().catch((e) => { out.textContent = String(e.stack ?? e); window.__result = { error: String(e.stack ?? e) }; });
