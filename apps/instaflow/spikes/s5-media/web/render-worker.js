// Render worker: owns the GPU device and the decoder sessions (co-located per the spike brief).
import { MB, openMedia, keyframeIndex, ForwardSession, Notifier, frameBarcode, stats, mulberry32, sleep, TPS, frameTicks, sampleTicks, usToTicks, ticksToSec } from './common.js';
import { createCompositor } from './gpu.js';

const log = (msg) => postMessage({ log: msg });
let canvas = null;

onmessage = async (e) => {
  const { cmd } = e.data;
  try {
    if (e.data.canvas) canvas = e.data.canvas;
    const fn = { probe, decode, composite, seek, drift, stop: () => { stopFlag = true; } }[cmd];
    if (!fn) return;
    const result = await fn(e.data);
    if (cmd !== 'stop') postMessage({ done: result });
  } catch (err) {
    postMessage({ done: { error: String(err?.stack ?? err) } });
  }
};

async function probe() {
  const out = { workerRAF: typeof self.requestAnimationFrame === 'function', crossOriginIsolated: self.crossOriginIsolated };
  const cfgs = {
    'decode avc1.640028 1080p': [VideoDecoder, { codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080 }],
    'decode vp09.00.40.08 1080p': [VideoDecoder, { codec: 'vp09.00.40.08', codedWidth: 1920, codedHeight: 1080 }],
    'decode av01.0.08M.08 1080p': [VideoDecoder, { codec: 'av01.0.08M.08', codedWidth: 1920, codedHeight: 1080 }],
    'encode avc1.640028 1080p': [VideoEncoder, { codec: 'avc1.640028', width: 1920, height: 1080, bitrate: 8e6, framerate: 30 }],
    'encode vp09.00.40.08 1080p': [VideoEncoder, { codec: 'vp09.00.40.08', width: 1920, height: 1080, bitrate: 8e6, framerate: 30 }],
    'encode av01.0.08M.08 1080p': [VideoEncoder, { codec: 'av01.0.08M.08', width: 1920, height: 1080, bitrate: 8e6, framerate: 30 }],
    'decode opus': [AudioDecoder, { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 }],
    'decode mp4a.40.2 (AAC)': [AudioDecoder, { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 }],
    'encode opus': [AudioEncoder, { codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 }],
    'encode mp4a.40.2 (AAC)': [AudioEncoder, { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 }],
  };
  out.codecs = {};
  for (const [k, [C, cfg]] of Object.entries(cfgs)) {
    try { out.codecs[k] = (await C.isConfigSupported(cfg)).supported; } catch (err) { out.codecs[k] = String(err); }
  }
  const adapter = await navigator.gpu?.requestAdapter();
  out.webgpu = adapter ? { ...(adapter.info ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description } : {}) } : null;
  out.importExternalTexture = !!(adapter && GPUDevice.prototype.importExternalTexture);
  return out;
}

// ---------------------------------------------------------------------------------------------- decode
async function decodeRun(blobs, frames, { optimizeForLatency = false } = {}) {
  const medias = await Promise.all(blobs.map(openMedia));
  const sessions = medias.map((m) => new ForwardSession(m, { loop: true, maxQueue: 4, optimizeForLatency }));
  await Promise.all(sessions.map((s) => s.start()));
  const t0 = performance.now();
  const per = await Promise.all(sessions.map(async (s) => { for (let i = 0; i < frames; i++) (await s.next()).close(); return performance.now() - t0; }));
  const ms = Math.max(...per);
  sessions.forEach((s) => s.close());
  return { streams: blobs.length, framesPerStream: frames, ms: Math.round(ms), fpsPerStream: Math.round((frames / ms) * 1000 * 10) / 10, aggregateFps: Math.round(((frames * blobs.length) / ms) * 1000 * 10) / 10, codec: medias[0].vconfig.codec, size: `${medias[0].vconfig.codedWidth}x${medias[0].vconfig.codedHeight}` };
}
async function decode({ blobs, frames = 300, reps = 3 }) {
  const out = {};
  // demux-only rate (Mediabunny over a Blob)
  {
    const m = await openMedia(blobs.layer0);
    const idx = await keyframeIndex(m.vsink);
    const t0 = performance.now(); let n = 0, bytes = 0;
    for await (const p of m.vsink.packets()) { n++; bytes += p.byteLength; if (n >= 900) break; }
    out.demux = { packetsPerSec: Math.round((n / (performance.now() - t0)) * 1000), mbPerSec: Math.round((bytes / 1e6 / (performance.now() - t0)) * 1000), keyframeIndexMs: Math.round(idx.ms), keyframes: idx.keys.length, packets: idx.packets, gopSec: idx.keys[1] - idx.keys[0] };
  }
  const cases = {
    'h264 1080p x1': [blobs.layer0],
    'h264 540p x1': [blobs.layer0_540p],
    'vp9 1080p x1': [blobs.layer0_vp9],
    'av1 1080p x1': [blobs.layer0_av1],
    'h264 1080p x3': [blobs.layer0, blobs.layer1, blobs.layer2],
    'h264 540p x3': [blobs.layer0_540p, blobs.layer1_540p, blobs.layer2_540p],
  };
  for (const [k, bl] of Object.entries(cases)) {
    const runs = [];
    for (let r = 0; r < reps; r++) runs.push(await decodeRun(bl, k.includes('vp9') || k.includes('av1') ? Math.min(frames, 290) : frames));
    runs.sort((a, b) => a.aggregateFps - b.aggregateFps);
    out[k] = { ...runs[Math.floor(runs.length / 2)], allAggregateFps: runs.map((r) => r.aggregateFps) };
    log(`decode ${k}: ${JSON.stringify(out[k])}`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- composite
async function composite({ blobs, frames = 300, modes = ['external', 'copy'], rendition = '1080p' }) {
  const out = {};
  for (const mode of modes) {
    const gpu = await createCompositor(canvas, { mode });
    out.adapter = gpu.info;
    const set = rendition === '540p' ? [blobs.layer0_540p, blobs.layer1_540p, blobs.layer2_540p] : [blobs.layer0, blobs.layer1, blobs.layer2];
    const medias = await Promise.all(set.map(openMedia));
    const sessions = medias.map((m) => new ForwardSession(m, { loop: true, maxQueue: 6 }));
    await Promise.all(sessions.map((s) => s.start()));
    // decode + composite, a fresh frame on every layer every composite (= 3 x 1080p "60 fps-equivalent" streams)
    const frameMs = []; let mismatches = 0, checks = 0;
    const warm = Math.min(20, frames);
    let t0 = 0;
    for (let i = 0; i < frames + warm; i++) {
      if (i === warm) t0 = performance.now();
      const a = performance.now();
      const fs = await Promise.all(sessions.map((s) => s.next()));
      const check = i >= warm && i % 30 === 0;
      gpu.draw(fs, { readback: check });
      await gpu.done();
      if (check) { const want = await frameBarcode(fs[0]); const got = await gpu.readBarcode(); checks++; if (want !== got) mismatches++; }
      fs.forEach((f) => f.close());
      if (i >= warm) frameMs.push(performance.now() - a);
      if (i % 10 === 0) log(`composite ${mode} frame ${i}: ${(performance.now() - a).toFixed(1)} ms`);
    }
    const ms = performance.now() - t0;
    // composite-only: re-import the same three frames (isolates import + GPU work from decode)
    const fs = await Promise.all(sessions.map((s) => s.next()));
    const gpuMs = [];
    for (let i = 0; i < 120; i++) { const a = performance.now(); gpu.draw(fs); await gpu.done(); gpuMs.push(performance.now() - a); }
    fs.forEach((f) => f.close());
    sessions.forEach((s) => s.close());
    out[mode] = {
      rendition,
      decodeAndCompositeFps: Math.round((frames / ms) * 1000 * 10) / 10,
      frameMs: stats(frameMs),
      compositeOnlyMs: stats(gpuMs),
      compositeOnlyFps: Math.round(1000 / stats(gpuMs).median),
      readbackChecks: checks, readbackMismatches: mismatches,
      deviceLost: gpu.lost,
    };
    log(`composite ${mode}: ${JSON.stringify(out[mode])}`);
    gpu.device.destroy();
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- seek
/** Exact seek: reset → configure → feed from the keyframe ≤ t → discard until the frame containing t. */
async function seekExact(m, dec, state, tSec, strategy) {
  const tUs = tSec * 1e6;
  dec.reset();
  dec.configure({ ...m.vconfig, optimizeForLatency: strategy !== 'flush' });
  const n = new Notifier();
  let result = null, discarded = 0, fedPast = 0, fed = 0;
  state.onFrame = (f) => {
    const dur = f.duration || 33334;
    if (!result && f.timestamp <= tUs + 1 && tUs < f.timestamp + dur) result = f; else { f.close(); discarded++; }
    n.notify();
  };
  const key = await m.vsink.getKeyPacket(tSec);
  for await (const p of m.vsink.packets(key)) {
    if (result) break;
    dec.decode(p.toEncodedVideoChunk()); fed++;
    if (p.timestamp > tSec) fedPast++;
    if (strategy === 'flush') { if (p.timestamp > tSec + 3 / 30) break; continue; }
    if (fedPast > 0) { // past the target in decode order: give the decoder a chance to emit before feeding more
      const deadline = performance.now() + 4;
      while (!result && (dec.decodeQueueSize > 0 || performance.now() < deadline)) await Promise.race([n.wait(), sleep(1)]);
    }
  }
  if (!result) await dec.flush();
  return { frame: result, discarded, fedPast, fed };
}

async function seek({ blobs, n = 150, files = ['layer0', 'layer0_540p', 'long10'], strategies = ['feed', 'flush', 'mediabunny'] }) {
  const gpu = await createCompositor(canvas, { mode: 'external', layers: 1 });
  const out = { adapter: gpu.info };
  for (const name of files) {
    const m = await openMedia(blobs[name]);
    const dur = await m.video.computeDuration();
    const idx = await keyframeIndex(m.vsink);
    for (const strategy of strategies) {
      const rand = mulberry32(42);
      const state = { onFrame: (f) => f.close() };
      const dec = new VideoDecoder({ output: (f) => state.onFrame(f), error: (err) => log(`decoder error ${err}`) });
      const sink = strategy === 'mediabunny' ? new MB.VideoSampleSink(m.video) : null;
      const ready = [], presented = [], fedPast = [], discarded = [];
      let wrong = 0, readbackWrong = 0, readbacks = 0, missing = 0;
      for (let i = 0; i < n + 3; i++) {
        const f = Math.floor(rand() * (dur - 1) * 30);
        const tSec = f / 30 + 0.004; // inside frame f
        const t0 = performance.now();
        let frame;
        if (sink) { const s = await sink.getSample(tSec); frame = s?.toVideoFrame(); s?.close(); }
        else { const r = await seekExact(m, dec, state, tSec, strategy); frame = r.frame; if (i >= 3) { fedPast.push(r.fedPast); discarded.push(r.discarded); } }
        const t1 = performance.now();
        if (!frame) { missing++; continue; }
        const rb = i % 10 === 0;
        gpu.draw([frame], { readback: rb });
        await gpu.done();
        const t2 = performance.now();
        if (i < 3) { frame.close(); continue; } // warm-up
        ready.push(t1 - t0); presented.push(t2 - t0);
        const bc = await frameBarcode(frame);
        if (bc !== f) wrong++;
        if (rb) { readbacks++; if ((await gpu.readBarcode()) !== f) readbackWrong++; }
        frame.close();
      }
      try { dec.close(); } catch {}
      const key = `${name} ${m.vconfig.codedWidth}x${m.vconfig.codedHeight} ${strategy}`;
      out[key] = { gopSec: Math.round((idx.keys[1] - idx.keys[0]) * 1000) / 1000, seeks: ready.length, readyMs: stats(ready), presentedMs: stats(presented), wrongFrames: wrong, missing, readbacks, readbackWrong, packetsFedPastTarget: stats(fedPast), framesDiscarded: stats(discarded) };
      log(`seek ${key}: ready median ${out[key].readyMs.median} p95 ${out[key].readyMs.p95}, presented median ${out[key].presentedMs.median} p95 ${out[key].presentedMs.p95}, wrong ${wrong}`);
    }
  }
  gpu.device.destroy();
  return out;
}

// ---------------------------------------------------------------------------------------------- drift
let stopFlag = false;
/**
 * Playback with the audio clock as master. Each frame callback: read the clock cell → heard media time at the
 * predicted display moment → pick the frame on the 30 fps grid → present. Records offsets from the timeline's
 * point of view: (a) flash-frame onset vs beep second, (b) presented frame vs heard time, (c) audio vs wall skew.
 */
async function drift({ blobs, ctl, clock, lead = 1000 / 60, sampleRate = 48000 }) {
  stopFlag = false;
  const C = new Int32Array(ctl); // [1]=mediaFrames consumed, [3]=ctx frame end, [4]=seq
  const K = new Float64Array(clock); // [0] seq, [1] contextTime, [2] performanceTime(abs epoch ms), [3] outputLatency, [4] baseLatency
  const gpu = await createCompositor(canvas, { mode: 'external', layers: 1 });
  const m = await openMedia(blobs.long10);
  const s = new ForwardSession(m, { loop: false, maxQueue: 8 });
  await s.start();
  const FT = frameTicks(30), ST = sampleTicks(sampleRate);
  const now = () => performance.timeOrigin + performance.now();

  function readClock() {
    let a, b, seq;
    for (let tries = 0; tries < 8; tries++) { seq = Atomics.load(C, 4); if (seq & 1) continue; a = Atomics.load(C, 1); b = Atomics.load(C, 3); if (Atomics.load(C, 4) === seq) break; }
    let ct, pt, ol, bl;
    for (let tries = 0; tries < 8; tries++) { const q = K[0]; if (q % 2) continue; ct = K[1]; pt = K[2]; ol = K[3]; bl = K[4]; if (K[0] === q) break; }
    return { mediaFrameEnd: a, ctxFrameEnd: b, contextTime: ct, perfAbs: pt, outputLatency: ol, baseLatency: bl };
  }
  /** Heard media time in ticks at absolute wall time W (ms). */
  function heardTicks(W, c) {
    const heardCtxFrame = (c.contextTime + (W - c.perfAbs) / 1000) * sampleRate;
    const mediaFrame = c.mediaFrameEnd - (c.ctxFrameEnd - heardCtxFrame);
    return mediaFrame * ST;
  }

  const flash = []; const offsets = []; const skew = []; let presentedCount = 0, dropped = 0, late = 0, wrong = 0, lastBc = -1;
  let wall0 = null, media0 = null, lastLog = 0, startedAt = 0, latencies = null;
  const raf = self.requestAnimationFrame ? (f) => self.requestAnimationFrame(f) : (f) => setTimeout(() => f(performance.now()), 16);
  await new Promise((resolve) => {
    const tick = async () => {
      if (stopFlag) return resolve();
      const W = now() + lead;
      const c = readClock();
      if (!c.contextTime || !c.mediaFrameEnd) { raf(tick); return; }
      const t = heardTicks(W, c);
      if (t < 0) { raf(tick); return; }
      if (wall0 === null) { wall0 = W; media0 = t; startedAt = performance.now(); latencies = { outputLatency: c.outputLatency, baseLatency: c.baseLatency }; }
      const tUs = (t / TPS) * 1e6;
      // drop frames whose successor is already due
      while (s.queue.length >= 2 && s.queue[1].timestamp <= tUs) { const f = s.queue.shift(); if (f.__shown !== true) dropped++; f.close(); s.n.notify(); }
      const f = s.queue[0];
      if (f) {
        if (f.timestamp + (f.duration || 33334) <= tUs) late++;
        if (!f.__shown) {
          f.__shown = true;
          gpu.draw([f]);
          presentedCount++;
          const bc = await frameBarcode(f);
          const expected = Math.floor(t / FT);
          if (bc !== expected) wrong++;
          offsets.push((t - bc * FT) / TPS * 1000); // ms the heard time is past the presented frame's start
          if (bc % 30 === 0 && bc !== lastBc) flash.push({ second: bc / 30, offsetMs: (t - (bc / 30) * TPS) / TPS * 1000 });
          lastBc = bc;
        }
      }
      if (performance.now() - lastLog > 10000) {
        lastLog = performance.now();
        skew.push({ wallSec: (W - wall0) / 1000, audioMinusWallMs: ((t - media0) / TPS) * 1000 - (W - wall0) });
        const fl = flash.slice(-10).map((x) => x.offsetMs.toFixed(1)).join(',');
        log(`drift t=${(t / TPS).toFixed(1)}s presented=${presentedCount} dropped=${dropped} late=${late} wrong=${wrong} lastFlashOffsets=[${fl}]`);
      }
      raf(tick);
    };
    raf(tick);
  });
  s.close(); gpu.device.destroy();
  const fo = flash.map((x) => x.offsetMs);
  // linear trend of flash offset over time (ms per minute)
  const nF = flash.length, mx = flash.reduce((a, x) => a + x.second, 0) / nF, my = fo.reduce((a, b) => a + b, 0) / nF;
  const slope = flash.reduce((a, x) => a + (x.second - mx) * (x.offsetMs - my), 0) / Math.max(1e-9, flash.reduce((a, x) => a + (x.second - mx) ** 2, 0));
  const first = fo.slice(0, 30), last = fo.slice(-30);
  return {
    playedSec: Math.round((performance.now() - startedAt) / 100) / 10,
    displayLeadMs: lead, latencies,
    presented: presentedCount, dropped, late, wrongFrameForClock: wrong,
    flashOnsetOffsetMs: stats(fo), flashAbsMaxMs: Math.round(Math.max(...fo.map(Math.abs)) * 100) / 100,
    flashTrendMsPerMin: Math.round(slope * 60 * 1000) / 1000,
    flashMeanFirst30s: stats(first).mean, flashMeanLast30s: stats(last).mean,
    presentedOffsetMs: stats(offsets),
    audioVsWallSkew: skew.filter((_, i) => i % 6 === 0 || i === skew.length - 1).map((x) => ({ wallSec: Math.round(x.wallSec), audioMinusWallMs: Math.round(x.audioMinusWallMs * 100) / 100 })),
  };
}
