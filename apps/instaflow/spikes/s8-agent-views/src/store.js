// Canonical model in Loro (D14): ONE CRDT doc per page (and per flow), plus a small root doc for page order,
// brand tokens and asset facts. Each actor (human tab, each agent session) is its own peer (S4 rule) holding a
// replica of every doc; replicas are linked with subscribeLocalUpdates (in-process stand-in for the sync port).
//
// Page doc: LoroTree 'nodes' whose single root is the page node. Node `data` map = per-property LWW opinions keyed
// by property path (`spatial.x`, `temporal.start` in ticks…). Text nodes hold a LoroText under `text.content`.
import * as L from 'loro-crdt';
import { TEXT_PATH } from './schema.js';

export const TREE = 'nodes';
export { L };

function newDoc(peer) {
  const d = new L.LoroDoc();
  d.setPeerId(peer);
  return d;
}

/** Write a node spec under a parent tree node (or as a root). Frees every handle it touches (S4 leak rule). */
export function writeNode(doc, parentTid, index, spec) {
  const tree = doc.getTree(TREE);
  const h = parentTid == null ? tree.createNode(undefined, index) : tree.createNode(parentTid, index);
  const data = h.data;
  try {
    data.set('id', spec.id);
    data.set('kind', spec.kind);
    for (const [k, v] of Object.entries(spec.props ?? {})) if (v !== undefined) data.set(k, v);
    if (spec.text !== undefined) {
      const t = data.setContainer(TEXT_PATH, new L.LoroText());
      t.insert(0, spec.text);
      t.free?.();
    }
    const tid = h.id;
    (spec.children ?? []).forEach((c, i) => writeNode(doc, tid, i, c));
    return tid;
  } finally { data.free?.(); h.free?.(); }
}

/** A replica of the whole document for one actor (peer). */
export class Replica {
  constructor(peer, actor) { this.peer = peer; this.actor = actor; this.root = null; this.parts = new Map(); }

  static fromSeed(seed, peer, actor = 'human:guest') {
    const r = new Replica(peer, actor);
    r.root = newDoc(peer);
    const meta = r.root.getMap('meta'); meta.set('title', seed.title); meta.set('kind', seed.kind);
    const tokens = r.root.getMap('tokens'); for (const [k, v] of Object.entries(seed.tokens ?? {})) tokens.set(k, v);
    const assets = r.root.getMap('assets'); for (const [k, v] of Object.entries(seed.assets ?? {})) assets.set(k, v);
    const order = r.root.getList('pages');
    for (const p of seed.pages) {
      order.push(p.id);
      const d = newDoc(peer);
      d.getTree(TREE).enableFractionalIndex(0);
      writeNode(d, null, 0, p);
      d.commit({ message: JSON.stringify({ actor: 'system:seed' }) });
      r.parts.set('page:' + p.id, d);
    }
    for (const f of seed.flows ?? []) {
      const d = newDoc(peer);
      d.getTree(TREE).enableFractionalIndex(0);
      writeNode(d, null, 0, f);
      d.commit({ message: JSON.stringify({ actor: 'system:seed' }) });
      r.parts.set('flow:' + f.id, d);
    }
    r.root.commit({ message: JSON.stringify({ actor: 'system:seed' }) });
    return r;
  }

  /** Open another actor's replica from this one's snapshots (a new peer), optionally linked both ways. */
  openPeer(peer, actor, { link = true } = {}) {
    const r = new Replica(peer, actor);
    const clone = (d) => { const c = new L.LoroDoc(); c.import(d.export({ mode: 'snapshot' })); c.setPeerId(peer); return c; };
    r.root = clone(this.root);
    for (const [id, d] of this.parts) r.parts.set(id, clone(d));
    if (link) r._unlink = linkReplicas(this, r);
    return r;
  }

  part(id) { return this.parts.get(id); }
  pageIds() { return this.root.getList('pages').toArray(); }
  tokens() { return this.root.getMap('tokens').toJSON(); }
  assets() { return this.root.getMap('assets').toJSON(); }
  meta() { return this.root.getMap('meta').toJSON(); }
  /** version token per part: frontiers (opaque to agents; the view header shows a short hash of it). */
  frontiers(partIds = [...this.parts.keys()]) { const o = {}; for (const p of partIds) o[p] = this.parts.get(p).frontiers(); return o; }
  free() { this._unlink?.(); for (const d of this.parts.values()) d.free(); this.root.free(); }
}

export function linkReplicas(a, b) {
  const subs = [];
  const pair = (x, y) => { subs.push(x.subscribeLocalUpdates((u) => y.import(u))); subs.push(y.subscribeLocalUpdates((u) => x.import(u))); };
  pair(a.root, b.root);
  for (const [id, d] of a.parts) pair(d, b.parts.get(id));
  return () => subs.forEach((u) => u());
}

/** Canonical, CRDT-free state of a part (for equality checks only; small docs only — never on a big doc). */
export function partState(doc) {
  const out = [];
  const walk = (list, parent) => list.forEach((n, i) => {
    const meta = { ...n.meta };
    out.push({ id: meta.id, parent, i, meta });
    walk(n.children, meta.id);
  });
  walk(doc.getTree(TREE).toJSON(), null);
  return out;
}
export function replicaState(r) {
  const o = { root: { meta: r.meta(), tokens: r.tokens(), pages: r.pageIds() } };
  for (const [id, d] of [...r.parts].sort()) o[id] = partState(d);
  return JSON.stringify(o);
}
