// S2 channels over SharedArrayBuffer:
//  1. input ring    main → editor (+ render for the camera fast path). Binary, lossless, SPMC with per-reader cursors.
//  2. view frame    editor → render. One slot, "latest wins", guarded by a seqlock + checksum.
//  3. delta ring    editor → render. Sequenced variable-length records (docVersion, epoch, commits[]), lossless.
//  4. control       small Int32 words (stop, wake, resnapshot request, progress).
import { MAX_IDS, N } from './model.js';

export const absNow = () => performance.timeOrigin + performance.now();

// ---------- control ----------
export const C = { STOP: 0, WAKE: 1, RESNAP: 2, DRAWN_IN: 3, DRAWN_CAM: 4, EDITOR_IN: 5, EDITOR_DONE: 6, RENDER_READY: 7, EDITOR_READY: 8 };
export const makeControl = () => new Int32Array(new SharedArrayBuffer(64 * 4));
export function wake(ctl) { Atomics.add(ctl, C.WAKE, 1); Atomics.notify(ctl, C.WAKE); }

// ---------- 1. input ring ----------
// header Int32: [0]=written count, [1]=editor read count, [2]=render read count (fast path), [3]=render reader enabled
// record Float64 x8: seq, tAbs, type, x, y, dx, dy, flags
export const REC = 8;
export function makeInputRing(cap = 1 << 17) {
  return { hdr: new Int32Array(new SharedArrayBuffer(16 * 4)), rec: new Float64Array(new SharedArrayBuffer(cap * REC * 8)), cap };
}
export const attachInputRing = (r) => ({ hdr: r.hdr, rec: r.rec, cap: r.rec.length / REC });
export class InputWriter {
  constructor(ring, ctl) { this.r = ring; this.ctl = ctl; this.pending = []; this.maxPending = 0; }
  push(seq, t, type, x, y, dx, dy, flags) { this.pending.push([seq, t, type, x, y, dx, dy, flags]); this.flush(); }
  flush() {
    const { hdr, rec, cap } = this.r;
    let w = Atomics.load(hdr, 0);
    const minR = Atomics.load(hdr, 3) ? Math.min(Atomics.load(hdr, 1), Atomics.load(hdr, 2)) : Atomics.load(hdr, 1);
    let n = 0;
    while (this.pending.length && w - minR < cap) {
      const p = this.pending.shift(), o = (w % cap) * REC;
      for (let k = 0; k < REC; k++) rec[o + k] = p[k];
      w++; n++;
    }
    if (n) { Atomics.store(hdr, 0, w); wake(this.ctl); }
    this.maxPending = Math.max(this.maxPending, this.pending.length);
  }
}
/** Read all records after cursor `which` (1=editor, 2=render). Calls cb(rec, offset). Returns count. */
export function drainInput(r, which, cb, max = Infinity) {
  const w = Atomics.load(r.hdr, 0);
  let rd = Atomics.load(r.hdr, which), n = 0;
  while (rd < w && n < max) { cb(r.rec, (rd % r.cap) * REC); rd++; n++; }
  if (n) Atomics.store(r.hdr, which, rd);
  return n;
}

// ---------- 2. view-state frame (seqlock) ----------
// Int32 words: 0 lock | 1 viewSeq | 2 inputSeq | 3 docVersion | 4 gestureId | 5 dx | 6 dy | 7 nT | 8 nS | 9 hasMq
// 10..13 mq | 14 expectedHash | 15 epoch | 16..21 f64 cam tx,ty,z | 22..23 f64 tWritten | 24 checksum | 32.. targets | 32+MAX_IDS.. sel
const VF_WORDS = 32 + 2 * MAX_IDS;
export const makeViewFrame = () => new SharedArrayBuffer(VF_WORDS * 4);
function vfChecksum(i32) {
  let h = 0x811c9dc5;
  const nT = i32[7] >>> 0, nS = i32[8] >>> 0;
  for (let k = 1; k < 24; k++) h = Math.imul(h ^ i32[k], 16777619);
  for (let k = 0; k < Math.min(nT, MAX_IDS); k++) h = Math.imul(h ^ i32[32 + k], 16777619);
  for (let k = 0; k < Math.min(nS, MAX_IDS); k++) h = Math.imul(h ^ i32[32 + MAX_IDS + k], 16777619);
  return h | 0;
}
export class ViewFrameWriter {
  constructor(sab) { this.i32 = new Int32Array(sab); this.f64 = new Float64Array(sab); this.viewSeq = 0; }
  write(ed, epoch, hash) {
    const a = this.i32, f = this.f64, g = ed.g;
    Atomics.add(a, 0, 1); // odd: writing
    a[1] = ++this.viewSeq; a[2] = ed.inputSeq; a[3] = ed.docVersion;
    const drag = g && g.kind === 'drag';
    a[4] = g ? g.id : 0; a[5] = drag ? g.dx : 0; a[6] = drag ? g.dy : 0;
    const nT = drag ? Math.min(g.targets.length, MAX_IDS) : 0, nS = Math.min(ed.sel.length, MAX_IDS);
    a[7] = nT; a[8] = nS;
    if (g && g.kind === 'marquee') { a[9] = 1; a[10] = g.mq[0]; a[11] = g.mq[1]; a[12] = g.mq[2]; a[13] = g.mq[3]; } else a[9] = 0;
    a[14] = hash | 0; a[15] = epoch;
    f[8] = ed.cam.tx; f[9] = ed.cam.ty; f[10] = ed.cam.z; f[11] = absNow();
    for (let k = 0; k < nT; k++) a[32 + k] = g.targets[k];
    for (let k = 0; k < nS; k++) a[32 + MAX_IDS + k] = ed.sel[k];
    a[24] = vfChecksum(a);
    Atomics.add(a, 0, 1); // even: stable
  }
}
export class ViewFrameReader {
  constructor(sab, useSeqlock = true) {
    this.i32 = new Int32Array(sab); this.copy = new Int32Array(VF_WORDS); this.cf = new Float64Array(this.copy.buffer);
    this.useSeqlock = useSeqlock; this.retries = 0; this.tornAccepted = 0; this.reads = 0;
  }
  /** Returns a stable private copy, or null if no frame yet. */
  read() {
    const a = this.i32, c = this.copy;
    for (let attempt = 0; ; attempt++) {
      const s1 = Atomics.load(a, 0);
      if (this.useSeqlock && (s1 & 1)) { this.retries++; continue; }
      const nT = Math.min(a[7] >>> 0, MAX_IDS), nS = Math.min(a[8] >>> 0, MAX_IDS);
      for (let k = 1; k < 32; k++) c[k] = a[k];
      for (let k = 0; k < nT; k++) c[32 + k] = a[32 + k];
      for (let k = 0; k < nS; k++) c[32 + MAX_IDS + k] = a[32 + MAX_IDS + k];
      const s2 = Atomics.load(a, 0);
      if (this.useSeqlock && s1 !== s2) { this.retries++; continue; }
      this.reads++;
      // Checksum detects torn frames that slipped through (must stay 0 with the seqlock on).
      if (vfChecksum(c) !== c[24]) {
        this.tornAccepted++;
        if (!this.tornSamples) this.tornSamples = [];
        if (this.tornSamples.length < 4) { const again = Array.from(a.subarray(0, 32)); this.tornSamples.push({ s1, s2, attempt, copy: Array.from(c.subarray(0, 32)), now: again, nT, nS }); }
      }
      if (c[1] === 0) return null;
      const f = this.cf;
      return {
        viewSeq: c[1], inputSeq: c[2], docVersion: c[3], gestureId: c[4], dx: c[5], dy: c[6], nT: c[7], nS: c[8],
        mq: c[9] ? [c[10], c[11], c[12], c[13]] : null, expectedHash: c[14] >>> 0, epoch: c[15],
        cam: { tx: f[8], ty: f[9], z: f[10] }, tWritten: f[11],
        targets: c.subarray(32, 32 + Math.min(c[7] >>> 0, MAX_IDS)), sel: c.subarray(32 + MAX_IDS, 32 + MAX_IDS + Math.min(c[8] >>> 0, MAX_IDS)),
      };
    }
  }
}

// ---------- 3. scene delta ring ----------
// hdr Int32: [0] written words, [1] read words. Record: len, kind(1 delta|2 snapshot), v, epoch, nC, commits.., nCh, (id,x,y)*, nDead, dead*
export const KIND = { DELTA: 1, SNAP: 2 };
export function makeDeltaRing(capWords = 1 << 21) {
  return { hdr: new Int32Array(new SharedArrayBuffer(8 * 4)), buf: new Int32Array(new SharedArrayBuffer(capWords * 4)) };
}
export class DeltaWriter {
  constructor(ring) { this.hdr = ring.hdr; this.buf = ring.buf; this.cap = ring.buf.length; this.pending = []; this.records = 0; }
  _encode(d, epoch) {
    const n = 7 + d.commits.length + 3 * d.ids.length + d.dead.length, o = new Int32Array(n);
    let k = 0;
    o[k++] = n; o[k++] = KIND.DELTA; o[k++] = d.v; o[k++] = epoch; o[k++] = d.commits.length;
    for (const g of d.commits) o[k++] = g;
    o[k++] = d.ids.length;
    for (let i = 0; i < d.ids.length; i++) { o[k++] = d.ids[i]; o[k++] = d.xs[i]; o[k++] = d.ys[i]; }
    o[k++] = d.dead.length;
    for (const x of d.dead) o[k++] = x;
    return o;
  }
  encodeSnapshot(ed, epoch) {
    const n = 4 + 3 * N, o = new Int32Array(n);
    o[0] = n; o[1] = KIND.SNAP; o[2] = ed.docVersion; o[3] = epoch;
    for (let i = 0; i < N; i++) { o[4 + 3 * i] = ed.x[i]; o[5 + 3 * i] = ed.y[i]; o[6 + 3 * i] = ed.alive[i]; }
    return o;
  }
  queue(d, epoch) { this.pending.push(this._encode(d, epoch)); }
  queueRaw(words) { this.pending.push(words); }
  /** Publish as many queued records as fit. Returns true when the queue is empty. */
  flush() {
    const h = this.hdr, b = this.buf, cap = this.cap;
    let w = Atomics.load(h, 0);
    const r = Atomics.load(h, 1);
    while (this.pending.length) {
      const rec = this.pending[0], pos = w % cap, tail = cap - pos;
      const need = rec.length <= tail ? rec.length : tail + rec.length;
      if (cap - (w - r) < need) break;
      let p = pos;
      if (rec.length > tail) { b[pos] = -1; w += tail; p = 0; }
      b.set(rec, p); w += rec.length;
      this.pending.shift(); this.records++;
    }
    Atomics.store(h, 0, w);
    return this.pending.length === 0;
  }
}
export class DeltaReader {
  constructor(ring) { this.hdr = ring.hdr; this.buf = ring.buf; this.cap = ring.buf.length; }
  /** Peek next record header without consuming: { kind, v, epoch, pos, len } or null. */
  peek() {
    const h = this.hdr, b = this.buf, cap = this.cap;
    const w = Atomics.load(h, 0);
    let r = Atomics.load(h, 1);
    if (r >= w) return null;
    if (b[r % cap] === -1) { r += cap - (r % cap); Atomics.store(h, 1, r); if (r >= w) return null; }
    const p = r % cap;
    return { len: b[p], kind: b[p + 1], v: b[p + 2], epoch: b[p + 3], pos: p };
  }
  consume(hd) { Atomics.store(this.hdr, 1, Atomics.load(this.hdr, 1) + hd.len); }
}
