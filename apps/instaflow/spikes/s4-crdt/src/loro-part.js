// One Instaflow part as a Loro doc: a LoroTree (movable tree, native fractional `order`) whose node `data` map
// holds per-property LWW opinions keyed by property path (`spatial.x`, `style.fill.color`, ...); text nodes hold a
// LoroText (Peritext-style marks) under `text.content`. NodeId (asset-local, stable across forks) is the `id` prop.

export const TREE = 'nodes';

export function newDoc(L, peer) {
  const doc = new L.LoroDoc();
  doc.setPeerId(peer);
  doc.configTextStyle({ bold: { expand: 'after' }, italic: { expand: 'after' } });
  return doc;
}

/** Build the part from node specs. Commits once per page (a realistic import/compaction shape). Returns tree ids by spec index. */
export function buildLoro(L, specs, peer = 1, { commitEvery = 1000 } = {}) {
  const doc = newDoc(L, peer);
  const tree = doc.getTree(TREE);
  tree.enableFractionalIndex(0);
  const ids = new Array(specs.length);
  const handles = new Array(specs.length);
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    const node = s.parentIdx < 0 ? tree.createNode() : handles[s.parentIdx].createNode();
    const data = node.data;
    data.set('id', s.id);
    data.set('kind', s.kind);
    for (const k in s.props) data.set(k, s.props[k]);
    if (s.text) {
      const t = data.setContainer('text.content', new L.LoroText());
      t.insert(0, s.text.content);
      for (const m of s.text.marks) t.mark({ start: m.start, end: m.end }, m.key, m.value);
    }
    ids[i] = node.id;
    handles[i] = node;
    if (i % commitEvery === commitEvery - 1) doc.commit({ message: '{"actor":"human:guest","via":"direct"}' });
  }
  doc.commit({ message: '{"actor":"human:guest","via":"direct"}' });
  for (const h of handles) h.free?.();
  return { doc, tree, ids };
}

/** Apply one generic op (see model.generateOps). Returns false if skipped (target deleted etc.). */
export function applyLoroOp(L, part, op) {
  const { tree, ids } = part;
  try {
    switch (op.op) {
      case 'set': {
        const n = tree.getNodeByID(ids[op.node]);
        if (!n || tree.isNodeDeleted(ids[op.node])) return false;
        const m = n.data; m.set(op.key, op.value); m.free(); n.free();
        return true;
      }
      case 'move': {
        if (tree.isNodeDeleted(ids[op.node]) || tree.isNodeDeleted(ids[op.parent])) return false;
        const p = tree.getNodeByID(ids[op.parent]);
        const kids = p.children() ?? []; const len = kids.length; for (const k of kids) k.free(); p.free();
        tree.move(ids[op.node], ids[op.parent], Math.min(op.index, len));
        return true;
      }
      case 'text.insert': {
        if (tree.isNodeDeleted(ids[op.node])) return false;
        const n = tree.getNodeByID(ids[op.node]); const m = n.data; const t = m.get('text.content');
        t.insert(Math.min(op.at, t.length), op.insert); t.free(); m.free(); n.free();
        return true;
      }
      case 'text.mark': {
        if (tree.isNodeDeleted(ids[op.node])) return false;
        const n = tree.getNodeByID(ids[op.node]); const m = n.data; const t = m.get('text.content');
        t.mark({ start: Math.min(op.start, t.length - 1), end: Math.min(op.end, t.length) }, op.key, op.value); t.free(); m.free(); n.free();
        return true;
      }
      case 'create': {
        if (tree.isNodeDeleted(ids[op.parent])) return false;
        const n = tree.createNode(ids[op.parent]);
        const d0 = n.data; d0.set('id', `new-${op.seq.toString(36)}-${String(part.doc.peerIdStr)}`); d0.set('kind', 'shape'); d0.free();
        const m = n.data; for (const k in op.props) m.set(k, op.props[k]); m.free(); n.free();
        return true;
      }
      case 'delete': {
        if (tree.isNodeDeleted(ids[op.node])) return false;
        tree.delete(ids[op.node]);
        return true;
      }
    }
  } catch (e) {
    return false;
  }
  return false;
}

export function applyLoroOps(L, part, ops, { commitEvery = 10, message = '{"actor":"human:guest","via":"hud"}', origin } = {}) {
  let applied = 0;
  for (let i = 0; i < ops.length; i++) {
    if (applyLoroOp(L, part, ops[i])) applied++;
    if (i % commitEvery === commitEvery - 1) part.doc.commit({ message, origin });
  }
  part.doc.commit({ message, origin });
  return applied;
}

/** Materialize the part into a plain JS world (what the ECS index would be built from): Map NodeId → record. */
export function materializeLoro(doc) {
  const json = doc.toJSON()[TREE];
  const world = new Map();
  const walk = (list, parent) => {
    for (const n of list) {
      world.set(n.meta.id, { kind: n.meta.kind, parent, order: n.fractional_index, props: n.meta });
      if (n.children.length) walk(n.children, n.meta.id);
    }
  };
  walk(json, null);
  return world;
}

/** Re-attach tree ids for spec indices after opening a snapshot (NodeId → TreeID index). */
export function reindexLoro(doc, specs) {
  const tree = doc.getTree(TREE);
  const byNodeId = new Map();
  const json = doc.toJSON()[TREE];
  const walk = (list) => { for (const n of list) { byNodeId.set(n.meta.id, n.id); if (n.children.length) walk(n.children); } };
  walk(json);
  return { doc, tree, ids: specs.map((s) => byNodeId.get(s.id)) };
}
