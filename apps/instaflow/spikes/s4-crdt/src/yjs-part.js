// Same part modelled in Yjs 13 (no movable tree): Y.Map nodes: NodeId → Y.Map(props + parent + order), text as Y.Text
// with format attributes. Moves are LWW writes of parent+order (cycles must be repaired by the app — the reason
// research 01 prefers a native movable tree).

function orderKey(i) { return 'a' + i.toString(36).padStart(5, '0'); }

export function buildYjs(Y, specs, clientID = 1) {
  const doc = new Y.Doc({ gc: true });
  doc.clientID = clientID;
  const nodes = doc.getMap('nodes');
  const childCount = new Map();
  for (let p = 0; p < specs.length; p += 1000) {
    doc.transact(() => {
      for (let i = p; i < Math.min(specs.length, p + 1000); i++) {
        const s = specs[i];
        const m = new Y.Map();
        nodes.set(s.id, m);
        const parent = s.parentIdx < 0 ? null : specs[s.parentIdx].id;
        const c = childCount.get(parent) ?? 0; childCount.set(parent, c + 1);
        m.set('kind', s.kind); m.set('parent', parent); m.set('order', orderKey(c));
        for (const k in s.props) m.set(k, s.props[k]);
        if (s.text) {
          const t = new Y.Text();
          m.set('text.content', t);
          t.insert(0, s.text.content);
          for (const mk of s.text.marks) t.format(mk.start, mk.end - mk.start, { [mk.key]: mk.value });
        }
      }
    }, 'human');
  }
  return { doc, nodes, ids: specs.map((s) => s.id) };
}

export function applyYjsOp(Y, part, op) {
  const { nodes, ids } = part;
  switch (op.op) {
    case 'set': { const m = nodes.get(ids[op.node]); if (!m) return false; m.set(op.key, op.value); return true; }
    case 'move': {
      const m = nodes.get(ids[op.node]); if (!m || !nodes.get(ids[op.parent])) return false;
      m.set('parent', ids[op.parent]); m.set('order', orderKey(op.index) + 'm' + Math.random().toString(36).slice(2, 6)); return true;
    }
    case 'text.insert': { const m = nodes.get(ids[op.node]); if (!m) return false; const t = m.get('text.content'); t.insert(Math.min(op.at, t.length), op.insert); return true; }
    case 'text.mark': { const m = nodes.get(ids[op.node]); if (!m) return false; const t = m.get('text.content'); t.format(Math.min(op.start, t.length - 1), op.end - op.start, { [op.key]: op.value }); return true; }
    case 'create': {
      if (!nodes.get(ids[op.parent])) return false;
      const m = new Y.Map(); nodes.set(`new-${op.seq.toString(36)}-${part.doc.clientID}`, m);
      m.set('kind', 'shape'); m.set('parent', ids[op.parent]); m.set('order', 'z');
      for (const k in op.props) m.set(k, op.props[k]);
      return true;
    }
    case 'delete': { if (!nodes.get(ids[op.node])) return false; nodes.delete(ids[op.node]); return true; }
  }
  return false;
}

export function applyYjsOps(Y, part, ops, { commitEvery = 10 } = {}) {
  let applied = 0;
  for (let i = 0; i < ops.length; i += commitEvery) {
    part.doc.transact(() => { for (let j = i; j < Math.min(ops.length, i + commitEvery); j++) if (applyYjsOp(Y, part, ops[j])) applied++; }, 'human');
  }
  return applied;
}

export function materializeYjs(Y, part) {
  const world = new Map();
  part.nodes.forEach((m, id) => {
    const props = {};
    m.forEach((v, k) => { props[k] = v instanceof Y.AbstractType ? v.toString() : v; });
    world.set(id, { kind: props.kind, parent: props.parent, order: props.order, props });
  });
  return world;
}
