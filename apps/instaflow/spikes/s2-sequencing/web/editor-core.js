// Editor side of the protocol: drains the input ring, runs the reducer, publishes deltas then the view frame.
import { Editor } from './model.js';
import { C, attachInputRing, drainInput, ViewFrameWriter, DeltaWriter, absNow } from './channels.js';

export class EditorHost {
  constructor(s, p) {
    this.ctl = s.ctl; this.input = attachInputRing(s.input);
    this.vf = new ViewFrameWriter(s.view); this.dw = new DeltaWriter(s.delta);
    this.p = p; this.epoch = 0; this.dropped = 0; this.snapshots = 0; this.batches = 0; this.maxBatch = 0;
    this.ed = new Editor((d) => {
      // Fault injection for E-1: silently lose every Nth delta (as if a record was lost) → render must detect the gap.
      if (p.gapEvery && d.v % p.gapEvery === 0) { this.dropped++; return; }
      this.dw.queue(d, this.epoch);
    });
    this.r = { seq: 0, type: 0, x: 0, y: 0, dx: 0, dy: 0, flags: 0 };
    this.vf.write(this.ed, this.epoch, this.ed.displayHash()); // initial frame
    this.dw.flush();
  }
  /** One batch. Returns number of input records applied. */
  step() {
    let dirty = false;
    const req = Atomics.load(this.ctl, C.RESNAP);
    if (req > this.epoch) { // E-1: render saw a gap → resnapshot under a new epoch
      this.epoch = req; this.snapshots++;
      this.dw.queueRaw(this.dw.encodeSnapshot(this.ed, this.epoch));
      dirty = true;
    }
    const r = this.r, ed = this.ed;
    const n = drainInput(this.input, 1, (rec, o) => {
      r.seq = rec[o]; r.type = rec[o + 2]; r.x = rec[o + 3]; r.y = rec[o + 4]; r.dx = rec[o + 5]; r.dy = rec[o + 6]; r.flags = rec[o + 7];
      ed.apply(r);
    });
    if (n) {
      if (this.p.editorLoad) { const t = performance.now() + this.p.editorLoad; while (performance.now() < t); } // simulated busy editor
      dirty = true; this.batches++; this.maxBatch = Math.max(this.maxBatch, n);
    }
    if (dirty || this.dw.pending.length) {
      this.dw.flush();                                       // deltas first …
      this.vf.write(ed, this.epoch, ed.displayHash());        // … then the frame that references them
      Atomics.store(this.ctl, C.EDITOR_IN, ed.inputSeq);
      Atomics.notify(this.ctl, C.EDITOR_IN); // wakes a latching render worker
    }
    return n;
  }
  final() {
    return {
      x: this.ed.x, y: this.ed.y, alive: this.ed.alive, docVersion: this.ed.docVersion, commits: this.ed.commits,
      cancels: this.ed.cancels, errors: this.ed.errors.length, errorSample: this.ed.errors[0] ?? null, inputSeq: this.ed.inputSeq,
      viewFrames: this.vf.viewSeq, deltasWritten: this.dw.records, dropped: this.dropped, snapshots: this.snapshots,
      batches: this.batches, maxBatch: this.maxBatch, finalHash: this.ed.committedHash(),
    };
  }
}
export { absNow };
