// Composed stage for one part (page or flow doc): a plain-JS mirror built once per part, then refreshed
// incrementally from the ops since its last frontier (findIdSpansBetween + exportJsonInIdSpan — the S4 primitive
// that scales with the ops, not the doc). Never calls doc.toJSON(); reads only the page tree it needs.
// The same primitive answers `changedSince(base)` for stale-field detection (IF-6.9 / IF-CS-010).
import { TREE } from './store.js';
import { TEXT_PATH } from './schema.js';

const SKIP = new Set(['id', 'kind', TEXT_PATH]);

export class PartStage {
  constructor(doc, partId, { cache } = {}) {
    this.doc = doc; this.partId = partId;
    this.nodes = new Map();      // NodeId → { id, tid, kind, parent, children: NodeId[], props, text, ver }
    this.byTid = new Map();      // TreeID → NodeId
    this.textCid = new Map();    // Text ContainerID → NodeId (lazy)
    this.rootId = null; this.frontiers = null; this.version = 0;
    if (cache) this.restore(cache); else this.build();
  }

  /** World cache (S4 recommendation): the mirror as JSON stored beside the part snapshot, stamped with its frontier. */
  toCache() { return JSON.stringify({ frontiers: this.frontiers, rootId: this.rootId, nodes: [...this.nodes.values()].map(({ ver, ...r }) => r) }); }
  restore(json) {
    const c = JSON.parse(json);
    for (const r of c.nodes) { r.ver = ++this.version; this.nodes.set(r.id, r); this.byTid.set(r.tid, r.id); }
    this.rootId = c.rootId; this.frontiers = c.frontiers;
    this.refresh();                // catch up with any ops after the cache's frontier
  }

  build() {
    this.rebuilds = (this.rebuilds ?? -1) + 1;     // 0 after construction; > 0 = the incremental path gave up
    this.nodes.clear(); this.byTid.clear();
    const tree = this.doc.getTree(TREE);
    const json = tree.toJSON();      // one page tree only (≈ 200 nodes), not the whole document
    const walk = (list, parent) => {
      const ids = [];
      for (const n of list) {
        const m = n.meta; const props = {};
        for (const k in m) if (!SKIP.has(k)) props[k] = m[k];
        const rec = { id: m.id, tid: n.id, kind: m.kind, parent, children: [], props, text: m[TEXT_PATH], ver: ++this.version };
        this.nodes.set(m.id, rec); this.byTid.set(n.id, m.id); ids.push(m.id);
        rec.children = walk(n.children, m.id);
      }
      return ids;
    };
    const roots = walk(json, null);
    this.rootId = roots[0];
    this.frontiers = this.doc.frontiers();
  }

  /** Bring the mirror up to date. Returns the set of NodeIds whose record changed ('all' after a rebuild). */
  refresh() {
    const now = this.doc.frontiers();
    if (sameFrontiers(now, this.frontiers)) return new Set();
    const spans = this.doc.findIdSpansBetween(this.frontiers, now);
    if (spans.retreat.length) { this.build(); return 'all'; }
    const dirty = new Set(); const treeOps = []; const containers = [];
    for (const sp of spans.forward) for (const ch of this.doc.exportJsonInIdSpan(sp)) for (const op of ch.ops) {
      if (op.container.endsWith(':Tree')) treeOps.push(op.content); else containers.push(op.container);
    }
    const tree = this.doc.getTree(TREE);
    // structural ops are applied to the mirror incrementally (create / move / delete), not by a rebuild
    if (treeOps.length && !this.applyTreeOps(tree, treeOps, dirty)) { this.build(); return 'all'; }
    for (const c of containers) {
      const nid = this.nodeOfContainer(c);
      if (nid) dirty.add(nid);
      else if (!c.endsWith(':Map') || !this.deletedTids?.has(c.slice(4, -4))) { this.build(); return 'all'; }   // unknown container
    }
    for (const nid of dirty) {
      const rec = this.nodes.get(nid); if (!rec) continue;
      const h = tree.getNodeByID(rec.tid); const d = h.data;
      try {
        const m = d.toJSON(); const props = {};
        for (const k in m) if (!SKIP.has(k)) props[k] = m[k];
        rec.props = props; rec.text = m[TEXT_PATH]; rec.ver = ++this.version;
      } finally { d.free?.(); h.free?.(); }
    }
    this.frontiers = now;
    return dirty;
  }

  /** Apply tree ops (in op order) to the mirror. Returns false when the mirror cannot follow (→ rebuild). */
  applyTreeOps(tree, ops, dirty) {
    const touched = new Set();
    this.deletedTids ??= new Set();
    const readRec = (tid, parent) => {
      const h = tree.getNodeByID(tid); const d = h.data;
      try {
        const m = d.toJSON(); const props = {};
        for (const k in m) if (!SKIP.has(k)) props[k] = m[k];
        return { id: m.id, tid, kind: m.kind, parent, children: [], props, text: m[TEXT_PATH], ver: ++this.version };
      } finally { d.free?.(); h.free?.(); }
    };
    const drop = (nid) => { const r = this.nodes.get(nid); if (!r) return; for (const c of r.children) if (this.nodes.get(c)?.parent === nid) drop(c); this.nodes.delete(nid); this.byTid.delete(r.tid); this.deletedTids.add(r.tid); };
    for (const t of ops) {
      const parentNid = t.parent == null ? null : this.byTid.get(t.parent);
      if (t.type === 'create') {
        if (tree.isNodeDeleted(t.target)) { this.deletedTids.add(t.target); continue; }
        if (t.parent != null && !parentNid) return false;
        const rec = readRec(t.target, parentNid);
        if (rec.id === undefined) return false;
        this.nodes.set(rec.id, rec); this.byTid.set(t.target, rec.id); dirty.add(rec.id); touched.add(parentNid);
        if (parentNid) this.nodes.get(parentNid).children.push(rec.id);
      } else if (t.type === 'move') {
        const nid = this.byTid.get(t.target); if (!nid) { if (tree.isNodeDeleted(t.target)) continue; return false; }
        const rec = this.nodes.get(nid);
        if (t.parent != null && !parentNid) return false;
        const old = this.nodes.get(rec.parent); if (old) old.children = old.children.filter((c) => c !== nid);
        touched.add(rec.parent); rec.parent = parentNid; touched.add(parentNid); dirty.add(nid);
        if (parentNid) this.nodes.get(parentNid).children.push(nid);
      } else if (t.type === 'delete') {
        const nid = this.byTid.get(t.target); if (!nid) continue;
        const rec = this.nodes.get(nid); touched.add(rec.parent); drop(nid); dirty.add(nid);
      } else return false;
    }
    for (const p of touched) {
      const rec = p && this.nodes.get(p); if (!rec) continue;
      const h = tree.getNodeByID(rec.tid);
      try { const ks = h.children() ?? []; rec.children = ks.map((k) => this.byTid.get(k.id)).filter(Boolean); ks.forEach((k) => k.free?.()); }
      finally { h.free?.(); }
      dirty.add(p);
    }
    return true;
  }

  nodeOfContainer(cid) {
    if (cid.endsWith(':Map')) { const tid = cid.slice(4, -4); return this.byTid.get(tid) ?? null; }
    if (cid.endsWith(':Text')) {
      if (this.textCid.has(cid)) return this.textCid.get(cid);
      const path = this.doc.getPathToContainer(cid);          // ['nodes', '<tid>', 'text.content']
      const nid = path && path[0] === TREE ? this.byTid.get(String(path[1])) ?? null : null;
      if (nid) this.textCid.set(cid, nid);
      return nid;
    }
    return null;
  }

  /**
   * What OTHER peers changed in this part since `base` (the frontier the agent's view was projected at).
   * Returns field-level facts: `${nodeId}|${path}`, text edits, tree creates/moves/deletes.
   */
  changedSince(base, excludePeer) {
    const out = { fields: new Set(), text: new Set(), moved: new Set(), deleted: new Set(), created: new Set(), ops: 0 };
    const now = this.doc.frontiers();
    if (sameFrontiers(now, base)) return out;
    const spans = this.doc.findIdSpansBetween(base, now);
    for (const sp of spans.forward) {
      if (String(sp.peer) === String(excludePeer)) continue;
      for (const ch of this.doc.exportJsonInIdSpan(sp)) for (const op of ch.ops) {
        out.ops++;
        const c = op.container; const ct = op.content;
        if (c.endsWith(':Tree')) {
          const nid = this.byTid.get(ct.target) ?? ct.target;
          if (ct.type === 'delete') out.deleted.add(nid); else if (ct.type === 'move') out.moved.add(nid); else out.created.add(nid);
          continue;
        }
        const nid = this.nodeOfContainer(c);
        if (!nid) continue;
        if (c.endsWith(':Text')) out.text.add(nid);
        else if (ct.key !== undefined) { if (ct.key === TEXT_PATH) out.text.add(nid); else out.fields.add(nid + '|' + ct.key); }
      }
    }
    return out;
  }

  get(nid) { return this.nodes.get(nid); }
}

export function sameFrontiers(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  const k = (f) => f.map((x) => `${x.peer}:${x.counter}`).sort().join(',');
  return k(a) === k(b);
}

/** Composed stage for a replica: one PartStage per part, created on first use (lazy page loading). */
export class Stage {
  constructor(replica) { this.replica = replica; this.parts = new Map(); this.nodeIndex = new Map(); }
  part(partId) {
    let s = this.parts.get(partId);
    if (!s) { s = new PartStage(this.replica.part(partId), partId); this.parts.set(partId, s); this.nodeIndex.clear(); }
    else if (!this.frozen) { const d = s.refresh(); if (d === 'all' || d.size) this.nodeIndex.clear(); }
    if (!this.nodeIndex.size) this.reindex();
    return s;
  }
  /** run fn with mirrors frozen (no refresh per lookup): the document cannot change during one compile */
  frozenDuring(fn) { for (const s of this.parts.values()) { const d = s.refresh(); if (d === 'all' || d.size) this.nodeIndex.clear(); } this.frozen = true; try { return fn(); } finally { this.frozen = false; } }
  reindex() { for (const [pid, s] of this.parts) for (const id of s.nodes.keys()) this.nodeIndex.set(id, pid); }
  /** which part holds a node (loads all parts on a miss; fine for the spike's documents) */
  partOf(nid) {
    if (!this.nodeIndex.has(nid)) { for (const pid of this.replica.parts.keys()) this.part(pid); this.reindex(); }
    return this.nodeIndex.get(nid);
  }
  node(nid) { const p = this.partOf(nid); return p ? this.part(p).get(nid) : undefined; }
  tokens() { return this.replica.tokens(); }
  assets() { return this.replica.assets(); }
}
