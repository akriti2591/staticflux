// AudioWorklet: pulls interleaved stereo f32 PCM from a SAB SPSC ring and advances the master clock.
// ctl (Int32): [0] write frames (producer), [1] read frames = media frames consumed (clock), [2] underrun frames,
// [3] context frame at end of last quantum, [4] seqlock for ([1],[3]), [5] beep count, [6] state (1 = play).
// beeps (Int32): media frame index of each detected beep onset (verifies no lost/duplicated samples).
class RingPlayer extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const { pcm, ctl, beeps, capacity } = opts.processorOptions;
    this.pcm = new Float32Array(pcm); this.ctl = new Int32Array(ctl); this.beeps = new Int32Array(beeps); this.cap = capacity;
    this.quiet = 1 << 30;
  }
  process(_in, outputs) {
    const out = outputs[0]; const L = out[0], R = out[1] ?? out[0]; const n = L.length;
    const C = this.ctl;
    let read = Atomics.load(C, 1);
    let got = 0;
    if (Atomics.load(C, 6) === 1) {
      const avail = Atomics.load(C, 0) - read;
      got = Math.min(n, avail);
      for (let i = 0; i < got; i++) {
        const j = ((read + i) % this.cap) * 2;
        const l = this.pcm[j];
        L[i] = l; R[i] = this.pcm[j + 1];
        // beep onset detector: |x| > 0.2 after >= 0.5 s of near-silence
        if (Math.abs(l) > 0.2) { if (this.quiet > 24000) { const k = Atomics.load(C, 5); if (k < this.beeps.length) this.beeps[k] = read + i; Atomics.store(C, 5, k + 1); } this.quiet = 0; } else this.quiet++;
      }
      if (got < n) Atomics.add(C, 2, n - got); // underrun: output silence, the clock does not advance
    }
    for (let i = got; i < n; i++) { L[i] = 0; R[i] = 0; }
    Atomics.add(C, 4, 1); // seqlock: odd = writing
    Atomics.store(C, 1, read + got);
    Atomics.store(C, 3, currentFrame + n);
    Atomics.add(C, 4, 1);
    return true;
  }
}
registerProcessor('ring-player', RingPlayer);
