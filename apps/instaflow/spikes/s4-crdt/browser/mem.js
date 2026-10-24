// Main-thread open for JS-heap measurement (workers expose no heap API in Chromium headless). One engine per page load.
import * as L from 'loro-crdt/web';
import * as Y from 'yjs';
import * as P from '../src/phases.js';
const engine = new URLSearchParams(location.search).get('engine') ?? 'loro';
const module = await WebAssembly.compileStreaming(fetch('/node_modules/loro-crdt/web/loro_wasm_bg.wasm'));
const exports = L.initSync({ module });
const env = {
  L, Y, reps: 2, now: () => performance.now(), gc: () => self.gc?.(),
  mem: () => ({ jsHeapMB: +(performance.memory.usedJSHeapSize / 2 ** 20).toFixed(1), wasmMB: +(exports.memory.buffer.byteLength / 2 ** 20).toFixed(1) }),
  gzip: async () => ({}), fixture: async (name) => new Uint8Array(await (await fetch('/fixtures/' + name)).arrayBuffer()),
};
try { window.__result = { engine, out: engine === 'loro' ? await P.openLoro(env) : await P.openYjs(env) }; }
catch (e) { window.__result = { error: String(e.stack ?? e) }; }
