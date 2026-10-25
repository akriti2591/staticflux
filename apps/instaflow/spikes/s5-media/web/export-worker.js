// Export worker: frame counter clock t_n = n · frameDuration, exact decode (in order, wait for each frame),
// composite (WebGPU on its own OffscreenCanvas) → VideoEncoder, offline audio mix → AudioEncoder, Mediabunny mux.
import { MB, openMedia, ForwardSession, frameBarcode, stats, TPS, frameTicks, ticksToUs } from './common.js';
import { createCompositor } from './gpu.js';

const log = (msg) => postMessage({ log: msg });
const CODECS = {
  vp9: { wc: 'vp09.00.40.08', mb: 'vp9', fmt: 'webm' },
  av1: { wc: 'av01.0.08M.08', mb: 'av1', fmt: 'webm' },
  h264: { wc: 'avc1.640028', mb: 'avc', fmt: 'mp4' },
};
const vconfig = (codec, latencyMode) => ({ codec: CODECS[codec].wc, width: 1920, height: 1080, bitrate: 8e6, framerate: 30, latencyMode, ...(codec === 'h264' ? { avc: { format: 'avc' } } : {}) });

onmessage = async (e) => {
  try { postMessage({ done: await run(e.data) }); } catch (err) { postMessage({ done: { error: String(err?.stack ?? err) } }); }
};

async function run({ blobs, codecs, seconds, latencyMode, gpuSeconds = seconds, composites = ['none', 'gpu'], encodeOnlyCodecs = ['vp9', 'av1', 'h264'] }) {
  const out = { support: {} };
  for (const c of ['vp9', 'av1', 'h264']) out.support[c] = (await VideoEncoder.isConfigSupported(vconfig(c, latencyMode))).supported;
  // 1) encoder-only throughput: 60 pre-decoded 1080p frames re-stamped and fed for 300 frames
  out.encodeOnly = {};
  for (const c of encodeOnlyCodecs) for (const lm of ['quality', 'realtime']) {
    try { out.encodeOnly[`${c} ${lm}`] = await encodeOnly(blobs.layer0, c, lm); } catch (err) { out.encodeOnly[`${c} ${lm}`] = { error: String(err) }; }
    log(`encodeOnly ${c} ${lm}: ${JSON.stringify(out.encodeOnly[`${c} ${lm}`])}`);
  }
  // 2) full 60 s exports
  for (const c of codecs) for (const composite of composites) {
    const k = `${c} ${latencyMode} composite=${composite}`;
    try { out[k] = await exportRun({ blobs, codec: c, seconds: composite === 'gpu' ? gpuSeconds : seconds, latencyMode, composite }); } catch (err) { out[k] = { error: String(err?.stack ?? err) }; }
    log(`export ${k}: ${JSON.stringify(out[k])}`);
  }
  return out;
}

async function encodeOnly(blob, codec, latencyMode, n = 300) {
  const m = await openMedia(blob);
  const s = new ForwardSession(m, { loop: false, maxQueue: 64 });
  await s.start();
  const pool = []; for (let i = 0; i < 60; i++) pool.push(await s.next());
  s.close();
  let chunks = 0, bytes = 0, err = null;
  const enc = new VideoEncoder({ output: (ch) => { chunks++; bytes += ch.byteLength; }, error: (e) => { err = e; } });
  enc.configure(vconfig(codec, latencyMode));
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    while (enc.encodeQueueSize > 6) await new Promise((r) => enc.addEventListener('dequeue', r, { once: true }));
    if (err) throw err;
    const f = new VideoFrame(pool[i % 60], { timestamp: Math.round((i * 1e6) / 30), duration: 33333 });
    enc.encode(f, { keyFrame: i % 60 === 0 }); f.close();
  }
  await enc.flush();
  const ms = performance.now() - t0;
  enc.close(); pool.forEach((f) => f.close());
  if (err) throw err;
  return { fps: Math.round((n / ms) * 1000 * 10) / 10, xRealtime: Math.round((n / 30 / (ms / 1000)) * 100) / 100, chunks, mbps: Math.round(((bytes * 8) / (n / 30) / 1e6) * 10) / 10 };
}

/** Decode the audio of a clip fully into planar f32 [L, R] for the first `seconds`. */
async function decodeAudio(m, seconds) {
  const sr = m.aconfig.sampleRate, N = sr * seconds;
  const L = new Float32Array(N), R = new Float32Array(N);
  const tmp = [new Float32Array(8192), new Float32Array(8192)];
  const dec = new AudioDecoder({
    output: (d) => {
      const start = Math.round((d.timestamp / 1e6) * sr);
      for (let ch = 0; ch < 2; ch++) d.copyTo(tmp[ch].subarray(0, d.numberOfFrames), { planeIndex: Math.min(ch, d.numberOfChannels - 1), format: 'f32-planar' });
      for (let i = 0; i < d.numberOfFrames; i++) { const j = start + i; if (j >= 0 && j < N) { L[j] = tmp[0][i]; R[j] = tmp[1][i]; } }
      d.close();
    },
    error: (e) => log(`audio decode error ${e}`),
  });
  dec.configure(m.aconfig);
  for await (const p of m.asink.packets()) { if (p.timestamp > seconds + 0.1) break; dec.decode(p.toEncodedAudioChunk()); }
  await dec.flush(); dec.close();
  return [L, R];
}

async function exportRun({ blobs, codec, seconds, latencyMode, composite }) {
  const c = CODECS[codec], fps = 30, N = seconds * fps, FT = frameTicks(fps);
  const T = {}; const mark = (k, ms) => { T[k] = (T[k] ?? 0) + ms; };
  const t0 = performance.now();
  const medias = await Promise.all([blobs.layer0, blobs.layer1, blobs.layer2].map(openMedia));
  const output = new MB.Output({ format: c.fmt === 'mp4' ? new MB.Mp4OutputFormat({ fastStart: 'in-memory' }) : new MB.WebMOutputFormat(), target: new MB.BufferTarget() });
  const vsrc = new MB.EncodedVideoPacketSource(c.mb); output.addVideoTrack(vsrc, { frameRate: fps });
  const asrc = new MB.EncodedAudioPacketSource('opus'); output.addAudioTrack(asrc);
  await output.start();

  // audio: same mixer for preview and export (here: equal-gain sum of the three layers), offline, ahead of video
  let ta = performance.now();
  const tracks = await Promise.all(medias.map((m) => decodeAudio(m, seconds)));
  const sr = 48000, NA = sr * seconds, mixL = new Float32Array(NA), mixR = new Float32Array(NA);
  for (const [L, R] of tracks) for (let i = 0; i < NA; i++) { mixL[i] += L[i] / 3; mixR[i] += R[i] / 3; }
  let aChain = Promise.resolve(), aErr = null;
  const aenc = new AudioEncoder({ output: (ch, meta) => { aChain = aChain.then(() => asrc.add(MB.EncodedPacket.fromEncodedChunk(ch), meta)); }, error: (e) => { aErr = e; } });
  aenc.configure({ codec: 'opus', sampleRate: sr, numberOfChannels: 2, bitrate: 128000 });
  for (let i = 0; i < NA; i += 960) {
    const n = Math.min(960, NA - i), buf = new Float32Array(n * 2);
    buf.set(mixL.subarray(i, i + n), 0); buf.set(mixR.subarray(i, i + n), n);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((i / sr) * 1e6), data: buf });
    aenc.encode(ad); ad.close();
  }
  await aenc.flush(); await aChain; aenc.close();
  if (aErr) throw aErr;
  mark('audioDecodeMixEncodeMs', performance.now() - ta);

  // video
  const sessions = medias.map((m) => new ForwardSession(m, { loop: false, maxQueue: 4 }));
  await Promise.all(sessions.map((s) => s.start()));
  let gpu = null, canvas = null;
  if (composite === 'gpu') { canvas = new OffscreenCanvas(1920, 1080); gpu = await createCompositor(canvas, { mode: 'external' }); }
  let vChain = Promise.resolve(), vErr = null, vbytes = 0;
  const venc = new VideoEncoder({ output: (ch, meta) => { vbytes += ch.byteLength; vChain = vChain.then(() => vsrc.add(MB.EncodedPacket.fromEncodedChunk(ch), meta)); }, error: (e) => { vErr = e; } });
  venc.configure(vconfig(codec, latencyMode));
  let notExact = 0;
  const tv = performance.now();
  for (let n = 0; n < N; n++) {
    const tick = n * FT; const tsUs = Math.round(ticksToUs(tick));
    let a = performance.now();
    const fs = await Promise.all(sessions.map((s) => s.next())); // exact mode: wait for the frame, never skip
    mark('decodeWaitMs', performance.now() - a);
    for (const f of fs) if (Math.abs(f.timestamp - tsUs) > 1000) notExact++;
    a = performance.now();
    let vf;
    if (gpu) { gpu.draw(fs); vf = new VideoFrame(canvas, { timestamp: tsUs, duration: 33333 }); }
    else vf = new VideoFrame(fs[0], { timestamp: tsUs, duration: 33333 });
    fs.forEach((f) => f.close());
    mark('renderAndCaptureMs', performance.now() - a);
    a = performance.now();
    while (venc.encodeQueueSize > 6) await new Promise((r) => venc.addEventListener('dequeue', r, { once: true }));
    mark('encodeBackpressureMs', performance.now() - a);
    if (vErr) throw vErr;
    venc.encode(vf, { keyFrame: n % 60 === 0 }); vf.close();
    if (n % 300 === 0) log(`export ${codec} ${composite}: frame ${n}/${N} at ${((performance.now() - tv) / 1000).toFixed(1)} s`);
  }
  let a = performance.now();
  await venc.flush(); await vChain; venc.close();
  mark('encodeDrainMs', performance.now() - a);
  if (vErr) throw vErr;
  sessions.forEach((s) => s.close()); gpu?.device.destroy();
  a = performance.now();
  await output.finalize();
  mark('muxFinalizeMs', performance.now() - a);
  const wall = performance.now() - t0, videoWall = performance.now() - tv;
  const bytes = output.target.buffer;

  // verify: reopen, check duration/tracks, decode frames at known indices and read the layer-0 barcode
  const inp = new MB.Input({ source: new MB.BlobSource(new Blob([bytes])), formats: MB.ALL_FORMATS });
  const vt = await inp.getPrimaryVideoTrack(), at = await inp.getPrimaryAudioTrack();
  const sink = new MB.VideoSampleSink(vt);
  const checks = [];
  for (const n of [0, 1, 299, 450, 900, 1351, N - 1]) {
    if (n >= N) continue;
    const s = await sink.getSample(n / fps + 0.004); const f = s.toVideoFrame(); s.close();
    checks.push({ n, barcode: await frameBarcode(f) }); f.close();
  }
  let vPackets = 0; for await (const _ of new MB.EncodedPacketSink(vt).packets(undefined, undefined, { metadataOnly: true })) vPackets++;
  const duration = Math.round((await inp.computeDuration()) * 1000) / 1000, fileMB = Math.round(bytes.byteLength / 1e5) / 10;
  postMessage({ file: { name: `export-${codec}-${composite}.${c.fmt}`, bytes } }, [bytes]);
  Object.keys(T).forEach((k) => { T[k] = Math.round(T[k]); });
  return {
    seconds, frames: N, wallSec: Math.round(wall / 100) / 10, xRealtime: Math.round((seconds / (wall / 1000)) * 100) / 100,
    videoOnlyXRealtime: Math.round((seconds / (videoWall / 1000)) * 100) / 100,
    stagesMs: T, notExactSourceFrames: notExact, videoMbps: Math.round(((vbytes * 8) / seconds / 1e6) * 10) / 10, fileMB,
    verify: { duration, videoCodec: vt?.codec, audioCodec: at?.codec, videoPackets: vPackets, barcodeChecks: checks, barcodeAllMatch: checks.every((x) => x.barcode === x.n) },
  };
}
