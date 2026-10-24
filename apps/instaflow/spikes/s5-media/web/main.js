// S5 Media spike — page entry. ?test=probe|decode|composite|seek|drift|export  (results also in window.__result)
const q = new URLSearchParams(location.search);
const test = q.get('test') ?? 'probe';
const out = document.getElementById('out');
const lines = [];
const log = (s) => { lines.push(s); out.textContent = lines.join('\n'); console.log(s); };
const finish = (r) => { log(JSON.stringify(r, null, 2)); window.__result = r; };

const FILES = ['layer0', 'layer1', 'layer2', 'layer0_540p', 'layer1_540p', 'layer2_540p', 'layer0_vp9', 'layer0_av1', 'long10'];
const PATH = (n) => `/media/${n}${n.endsWith('vp9') ? '.webm' : '.mp4'}`;
async function loadBlobs(names) {
  const b = {};
  for (const n of names) { const r = await fetch(PATH(n)); if (!r.ok) throw new Error(`missing ${PATH(n)} — run scripts/gen-media.sh`); b[n] = await r.blob(); }
  return b;
}
function rpc(worker, msg, transfer = []) {
  return new Promise((resolve) => {
    const h = (e) => { if (e.data.log) log(e.data.log); if (e.data.done) { worker.removeEventListener('message', h); resolve(e.data.done); } };
    worker.addEventListener('message', h);
    worker.postMessage(msg, transfer);
  });
}
const renderWorker = () => new Worker('./render-worker.js', { type: 'module' });
let canvasSent = false;
const canvasMsg = () => { if (canvasSent) return [{}, []]; canvasSent = true; const c = document.getElementById('c').transferControlToOffscreen(); return [{ canvas: c }, [c]]; };
const meta = () => ({ userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, crossOriginIsolated, date: new Date().toISOString() });

async function gesture() {
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: q.get('latency') ?? 'interactive' });
  if (ctx.state !== 'running') { try { await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 1500))]); } catch {} }
  if (ctx.state !== 'running') {
    document.getElementById('gesture').hidden = false;
    await new Promise((r) => document.getElementById('go').addEventListener('click', r, { once: true }));
    await ctx.resume();
  }
  return ctx;
}

const tests = {
  async probe() {
    const ctx = new AudioContext({ sampleRate: 48000 });
    await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 1500))]);
    const a = { state: ctx.state, sampleRate: ctx.sampleRate, baseLatency: ctx.baseLatency, outputLatency: ctx.outputLatency, outputTimestamp: ctx.getOutputTimestamp?.() };
    await new Promise((r) => setTimeout(r, 500));
    a.after500ms = { currentTime: ctx.currentTime, outputTimestamp: ctx.getOutputTimestamp?.(), outputLatency: ctx.outputLatency };
    const w = renderWorker();
    const [m, t] = canvasMsg();
    return { meta: meta(), audio: a, worker: await rpc(w, { cmd: 'probe', ...m }, t) };
  },
  async decode() {
    const blobs = await loadBlobs(FILES.filter((f) => f !== 'long10'));
    return { meta: meta(), decode: await rpc(renderWorker(), { cmd: 'decode', blobs, frames: Number(q.get('frames') ?? 300), reps: Number(q.get('reps') ?? 3) }) };
  },
  async composite() {
    const blobs = await loadBlobs(FILES.filter((f) => f !== 'long10'));
    const w = renderWorker(); const [m, t] = canvasMsg();
    const frames = Number(q.get('frames') ?? 300);
    const small = (q.get('small') ?? '480x270').split('x').map(Number);
    const r = { meta: meta() };
    // full 1080p output (the real criterion), then a small output canvas: same 3 x 1080p decode + import, little fill
    r['1080p layers -> 1920x1080 canvas'] = await rpc(w, { cmd: 'composite', blobs, frames, ...m }, t);
    r[`1080p layers -> ${small.join('x')} canvas`] = await rpc(w, { cmd: 'composite', blobs, frames: frames * 3, canvasSize: small });
    r['540p layers -> 1920x1080 canvas'] = await rpc(w, { cmd: 'composite', blobs, frames, modes: ['external'], rendition: '540p' });
    return r;
  },
  async seek() {
    const blobs = await loadBlobs(['layer0', 'layer0_540p', 'long10']);
    const w = renderWorker(); const [m, t] = canvasMsg();
    return { meta: meta(), seek: await rpc(w, { cmd: 'seek', blobs, n: Number(q.get('n') ?? 150), ...m }, t) };
  },
  async drift() {
    const dur = Number(q.get('dur') ?? 60);
    const ctx = await gesture();
    const blobs = await loadBlobs(['long10']);
    const capacity = 48000;
    const pcm = new SharedArrayBuffer(capacity * 2 * 4), ctl = new SharedArrayBuffer(64), beeps = new SharedArrayBuffer(4 * 2000), clock = new SharedArrayBuffer(64);
    const C = new Int32Array(ctl), K = new Float64Array(clock), B = new Int32Array(beeps);
    await ctx.audioWorklet.addModule('./worklet.js');
    const node = new AudioWorkletNode(ctx, 'ring-player', { numberOfInputs: 0, outputChannelCount: [2], processorOptions: { pcm, ctl, beeps, capacity } });
    node.connect(ctx.destination);
    // clock cell writer (main owns AudioContext): getOutputTimestamp → abs wall time, + latencies (seqlock on K[0])
    const publish = () => {
      const ts = ctx.getOutputTimestamp();
      K[0]++; K[1] = ts.contextTime; K[2] = performance.timeOrigin + ts.performanceTime; K[3] = ctx.outputLatency; K[4] = ctx.baseLatency; K[0]++;
      // how far behind the render clock (currentTime) the output timestamp is = latency getOutputTimestamp accounts for
      if (ts.contextTime > 0 && latGap.length < 5000) latGap.push((ctx.currentTime - (ts.contextTime + (performance.now() - ts.performanceTime) / 1000)) * 1000);
    };
    const latGap = [];
    const iv = setInterval(publish, 20);
    const rafLoop = () => { publish(); if (!stopped) requestAnimationFrame(rafLoop); };
    let stopped = false; requestAnimationFrame(rafLoop);
    const aw = new Worker('./audio-worker.js', { type: 'module' });
    const audioDone = new Promise((r) => aw.addEventListener('message', (e) => { if (e.data.log) log(e.data.log); if (e.data.done) r(e.data.done); }));
    aw.postMessage({ blob: blobs.long10, pcm, ctl, capacity });
    // wait until 250 ms is buffered, then start playback
    while (Atomics.load(C, 0) < 12000) await new Promise((r) => setTimeout(r, 10));
    const w = renderWorker(); const [m, t] = canvasMsg();
    const canvasSize = (q.get('canvas') ?? '1920x1080').split('x').map(Number);
    const videoDone = rpc(w, { cmd: 'drift', blobs, ctl, clock, canvasSize, present: q.get('present') ?? 'gpu', lead: Number(q.get('lead') ?? 1000 / 60), ...m }, t);
    await new Promise((r) => setTimeout(r, 500)); // let the render worker open the media and pre-roll
    const ctxStart = ctx.currentTime;
    Atomics.store(C, 6, 1);
    log(`playing for ${dur}s (outputLatency=${ctx.outputLatency}, baseLatency=${ctx.baseLatency})`);
    await new Promise((r) => setTimeout(r, dur * 1000));
    w.postMessage({ cmd: 'stop' }); aw.postMessage({ cmd: 'stop' });
    const video = await videoDone; Atomics.store(C, 6, 0); stopped = true; clearInterval(iv);
    const audio = await audioDone;
    const nb = Atomics.load(C, 5);
    const beepErr = []; for (let k = 0; k < nb; k++) beepErr.push(B[k] - Math.round(B[k] / 48000) * 48000);
    const consumed = Atomics.load(C, 1);
    return {
      meta: meta(), durationSec: dur, canvasSize,
      audio: { ...audio, consumedFrames: consumed, underrunFrames: Atomics.load(C, 2), ctxElapsedSec: ctx.currentTime - ctxStart, consumedSec: consumed / 48000, outputLatency: ctx.outputLatency, baseLatency: ctx.baseLatency,
        beepsDetected: nb, currentTimeMinusOutputTimestampMs: summarize(latGap.map((x) => Math.round(x * 10) / 10)), beepOnsetErrorSamples: summarize(beepErr) },
      video,
    };
  },
  async export() {
    const blobs = await loadBlobs(['layer0', 'layer1', 'layer2']);
    const w = new Worker('./export-worker.js', { type: 'module' });
    w.addEventListener('message', (e) => { if (e.data.file) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([e.data.file.bytes])); a.download = e.data.file.name; a.textContent = `download ${e.data.file.name}`; document.body.prepend(a); } });
    const codecs = (q.get('codecs') ?? 'vp9,av1').split(',');
    return { meta: meta(), export: await rpc(w, { cmd: 'export', blobs, codecs, seconds: Number(q.get('seconds') ?? 60), gpuSeconds: Number(q.get('gpuSeconds') ?? q.get('seconds') ?? 60), composites: (q.get('composites') ?? 'none,gpu').split(','), encodeOnlyCodecs: (q.get('encodeOnly') ?? 'vp9,av1,h264').split(',').filter(Boolean), latencyMode: q.get('latencyMode') ?? 'quality' }) };
  },
};
function summarize(xs) { if (!xs.length) return { n: 0 }; const s = [...xs].sort((a, b) => a - b); return { n: s.length, min: s[0], median: s[s.length >> 1], max: s[s.length - 1] }; }

(async () => {
  try { log(`test=${test}`); finish(await tests[test]()); } catch (e) { finish({ error: String(e?.stack ?? e) }); }
})();
