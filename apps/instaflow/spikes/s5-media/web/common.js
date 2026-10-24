// Shared helpers for the S5 spike: ticks, stats, PRNG, barcode reading, decoder-session helpers.
import * as MB from '../node_modules/mediabunny/dist/bundles/mediabunny.mjs';
export { MB };

// Timeline time is integer ticks at 705,600,000 per second (flicks). Convert only at the edges.
export const TPS = 705_600_000;
export const secToTicks = (s) => Math.round(s * TPS);
export const usToTicks = (us) => Math.round(us * (TPS / 1e6)); // 705.6 ticks per µs
export const ticksToSec = (t) => t / TPS;
export const ticksToUs = (t) => t / (TPS / 1e6);
export const frameTicks = (fps) => TPS / fps; // 30 fps -> 23,520,000 (exact integer)
export const sampleTicks = (sr) => TPS / sr; // 48 kHz -> 14,700 (exact integer)
export const frameIndexAt = (t, fps) => Math.floor(t / frameTicks(fps));

export function stats(xs) {
  if (!xs.length) return { n: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
  const r = (v) => Math.round(v * 100) / 100;
  return { n: s.length, min: r(s[0]), median: r(q(0.5)), p95: r(q(0.95)), p99: r(q(0.99)), max: r(s[s.length - 1]), mean: r(s.reduce((a, b) => a + b, 0) / s.length) };
}
export function mulberry32(seed) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 16-bit frame-index barcode drawn by scripts/gen-media.sh: box k at x = k*48+4..+40, y = 4..44, white = 1.
export const BARCODE_RECT = { x: 0, y: 0, width: 768, height: 48 };
export function decodeBarcode(getLuma) {
  let v = 0;
  for (let k = 0; k < 16; k++) if (getLuma(k * 48 + 24, 24) > 128) v |= 1 << k;
  return v;
}
/** Reads the barcode from a VideoFrame by copying only the 768x48 barcode rect (cheap CPU read). */
export async function frameBarcode(frame) {
  const fmt = frame.format;
  const opts = { rect: BARCODE_RECT };
  if (!fmt || !/^(I4|NV12)/.test(fmt)) opts.format = 'RGBA';
  const buf = new Uint8Array(frame.allocationSize(opts));
  const layout = await frame.copyTo(buf, opts);
  const { offset, stride } = layout[0];
  const bpp = opts.format ? 4 : 1;
  return decodeBarcode((x, y) => buf[offset + y * stride + x * bpp + (bpp === 4 ? 1 : 0)]);
}

/** Opens a Blob with Mediabunny (BlobSource = the OPFS File path in production). */
export async function openMedia(blob) {
  const input = new MB.Input({ source: new MB.BlobSource(blob), formats: MB.ALL_FORMATS });
  const video = await input.getPrimaryVideoTrack();
  const audio = await input.getPrimaryAudioTrack();
  return {
    input,
    video,
    audio,
    vconfig: video ? await video.getDecoderConfig() : null,
    aconfig: audio ? await audio.getDecoderConfig() : null,
    vsink: video ? new MB.EncodedPacketSink(video) : null,
    asink: audio ? new MB.EncodedPacketSink(audio) : null,
  };
}

/** Builds the keyframe index (what MediaIndex would persist as media.keyframeIndex). */
export async function keyframeIndex(sink) {
  const t0 = performance.now();
  const keys = [];
  let n = 0;
  for await (const p of sink.packets(undefined, undefined, { metadataOnly: true })) { n++; if (p.type === 'key') keys.push(p.timestamp); }
  return { keys, packets: n, ms: performance.now() - t0 };
}

/** Tiny notifier: wait() resolves on the next notify(). */
export class Notifier {
  #r = [];
  wait() { return new Promise((r) => this.#r.push(r)); }
  notify() { const r = this.#r; this.#r = []; for (const f of r) f(); }
}

/**
 * Forward decode session: (asset, track, rendition) → VideoDecoder + demux cursor + small output queue.
 * Used for playback (nearest) and export (exact, in order).
 */
export class ForwardSession {
  constructor(media, { maxQueue = 4, loop = true, optimizeForLatency = false, decoderConfig } = {}) {
    this.m = media; this.maxQueue = maxQueue; this.loop = loop; this.queue = []; this.n = new Notifier();
    this.decoded = 0; this.loops = 0; this.offset = 0; this.done = false; this.error = null;
    this.dec = new VideoDecoder({
      output: (f) => { if (this.offset) { const g = new VideoFrame(f, { timestamp: f.timestamp + this.offset }); f.close(); f = g; } this.queue.push(f); this.decoded++; this.n.notify(); },
      error: (e) => { this.error = e; this.n.notify(); },
    });
    this.dec.addEventListener('dequeue', () => this.n.notify());
    this.dec.configure({ ...(decoderConfig ?? media.vconfig), optimizeForLatency });
  }
  async start() {
    this.dur = await this.m.video.computeDuration();
    this.pump();
  }
  async pump() {
    try {
      for (;;) {
        for await (const p of this.m.vsink.packets()) {
          while (this.dec.decodeQueueSize > 3 || this.queue.length >= this.maxQueue) { if (this.closed) return; await this.n.wait(); }
          if (this.closed) return;
          this.dec.decode(p.toEncodedVideoChunk());
        }
        await this.dec.flush();
        if (!this.loop) { this.done = true; this.n.notify(); return; }
        // loop: subsequent frames get timestamps offset by the clip duration (monotonic media time)
        this.loops++;
        this.offset = Math.round(this.dur * 1e6) * this.loops; // flush() above guarantees earlier outputs are done
      }
    } catch (e) { if (!this.closed) { this.error = e; this.n.notify(); } }
  }
  async next() {
    while (!this.queue.length) { if (this.error) throw this.error; if (this.done) return null; await this.n.wait(); }
    const f = this.queue.shift(); this.n.notify(); return f;
  }
  peek() { return this.queue[0] ?? null; }
  close() { this.closed = true; for (const f of this.queue) f.close(); this.queue = []; try { this.dec.close(); } catch {} this.n.notify(); }
}
