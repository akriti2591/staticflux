// Render side of the protocol. Rebuilds the display from (a) scene deltas and (b) the latest view frame,
// independently of the editor's reducer, so the per-frame display hash is a real end-to-end check.
//
// Protocol rule (E-1 + E-2): read the view frame F first, then apply deltas only up to F.docVersion.
// Draw F only if the committed state is exactly at F.docVersion. Overlay g therefore disappears in exactly
// the frame that applies the delta committing g. `naive=1` disables the rule to validate the detector.
import { N, initialLayout, mix, viewPartHash, camApplyWheel, T } from './model.js';
import { C, ViewFrameReader, DeltaReader, KIND, attachInputRing, drainInput, absNow } from './channels.js';

export class RenderCore {
  constructor(s, p, gfx) {
    this.p = p; this.ctl = s.ctl; this.gfx = gfx;
    this.vr = new ViewFrameReader(s.view, p.seqlock !== 0);
    this.dr = new DeltaReader(s.delta);
    this.input = p.mode === 'fast' ? attachInputRing(s.input) : null;
    this.inHdr = s.input.hdr; this.latchWaits = []; this.latchHits = 0; this.latchMisses = 0;
    const L = initialLayout(); this.x = L.x; this.y = L.y; this.alive = L.alive;
    this.sum = 0; for (let i = 0; i < N; i++) this.sum = (this.sum + mix(i, this.x[i], this.y[i])) >>> 0;
    this.docVersion = 0; this.epoch = 0; this.awaitSnap = false;
    this.committedBy = new Map(); // gestureId → docVersion that committed it
    this.camQ = []; this.ringSeq = 0;
    this.last = { viewSeq: -1, docVersion: -1, tx: NaN, ty: NaN, z: NaN };
    this.c = { gaps: 0, resnapRequests: 0, snapshotsApplied: 0, staleEpochSkipped: 0, waitFrames: 0, ticks: 0, draws: 0, orderViolations: 0, overlayAfterCommit: 0 };
    // per-drawn-frame log (columns)
    this.L = { viewSeq: [], inSeq: [], camSeq: [], docV: [], fDocV: [], hash: [], exp: [], tx: [], ty: [], z: [], gid: [], tWritten: [], tRaf: [], tDraw: [], tSubmit: [], tGpu: [], tPresent: [] };
    this.pendingPresent = -1;
    this.tickDt = []; this.lastTick = 0; this.tickAbs = [];
  }
  _applyDelta(hd) {
    const b = this.dr.buf; let k = hd.pos + 4;
    const nC = b[k++];
    for (let i = 0; i < nC; i++) this.committedBy.set(b[k++], hd.v);
    const nCh = b[k++];
    for (let i = 0; i < nCh; i++) {
      const id = b[k++], nx = b[k++], ny = b[k++];
      this.sum = (this.sum - mix(id, this.x[id], this.y[id]) + mix(id, nx, ny)) >>> 0; this.x[id] = nx; this.y[id] = ny;
    }
    const nD = b[k++];
    for (let i = 0; i < nD; i++) { const id = b[k++]; if (this.alive[id]) { this.sum = (this.sum - mix(id, this.x[id], this.y[id])) >>> 0; this.alive[id] = 0; } }
    if (hd.v !== this.docVersion + 1) this.c.orderViolations++;
    this.docVersion = hd.v;
  }
  _applySnap(hd) {
    const b = this.dr.buf; let s = 0;
    for (let i = 0; i < N; i++) {
      const o = hd.pos + 4 + 3 * i; this.x[i] = b[o]; this.y[i] = b[o + 1]; this.alive[i] = b[o + 2];
      if (this.alive[i]) s = (s + mix(i, this.x[i], this.y[i])) >>> 0;
    }
    this.sum = s; this.docVersion = hd.v; this.epoch = hd.epoch; this.awaitSnap = false; this.c.snapshotsApplied++;
  }
  /** Apply sequenced deltas up to `limit` (docVersion). E-1: in order; a gap requests a resnapshot. */
  _pumpDeltas(limit) {
    for (;;) {
      const hd = this.dr.peek();
      if (!hd) return;
      if (hd.kind === KIND.SNAP) {
        if (hd.epoch > this.epoch || this.awaitSnap) { this._applySnap(hd); this.dr.consume(hd); continue; }
        this.dr.consume(hd); continue;
      }
      if (hd.epoch < this.epoch || this.awaitSnap) { this.c.staleEpochSkipped++; this.dr.consume(hd); continue; }
      if (hd.v > limit) return;
      if (hd.v <= this.docVersion) { this.c.orderViolations++; this.dr.consume(hd); continue; }
      if (hd.v !== this.docVersion + 1) { // gap: keep last good frame, ask for a resnapshot
        this.c.gaps++; this.awaitSnap = true; this.c.resnapRequests++;
        Atomics.store(this.ctl, C.RESNAP, this.epoch + 1);
        Atomics.add(this.ctl, C.WAKE, 1); Atomics.notify(this.ctl, C.WAKE);
        continue;
      }
      this._applyDelta(hd); this.dr.consume(hd);
    }
  }
  /** One rAF. rafAbs = absolute timestamp of this rAF. */
  tick(rafAbs) {
    this.c.ticks++;
    if (this.lastTick) this.tickDt.push(rafAbs - this.lastTick);
    this.lastTick = rafAbs; this.tickAbs.push(rafAbs);
    if (this.pendingPresent >= 0) { this.L.tPresent[this.pendingPresent] = rafAbs; this.pendingPresent = -1; }
    // Latch (split mode): input already in the ring but not yet in a view frame → wait up to `latch` ms for the
    // editor inside this rAF instead of drawing a stale frame and paying a whole extra frame.
    if (this.p.latch && this.p.mode !== 'colo') {
      const target = Atomics.load(this.inHdr, 0), t0 = performance.now(), dl = t0 + this.p.latch;
      let cur = Atomics.load(this.ctl, C.EDITOR_IN);
      if (cur < target) {
        while (cur < target) { const rem = dl - performance.now(); if (rem <= 0) break; Atomics.wait(this.ctl, C.EDITOR_IN, cur, rem); cur = Atomics.load(this.ctl, C.EDITOR_IN); }
        this.latchWaits.push(performance.now() - t0);
        if (cur >= target) this.latchHits++; else this.latchMisses++;
      }
    }
    const naive = this.p.naive;
    if (naive) this._pumpDeltas(Infinity);           // naive: deltas and frames consumed independently
    const F = this.vr.read();
    if (!F) return false;
    if (!naive) {
      this._pumpDeltas(F.docVersion);
      if (this.awaitSnap || this.docVersion !== F.docVersion) { this.c.waitFrames++; return false; } // keep last good frame
    }
    // camera: the frame's camera, plus (fast path) wheel records the editor has not consumed yet
    const cam = { tx: F.cam.tx, ty: F.cam.ty, z: F.cam.z };
    let camSeq = F.inputSeq;
    if (this.input) {
      drainInput(this.input, 2, (rec, o) => {
        this.ringSeq = rec[o];
        if (rec[o + 2] === T.WHEEL) this.camQ.push([rec[o], rec[o + 3], rec[o + 4], rec[o + 5], rec[o + 6], rec[o + 7]]);
      });
      while (this.camQ.length && this.camQ[0][0] <= F.inputSeq) this.camQ.shift();
      for (const q of this.camQ) camApplyWheel(cam, q[1], q[2], q[3], q[4], q[5]);
      camSeq = Math.max(F.inputSeq, this.ringSeq);
    }
    const l = this.last;
    if (F.viewSeq === l.viewSeq && this.docVersion === l.docVersion && cam.tx === l.tx && cam.ty === l.ty && cam.z === l.z) return false;
    // display hash of exactly what we draw
    let h = this.sum;
    if (F.gestureId && F.nT && (F.dx || F.dy)) {
      if (this.committedBy.has(F.gestureId)) this.c.overlayAfterCommit++; // E-2 double-draw signature
      for (const i of F.targets) if (this.alive[i]) h = (h - mix(i, this.x[i], this.y[i]) + mix(i, this.x[i] + F.dx, this.y[i] + F.dy)) >>> 0;
    }
    h = (h + viewPartHash(F.sel, F.sel.length, F.mq)) >>> 0;
    const tDraw = absNow();
    this.gfx.draw(this, F, cam);
    const tSubmit = absNow();
    const L = this.L, idx = L.viewSeq.length;
    L.viewSeq.push(F.viewSeq); L.inSeq.push(F.inputSeq); L.camSeq.push(camSeq); L.docV.push(this.docVersion); L.fDocV.push(F.docVersion);
    L.hash.push(h); L.exp.push(F.expectedHash); L.tx.push(cam.tx); L.ty.push(cam.ty); L.z.push(cam.z); L.gid.push(F.nT && (F.dx || F.dy) ? F.gestureId : 0);
    L.tWritten.push(F.tWritten); L.tRaf.push(rafAbs); L.tDraw.push(tDraw); L.tSubmit.push(tSubmit); L.tGpu.push(0); L.tPresent.push(0);
    this.pendingPresent = idx;
    this.gfx.onDone?.((t) => { L.tGpu[idx] = t; });
    Object.assign(l, { viewSeq: F.viewSeq, docVersion: this.docVersion, tx: cam.tx, ty: cam.ty, z: cam.z });
    this.c.draws++;
    Atomics.store(this.ctl, C.DRAWN_IN, F.inputSeq); Atomics.store(this.ctl, C.DRAWN_CAM, camSeq);
    return true;
  }
  final() {
    let h = 0; for (let i = 0; i < N; i++) if (this.alive[i]) h = (h + mix(i, this.x[i], this.y[i])) >>> 0;
    return {
      x: this.x, y: this.y, alive: this.alive, docVersion: this.docVersion, finalHash: h, counters: { ...this.c, latchHits: this.latchHits, latchMisses: this.latchMisses, seqlockRetries: this.vr.retries, tornAccepted: this.vr.tornAccepted, tornSamples: this.vr.tornSamples ?? [], frameReads: this.vr.reads },
      log: this.L, gfx: this.gfx.info, tickDt: this.tickDt, latchWaits: this.latchWaits, tickAbs: this.tickAbs,
    };
  }
}
