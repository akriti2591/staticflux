// Module worker running one phase (bundled by build.mjs into dist/worker.js).
import * as L from 'loro-crdt/web';
import * as Y from 'yjs';
import * as P from '../src/phases.js';

const WASM_URL = '/node_modules/loro-crdt/web/loro_wasm_bg.wasm';
const GLUE_URL = '/node_modules/loro-crdt/web/loro_wasm.js';
let pendingMem;

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.type === 'memdone') { pendingMem?.(msg.value); return; }
  if (msg.type !== 'run') return;
  try {
    const boot = {};
    let t = performance.now();
    let module = msg.module;
    if (!module) {
      if (msg.streaming) module = await WebAssembly.compileStreaming(fetch(WASM_URL));
      else { const bytes = await (await fetch(WASM_URL)).arrayBuffer(); boot.fetchMs = performance.now() - t; t = performance.now(); module = await WebAssembly.compile(bytes); }
      boot.compileMs = performance.now() - t;
    }
    t = performance.now();
    const exports = L.initSync({ module });
    const d = new L.LoroDoc(); d.free();
    boot.instantiateMs = performance.now() - t;
    if (msg.phase === 'boot') { self.postMessage({ type: 'result', out: { boot } }); return; }
    if (msg.phase === 'fresh-glue') {
      const warm = [];
      for (let i = 0; i < 10; i++) {
        const g = await import(/* @vite-ignore */ `${GLUE_URL}?fresh=${i}`);
        const a = performance.now(); g.initSync({ module }); const doc = new g.LoroDoc(); warm.push(performance.now() - a); doc.free();
      }
      self.postMessage({ type: 'result', out: { boot, warmInstantiateFromCompiledModuleMs: warm } });
      return;
    }
    const env = {
      L, Y, reps: msg.reps ?? 5, checkpoints: msg.checkpoints, milestone: msg.milestone,
      now: () => performance.now(),
      log: (...a) => self.postMessage({ type: 'log', text: a.join(' ') }),
      gc: () => self.gc?.(),
      mem: () => ({ jsHeapMB: self.performance.memory ? +(performance.memory.usedJSHeapSize / 2 ** 20).toFixed(1) : null, wasmMB: +(exports.memory.buffer.byteLength / 2 ** 20).toFixed(1) }),
      extraMem: (label) => new Promise((res) => { pendingMem = res; self.postMessage({ type: 'mem', label }); }),
      gzip: async (b) => ({ deflateRaw: (await new Response(new Blob([b]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer()).byteLength }),
      fixture: async (name) => new Uint8Array(await (await fetch('/fixtures/' + name)).arrayBuffer()),
    };
    let out;
    if (msg.phase === 'open-loro') out = await P.openLoro(env);
    else if (msg.phase === 'open-yjs') out = await P.openYjs(env);
    else if (msg.phase === 'perf') out = await P.perf(env, msg.only);
    else if (msg.phase === 'merge1') out = await P.mergeOne(env, msg.kind, msg.N);
    else if (msg.phase === 'correctness') out = P.correctness(env);
    self.postMessage({ type: 'result', out: { boot, out } });
  } catch (e) {
    self.postMessage({ type: 'error', error: String(e?.stack ?? e) });
  }
};
