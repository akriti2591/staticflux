// Downloads the spike's models into ../models (gitignored), verifies SHA-256, then (optionally) builds the
// fp16 / int8 variants with a local Python venv (.tools/venv). Cross-platform (macOS/Linux), Node >= 18.
//   node scripts/setup.mjs            # download + convert
//   node scripts/setup.mjs --no-convert
// Sources are the upstream release assets (see README §Licensing). Hugging Face was not reachable from the
// spike container, so these are the GitHub-release ONNX exports.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const models = join(root, 'models');
mkdirSync(models, { recursive: true });

const BRN = 'https://github.com/ZhengPeng7/BiRefNet/releases/download/v1';
const REMBG = 'https://github.com/danielgatis/rembg/releases/download/v0.0.0';
const FILES = [
  ['birefnet_lite_fp32.onnx', `${BRN}/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx`, '5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333'],
  ['birefnet_portrait_fp32.onnx', `${BRN}/BiRefNet-portrait-epoch_150.onnx`, '1ba1c8ff5a7bbfadc8d8d13fb11d7be793f91f23d9d466549e37a854f6668f99'],
  ['u2netp.onnx', `${REMBG}/u2netp.onnx`, '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8'],
  ['u2net_human_seg.onnx', `${REMBG}/u2net_human_seg.onnx`, '01eb6a29a5c4d8edb30b56adad9bb3a2a0535338e480724a213e0acfd2d1c73c'],
  ['selfie_segmenter_f16.tflite', 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite', '191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b'],
];
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

for (const [name, url, hash] of FILES) {
  const dst = join(models, name);
  if (existsSync(dst) && sha(dst) === hash) { console.log(`ok   ${name}`); continue; }
  console.log(`get  ${name} <- ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  writeFileSync(dst, Buffer.from(await res.arrayBuffer()));
  const got = sha(dst);
  if (got !== hash) console.warn(`WARN ${name}: sha256 ${got} != expected ${hash} (upstream changed?)`);
}

// MODNet int8 (Xenova/modnet export) from the npm re-host `sts-rmbg-modnet@1.0.0` (HF unreachable from the spike box).
const modnet = join(models, 'modnet_int8.onnx');
if (!existsSync(modnet)) {
  const tmp = mkdtempSync(join(tmpdir(), 's9-modnet-'));
  execFileSync('npm', ['pack', 'sts-rmbg-modnet@1.0.0', '--ignore-scripts', '--pack-destination', tmp], { stdio: 'inherit' });
  execFileSync('tar', ['xzf', join(tmp, 'sts-rmbg-modnet-1.0.0.tgz'), '-C', tmp]);
  renameSync(join(tmp, 'package/models/Xenova/modnet/onnx/model_quantized.onnx'), modnet);
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`ok   modnet_int8.onnx sha256 ${sha(modnet)} (expected 92e49898c3e05a6d7a944fc67a8cb87c4aad754ffb6ebd949528c7d1105fee3a)`);

// Optional (needs Hugging Face, unreachable from the spike container): MODNet fp32 export for WebGPU
// (the int8 dynamic-quant export runs its integer ops on CPU under the WebGPU EP).
const modnet32 = join(models, 'modnet_fp32.onnx');
if (!existsSync(modnet32)) {
  try {
    const res = await fetch('https://huggingface.co/Xenova/modnet/resolve/main/onnx/model.onnx', { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(modnet32, Buffer.from(await res.arrayBuffer()));
    console.log(`ok   modnet_fp32.onnx sha256 ${sha(modnet32)} (unpinned; record it in the README)`);
  } catch (e) { console.warn(`skip modnet_fp32.onnx (optional): ${e.message}`); }
}

if (process.argv.includes('--no-convert')) process.exit(0);
// fp16 / int8 variants (needs python3; ~3 min, ~2 GB RAM peak for the portrait model)
const venv = join(root, '.tools/venv'), py = join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
try {
  if (!existsSync(py)) {
    execFileSync('python3', ['-m', 'venv', venv], { stdio: 'inherit' });
    execFileSync(py, ['-m', 'pip', 'install', '-q', 'onnx', 'onnxruntime', 'onnxconverter-common'], { stdio: 'inherit' });
  }
  const conv = (args) => execFileSync(py, ['-I', join(root, 'scripts', args[0]), ...args.slice(1)], { cwd: models, stdio: ['ignore', 'inherit', 'ignore'] });
  // WebGPU-safe rewrite (Split/Concat with > 7 tensors -> Slices / Concat tree; bit-exact) then fp16
  const wgs = (src, dst) => { if (!existsSync(join(models, dst))) conv(['webgpu_safe.py', src, dst]); };
  wgs('birefnet_lite_fp32.onnx', 'birefnet_lite_wgs_fp32.onnx');
  wgs('birefnet_portrait_fp32.onnx', 'birefnet_portrait_wgs_fp32.onnx');
  if (!existsSync(join(models, 'birefnet_lite_wgs_fp16.onnx'))) conv(['convert.py', 'birefnet_lite_wgs_fp32.onnx', 'birefnet_lite_wgs', 'fp16']);
  if (!existsSync(join(models, 'birefnet_portrait_wgs_fp16.onnx'))) conv(['convert.py', 'birefnet_portrait_wgs_fp32.onnx', 'birefnet_portrait_wgs', 'fp16']);
  if (!existsSync(join(models, 'birefnet_lite_int8.onnx'))) { conv(['quant.py', 'birefnet_lite_fp32.onnx', 'birefnet_lite_int8.onnx']); rmSync(join(models, 'birefnet_lite_int8.onnx.pre.onnx'), { force: true }); }
  if (!existsSync(join(models, 'u2netp_fp16.onnx'))) conv(['convert.py', 'u2netp.onnx', 'u2netp', 'fp16']);
  console.log('conversions done');
} catch (e) {
  console.warn(`conversion skipped (${e.message}); fp32 / int8-MODNet runs still work`);
}
