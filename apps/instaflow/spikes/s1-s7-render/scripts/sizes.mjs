// Wasm/JS sizes: raw, gzip -9, brotli q11 (Node zlib) — same method as research/03 §2.2.
//   build/raw/*.cargo.wasm      = cargo output (still contains wasm-bindgen descriptor sections!)
//   build/bindgen/*_bg.wasm     = after wasm-bindgen (what a bundler would ship without wasm-opt)
//   build/bindgen/*_bg.opt.wasm = after wasm-opt (-Oz for size variants, -O3 for speed variants)
import fs from 'node:fs';
import zlib from 'node:zlib';
const kb = (n) => +(n / 1024).toFixed(1);
const measure = (f) => {
  const b = fs.readFileSync(f);
  return {
    file: f,
    raw_kb: kb(b.length),
    gzip_kb: kb(zlib.gzipSync(b, { level: 9 }).length),
    brotli_kb: kb(zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: b.length } }).length),
  };
};
const ls = (d, re) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => re.test(f)).sort().map((f) => `${d}/${f}`) : []);
const files = [
  ...ls('build/raw', /\.wasm$/),
  ...ls('build/bindgen', /\.(wasm|js)$/),
  ...ls('build/pdf', /\.wasm$/),
  'node_modules/canvaskit-wasm/bin/canvaskit.wasm',
  'node_modules/canvaskit-wasm/bin/canvaskit.js',
  'node_modules/canvaskit-wasm/bin/full/canvaskit.wasm',
].filter((f) => fs.existsSync(f));
const rows = files.map(measure);
console.table(rows);
let ck = null;
try { ck = JSON.parse(fs.readFileSync('node_modules/canvaskit-wasm/package.json', 'utf8')).version; } catch {}
fs.mkdirSync('results', { recursive: true });
fs.writeFileSync('results/sizes.json', JSON.stringify({ canvaskit_version: ck, rows }, null, 2));
