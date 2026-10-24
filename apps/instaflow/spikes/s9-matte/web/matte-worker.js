// S9 ML worker: ONNX Runtime Web (WebGPU EP or WASM EP) matte inference + temporal smoothing.
// Spike code — one model session per worker. Messages:
//   {type:'load', model, ep, threads}          -> {type:'loaded', ...timings}
//   {type:'frame', bitmap, index, smooth}      -> {type:'matte', raw, smoothed, timings}  (Uint8 alpha, 1280x720)
//   {type:'reset'}                             -> clears temporal state
import * as ort from '../node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs';
import { createSmoother } from './smooth.js';
import { upsample, toU8 } from './post.js';

ort.env.wasm.wasmPaths = new URL('../node_modules/onnxruntime-web/dist/', import.meta.url).href;

let session = null;
let spec = null; // { inW, inH, mean, std, sigmoid, minmax, outName, inName }
let pre = null;  // OffscreenCanvas for resizing
let smoother = null;
let frameW = 0, frameH = 0;

const now = () => performance.now();

async function load({ model, ep, threads, warm = true }) {
  ort.env.wasm.numThreads = threads ?? Math.min(4, navigator.hardwareConcurrency || 4);
  const t0 = now();
  const res = await fetch(model.url);
  if (!res.ok) throw new Error(`fetch ${model.url}: ${res.status} (run "npm run setup" first)`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const t1 = now();
  const opts = {
    executionProviders: ep === 'webgpu' ? ['webgpu'] : ['wasm'],
    graphOptimizationLevel: 'all',
    // BiRefNet @1024² overflows the 4 GB wasm32 heap with the default arena + memory-pattern planner
    enableCpuMemArena: model.lowMem ? false : true,
    enableMemPattern: model.lowMem ? false : true,
    // keep fp32 I/O on CPU for simplicity; M1 should bind GPU buffers (preferredOutputLocation:'gpu-buffer')
  };
  session = await ort.InferenceSession.create(bytes, opts);
  const t2 = now();
  spec = {
    inW: model.inW, inH: model.inH, mean: model.mean, std: model.std,
    sigmoid: !!model.sigmoid, minmax: !!model.minmax,
    inName: session.inputNames[0], outName: model.outName ?? session.outputNames[0],
  };
  pre = new OffscreenCanvas(spec.inW, spec.inH);
  // First inference = shader compilation / kernel warmup; reported separately.
  const dummy = new ort.Tensor('float32', new Float32Array(3 * spec.inW * spec.inH), [1, 3, spec.inH, spec.inW]);
  const t3 = now();
  if (warm) { const out = await session.run({ [spec.inName]: dummy }); for (const k in out) out[k].dispose?.(); }
  const t4 = now();
  let adapterInfo = null;
  if (ep === 'webgpu') {
    try { const a = ort.env.webgpu?.adapter ?? (await navigator.gpu.requestAdapter()); adapterInfo = a?.info ? { vendor: a.info.vendor, architecture: a.info.architecture, description: a.info.description, f16: a.features.has('shader-f16') } : null; } catch {}
  }
  return {
    type: 'loaded', bytes: bytes.byteLength, fetchMs: t1 - t0, createMs: t2 - t1, firstRunMs: t4 - t3,
    inputNames: session.inputNames, outputNames: session.outputNames, ortVersion: ort.env.versions?.web, adapterInfo,
  };
}

function toTensor(bitmap) {
  const ctx = pre.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, spec.inW, spec.inH);
  const px = ctx.getImageData(0, 0, spec.inW, spec.inH).data;
  const n = spec.inW * spec.inH;
  const f = new Float32Array(3 * n);
  const [m0, m1, m2] = spec.mean, [s0, s1, s2] = spec.std;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    f[i] = (px[j] / 255 - m0) / s0;
    f[n + i] = (px[j + 1] / 255 - m1) / s1;
    f[2 * n + i] = (px[j + 2] / 255 - m2) / s2;
  }
  return new ort.Tensor('float32', f, [1, 3, spec.inH, spec.inW]);
}

async function frame({ bitmap, index, smooth }) {
  const t0 = now();
  if (bitmap.width !== frameW || bitmap.height !== frameH) { frameW = bitmap.width; frameH = bitmap.height; smoother = createSmoother(frameW, frameH); }
  // luma guide at frame res for smoothing (motion gate + guided filter)
  const g = new OffscreenCanvas(frameW, frameH).getContext('2d', { willReadFrequently: true });
  g.drawImage(bitmap, 0, 0);
  const rgba = g.getImageData(0, 0, frameW, frameH).data;
  const input = toTensor(bitmap);
  bitmap.close();
  const t1 = now();
  const out = await session.run({ [spec.inName]: input });
  const t2 = now();
  const o = out[spec.outName];
  const data = await o.getData();
  const [oh, ow] = o.dims.slice(-2);
  for (const k in out) out[k].dispose?.();
  input.dispose?.();
  const raw = upsample(data, ow, oh, frameW, frameH, spec.sigmoid, spec.minmax);
  const t3 = now();
  const sm = smooth ? smoother.step(raw, rgba, smooth) : { out: raw, emaOnly: raw };
  const t4 = now();
  const rawU8 = toU8(raw), smU8 = toU8(sm.out), emaU8 = toU8(sm.emaOnly);
  return {
    msg: { type: 'matte', index, raw: rawU8, smoothed: smU8, emaOnly: emaU8, w: frameW, h: frameH, timings: { preMs: t1 - t0, inferMs: t2 - t1, postMs: t3 - t2, smoothMs: t4 - t3, totalMs: t4 - t0 } },
    transfer: [rawU8.buffer, smU8.buffer, emaU8.buffer],
  };
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'load') self.postMessage(await load(m));
    else if (m.type === 'frame') { const { msg, transfer } = await frame(m); self.postMessage(msg, transfer); }
    else if (m.type === 'reset') { smoother?.reset(); self.postMessage({ type: 'reset' }); }
    else if (m.type === 'dispose') { await session?.release(); session = null; self.postMessage({ type: 'disposed' }); }
  } catch (err) {
    self.postMessage({ type: 'error', error: String(err?.message ?? err), stack: String(err?.stack ?? '') });
  }
};
