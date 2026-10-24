// Thin JS wrapper over the hand-written Wasm ABI in wasm/src/lib.rs. Works in a worker and in Node.
const enc = new TextEncoder();
const dec = new TextDecoder();

export async function createEngine(wasmBytesOrModule) {
  const t0 = performance.now();
  const module = wasmBytesOrModule instanceof WebAssembly.Module ? wasmBytesOrModule : await WebAssembly.compile(wasmBytesOrModule);
  const t1 = performance.now();
  const instance = await WebAssembly.instantiate(module, {});
  const t2 = performance.now();
  const x = instance.exports;

  const put = (bytes) => {
    const p = x.alloc(bytes.length);
    new Uint8Array(x.memory.buffer, p, bytes.length).set(bytes);
    return p;
  };
  const out = () => new Float32Array(x.memory.buffer, x.out_ptr(), x.out_len()).slice();
  const str = () => dec.decode(new Uint8Array(x.memory.buffer, x.str_ptr(), x.str_len()));

  return {
    compileMs: t1 - t0,
    instantiateMs: t2 - t1,
    addFont(bytes) {
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const faces = x.add_font(put(u8), u8.length);
      return { faces, families: str().split('\n').filter(Boolean) };
    },
    setFamily(css) { const b = enc.encode(css); x.set_family(put(b), b.length); },
    /** align: 0 start 1 end 2 center 3 justify 4 left 5 right; width<=0: no wrap */
    layout(text, { fontSize = 16, width = 0, align = 0, dump = true } = {}) {
      const b = enc.encode(text);
      const lines = x.layout(put(b), b.length, fontSize, width, align, dump ? 1 : 0);
      return dump ? parseLayout(out()) : { lines };
    },
    hitTest(px, py) { x.hit_test(px, py); const o = out(); return { index: o[0], affinity: o[1] ? 'upstream' : 'downstream' }; },
    caretRect(index, upstream = false, caretWidth = 1.5) { x.caret_rect(index, upstream ? 1 : 0, caretWidth); const [x0, y0, x1, y1] = out(); return { x0, y0, x1, y1 }; },
    selectionRects(a, b) { x.selection_rects(a, b); const o = out(); const r = []; for (let i = 0; i < o[0]; i++) { const k = 1 + i * 4; r.push({ x0: o[k], y0: o[k + 1], x1: o[k + 2], y1: o[k + 3] }); } return r; },
    charBounds(a, b) { x.char_bounds(a, b); const o = out(); const r = []; for (let k = 0; k < o.length; k += 4) r.push({ x0: o[k], y0: o[k + 1], x1: o[k + 2], y1: o[k + 3] }); return r; },
    glyphPath: x.glyph_path ? (font, glyph, size, coords = 0) => (x.glyph_path(font, glyph, size, coords) ? str() : '') : null,
  };
}

export function parseLayout(o) {
  let i = 0;
  const L = { width: o[i++], height: o[i++], lines: [] };
  const n = o[i++];
  for (let l = 0; l < n; l++) {
    const line = { baseline: o[i++], lineHeight: o[i++], top: o[i++], bottom: o[i++], offset: o[i++], advance: o[i++], start: o[i++], end: o[i++], runs: [] };
    const nr = o[i++];
    for (let r = 0; r < nr; r++) {
      const run = { font: o[i++], coords: o[i++], fontSize: o[i++], rtl: !!o[i++], start: o[i++], end: o[i++], glyphs: [] };
      const ng = o[i++];
      for (let g = 0; g < ng; g++) run.glyphs.push({ id: o[i++], x: o[i++], y: o[i++], advance: o[i++] });
      line.runs.push(run);
    }
    L.lines.push(line);
  }
  return L;
}
