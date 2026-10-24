// Fragment upserts (IF-6.6): the agent sends elements by id; they are diffed against THE BASE VIEW IT READ (never
// against current state), and only what changed becomes ops. Grammar (markup; JSON views use the same shape):
//   <text id="n4" .../>                existing element: changed attributes / text become set/text ops;
//                                      omitted attributes are left unchanged
//   <x id="n4" parent="n2" after="n3"> move / reorder (after="" = first, i.e. back-most)
//   <group id="n2">…children…</group>  a container WITH children lists all of them: missing ones are deleted,
//                                      new:… ones are inserted, order is applied
//   <rect id="new:badge" parent="n1" after="n9" …/>  insert
//   <delete id="n7"/>                  delete
import { parseXml, elToNode, jsonToNode, nodeToMarkup } from './codec.js';
import { itemFromJson, itemJson, TL_DERIVED } from './views.js';
import { KINDS } from './schema.js';

export function parseMarkupFragment(text) {
  const els = parseXml(text);
  const top = els.length === 1 && els[0].tag === 'fragment' ? els[0].children : els;
  return top.map((e) => (e.tag === 'delete' ? { del: e.attrs.id } : elToNode(e)));
}
/** JSON fragment: { "upsert": [node|item|track…], "delete": ["n7"] } */
export function parseJsonFragment(obj, kind) {
  const o = typeof obj === 'string' ? JSON.parse(obj) : obj;
  const conv = kind === 'timeline' ? timelineNode : jsonToNode;
  return [...(o.upsert ?? []).map(conv), ...(o.delete ?? []).map((id) => ({ del: id }))];
}
function timelineNode(o) {
  if (o.kind === 'track' || Array.isArray(o.items)) {
    const { id, kind, items, parent, after, ...attrs } = o;
    const n = { id, kind: 'track', attrs };
    if (items) n.children = items.map(itemFromJson);
    return n;
  }
  return itemFromJson(o);
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** fragment nodes + base view index → agent ops (then compiled like any other ops) */
export function fragmentToOps(frags, baseIndex) {
  const ops = [];
  const diffNode = (F, parentH, afterH) => {
    if (F.del) { ops.push({ op: 'delete', id: F.del }); return; }
    if (typeof F.id === 'string' && F.id.startsWith('new:')) {
      const parent = F.parent ?? parentH;
      const el = { kind: F.kind, ...F.attrs };
      if (F.text !== undefined) el.text = F.text;
      const op = { op: 'insert', tempId: F.id, parent, el: { kind: F.kind, attrs: F.attrs, text: F.text, children: [] } };
      if (F.after !== undefined) op.after = F.after === '' ? null : F.after; else if (afterH !== undefined) op.after = afterH;
      ops.push(op);
      // nested children of a new container → inserted after it
      let prev = null;
      for (const c of F.children ?? []) { diffNode(c, F.id, prev); prev = c.id; }
      return;
    }
    const B = baseIndex.get(F.id);
    if (!B) { ops.push({ op: 'set', id: F.id, attrs: F.attrs ?? {} }); return; }   // compiler reports IF-CS-002
    const changed = {};
    for (const [a, v] of Object.entries(F.attrs ?? {})) {
      if (TL_DERIVED.includes(a) || a === 'kind') continue;
      if (!eq(B.node.attrs[a], v)) changed[a] = v;
    }
    if (Object.keys(changed).length) ops.push({ op: 'set', id: F.id, attrs: changed });
    if (F.text !== undefined && B.node.text !== undefined && F.text !== B.node.text) ops.push({ op: 'text', id: F.id, value: F.text });
    const targetParent = F.parent ?? parentH;
    if (targetParent !== undefined && targetParent !== B.parent) {
      const op = { op: 'move', id: F.id, parent: targetParent };
      if (F.after !== undefined) op.after = F.after === '' ? null : F.after;
      ops.push(op);
    } else if (F.after !== undefined) ops.push({ op: 'reorder', id: F.id, after: F.after === '' ? null : F.after });
    if (F.children) {
      const baseKids = (B.node.children ?? []).map((c) => c.id);
      const listed = new Set(F.children.map((c) => c.id));
      for (const k of baseKids) if (!listed.has(k)) ops.push({ op: 'delete', id: k });
      // order: keep base order if the surviving existing children are already in order
      const existing = F.children.filter((c) => baseKids.includes(c.id)).map((c) => c.id);
      const baseOrder = baseKids.filter((k) => listed.has(k));
      const inOrder = eq(existing, baseOrder);
      let prev = null;
      for (const c of F.children) {
        if (c.id?.startsWith('new:') || !baseKids.includes(c.id)) diffNode({ ...c, after: c.after ?? (prev ?? '') }, F.id);
        else {
          diffNode(c, F.id);
          if (!inOrder) ops.push({ op: 'reorder', id: c.id, after: prev });
        }
        prev = c.id;
      }
    }
  };
  for (const F of frags) diffNode(F, undefined, undefined);
  return ops;
}

// ---------------------------------------------------------------------------------------------- model diff (mock)
/** Flatten a view model (layout pages or timeline tracks) → Map handle → { node, parent, prev } */
export function flatten(roots) {
  const m = new Map();
  const walk = (n, parent, prev) => {
    m.set(n.id, { node: n, parent, prev });
    let p = null;
    for (const c of n.children ?? []) { walk(c, n.id, p); p = c.id; }
  };
  for (const r of roots) walk(r, null, null);
  return m;
}
/**
 * Diff two models (base view vs target view of the same session) → minimal fragment nodes.
 * Handles that are new in the target are renamed new:<handle>. Used to script mock responses.
 */
export function diffToFragment(baseRoots, targetRoots) {
  const B = flatten(baseRoots), T = flatten(targetRoots);
  const ren = (h) => (h && !B.has(h) ? 'new:' + h : h);
  const out = [];
  const strip = (n) => { const { children, ro, ...rest } = n; return rest; };
  // relative order of siblings that exist in both and keep their parent
  const survivorPrev = (M, other, h) => {
    const e = M.get(h); const parent = e.parent;
    const sibs = parent === null ? [] : (M.get(parent).node.children ?? []).map((c) => c.id).filter((k) => other.has(k) && other.get(k).parent === parent);
    const i = sibs.indexOf(h); return i > 0 ? sibs[i - 1] : null;
  };
  for (const [h, t] of T) {
    if (!B.has(h)) {
      out.push({ ...strip(t.node), id: ren(h), parent: ren(t.parent), after: t.prev ? ren(t.prev) : '' });
      continue;
    }
    const b = B.get(h);
    const attrsChanged = !eq(b.node.attrs, t.node.attrs) || b.node.text !== t.node.text;
    const moved = b.parent !== t.parent;
    const prevT = t.prev;
    const reordered = !moved && t.parent !== null && survivorPrev(B, T, h) !== survivorPrev(T, B, h);
    if (attrsChanged || moved || reordered) {
      const f = { ...strip(t.node) };
      if (moved) { f.parent = ren(t.parent); f.after = prevT ? ren(prevT) : ''; }
      else if (reordered) f.after = prevT ? ren(prevT) : '';
      out.push(f);
    }
  }
  for (const h of B.keys()) if (!T.has(h)) out.push({ del: h });
  // a reordered sibling whose new predecessor was itself moved: emit in target order (fine for the compiler)
  return out;
}
export function fragmentToMarkup(frags) {
  const lines = [];
  for (const f of frags) {
    if (f.del) { lines.push(`<delete id="${f.del}"/>`); continue; }
    const extra = {};
    if (f.parent !== undefined) extra.parent = f.parent;
    if (f.after !== undefined) extra.after = f.after;
    const node = { ...f, attrs: { ...extra, ...f.attrs } };
    delete node.parent; delete node.after;
    nodeToMarkup(node, '', lines);
  }
  return lines.join('\n');
}
export function fragmentToJson(frags, kind) {
  const upsert = []; const del = [];
  for (const f of frags) {
    if (f.del) { del.push(f.del); continue; }
    const o = { id: f.id, kind: f.kind, ...f.attrs };
    if (f.text !== undefined) o.text = f.text;
    if (f.parent !== undefined) o.parent = f.parent;
    if (f.after !== undefined) o.after = f.after;
    upsert.push(o);
  }
  return JSON.stringify({ upsert, ...(del.length ? { delete: del } : {}) }, null, 0);
}
export { KINDS, itemJson };
