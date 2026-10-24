// Media (audio) worker: Mediabunny demux → AudioDecoder → interleaved f32 → SAB ring for the AudioWorklet.
// Places samples by AudioData.timestamp so ring frame index == media frame index (pre-skip trimmed, gaps padded).
import { openMedia, sleep } from './common.js';

let stop = false;
onmessage = async (e) => {
  if (e.data.cmd === 'stop') { stop = true; return; }
  const { blob, pcm, ctl, capacity, aheadFrames = 12000 } = e.data; // 250 ms ahead at 48 kHz
  const P = new Float32Array(pcm), C = new Int32Array(ctl);
  const m = await openMedia(blob);
  const sr = m.aconfig.sampleRate;
  const pending = [];
  let wake = null;
  const dec = new AudioDecoder({ output: (d) => { pending.push(d); wake?.(); }, error: (err) => postMessage({ log: `audio decode error ${err}` }) });
  dec.configure(m.aconfig);
  let next = 0, decodedFrames = 0, trimmed = 0, padded = 0, maxFill = 0, minFillWhilePlaying = Infinity;
  const tmpL = new Float32Array(8192), tmpR = new Float32Array(8192);
  const write = (d) => {
    const nf = d.numberOfFrames;
    d.copyTo(tmpL.subarray(0, nf), { planeIndex: 0, format: 'f32-planar' });
    if (d.numberOfChannels > 1) d.copyTo(tmpR.subarray(0, nf), { planeIndex: 1, format: 'f32-planar' }); else tmpR.set(tmpL.subarray(0, nf));
    let start = Math.round((d.timestamp / 1e6) * sr);
    let i0 = 0;
    if (start < next) { i0 = next - start; trimmed += Math.min(nf, i0); }
    while (start + i0 > next) { const j = (next % capacity) * 2; P[j] = 0; P[j + 1] = 0; next++; padded++; }
    for (let i = i0; i < nf; i++) { const j = (next % capacity) * 2; P[j] = tmpL[i]; P[j + 1] = tmpR[i]; next++; }
    decodedFrames += nf;
    d.close();
    Atomics.store(C, 0, next);
  };
  postMessage({ ready: true });
  for await (const p of m.asink.packets()) {
    if (stop) break;
    dec.decode(p.toEncodedAudioChunk());
    while (pending.length) write(pending.shift());
    // keep the ring filled ~aheadFrames ahead of the consumer, never overwrite unread samples
    for (;;) {
      if (stop) break;
      const read = Atomics.load(C, 1), fill = next - read;
      maxFill = Math.max(maxFill, fill);
      if (Atomics.load(C, 6) === 1 && read > 0) minFillWhilePlaying = Math.min(minFillWhilePlaying, fill);
      if (fill < aheadFrames && fill < capacity - 8192) break;
      await sleep(5);
    }
    if (pending.length === 0 && dec.decodeQueueSize > 8) await new Promise((r) => { wake = r; setTimeout(r, 5); });
  }
  if (!stop) { await dec.flush(); while (pending.length) write(pending.shift()); }
  postMessage({ done: { sampleRate: sr, decodedFrames, trimmedFrames: trimmed, paddedFrames: padded, ringFillMaxFrames: maxFill, ringFillMinWhilePlayingFrames: minFillWhilePlaying } });
};
