// One benchmark phase in a fresh Node process: node --expose-gc node/bench.mjs <phase>
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const wasmPath = path.join(root, 'node_modules/loro-crdt/web/loro_wasm_bg.wasm');
const gluePath = path.join(root, 'node_modules/loro-crdt/web/loro_wasm.js');
const phase = process.argv[2];

const t0 = performance.now();
const L = await import(pathToFileURL(path.join(root, 'node_modules/loro-crdt/web/index.js')).href);
const bytes = fs.readFileSync(wasmPath);
const t1 = performance.now();
const module = new WebAssembly.Module(bytes);
const t2 = performance.now();
const exports = L.initSync({ module });
const t3 = performance.now();
const boot = { importGlueMs: t1 - t0, compileMs: t2 - t1, instantiateMs: t3 - t2 };
const Y = await import('yjs');
const P = await import('../src/phases.js');

const env = {
  L, Y, reps: Number(process.env.REPS ?? 5),
  now: () => performance.now(),
  gc: () => globalThis.gc?.(),
  mem: () => { const m = process.memoryUsage(); return { jsHeapMB: +(m.heapUsed / 2 ** 20).toFixed(1), externalMB: +(m.external / 2 ** 20).toFixed(1), rssMB: +(m.rss / 2 ** 20).toFixed(1), wasmMB: +(exports.memory.buffer.byteLength / 2 ** 20).toFixed(1) }; },
  gzip: async (b) => ({ deflateRaw: zlib.deflateRawSync(b).byteLength }),
  fixture: async (name) => new Uint8Array(fs.readFileSync(path.join(root, 'fixtures', name))),
};

let out;
if (phase === 'fixtures') {
  const f = P.makeFixtures(L, Y);
  for (const [k, v] of Object.entries(f)) fs.writeFileSync(path.join(root, 'fixtures', k), v);
  out = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.byteLength]));
} else if (phase === 'instantiate') {
  const warm = [];
  for (let i = 0; i < 10; i++) {
    const g = await import(pathToFileURL(gluePath).href + '?fresh=' + i);
    const a = performance.now(); g.initSync({ module }); const d = new g.LoroDoc(); warm.push(performance.now() - a); d.free();
  }
  out = { boot, warmInstantiateFromCompiledModuleMs: warm };
} else if (phase === 'open-loro') out = await P.openLoro(env);
else if (phase === 'open-yjs') out = await P.openYjs(env);
else if (phase === 'perf') out = await P.perf(env, process.argv[3]?.split(','));
else if (phase === 'correctness') out = P.correctness(env);
else throw new Error('unknown phase ' + phase);
process.stdout.write(JSON.stringify({ phase, boot, out }));
