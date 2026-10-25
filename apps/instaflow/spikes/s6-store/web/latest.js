// Latest store for one tree asset: op log segments + per-part snapshots + head (DOCUMENT-FORMAT §5.2).
// Synthetic "CRDT": a part's state is the set of commit ids applied to it (idempotent, commutative),
// which is exactly what the durability test needs to check.
import { pool, enc, dec, canonicalJSON, sha256Hex, putBlob, getBlob, readHead, casHead, frame, parseFrames, segName, segNum } from './core.js';

export class LatestStore {
  constructor(be, { lockPrefix, asset, peer }) {
    Object.assign(this, { be, lockPrefix, asset, peer });
    this.logDir = ['log', asset];
    this.ids = new Set(); this.parts = new Map(); this.dirty = new Set();
    this.head = null; this.seg = null; this.io = Promise.resolve();
    this.busyMs = 0; this.appended = 0; this.compactions = 0; this.casConflicts = 0;
  }
  /** serialise all I/O of this store (appends and compactions) */
  run(fn) { const p = this.io.then(async () => { const t = performance.now(); try { return await fn(); } finally { this.busyMs += performance.now() - t; } }); this.io = p.catch(() => {}); return p; }

  #add(id, part, fromSnapshot = false) {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    let s = this.parts.get(part); if (!s) this.parts.set(part, (s = new Set()));
    s.add(id); if (!fromSnapshot) this.dirty.add(part); return true;
  }

  async recover() {
    const t0 = performance.now();
    const rep = { headStatus: null, generation: 0, partsLoaded: 0, partsMissing: 0, partsBadDigest: 0, segments: 0, staleSegments: 0, tornTails: 0, records: 0, dupRecords: 0, tmpCleaned: 0 };
    const hr = await readHead(this.be, this.asset);
    rep.headStatus = hr.status;
    if (hr.status === 'torn') rep.headTorn = hr;
    this.head = hr.head ?? { schema: 'instaflow.head/1', asset: this.asset, generation: 0, engine: 'spike/1', treeSchema: 1, minReader: 1, minWriter: 1, parts: {}, logFrom: 0, undoHorizon: { steps: 200 }, milestones: [], pinned: [] };
    rep.generation = this.head.generation;
    const tp = performance.now();
    const loaded = await pool(Object.entries(this.head.parts), 8, async ([part, ref]) => {
      const hex = ref.digest.slice(7);
      const bytes = await getBlob(this.be, hex);
      if (!bytes) { rep.partsMissing++; return null; }
      if (await sha256Hex(bytes) !== hex) { rep.partsBadDigest++; return null; }
      rep.partsLoaded++; return [part, JSON.parse(dec.decode(bytes)).ids];
    });
    for (const x of loaded) if (x) for (const id of x[1]) this.#add(id, x[0], true);
    rep.partsMs = performance.now() - tp;
    const ts = performance.now();
    let maxNum = this.head.logFrom;
    const segs = (await this.be.list(this.logDir)).map(([n]) => n).filter((n) => n.endsWith('.bin')).sort();
    const live = [];
    for (const name of segs) {
      const num = segNum(name); maxNum = Math.max(maxNum, num);
      if (num < this.head.logFrom) { rep.staleSegments++; await this.be.remove(this.logDir, name); } else live.push(name);
    }
    const bodies = await pool(live, 8, (name) => this.be.read(this.logDir, name, { viaFile: true }));
    for (const bytes of bodies) {
      const { recs, torn } = parseFrames(bytes);
      rep.segments++; if (torn) rep.tornTails++;
      for (const r of recs) for (const c of JSON.parse(dec.decode(r))) { rep.records++; if (!this.#add(c.id, c.part)) rep.dupRecords++; }
    }
    rep.logMs = performance.now() - ts;
    // orphaned temp files from a crashed atomic write
    for (const [n] of await this.be.list(['heads'])) if (n.includes('.tmp-')) { await this.be.remove(['heads'], n); rep.tmpCleaned++; }
    // everything recovered from the log is not yet in a snapshot
    this.segNo = maxNum + 1;
    await this.#openSegment();
    rep.recoveredIds = this.ids.size; rep.dirtyParts = this.dirty.size; rep.ms = performance.now() - t0;
    return rep;
  }

  async #openSegment() {
    const d = await this.be.dir(this.logDir);
    const name = segName(this.segNo, this.peer);
    if (this.be.kind === 'sync') {
      const fh = await d.getFileHandle(name, { create: true });
      this.seg = { name, h: await fh.createSyncAccessHandle(), off: 0 };
    } else this.seg = { name };
  }
  async #closeSegment() { if (this.seg?.h) { this.seg.h.flush(); this.seg.h.close(); } this.seg = null; }

  /** durable append of a batch; resolves after flush. Returns the commits that were new. */
  append(commits) {
    return this.run(async () => {
      const seen = new Set();
      const fresh = commits.filter((c) => !this.ids.has(c.id) && !seen.has(c.id) && seen.add(c.id));
      if (!fresh.length) return fresh;
      const rec = frame(enc.encode(JSON.stringify(fresh)));
      if (this.be.kind === 'sync') {
        let off = 0; while (off < rec.length) off += this.seg.h.write(rec.subarray(off), { at: this.seg.off + off });
        this.seg.h.flush(); this.seg.off += rec.length;
        this.be.stats.bytesWritten += rec.length;
      } else {
        // folder backend: no appends (createWritable copies the file); one immutable segment per batch
        await this.be.writeAtomic(this.logDir, segName(this.segNo, this.peer), rec);
        this.segNo++;
      }
      for (const c of fresh) this.#add(c.id, c.part);
      this.appended += fresh.length;
      return fresh;
    });
  }

  /**
   * Snapshot dirty parts, CAS the head (logFrom = new segment), drop older segments. hooks: fault injection.
   * Only the segment roll + state capture is serialised with appends; blob writes and the head swap run
   * concurrently with new appends (which land in the new segment).
   */
  async compact(hooks = {}) {
    if (this.compacting || !this.dirty.size) return { skipped: true };
    this.compacting = true;
    const t0 = performance.now();
    let dirty = [];
    try {
      const { logFrom, snaps } = await this.run(async () => {
        if (this.be.kind === 'sync') { await this.#closeSegment(); this.segNo++; await this.#openSegment(); }
        // incremental: at most `chunk` parts per head swap so a short-lived leader still makes progress.
        // logFrom only advances when no dirty part remains (every older record is then in some snapshot);
        // recovery marks a part dirty only for log records NOT already in its snapshot.
        dirty = [...this.dirty].slice(0, hooks.chunk ?? 16); for (const p of dirty) this.dirty.delete(p);
        return { logFrom: this.dirty.size ? this.head.logFrom : this.segNo, snaps: dirty.map((p) => [p, enc.encode(canonicalJSON({ part: p, ids: [...this.parts.get(p)].sort() }))]) };
      });
      const parts = { ...this.head.parts };
      for (const [p, bytes] of snaps) {
        const hex = await sha256Hex(bytes);
        await putBlob(this.be, hex, bytes);
        parts[p] = { digest: `sha256:${hex}`, size: bytes.length, mime: 'application/x-spike-part' };
      }
      if (hooks.afterBlobs) await hooks.afterBlobs();
      const res = await casHead(this.be, this.lockPrefix, this.asset, this.head.generation, { ...this.head, parts, logFrom }, { beforeMove: hooks.beforeMove });
      if (!res.ok) { this.casConflicts++; throw Object.assign(new Error(res.error.code), { sf: res.error }); }
      this.head = res.head; this.compactions++;
      if (hooks.afterHead) await hooks.afterHead();
      for (const [n] of await this.be.list(this.logDir)) if (n.endsWith('.bin') && segNum(n) < logFrom) await this.be.remove(this.logDir, n);
      this.busyMs += performance.now() - t0;
      return { ok: true, generation: this.head.generation, parts: dirty.length };
    } catch (e) { for (const p of dirty) this.dirty.add(p); throw e; }
    finally { this.compacting = false; }
  }
  async close() { await this.run(() => this.#closeSegment()); }
}
