// Human IME check page (B2). Plain ESM over the built dist files (see index.html); not part of the build or the tests.
// Pipeline: TextInput (variant-bound) → text session → Parley layout (authoring text Wasm) → scene IR → Vello (render
// Wasm, headless region) → canvas. The caret, selection and composition underline are drawn on an overlay.
import { createInjector } from '@staticflux/core';
import { browserEnv, readWebApis } from '@staticflux/platform';
import { TextInputFactoryToken, textInputBindings } from '@staticflux/surface/text-input';
import { loadRenderModule } from '/apps/instaflow/dist/render/render-module.js';
import { createSceneWriter } from '/apps/instaflow/dist/render/scene-ir.js';
import { createVelloRasterBackend } from '/apps/instaflow/dist/render/vello-backend.js';
import { loadAuthoringModule } from '/apps/instaflow/dist/text/authoring-module.js';
import { encodeLayoutSpec, familyList } from '/apps/instaflow/dist/text/layout-spec.js';
import { createTextLayoutEngine } from '/apps/instaflow/dist/text/text-engine.js';
import { createSceneFontTable, textSceneNodes } from '/apps/instaflow/dist/text/text-scene.js';
import { createTextSession } from '/apps/instaflow/dist/text/text-session.js';

const MANIFEST = '/apps/instaflow/engine/dist/sf-wasm-manifest.json';
const FONTS = '/apps/instaflow/test/fonts/';
const PAD = 16;
const W = 640;
const H = 320;
const status = document.getElementById('status');
const logView = document.getElementById('log');
const host = document.getElementById('host');
const ink = document.getElementById('ink').getContext('2d');
const overlay = document.getElementById('overlay').getContext('2d');
const log = [];
window.__imeCheck = { log };
const note = (entry) => {
  log.push({ t: Math.round(performance.now()), ...entry });
  logView.textContent = log.slice(-40).map((e) => JSON.stringify(e)).join('\n');
};
const must = (r, what) => {
  if (!r.ok) throw new Error(`${what}: ${r.error.code} ${r.error.message}`);
  return r.value;
};
const sha256 = async (bytes) => `sha256:${[...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;

async function main() {
  const render = must(await loadRenderModule({ manifestUrl: MANIFEST }), 'render wasm');
  const authoring = must(await loadAuthoringModule({ manifestUrl: MANIFEST }), 'authoring text wasm');
  const engine = createTextLayoutEngine({ wasm: authoring, loadComplex: (signal) => loadAuthoringModule({ manifestUrl: MANIFEST, build: 'complex', signal }) });
  const bytesByHash = new Map();
  const register = async (bytes) => {
    const hash = await sha256(bytes);
    bytesByHash.set(hash, bytes);
    return must(engine.registerFont(hash, bytes), 'register font');
  };
  for (const file of ['NotoSans-Latin.wght.ttf', 'NotoSansArabic.wght.ttf', 'NotoSansDevanagari.wght.ttf', 'NotoSansThai.wght.ttf']) {
    await register(new Uint8Array(await (await fetch(FONTS + file)).arrayBuffer()));
  }
  must(engine.setFallbacks('Arab', ['Noto Sans Arabic']), 'fallback');
  must(engine.setFallbacks('Deva', ['Noto Sans Devanagari']), 'fallback');
  must(engine.setFallbacks('Thai', ['Noto Sans Thai']), 'fallback');
  must(engine.setGeneric('sans-serif', ['Noto Sans']), 'generic');
  let families = ['Noto Sans', 'Noto Sans Arabic', 'Noto Sans Devanagari'];

  const backend = createVelloRasterBackend({ wasm: render, width: W, height: H, id: 'ime-check' });
  must(await backend.attach({ signal: new AbortController().signal }), 'GPU attach (needs WebGPU)');
  must(backend.resize(W, H), 'resize');
  const fonts = createSceneFontTable();

  // The document: one text element, as plain text (this page checks input and IME placement, not the CRDT).
  let text = 'Type here: ';
  const block = () => {
    const paragraphs = [];
    let start = 0;
    for (const [index, part] of text.split('\n').entries()) {
      paragraphs.push({ index, start, end: start + part.length, text: part, style: {}, runs: [{ start, end: start + part.length, style: {} }] });
      start += part.length + 1;
    }
    return { node: 't', text, paragraphs };
  };
  const target = {
    read: () => ({ ok: true, value: block() }),
    commit(ops) {
      for (const op of ops) {
        if (op.op === 'text.insert') text = text.slice(0, op.at) + op.text + text.slice(op.at);
        if (op.op === 'text.delete') text = text.slice(0, op.from) + text.slice(op.to);
      }
      return { ok: true, value: undefined };
    },
  };
  const layoutOf = (model) => {
    const css = familyList(families);
    const spec = encodeLayoutSpec({ width: W - 2 * PAD, paragraphs: model.paragraphs.map((p) => ({ text: p.text, spans: [{ start: 0, end: p.text.length, family: css, size: 28 }] })) });
    return engine.layout(1, spec, model.text);
  };

  // TextInput: the platform fact picks the implementation (variant binding); ?input=textarea forces the fallback.
  const forceTextarea = new URLSearchParams(location.search).get('input') === 'textarea';
  const injector = createInjector({ units: textInputBindings({ editContext: () => readWebApis(browserEnv()).editContext && !forceTextarea }) });
  const factory = must(await injector.get(TextInputFactoryToken), 'text input factory');
  const input = must(factory.create({ host, label: 'Text under test' }), 'text input');
  document.getElementById('input-kind').textContent = `TextInput: ${input.kind}`;
  for (const name of ['setSelectionBounds', 'setCharacterBounds', 'setControlBounds']) {
    const original = input[name].bind(input);
    input[name] = (...args) => {
      note({ call: name, args: name === 'setCharacterBounds' ? [args[0], args[1].map((r) => [r.x, r.y, r.width, r.height].map(Math.round))] : [[args[0].x, args[0].y, args[0].width, args[0].height].map(Math.round)] });
      original(...args);
    };
  }
  input.onIntent((intent) => note({ intent: intent.kind, ...(intent.text === undefined ? {} : { text: intent.text }), ...(intent.range === undefined ? {} : { range: intent.range }) }));
  const toClient = (r) => {
    const box = host.getBoundingClientRect();
    return { x: box.left + PAD + r.x0, y: box.top + PAD + r.y0, width: Math.max(1, r.x1 - r.x0), height: r.y1 - r.y0 };
  };
  const session = must(createTextSession({ input, target, engine, blockId: 1, layout: layoutOf, toClient, onProblem: (e) => note({ problem: e.code, message: e.message }) }), 'session');

  let pending = false;
  const draw = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(async () => {
      pending = false;
      const { layout, composition, anchor, focus } = session.state;
      if (layout === undefined) return;
      const w = createSceneWriter();
      w.clear();
      fonts.resnapshot();
      for (const run of layout.runs()) {
        const hash = engine.fontOf(run.font)?.hash;
        if (hash !== undefined) fonts.ensure(w, hash, () => bytesByHash.get(hash));
      }
      let next = 2;
      const nodes = textSceneNodes(layout, { id: 1, transform: [1, 0, 0, 1, PAD, PAD], brushes: [{ color: [27, 27, 34, 255] }], fontId: (id) => fonts.idFor(engine.fontOf(id).hash), nextId: () => next++ });
      for (const n of nodes) w.upsert(n);
      must(backend.apply(w.finish()), 'apply');
      const image = must(await backend.renderRegion({ world: { x0: 0, y0: 0, x1: W, y1: H }, width: W, height: H, background: [1, 1, 1, 1] }, { signal: new AbortController().signal }), 'render');
      ink.putImageData(new ImageData(new Uint8ClampedArray(image.data), W, H), 0, 0);
      overlay.clearRect(0, 0, W, H);
      const [a, b] = [Math.min(anchor, focus.offset), Math.max(anchor, focus.offset)];
      overlay.fillStyle = 'rgba(59, 108, 255, 0.25)';
      for (const r of a === b ? [] : must(engine.selectionRects(1, a, b), 'selection')) overlay.fillRect(PAD + r.x0, PAD + r.y0, r.x1 - r.x0, r.y1 - r.y0);
      overlay.fillStyle = '#d0021b';
      if (composition !== undefined && composition.text.length > 0) {
        for (const r of must(engine.charBounds(1, composition.from, composition.from + composition.text.length), 'composition')) overlay.fillRect(PAD + r.x0, PAD + r.y1 - 2, r.x1 - r.x0, 2);
      }
      const caret = must(engine.caret(1, composition === undefined ? focus : { offset: composition.from + composition.text.length, upstream: false }, 2), 'caret');
      overlay.fillRect(PAD + caret.x0, PAD + caret.y0, 2, caret.y1 - caret.y0);
    });
  };
  session.onChange(draw);
  host.addEventListener('pointerdown', (e) => {
    const box = host.getBoundingClientRect();
    const hit = engine.hitTest(1, e.clientX - box.left - PAD, e.clientY - box.top - PAD);
    if (hit.ok) session.select(hit.value.offset, hit.value.offset);
    input.focus();
    e.preventDefault();
  });
  document.getElementById('arabic').addEventListener('click', () => {
    const [a] = session.selection;
    target.commit([{ op: 'text.insert', at: a, text: 'مرحبا ' }]);
    session.refresh();
    session.select(a + 6, a + 6);
    input.focus();
  });
  document.getElementById('wrap').addEventListener('click', () => {
    text += ' The quick brown fox jumps over the lazy dog, again and again.';
    session.refresh();
    session.select(text.length, text.length);
    input.focus();
  });
  document.getElementById('local').addEventListener('click', async () => {
    if (typeof window.queryLocalFonts !== 'function') return note({ problem: 'Local Font Access is not available here' });
    try {
      const all = await window.queryLocalFonts();
      const cjk = all.filter((f) => /(Noto Sans (CJK|JP|SC|TC|KR))|Hiragino|PingFang|Apple SD Gothic|Yu Gothic|Meiryo|Microsoft YaHei|Malgun|MS Gothic|Source Han/i.test(f.family) && /regular|w3|normal/i.test(f.style));
      const picked = [];
      for (const face of cjk.slice(0, 6)) {
        const r = await register(new Uint8Array(await (await face.blob()).arrayBuffer()));
        picked.push(...r.families);
      }
      const names = [...new Set(picked)];
      for (const script of ['Hani', 'Hira', 'Kana', 'Hang']) engine.setFallbacks(script, names);
      families = [...families, ...names];
      note({ localFonts: names });
      session.refresh();
    } catch (e) {
      note({ problem: String(e?.message ?? e) });
    }
  });
  draw();
  input.focus();
  status.textContent = `Ready (${input.kind}). Click the box and type with your OS IME.`;
}

main().catch((e) => {
  status.textContent = `Failed: ${e?.message ?? e}`;
  note({ problem: String(e?.stack ?? e) });
});
