// Bundle sizes (raw / gzip -9 / brotli q11) of loro-crdt (web build) and yjs.
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sz = (buf) => ({ rawKB: +(buf.length / 1024).toFixed(1), gzKB: +(zlib.gzipSync(buf, { level: 9 }).length / 1024).toFixed(1), brKB: +(zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length / 1024).toFixed(1) });
const bundle = async (code) => (await build({ stdin: { contents: code, resolveDir: root, loader: 'js' }, bundle: true, minify: true, format: 'esm', write: false, external: ['*.wasm'] })).outputFiles[0].contents;
const pkg = (n) => JSON.parse(fs.readFileSync(path.join(root, 'node_modules', n, 'package.json'))).version;
export async function sizes() {
  return {
    versions: { 'loro-crdt': pkg('loro-crdt'), yjs: pkg('yjs') },
    loroWasm: sz(fs.readFileSync(path.join(root, 'node_modules/loro-crdt/web/loro_wasm_bg.wasm'))),
    loroGlueMinified: sz(Buffer.from(await bundle("export * from 'loro-crdt/web';"))),
    yjsMinified: sz(Buffer.from(await bundle("export * from 'yjs';"))),
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await sizes(), null, 2));
