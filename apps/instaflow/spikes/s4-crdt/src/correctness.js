// Correctness scenarios (per-actor undo, proposals) + canonical part encode/rebuild (milestone fork).
import { buildLoro, materializeLoro, newDoc, TREE } from './loro-part.js';

// canonical part per DOCUMENT-FORMAT §6.2 (nodes sorted by id, props sorted, rich text as spans; no CRDT metadata)
export function canonicalPart(L, doc) {
  const tree = doc.getTree(TREE);
  const nodes = [];
  const walk = (list, parent) => {
    list.forEach((n, idx) => {
      const meta = n.meta;
      const props = {};
      for (const k of Object.keys(meta).sort()) {
        if (k === 'id' || k === 'kind' || k === 'text.content') continue;
        props[k] = meta[k];
      }
      if (meta['text.content'] !== undefined) {
        const t = tree.getNodeByID(n.id).data.get('text.content');
        props['text.content'] = { delta: t.toDelta() };
      }
      nodes.push({ id: meta.id, kind: meta.kind, parent, order: n.fractional_index, props });
      if (n.children.length) walk(n.children, meta.id);
    });
  };
  walk(doc.toJSON()[TREE], null);
  nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const obj = { schema: 'instaflow.part/1', part: 'root', treeSchema: 1, nodes };
  return { obj, json: JSON.stringify(obj) };
}

export function fromCanonical(L, part, peer) {
  const doc = newDoc(L, peer);
  const tree = doc.getTree(TREE);
  tree.enableFractionalIndex(0);
  const byParent = new Map();
  for (const n of part.nodes) { const k = n.parent ?? ''; if (!byParent.has(k)) byParent.set(k, []); byParent.get(k).push(n); }
  for (const l of byParent.values()) l.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  const make = (parentHandle, key) => {
    const kids = byParent.get(key) ?? [];
    for (const n of kids) {
      const h = parentHandle ? parentHandle.createNode() : tree.createNode();
      const d = h.data;
      d.set('id', n.id); d.set('kind', n.kind);
      for (const k in n.props) {
        if (k === 'text.content') { const t = d.setContainer(k, new L.LoroText()); t.applyDelta(n.props[k].delta); }
        else d.set(k, n.props[k]);
      }
      make(h, n.id);
    }
  };
  make(null, '');
  doc.commit({ message: '{"actor":"system:milestone-fork"}' });
  return doc;
}

// ---------------------------------------------------------------------------------------------- correctness
const SMALL = [
  { id: 'root', kind: 'composition', parentIdx: -1, props: {} },
  { id: 'g1', kind: 'group', parentIdx: 0, props: {} },
  { id: 'g2', kind: 'group', parentIdx: 0, props: {} },
  ...[1, 2, 3, 4, 5, 6].map((k) => ({ id: 'n' + k, kind: 'shape', parentIdx: 1, props: { 'spatial.x': 0, 'spatial.y': 0, 'style.fill.color': '#000000' } })),
  { id: 't1', kind: 'text', parentIdx: 1, props: {}, text: { content: 'alpha beta gamma', marks: [] } },
];

function smallState(doc) {
  const w = materializeLoro(doc);
  const o = {};
  for (const [id, r] of [...w].sort()) o[id] = { parent: r.parent, x: r.props['spatial.x'], y: r.props['spatial.y'], fill: r.props['style.fill.color'], text: r.props['text.content'] };
  return o;
}

function linkPeers(a, b) {
  const u1 = a.subscribeLocalUpdates((u) => b.import(u));
  const u2 = b.subscribeLocalUpdates((u) => a.import(u));
  return () => { u1(); u2(); };
}

function undoScript(L, H, A, commitH, commitA) {
  // H/A: { doc, tree, idx: NodeId→TreeID }
  const node = (P, id) => P.tree.getNodeByID(P.idx.get(id));
  const text = (P) => node(P, 't1').data.get('text.content');
  node(H, 'n1').data.set('spatial.x', 10); commitH();
  node(A, 'n1').data.set('style.fill.color', '#ff0000'); commitA();
  H.tree.move(H.idx.get('n2'), H.idx.get('g2')); commitH();
  node(A, 'n3').data.set('spatial.x', 50); commitA();
  text(H).insert(0, 'Hi '); commitH();
  text(A).insert(text(A).length, ' (AI)'); commitA();
  node(A, 'n1').data.set('spatial.x', 99); commitA();  // agent overwrites a prop the human set earlier
  node(H, 'n4').data.set('spatial.y', 5); commitH();
  node(H, 'n5').data.set('spatial.x', 10); commitH();
  node(A, 'n5').data.set('spatial.x', 20); commitA();  // human undo of n5 after agent overwrote it: what happens?
}

function idxOf(doc) { const m = new Map(); const walk = (l) => { for (const n of l) { m.set(n.meta.id, n.id); walk(n.children); } }; walk(doc.toJSON()[TREE]); return m; }

export function correctness(env) {
  const { L } = env;
  const res = {};
  const base = buildLoro(L, SMALL, 1).doc.export({ mode: 'snapshot' });
  const open = (peer) => { const d = new L.LoroDoc(); d.import(base); d.setPeerId(peer); d.configTextStyle({ bold: { expand: 'after' } }); return { doc: d, tree: d.getTree(TREE), idx: idxOf(d) }; };
  const original = smallState(open(99).doc);

  // A. one peer per actor (agent session = its own peer, DOCUMENT-FORMAT §2 PeerId) + one UndoManager each
  {
    const H = open(100), A = open(200);
    const unlink = linkPeers(H.doc, A.doc);
    const uh = new L.UndoManager(H.doc, { mergeInterval: 0, maxUndoSteps: 200 });
    const ua = new L.UndoManager(A.doc, { mergeInterval: 0, maxUndoSteps: 200 });
    undoScript(L, H, A, () => H.doc.commit({ message: '{"actor":"human"}' }), () => A.doc.commit({ message: '{"actor":"agent"}' }));
    const afterScript = smallState(H.doc);
    let n = 0; while (ua.canUndo()) { ua.undo(); n++; }
    const afterAgentUndo = smallState(H.doc);
    let m = 0; while (uh.canUndo()) { uh.undo(); m++; }
    const afterBothUndo = smallState(H.doc);
    const converged = JSON.stringify(smallState(A.doc)) === JSON.stringify(afterBothUndo);
    const expectAfterAgent = { n1x: 10, n1fill: '#000000', n2parent: 'g2', n3x: 0, text: 'Hi alpha beta gamma', n4y: 5 };
    const got = { n1x: afterAgentUndo.n1.x, n1fill: afterAgentUndo.n1.fill, n2parent: afterAgentUndo.n2.parent, n3x: afterAgentUndo.n3.x, text: afterAgentUndo.t1.text, n4y: afterAgentUndo.n4.y };
    res.undoPeerPerActor = {
      agentSteps: n, humanSteps: m,
      agentUndoKeepsHumanEdits: JSON.stringify(got) === JSON.stringify(expectAfterAgent), afterAgentUndo: got,
      n5AfterAgentUndo: afterAgentUndo.n5.x,
      fullUndoRestoresOriginal: JSON.stringify(afterBothUndo) === JSON.stringify(original), converged,
      afterScript: { n1x: afterScript.n1.x, text: afterScript.t1.text },
    };
    // human undoes their n5 edit after the agent overwrote it (without the agent undoing first)
    {
      const H2 = open(110), A2 = open(210); const un2 = linkPeers(H2.doc, A2.doc);
      const uh2 = new L.UndoManager(H2.doc, { mergeInterval: 0 });
      H2.tree.getNodeByID(H2.idx.get('n5')).data.set('spatial.x', 10); H2.doc.commit();
      A2.tree.getNodeByID(A2.idx.get('n5')).data.set('spatial.x', 20); A2.doc.commit();
      uh2.undo();
      res.undoPeerPerActor.humanUndoAfterAgentOverwrite_n5x = smallState(H2.doc).n5.x;
      un2();
    }
    unlink();
  }

  // B. single doc, two UndoManagers separated by commit origin prefix
  {
    const D = open(300);
    const uh = new L.UndoManager(D.doc, { mergeInterval: 0, excludeOriginPrefixes: ['agent'] });
    const ua = new L.UndoManager(D.doc, { mergeInterval: 0, excludeOriginPrefixes: ['human'] });
    let err;
    try {
      undoScript(L, D, D, () => D.doc.commit({ origin: 'human:guest' }), () => D.doc.commit({ origin: 'agent:s1' }));
      while (ua.canUndo()) ua.undo();
    } catch (e) { err = String(e); }
    const st = smallState(D.doc);
    const got = { n1x: st.n1.x, n1fill: st.n1.fill, n2parent: st.n2.parent, n3x: st.n3.x, text: st.t1.text, n4y: st.n4.y };
    // then the human undoes everything: do the agent's undo commits leak into the human's stack?
    let humanSteps = 0;
    try { while (uh.canUndo() && humanSteps < 50) { uh.undo(); humanSteps++; } } catch (e) { err = (err ?? '') + String(e); }
    const fin = smallState(D.doc);
    res.undoOneDocOriginFilter = {
      got, agentUndoKeepsHumanEdits: JSON.stringify(got) === JSON.stringify({ n1x: 10, n1fill: '#000000', n2parent: 'g2', n3x: 0, text: 'Hi alpha beta gamma', n4y: 5 }),
      humanStepsAfterAgentUndo: humanSteps, fullUndoRestoresOriginal: JSON.stringify(fin) === JSON.stringify(original),
      finalAfterHumanUndo: { n1fill: fin.n1.fill, n3x: fin.n3.x, text: fin.t1.text, n5x: fin.n5.x }, error: err,
      note: 'both UndoManagers share one peer; undo commits carry no actor origin',
    };
  }

  // B2. same, but the other actor's UndoManager is paused while one actor undoes
  {
    const D = open(310);
    const uh = new L.UndoManager(D.doc, { mergeInterval: 0, excludeOriginPrefixes: ['agent'] });
    const ua = new L.UndoManager(D.doc, { mergeInterval: 0, excludeOriginPrefixes: ['human'] });
    let err;
    try {
      undoScript(L, D, D, () => D.doc.commit({ origin: 'human:guest' }), () => D.doc.commit({ origin: 'agent:s1' }));
      while (ua.canUndo()) { uh.pause(); ua.undo(); uh.resume(); }
    } catch (e) { err = String(e); }
    const st = smallState(D.doc);
    const got = { n1x: st.n1.x, n1fill: st.n1.fill, n2parent: st.n2.parent, n3x: st.n3.x, text: st.t1.text, n4y: st.n4.y };
    let humanSteps = 0;
    try { while (uh.canUndo() && humanSteps < 50) { ua.pause(); uh.undo(); ua.resume(); humanSteps++; } } catch (e) { err = (err ?? '') + String(e); }
    const fin = smallState(D.doc);
    res.undoOneDocOriginFilterPaused = {
      agentUndoKeepsHumanEdits: JSON.stringify(got) === JSON.stringify({ n1x: 10, n1fill: '#000000', n2parent: 'g2', n3x: 0, text: 'Hi alpha beta gamma', n4y: 5 }),
      humanSteps, fullUndoRestoresOriginal: JSON.stringify(fin) === JSON.stringify(original), finalAfterHumanUndo: { n1fill: fin.n1.fill, n3x: fin.n3.x, text: fin.t1.text, n5x: fin.n5.x }, error: err,
    };
  }

  // C. undo after reload (D9: persisted undo): rebuild the agent's last step from history (commit message) as an inverse diff
  {
    const H = open(400), A = open(500); const unlink = linkPeers(H.doc, A.doc);
    const t = (P) => P.tree.getNodeByID(P.idx.get('t1')).data.get('text.content');
    A.tree.getNodeByID(A.idx.get('n6')).data.set('spatial.x', 77); t(A).insert(6, 'AGENT '); A.doc.commit({ message: '{"actor":"agent","cs":"cs_1"}' });
    t(H).insert(0, 'Hey '); H.tree.getNodeByID(H.idx.get('n6')).data.set('spatial.y', 3); H.doc.commit({ message: '{"actor":"human"}' });
    unlink();
    // "reload": a fresh doc from the full snapshot, no UndoManager state
    const R = new L.LoroDoc(); R.import(H.doc.export({ mode: 'snapshot' })); R.setPeerId(401);
    const changes = R.getAllChanges().get('500');
    const c = changes[changes.length - 1];
    const before = c.deps, after = [{ peer: c.peer, counter: c.counter + c.length - 1 }];
    const inv = R.diff(after, before, true);
    R.applyDiff(inv); R.commit({ message: '{"actor":"agent","undo":"cs_1"}' });
    const st = smallState(R);
    res.undoAfterReloadViaInverseDiff = { message: c.message, text: st.t1.text, expectedText: 'Hey alpha beta gamma', n6: { x: st.n6.x, y: st.n6.y }, propsOk: st.n6.x === 0 && st.n6.y === 3, textOk: st.t1.text === 'Hey alpha beta gamma' };
  }

  res.proposals = proposals(L, open, smallState);
  return res;
}

// D. proposals: agent change set applied to a fork (one commit per op), human edits Latest concurrently, then accept a subset
function proposals(L, open, smallState) {
  const out = {};
  const Lt = open(1000);                              // Latest (human tab peer)
  const base = Lt.doc.frontiers();
  const P = { doc: Lt.doc.fork() }; P.doc.setPeerId(2000); P.tree = P.doc.getTree(TREE); P.idx = idxOf(P.doc);
  const t1 = (X) => X.tree.getNodeByID(X.idx.get('t1')).data.get('text.content');
  // change set (canonical ops) — positions/values relative to base
  const cs = [
    { op: 'update', node: 'n1', set: { 'style.fill.color': '#0000ff' } },
    { op: 'update', node: 'n2', set: { 'spatial.x': 500 } },                // human changes n2.x concurrently → flag
    { op: 'move', node: 'n3', parent: 'g2' },                                 // human deletes n3 concurrently → flag
    { op: 'create', temp: '$t', kind: 'text', parent: 'g1', props: { 'spatial.x': 1 }, text: 'Agent headline' },
    { op: 'text.splice', node: 't1', at: 6, delete: 0, insert: 'NEW ' },     // "alpha NEW beta gamma"; human inserts at 0 concurrently
    { op: 'update', node: '$t', set: { 'spatial.y': 40 } },                  // depends on op 3
  ];
  const marks = [];
  const temps = new Map();
  const resolve = (X, ref) => (ref.startsWith('$') ? temps.get(ref) : X.idx.get(ref));
  cs.forEach((op, i) => {
    const before = P.doc.frontiers();
    let cursor;
    switch (op.op) {
      case 'update': { const m = P.tree.getNodeByID(resolve(P, op.node)).data; for (const k in op.set) m.set(k, op.set[k]); break; }
      case 'move': P.tree.move(resolve(P, op.node), resolve(P, op.parent)); break;
      case 'create': { const h = P.tree.createNode(resolve(P, op.parent)); h.data.set('id', 'cs1-' + op.temp.slice(1)); h.data.set('kind', op.kind); for (const k in op.props) h.data.set(k, op.props[k]); const tx = h.data.setContainer('text.content', new L.LoroText()); tx.insert(0, op.text); temps.set(op.temp, h.id); break; }
      case 'text.splice': { const t = t1(P); cursor = t.getCursor(op.at); t.insert(op.at, op.insert); break; }
    }
    P.doc.commit({ message: JSON.stringify({ cs: 'cs_1', op: i }) });
    marks.push({ before, after: P.doc.frontiers(), cursor });
  });
  // concurrent human edits on Latest
  Lt.tree.getNodeByID(Lt.idx.get('n2')).data.set('spatial.x', 111);
  Lt.tree.delete(Lt.idx.get('n3'));
  t1(Lt).insert(0, 'Hey ');
  Lt.tree.getNodeByID(Lt.idx.get('n6')).data.set('spatial.x', 7);
  Lt.doc.commit({ message: '{"actor":"human"}' });
  const accept = [1, 2, 4, 5]; // op 5 pulls op 3 (dependency)
  const withDeps = [...new Set(accept.flatMap((i) => (i === 5 ? [3, 5] : [i])))].sort();

  // conflict detection: which (node, key) changed in Latest since base
  const changed = new Set();
  const deleted = new Set();
  for (const [cid, d] of Lt.doc.diff(base, Lt.doc.frontiers(), true)) {
    if (d.type === 'map') for (const k of Object.keys(d.updated)) changed.add(cid + '|' + k);
    if (d.type === 'tree') for (const td of d.diff) if (td.action === 'delete') deleted.add(td.target);
    if (d.type === 'text') changed.add(cid + '|#text');
  }
  const flag = (op) => {
    if (op.node?.startsWith?.('$')) return null;
    const tid = Lt.idx.get(op.node);
    if (op.node && deleted.has(tid)) return 'target deleted in Latest';
    if (op.op === 'update') {
      const cid = Lt.tree.getNodeByID(tid)?.data.id;
      const hits = Object.keys(op.set).filter((k) => changed.has(cid + '|' + k));
      if (hits.length) return 'stale field ' + hits.join(',') + ' (IF-CS-010)';
    }
    return null;
  };

  // Method 1 (DOCUMENT-FORMAT §7.5): re-apply the chosen canonical ops onto Latest as ONE commit, author = agent peer
  {
    const Lat = { doc: Lt.doc.fork() }; Lat.doc.setPeerId(3000); Lat.tree = Lat.doc.getTree(TREE); Lat.idx = idxOf(Lat.doc);
    const um = new L.UndoManager(Lat.doc, { mergeInterval: 0 });
    const results = [];
    const tmp = new Map();
    const res = (ref) => (ref.startsWith('$') ? tmp.get(ref) : Lat.idx.get(ref));
    for (const i of withDeps) {
      const op = cs[i];
      const f = flag(op);
      if (f) { results.push({ op: i, status: 'flagged', reason: f, kept: 'current' }); continue; }
      switch (op.op) {
        case 'update': { const m = Lat.tree.getNodeByID(res(op.node)).data; for (const k in op.set) m.set(k, op.set[k]); break; }
        case 'move': Lat.tree.move(res(op.node), res(op.parent)); break;
        case 'create': { const h = Lat.tree.createNode(res(op.parent)); h.data.set('id', 'cs1-' + op.temp.slice(1)); h.data.set('kind', op.kind); for (const k in op.props) h.data.set(k, op.props[k]); h.data.setContainer('text.content', new L.LoroText()).insert(0, op.text); tmp.set(op.temp, h.id); break; }
        case 'text.splice': { const pos = Lat.doc.getCursorPos(marks[i].cursor); const t = Lat.tree.getNodeByID(res(op.node)).data.get('text.content'); t.insert(pos.offset, op.insert); break; }
      }
      results.push({ op: i, status: 'accepted' });
    }
    Lat.doc.commit({ message: JSON.stringify({ actor: 'agent', acceptedBy: 'human', changeSet: 'cs_1' }) });
    const st = smallState(Lat.doc);
    const created = [...materializeLoro(Lat.doc).values()].find((r) => r.props.id === 'cs1-t');
    const undone = um.undo();
    const st2 = smallState(Lat.doc);
    out.reapplyOneCommit = {
      results, text: st.t1.text, textOk: st.t1.text === 'Hey alpha NEW beta gamma',
      n1fillUnchanged: st.n1.fill === '#000000', n2xKeptCurrent: st.n2.x === 111, n6humanKept: st.n6.x === 7,
      createdWithDep: created ? { y: created.props['spatial.y'], text: created.props['text.content'] } : null,
      oneUndoStepRevertsAccept: undone && st2.t1.text === 'Hey alpha beta gamma' && st2['cs1-t'] === undefined && st2.n6.x === 7,
    };
  }

  // Method 2: cherry-pick CRDT diffs of the chosen ops from the fork (P.diff(before_i, after_i) → Latest.applyDiff)
  {
    const Lat = Lt.doc.fork(); Lat.setPeerId(4000);
    const errs = [];
    for (const i of withDeps) {
      if (flag(cs[i])) continue;
      try { Lat.applyDiff(P.doc.diff(marks[i].before, marks[i].after, true)); } catch (e) { errs.push({ op: i, err: String(e).slice(0, 160) }); }
    }
    Lat.commit({ message: '{"actor":"agent","changeSet":"cs_1"}' });
    const st = smallState(Lat);
    const created = [...materializeLoro(Lat).values()].find((r) => r.props.id === 'cs1-t');
    out.cherryPickDiff = { text: st.t1.text, textOk: st.t1.text === 'Hey alpha NEW beta gamma', createdWithDep: created ? { y: created.props['spatial.y'], text: created.props['text.content'] } : null, errors: errs };
  }

  // Method 3: merge the whole fork, then revert rejected ops (inverse diffs) — the "import branch" shape
  {
    const Lat = Lt.doc.fork(); Lat.setPeerId(5000);
    Lat.import(P.doc.export({ mode: 'update', from: Lt.doc.oplogVersion() }));
    const rejected = cs.map((_, i) => i).filter((i) => !withDeps.includes(i) || flag(cs[i]));
    for (const i of rejected.reverse()) Lat.applyDiff(Lat.diff(marks[i].after, marks[i].before, true));
    Lat.commit();
    const st = smallState(Lat);
    out.mergeThenRevert = { rejected, text: st.t1.text, n2x: st.n2.x, n1fill: st.n1.fill, n3: st.n3 ?? 'deleted', note: 'revert of a flagged op restores the base value, clobbering the concurrent human value unless restricted to unchanged paths' };
  }
  return out;
}
