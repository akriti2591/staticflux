// S9 matte bench page. Query params:
//   ?preset=cloud|owner          (default: owner when opened by hand, see index.html)
//   ?runs=model:ep:frames,...     explicit run list, e.g. birefnet_lite:webgpu:30,u2netp:wasm:10
//   ?seqs=static,bgmotion,moving  sequences (default all three)
//   ?ema=0.3&motion=0.04&gfR=6&gfEps=0.001
// Sets window.__result when done (harness contract).
import { MODELS, PRESETS } from './models.js';
import { renderFrame, SEQUENCES, W, H } from './scene.js';
import { boxMean, createSmoother } from './smooth.js';
import { upsample } from './post.js';

const q = new URLSearchParams(location.search);
const log = (s) => { document.getElementById('log').textContent += s + '\n'; console.log(s); };
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN; };
const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] : NaN; };
const r2 = (x) => Math.round(x * 100) / 100, r4 = (x) => Math.round(x * 1e4) / 1e4;

// ---------- metrics ----------
function edgeBand(gt) { // pixels within ~6 px of the GT boundary
  const n = W * H, b = new Float32Array(n), o = new Float32Array(n), tmp = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = gt[i] > 127 ? 1 : 0;
  boxMean(b, o, tmp, W, H, 6);
  const band = new Uint8Array(n); let c = 0;
  for (let i = 0; i < n; i++) if (o[i] > 0.01 && o[i] < 0.99) { band[i] = 1; c++; }
  return { band, count: c };
}
function meanAbs(a, b, band) { let s = 0, c = 0; for (let i = 0; i < a.length; i++) if (!band || band[i]) { s += Math.abs(a[i] - b[i]); c++; } return s / c / 255; }
// ghosting: alpha the smoother ADDS over the raw matte on true-background pixels (trails behind a moving subject)
function ghost(sm, raw, gt) { let s = 0, c = 0; for (let i = 0; i < sm.length; i++) if (gt[i] < 8) { const d = sm[i] - raw[i]; if (d > 0) s += d; c++; } return s / c / 255; }
function iou(a, gt) { let I = 0, U = 0; for (let i = 0; i < a.length; i++) { const x = a[i] > 127, y = gt[i] > 127; if (x && y) I++; if (x || y) U++; } return I / U; }

// ---------- runners ----------
function workerRunner(id, ep) {
  const m = MODELS[id];
  const w = new Worker(new URL('./matte-worker.js', import.meta.url), { type: 'module' });
  const call = (msg, transfer = []) => new Promise((res, rej) => {
    w.onmessage = (e) => (e.data.type === 'error' ? rej(new Error(e.data.error)) : res(e.data));
    w.onerror = (e) => rej(new Error(e.message || 'worker error'));
    w.postMessage(msg, transfer);
  });
  return {
    load: () => call({ type: 'load', ep, warm: q.get('nowarm') !== '1', model: { ...m, url: new URL(`../models/${m.file}`, location.href).href } }),
    frame: (bitmap, index, smooth) => call({ type: 'frame', bitmap, index, smooth }, [bitmap]),
    reset: () => call({ type: 'reset' }),
    dispose: async () => { try { await call({ type: 'dispose' }); } catch {} w.terminate(); },
  };
}

// MediaPipe fallback tier (main thread; tasks-vision manages its own GL context). ep 'webgpu' -> GPU delegate.
function mediapipeRunner(id, ep) {
  let seg = null, smoother = null, ts = 0;
  return {
    async load() {
      const t0 = performance.now();
      const { FilesetResolver, ImageSegmenter } = await import('../node_modules/@mediapipe/tasks-vision/vision_bundle.mjs');
      const fileset = await FilesetResolver.forVisionTasks(new URL('../node_modules/@mediapipe/tasks-vision/wasm', location.href).href);
      const bytes = new Uint8Array(await (await fetch(`../models/${MODELS[id].file}`)).arrayBuffer());
      const t1 = performance.now();
      seg = await ImageSegmenter.createFromOptions(fileset, { baseOptions: { modelAssetBuffer: bytes, delegate: ep === 'webgpu' ? 'GPU' : 'CPU' }, runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false });
      const t2 = performance.now();
      return { type: 'loaded', bytes: bytes.byteLength, fetchMs: t1 - t0, createMs: t2 - t1, firstRunMs: 0, note: ep === 'webgpu' ? 'MediaPipe GPU delegate = WebGL2, not WebGPU' : 'CPU delegate (wasm/XNNPACK)' };
    },
    async frame(bitmap, index, smooth) {
      const t0 = performance.now();
      const g = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true });
      g.drawImage(bitmap, 0, 0); const rgba = g.getImageData(0, 0, W, H).data;
      const t1 = performance.now();
      let data, mw, mh;
      seg.segmentForVideo(bitmap, (ts += 33), (res) => { const mk = res.confidenceMasks[0]; data = mk.getAsFloat32Array().slice(); mw = mk.width; mh = mk.height; });
      const t2 = performance.now();
      bitmap.close();
      const raw = upsample(data, mw, mh, W, H, false, false);
      const t3 = performance.now();
      if (!smoother) smoother = createSmoother(W, H);
      const sm = smooth ? smoother.step(raw, rgba, smooth) : { out: raw, emaOnly: raw };
      const t4 = performance.now();
      const u = (f) => { const o = new Uint8Array(f.length); for (let i = 0; i < f.length; i++) o[i] = Math.max(0, Math.min(255, Math.round(f[i] * 255))); return o; };
      return { raw: u(raw), smoothed: u(sm.out), emaOnly: u(sm.emaOnly), w: W, h: H, timings: { preMs: t1 - t0, inferMs: t2 - t1, postMs: t3 - t2, smoothMs: t4 - t3, totalMs: t4 - t0 }, maskSize: [mw, mh] };
    },
    async reset() { smoother?.reset(); },
    async dispose() { seg?.close(); },
  };
}

async function memorySnapshot() {
  const out = {};
  if (performance.memory) out.jsHeapUsedMB = r2(performance.memory.usedJSHeapSize / 2 ** 20);
  if (performance.measureUserAgentSpecificMemory && crossOriginIsolated) {
    try {
      const m = await Promise.race([performance.measureUserAgentSpecificMemory(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000))]);
      out.uaSpecificMB = r2(m.bytes / 2 ** 20); // JS + wasm heaps of page + workers; excludes GPU buffers
    } catch (e) { out.uaSpecificErr = String(e.message); }
  }
  return out;
}

// ---------- preview ----------
function preview(label, bitmapCanvas, raw, sm, gt) {
  const box = document.createElement('figure');
  box.innerHTML = `<figcaption>${label}</figcaption>`;
  const mk = (fill) => { const c = document.createElement('canvas'); c.width = W / 4; c.height = H / 4; fill(c.getContext('2d')); box.appendChild(c); };
  const plane = (a) => (ctx) => { const big = new OffscreenCanvas(W, H), id = new ImageData(W, H); for (let i = 0; i < a.length; i++) { id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = a[i]; id.data[i * 4 + 3] = 255; } big.getContext('2d').putImageData(id, 0, 0); ctx.drawImage(big, 0, 0, W / 4, H / 4); };
  mk((ctx) => ctx.drawImage(bitmapCanvas, 0, 0, W / 4, H / 4));
  mk(plane(gt)); mk(plane(raw)); mk(plane(sm));
  mk((ctx) => { // cutout over checkerboard
    for (let y = 0; y < H / 4; y += 10) for (let x = 0; x < W / 4; x += 10) { ctx.fillStyle = ((x + y) / 10) % 2 ? '#ccc' : '#fff'; ctx.fillRect(x, y, 10, 10); }
    const big = new OffscreenCanvas(W, H), bctx = big.getContext('2d'); bctx.drawImage(bitmapCanvas, 0, 0);
    const id = bctx.getImageData(0, 0, W, H); for (let i = 0; i < sm.length; i++) id.data[i * 4 + 3] = sm[i]; bctx.putImageData(id, 0, 0);
    ctx.drawImage(big, 0, 0, W / 4, H / 4);
  });
  document.getElementById('previews').appendChild(box);
}

// ---------- one run ----------
async function runOne(id, ep, frames, seqs, smooth) {
  const m = MODELS[id];
  const res = { model: id, ep, licence: m.licence, commercial: m.commercial, note: m.note, input: m.mediapipe ? '256x256 (internal)' : `${m.inW}x${m.inH}`, frames };
  const runner = m.mediapipe ? mediapipeRunner(id, ep) : workerRunner(id, ep);
  try {
    const memBefore = await memorySnapshot();
    const l = await runner.load();
    Object.assign(res, { sizeMB: r2(l.bytes / 1e6), fetchMs: Math.round(l.fetchMs), sessionCreateMs: Math.round(l.createMs), firstRunMs: Math.round(l.firstRunMs), loadTotalMs: Math.round(l.fetchMs + l.createMs + l.firstRunMs), adapter: l.adapterInfo, loadNote: l.note });
    log(`  loaded ${id}/${ep}: ${res.sizeMB} MB, create ${res.sessionCreateMs} ms, first run ${res.firstRunMs} ms`);
    res.memAfterLoad = await memorySnapshot(); res.memBefore = memBefore;
    res.seqs = {};
    for (const s of seqs) {
      await runner.reset();
      const per = { total: [], infer: [], smooth: [], flickerRaw: [], flickerSm: [], flickerEma: [], flickerEmaEdge: [], maeEmaEdge: [], flickerRawEdge: [], flickerSmEdge: [], maeRaw: [], maeSm: [], maeRawEdge: [], maeSmEdge: [], iouRaw: [], iouSm: [], ghostSm: [], ghostEma: [] };
      let prev = null, last = null;
      for (let t = 0; t < frames; t++) {
        const { bitmap, gt } = await renderFrame(s, t);
        const keep = document.createElement('canvas'); keep.width = W; keep.height = H; keep.getContext('2d').drawImage(bitmap, 0, 0);
        const { band } = edgeBand(gt);
        const r = await runner.frame(bitmap, t, smooth);
        per.total.push(r.timings.totalMs); per.infer.push(r.timings.inferMs); per.smooth.push(r.timings.smoothMs);
        per.maeRaw.push(meanAbs(r.raw, gt)); per.maeSm.push(meanAbs(r.smoothed, gt));
        per.maeRawEdge.push(meanAbs(r.raw, gt, band)); per.maeSmEdge.push(meanAbs(r.smoothed, gt, band));
        per.maeEmaEdge.push(meanAbs(r.emaOnly, gt, band));
        per.ghostSm.push(ghost(r.smoothed, r.raw, gt)); per.ghostEma.push(ghost(r.emaOnly, r.raw, gt));
        per.iouRaw.push(iou(r.raw, gt)); per.iouSm.push(iou(r.smoothed, gt));
        if (prev && s !== 'moving') { // flicker only meaningful on a static subject
          per.flickerRaw.push(meanAbs(r.raw, prev.raw)); per.flickerSm.push(meanAbs(r.smoothed, prev.smoothed)); per.flickerEma.push(meanAbs(r.emaOnly, prev.emaOnly));
          per.flickerEmaEdge.push(meanAbs(r.emaOnly, prev.emaOnly, band));
          per.flickerRawEdge.push(meanAbs(r.raw, prev.raw, band)); per.flickerSmEdge.push(meanAbs(r.smoothed, prev.smoothed, band));
        }
        prev = r; last = { keep, r, gt };
      }
      // skip frame 0 for timing (pipeline warm), keep if only 1-2 frames
      const tt = per.total.length > 2 ? per.total.slice(1) : per.total, ti = per.infer.length > 2 ? per.infer.slice(1) : per.infer;
      const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
      res.seqs[s] = {
        fpsEndToEndMedian: r2(1000 / median(tt)), totalMsMedian: Math.round(median(tt)), totalMsP95: Math.round(p95(tt)),
        inferMsMedian: Math.round(median(ti)), inferMsP95: Math.round(p95(ti)), fpsInferOnly: r2(1000 / median(ti)), smoothMsMedian: Math.round(median(per.smooth)),
        flickerRaw: r4(mean(per.flickerRaw)), flickerSmoothed: r4(mean(per.flickerSm)),
        flickerRawEdge: r4(mean(per.flickerRawEdge)), flickerSmoothedEdge: r4(mean(per.flickerSmEdge)),
        flickerEmaOnly: r4(mean(per.flickerEma)), flickerEmaOnlyEdge: r4(mean(per.flickerEmaEdge)), maeEmaOnlyEdge: r4(mean(per.maeEmaEdge)),
        // steady-state flicker (frames >= 4, after the EMA has converged), edge band
        flickerRawEdgeSteady: r4(mean(per.flickerRawEdge.slice(3))), flickerSmoothedEdgeSteady: r4(mean(per.flickerSmEdge.slice(3))),
        maeRaw: r4(mean(per.maeRaw)), maeSmoothed: r4(mean(per.maeSm)), maeRawEdge: r4(mean(per.maeRawEdge)), maeSmoothedEdge: r4(mean(per.maeSmEdge)),
        iouRaw: r4(mean(per.iouRaw)), iouSmoothed: r4(mean(per.iouSm)),
        ghostSmoothed: r4(mean(per.ghostSm)) * 1, ghostEmaOnly: r4(mean(per.ghostEma)),
      };
      log(`  ${s}: ${JSON.stringify(res.seqs[s])}`);
      if (last) preview(`${id} / ${ep} / ${s} (frame ${frames - 1}): input · GT · raw · smoothed · cutout`, last.keep, last.r.raw, last.r.smoothed, last.gt);
    }
    res.memAfterRun = await memorySnapshot();
  } catch (e) {
    res.error = String(e.message ?? e); log(`  ERROR ${id}/${ep}: ${res.error}`);
  } finally { await runner.dispose(); }
  return res;
}

function renderTable(results) {
  const rows = results.map((r) => {
    const s = r.seqs?.static ?? {}, b = r.seqs?.bgmotion ?? {}, mv = r.seqs?.moving ?? {};
    return `<tr><td>${r.model}</td><td>${r.ep}</td><td>${r.commercial === true ? 'yes' : r.commercial === false ? '<b>NO — measure only</b>' : 'unclear'}</td><td>${r.sizeMB ?? ''}</td><td>${r.loadTotalMs ?? ''}</td>
      <td>${s.fpsEndToEndMedian ?? ''}</td><td>${s.fpsInferOnly ?? ''}</td><td>${s.totalMsP95 ?? ''}</td>
      <td>${s.flickerRaw ?? ''} → ${s.flickerSmoothed ?? ''}</td><td>${b.flickerRaw ?? ''} → ${b.flickerSmoothed ?? ''}</td>
      <td>${s.iouRaw ?? ''} / ${mv.iouRaw ?? ''} → ${mv.iouSmoothed ?? ''}</td><td>${r.memAfterRun?.uaSpecificMB ?? ''}</td><td>${r.error ?? ''}</td></tr>`;
  }).join('');
  document.getElementById('table').innerHTML = `<table><tr><th>model</th><th>EP</th><th>commercial</th><th>MB</th><th>load ms</th><th>fps e2e</th><th>fps infer</th><th>p95 ms</th><th>flicker static raw→sm</th><th>flicker bg-motion raw→sm</th><th>IoU static / moving raw→sm</th><th>mem MB</th><th>error</th></tr>${rows}</table>`;
}

export async function main() {
  const smooth = { ema: Number(q.get('ema') ?? 0.3), motion: Number(q.get('motion') ?? 0.04), jump: Number(q.get('jump') ?? 0.5), gfR: Number(q.get('gfR') ?? 6), gfEps: Number(q.get('gfEps') ?? 1e-3), guided: q.get('guided') !== '0' };
  const seqs = (q.get('seqs') ?? 'static,bgmotion,moving').split(',').filter((s) => SEQUENCES[s]);
  const runs = q.get('runs')
    ? q.get('runs').split(',').map((x) => { const [m, ep, f, sq] = x.split(':'); return [m, ep ?? 'webgpu', Number(f ?? 12), sq ? sq.split(/[+ ]/) : undefined]; })
    : PRESETS[q.get('preset') ?? 'owner'].runs;
  const env = {
    ua: navigator.userAgent, crossOriginIsolated, cores: navigator.hardwareConcurrency, deviceMemoryGB: navigator.deviceMemory,
    webgpu: !!navigator.gpu, smooth, seqs, frameSize: `${W}x${H}`, date: new Date().toISOString(),
  };
  if (navigator.gpu) { try { const a = await navigator.gpu.requestAdapter(); env.adapter = a ? { ...a.info && { vendor: a.info.vendor, architecture: a.info.architecture, description: a.info.description }, f16: a.features.has('shader-f16'), maxBufferMB: Math.round(a.limits.maxBufferSize / 2 ** 20), maxStorageBufferMB: Math.round(a.limits.maxStorageBufferBindingSize / 2 ** 20), maxStorageBuffersPerShaderStage: a.limits.maxStorageBuffersPerShaderStage } : null; } catch (e) { env.adapterErr = String(e); } }
  log(`env: ${JSON.stringify(env)}`);
  const results = [];
  for (const [id, ep, frames, runSeqs] of runs) {
    if (!MODELS[id]) { log(`unknown model ${id}`); continue; }
    const sq = runSeqs ?? seqs;
    log(`run ${id} on ${ep}, ${frames} frames x ${sq.join('/')}`);
    results.push(await runOne(id, ep, frames, sq, smooth));
    renderTable(results);
  }
  window.__result = { spike: 'S9 matte', env, results };
  document.getElementById('json').textContent = JSON.stringify(window.__result, null, 2);
  log('done');
}
