// Authoring-worker stand-in: owns the Parley Wasm engine. Main sends font bytes (transferred) and edit intents;
// the worker lays out and returns glyph runs, caret/selection/character geometry.
import { createEngine } from './engine.mjs';

let eng = null;
let module = null;
const sentGlyphs = new Set();

const reply = (id, payload, transfer = []) => postMessage({ id, ...payload }, transfer);

function layoutAndGeometry(m) {
  const t0 = performance.now();
  const L = eng.layout(m.text, { fontSize: m.fontSize, width: m.width, align: m.align ?? 0 });
  const tLayout = performance.now() - t0;
  const a = Math.min(m.selStart, m.selEnd), b = Math.max(m.selStart, m.selEnd);
  const caret = eng.caretRect(m.selEnd, false, 1.5);
  const selection = a === b ? [] : eng.selectionRects(a, b);
  const cb = m.charRange ? eng.charBounds(m.charRange[0], m.charRange[1]) : null;
  // ship outlines for glyphs main has not seen yet
  const paths = {};
  if (eng.glyphPath) for (const line of L.lines) for (const run of line.runs) for (const g of run.glyphs) {
    const k = `${run.font}:${run.coords}:${g.id}`;
    if (!sentGlyphs.has(k)) { sentGlyphs.add(k); paths[k] = eng.glyphPath(run.font, g.id, 1000, run.coords); }
  }
  return { layout: L, caret, selection, charBounds: cb, paths, workerLayoutMs: tLayout, workerTotalMs: performance.now() - t0 };
}

onmessage = async (e) => {
  const m = e.data;
  try {
    switch (m.op) {
      case 'init': {
        const t0 = performance.now();
        const bytes = await (await fetch(m.wasmUrl)).arrayBuffer();
        const tFetch = performance.now() - t0;
        eng = await createEngine(bytes);
        module = await WebAssembly.compile(bytes);
        // warm re-instantiation timings (module cached, fresh instance each time)
        const inst = [];
        for (let i = 0; i < 15; i++) { const t = performance.now(); await WebAssembly.instantiate(module, {}); inst.push(performance.now() - t); }
        reply(m.id, { fetchMs: tFetch, compileMs: eng.compileMs, instantiateMs: eng.instantiateMs, warmInstantiateMs: inst, wasmBytes: bytes.byteLength });
        break;
      }
      case 'addFonts': {
        const t0 = performance.now();
        const fams = m.fonts.map((b) => eng.addFont(new Uint8Array(b)));
        reply(m.id, { families: fams, ms: performance.now() - t0 });
        break;
      }
      case 'setFamily': eng.setFamily(m.css); reply(m.id, {}); break;
      case 'edit': reply(m.id, layoutAndGeometry(m)); break;
      case 'hitTest': {
        eng.layout(m.text, { fontSize: m.fontSize, width: m.width, align: m.align ?? 0, dump: false });
        reply(m.id, eng.hitTest(m.x, m.y));
        break;
      }
      case 'charBounds': {
        eng.layout(m.text, { fontSize: m.fontSize, width: m.width, align: m.align ?? 0, dump: false });
        reply(m.id, { rects: eng.charBounds(m.start, m.end) });
        break;
      }
      case 'caretRoundTrip': {
        // For every caret index: caret rect -> hit test at rect centre -> index. Counts exact and
        // "same visual position" matches (bidi boundaries have 2 logical indices at one x).
        eng.layout(m.text, { fontSize: m.fontSize, width: m.width, align: m.align ?? 0, dump: false });
        const n = m.len;
        let exact = 0, samePlace = 0, total = 0;
        const bad = [];
        for (let i = 0; i <= n; i++) {
          if (i > 0 && i < n && (m.text.charCodeAt(i) & 0xfc00) === 0xdc00) continue; // inside surrogate pair
          const r = eng.caretRect(i, false, 1);
          const hit = eng.hitTest((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2);
          const r2 = eng.caretRect(hit.index, hit.affinity === 'upstream', 1);
          total++;
          if (hit.index === i) exact++;
          if (hit.index === i || (Math.abs(r2.x0 - r.x0) < 0.5 && Math.abs(r2.y0 - r.y0) < 0.5)) samePlace++;
          else if (bad.length < 5) bad.push({ i, got: hit.index, r, r2 });
        }
        reply(m.id, { total, exact, samePlace, bad });
        break;
      }
      case 'bench': {
        // m.paragraphs: string[]; lay out each as its own Layout, `reps` times
        const runs = [];
        let lines = 0;
        for (let r = 0; r < m.reps; r++) {
          const t0 = performance.now();
          lines = 0;
          for (const p of m.paragraphs) { const res = eng.layout(p, { fontSize: 16, width: m.width, align: 0, dump: m.dump }); lines += typeof res.lines === 'number' ? res.lines : res.lines.length; }
          runs.push(performance.now() - t0);
        }
        reply(m.id, { runs, lines });
        break;
      }
      case 'ping': reply(m.id, { t: performance.now() }); break;
      default: reply(m.id, { error: `unknown op ${m.op}` });
    }
  } catch (err) {
    reply(m.id, { error: String(err?.stack ?? err) });
  }
};
