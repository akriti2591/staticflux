// Wasm/JS sizes: raw, gzip -9, brotli q11 (Node zlib) — same method as research/03 §2.2.
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
const kb = (n) => +(n / 1024).toFixed(1);
const measure = (f) => {
  const b = fs.readFileSync(f);
  return { file: f, raw_kb: kb(b.length), gzip_kb: kb(zlib.gzipSync(b, { level: 9 }).length), brotli_kb: kb(zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: b.length } }).length) };
};
const files = [
  'build/raw/gpu.cargo.wasm', 'build/bindgen/gpu_bg.wasm', 'build/bindgen/gpu_bg.opt.wasm', 'build/bindgen/gpu.js',
  'build/raw/gpu_text.cargo.wasm',
  'build/raw/cpu.cargo.wasm', 'build/bindgen/cpu_bg.wasm', 'build/bindgen/cpu_bg.opt.wasm', 'build/bindgen/cpu.js',
  'build/raw/pdf.cargo.wasm', 'build/raw/pdf.opt.wasm',
  'node_modules/canvaskit-wasm/bin/canvaskit.wasm', 'node_modules/canvaskit-wasm/bin/canvaskit.js',
  'node_modules/canvaskit-wasm/bin/full/canvaskit.wasm',
].filter((f) => fs.existsSync(f));
const rows = files.map(measure);
console.table(rows);
let ck = null;
try { ck = JSON.parse(fs.readFileSync('node_modules/canvaskit-wasm/package.json', 'utf8')).version; } catch {}
fs.mkdirSync('results', { recursive: true });
fs.writeFileSync('results/sizes.json', JSON.stringify({ canvaskit_version: ck, rows }, null, 2));
