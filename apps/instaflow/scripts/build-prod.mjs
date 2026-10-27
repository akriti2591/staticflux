// Production build for local performance testing (no obfuscation):
// 1. vite build -c prod/vite.config.ts → dist-prod (minified, hidden source maps);
// 2. copy the runtime assets the pages load by URL (engine Wasm + manifest, bundled fonts, brand icons);
// 3. precompress every text/Wasm file ≥ 1 KB as .br (quality 11) and .gz (level 9);
// 4. print brotli totals for the Home and Studio entries.
// Run the root `pnpm build` first (it builds apps/instaflow/engine/dist).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const app = fileURLToPath(new URL('..', import.meta.url));
const out = join(app, 'dist-prod');

if (!existsSync(join(app, 'engine/dist/sf-wasm-manifest.json'))) {
  console.error('Missing engine/dist/sf-wasm-manifest.json — run the root `pnpm build` first (it builds the Wasm).');
  process.exit(1);
}

execFileSync('pnpm', ['exec', 'vite', 'build', '-c', 'prod/vite.config.ts'], { cwd: app, stdio: 'inherit' });

for (const dir of ['engine/dist', 'test/fonts', 'brand']) cpSync(join(app, dir), join(out, dir), { recursive: true });

const COMPRESSIBLE = /\.(js|mjs|css|html|json|svg|wasm|ttf|otf|webmanifest|map|txt)$/;
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else files.push(path);
  }
};
walk(out);

let raw = 0;
let br = 0;
for (const path of files) {
  if (!COMPRESSIBLE.test(path) || path.endsWith('.map')) continue;
  const bytes = readFileSync(path);
  if (bytes.length < 1024) continue;
  const b = brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } });
  writeFileSync(`${path}.br`, b);
  writeFileSync(`${path}.gz`, gzipSync(bytes, { level: 9 }));
  raw += bytes.length;
  br += b.length;
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`\nPrecompressed ${files.length} files: ${kb(raw)} raw → ${kb(br)} brotli.`);
const assets = files.filter((f) => /\/assets\/.*\.js$/.test(f) && !f.endsWith('.map'));
const sizes = assets
  .map((f) => ({ file: relative(out, f), br: existsSync(`${f}.br`) ? statSync(`${f}.br`).size : statSync(f).size }))
  .sort((a, b) => b.br - a.br)
  .slice(0, 12);
console.log('Largest JS chunks (brotli):');
for (const s of sizes) console.log(`  ${kb(s.br).padStart(9)}  ${s.file}`);
console.log('\nServe it: pnpm --filter @instaflow/app preview:prod');
