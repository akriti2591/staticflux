// Benchmark phases shared by Node and the browser worker.
// env = { L, Y, now(), mem(), gc(), gzip(bytes) → Promise<{deflateRaw}>, fixture(name) → Promise<Uint8Array>, reps, extraMem?(label) }
import { generateNodes, generateOps, stats } from './model.js';
import { buildLoro, applyLoroOps, materializeLoro, TREE } from './loro-part.js';
import { buildYjs, applyYjsOps, materializeYjs } from './yjs-part.js';
import { canonicalPart, fromCanonical } from './correctness.js';
export { correctness } from './correctness.js';

const r1 = (x) => Math.round(x * 10) / 10;
const kb = (n) => r1(n / 1024);
const tick = () => new Promise((res) => setTimeout(res, 0));
const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
const dec = (b) => JSON.parse(new TextDecoder().decode(b));

export const N_NODES = 50_000;
let SPECS;
export const specs = () => (SPECS ??= generateNodes(N_NODES, 42));

/** Page partition (DOCUMENT-FORMAT §5.2: one CRDT doc per page): specs of page p's subtree, parentIdx re-based. */
function pageSpecs(s, pageIdx) {
  const out = [];
  const map = new Map();
  for (let i = 0; i < s.length; i++) {
    const inPage = i === pageIdx || map.has(s[i].parentIdx);
    if (!inPage) continue;
    map.set(i, out.length);
    out.push({ ...s[i], parentIdx: i === pageIdx ? -1 : map.get(s[i].parentIdx) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- fixtures
export function makeFixtures(L, Y) {
  const s = specs();
  const lo = buildLoro(L, s, 1);
  const yj = buildYjs(Y, s, 1);
  // materialized world cache (what a store could write next to the part snapshot at compaction, stamped with frontiers)
  const world = [...materializeLoro(lo.doc)].map(([id, r]) => [id, r.kind, r.parent, r.order, r.props]);
  const f = {
    'loro-50k.snapshot': lo.doc.export({ mode: 'snapshot' }),
    'loro-50k.ids.json': enc(lo.ids),
    'loro-50k.world.json': enc({ frontiers: lo.doc.frontiers(), world }),
    'yjs-50k.update': Y.encodeStateAsUpdate(yj.doc),
  };
  const pages = s.map((x, i) => i).filter((i) => s[i].kind === 'page');
  pages.forEach((pi, k) => { f[`loro-page-${k}.snapshot`] = buildLoro(L, pageSpecs(s, pi), 100 + k).doc.export({ mode: 'snapshot' }); });
  return f;
}

// ---------------------------------------------------------------------------------------------- open (fresh instance first)
export async function openLoro(env) {
  const { L } = env;
  const bytes = await env.fixture('loro-50k.snapshot');
  const cacheBytes = await env.fixture('loro-50k.world.json');
  env.gc(); await tick();
  const m0 = env.mem();
  // A. import (lazy) + world from the side-car cache: the cheapest correct open
  let t0 = env.now();
  const doc = new L.LoroDoc(); doc.import(bytes);
  const tImport = env.now() - t0;
  const cache = dec(cacheBytes);
  const world = new Map(cache.world.map((r) => [r[0], r]));
  const fresh = JSON.stringify(cache.frontiers) === JSON.stringify(doc.frontiers());
  const tCache = env.now() - t0;
  // first local edit + commit after open (loads what the lazy import skipped)
  t0 = env.now();
  const tree = doc.getTree(TREE);
  const ids = dec(await env.fixture('loro-50k.ids.json'));
  tree.getNodeByID(ids[500]).data.set('spatial.x', 1); doc.commit();
  const tFirstEdit = env.now() - t0;
  env.gc(); await tick();
  const mA = env.mem();
  const uaA = env.extraMem ? await env.extraMem('loro-open-lazy+cache') : undefined;
  // B. full materialization of every node into JS (doc.toJSON) — what a naive ECS rebuild costs
  t0 = env.now();
  const full = materializeLoro(doc);
  const tFull = env.now() - t0;
  env.gc(); await tick();
  const mB = env.mem();
  const uaB = env.extraMem ? await env.extraMem('loro-open-full') : undefined;
  if (full.size !== world.size) throw new Error('world size mismatch');
  // C. structure only (tree.getShallowValue: parents + order, no props)
  t0 = env.now(); tree.getShallowValue(); const tStruct = env.now() - t0;
  doc.free();
  // D. repeats (warm instance): import, import+cache, import+full
  const imp = [], withCache = [], fullR = [];
  for (let i = 0; i < env.reps; i++) {
    let a = env.now(); const d = new L.LoroDoc(); d.import(bytes); imp.push(env.now() - a);
    const c = dec(cacheBytes); new Map(c.world.map((r) => [r[0], r])); withCache.push(env.now() - a);
    if (i < 2) { a = env.now(); const d2 = new L.LoroDoc(); d2.import(bytes); materializeLoro(d2); fullR.push(env.now() - a); d2.free(); }
    d.free();
  }
  // E. partitioned: 50 page parts of ~1k nodes; import all (lazy) and materialize the visible page
  const pageBytes = [];
  for (let k = 0; k < 50; k++) pageBytes.push(await env.fixture(`loro-page-${k}.snapshot`));
  const partT = [];
  for (let i = 0; i < env.reps; i++) {
    const a = env.now();
    const docs = pageBytes.map((b) => { const d = new L.LoroDoc(); d.import(b); return d; });
    const vis = materializeLoro(docs[0]);
    partT.push(env.now() - a);
    if (vis.size < 900) throw new Error('page too small');
    for (const d of docs) d.free();
  }
  const onePage = [];
  for (let i = 0; i < env.reps; i++) { const a = env.now(); const d = new L.LoroDoc(); d.import(pageBytes[7]); materializeLoro(d); onePage.push(env.now() - a); d.free(); }
  return {
    snapshotKB: kb(bytes.byteLength), worldCacheKB: kb(cacheBytes.byteLength), pagePartKB: kb(pageBytes[0].byteLength), nodes: world.size, cacheFresh: fresh,
    first: { importMs: r1(tImport), importPlusCacheMs: r1(tCache), firstEditCommitMs: r1(tFirstEdit), fullToJSONMs: r1(tFull), structureOnlyMs: r1(tStruct) },
    mem: { before: m0, afterLazyPlusCache: mA, afterFullMaterialize: mB, uaLazy: uaA, uaFull: uaB },
    repeat: { importMs: stats(imp), importPlusCacheMs: stats(withCache), importPlusFullMs: stats(fullR) },
    partitioned: { import50PagesPlusMaterialize1Ms: stats(partT), importAndMaterialize1PageMs: stats(onePage) },
  };
}

export async function openYjs(env) {
  const { Y } = env;
  const bytes = await env.fixture('yjs-50k.update');
  env.gc(); await tick();
  const before = env.mem();
  const t0 = env.now();
  const doc = new Y.Doc(); Y.applyUpdate(doc, bytes);
  const t1 = env.now();
  const world = materializeYjs(Y, { nodes: doc.getMap('nodes') });
  const t2 = env.now();
  env.gc(); await tick();
  const after = env.mem();
  const ua = env.extraMem ? await env.extraMem('yjs-open') : undefined;
  const imp = [], tot = [];
  for (let i = 0; i < env.reps; i++) {
    const a = env.now(); const d = new Y.Doc(); Y.applyUpdate(d, bytes); const b = env.now(); materializeYjs(Y, { nodes: d.getMap('nodes') }); const c = env.now();
    imp.push(b - a); tot.push(c - a); d.destroy();
  }
  return { snapshotKB: kb(bytes.byteLength), nodes: world.size, first: { importMs: r1(t1 - t0), materializeMs: r1(t2 - t1), totalMs: r1(t2 - t0) }, mem: { before, after, ua }, repeat: { importMs: stats(imp), importPlusMaterializeMs: stats(tot) } };
}

// ---------------------------------------------------------------------------------------------- perf
async function opener(env) {
  const { L } = env;
  const snap = await env.fixture('loro-50k.snapshot');
  const ids = dec(await env.fixture('loro-50k.ids.json'));
  return (peer) => {
    const doc = new L.LoroDoc(); doc.import(snap); doc.setPeerId(peer);
    doc.configTextStyle({ bold: { expand: 'after' }, italic: { expand: 'after' } });
    return { doc, tree: doc.getTree(TREE), ids };
  };
}

// cheap convergence check: structure + every node's props for a 1k sample (+ frontiers)
function loroDigest(doc, ids) {
  const tree = doc.getTree(TREE);
  const parts = [JSON.stringify([...doc.oplogVersion().toJSON()].sort())];
  parts.push(JSON.stringify(tree.getShallowValue()));
  for (let i = 0; i < ids.length; i += 50) { const n = tree.getNodeByID(ids[i]); parts.push(n && !tree.isNodeDeleted(ids[i]) ? JSON.stringify(n.data.toJSON()) : 'x'); }
  return parts.join('|');
}

export async function perf(env, only) {
  const { L, Y } = env;
  const s = specs();
  const out = {};
  const open = await opener(env);
  const yupd = await env.fixture('yjs-50k.update');
  const want = (k) => !only || only.includes(k);

  if (want('build')) {
    const t = env.now(); const p = buildLoro(L, s, 50); const lb = env.now() - t; p.doc.free();
    const t2 = env.now(); const q = buildYjs(Y, s, 50); const yb = env.now() - t2; q.doc.destroy();
    out.build50k = { loroMs: r1(lb), yjsMs: r1(yb) };
  }

  if (want('gestures')) {
    const { doc, tree, ids } = open(7);
    const elements = s.map((x, i) => i).filter((i) => !['composition', 'page', 'group'].includes(s[i].kind));
    const groups = s.map((x, i) => i).filter((i) => s[i].kind === 'group');
    const pick = (n, off) => Array.from({ length: n }, (_, k) => elements[(k * 37 + off) % elements.length]);
    tree.getNodeByID(ids[1]).data.set('name', 'warm'); doc.commit(); // first commit after import pays a one-time load (reported in open)
    const gesture = (label, fn) => {
      const vv = doc.oplogVersion();
      const t = env.now(); fn(); doc.commit({ message: '{"actor":"human:guest","via":"hud","label":"' + label + '"}' }); const ms = env.now() - t;
      const upd = doc.export({ mode: 'update', from: vv });
      return { KB: kb(upd.byteLength), ms: r1(ms) };
    };
    const target = ids[groups[3]];
    const moved = pick(1000, 1);
    const d = {};
    d.move1kNodesOneCommit = gesture('reparent 1k', () => { for (const i of moved) tree.move(ids[i], target); });
    d.reorder1kOneCommit = gesture('reorder 1k', () => { for (const i of pick(1000, 5)) { const p = tree.getNodeByID(ids[i]).parent(); tree.move(ids[i], p.id, 0); } });
    d.set1kPropsOneNodeOneCommit = gesture('1 node, 1k frames uncoalesced', () => { const m = tree.getNodeByID(ids[elements[10]]).data; for (let k = 0; k < 1000; k++) m.set(k % 2 ? 'spatial.y' : 'spatial.x', k * 1.5); });
    d.set1kNodesXOneCommit = gesture('nudge 1k nodes', () => { for (const i of pick(1000, 9)) tree.getNodeByID(ids[i]).data.set('spatial.x', 123.25); });
    d.set1kNodesXYOneCommit = gesture('drag 1k nodes x+y', () => { for (const i of pick(1000, 11)) { const m = tree.getNodeByID(ids[i]).data; m.set('spatial.x', 10.5); m.set('spatial.y', 20.5); } });
    {
      const vv = doc.oplogVersion();
      let logBytes = 0;
      const t = env.now();
      for (let k = 0; k < 1000; k++) {
        const v = doc.oplogVersion();
        tree.move(ids[moved[k]], ids[groups[(k % 20) + 40]]);
        doc.commit({ message: '{"actor":"human:guest","via":"hud"}' });
        logBytes += doc.export({ mode: 'update', from: v }).byteLength;
      }
      const ms = env.now() - t;
      d.move1kOneCommitEach = { perCommitLogKB: kb(logBytes), coalescedExportKB: kb(doc.export({ mode: 'update', from: vv }).byteLength), totalMs: r1(ms) };
    }
    const fk = [];
    for (let i = 0; i < 3; i++) { const t = env.now(); const f = doc.fork(); fk.push(env.now() - t); f.free(); }
    d.fork50kDocMs = stats(fk);
    out.gestures = d;
    doc.free();
    const ydoc = new Y.Doc(); ydoc.clientID = 7; Y.applyUpdate(ydoc, yupd); const yn = ydoc.getMap('nodes');
    const yg = (fn) => { const sv = Y.encodeStateVector(ydoc); ydoc.transact(fn); return { KB: kb(Y.encodeStateAsUpdate(ydoc, sv).byteLength) }; };
    out.gesturesYjs = {
      move1kNodesOneCommit: yg(() => { for (const i of moved) { const m = yn.get(s[i].id); m.set('parent', s[groups[3]].id); m.set('order', 'zz' + i); } }),
      set1kPropsOneNodeOneCommit: yg(() => { const m = yn.get(s[elements[10]].id); for (let k = 0; k < 1000; k++) m.set(k % 2 ? 'spatial.y' : 'spatial.x', k * 1.5); }),
      set1kNodesXOneCommit: yg(() => { for (const i of pick(1000, 9)) yn.get(s[i].id).set('spatial.x', 123.25); }),
    };
    ydoc.destroy();
  }

  if (want('merge')) {
    out.merge = {};
    for (const N of [5000, 10000]) {
      const A = open(2), B = open(3);
      const baseVV = A.doc.oplogVersion();
      const baseFrontiers = A.doc.frontiers();
      const opsA = generateOps(s, N, 1001), opsB = generateOps(s, N, 2002);
      let t = env.now(); const appliedA = applyLoroOps(L, A, opsA); const applyMs = env.now() - t;
      const appliedB = applyLoroOps(L, B, opsB);
      const updA = A.doc.export({ mode: 'update', from: baseVV });
      const updB = B.doc.export({ mode: 'update', from: baseVV });
      const noSub = [], withSub = [];
      for (let i = 0; i < env.reps; i++) {
        const t1 = A.doc.fork();
        let t0 = env.now(); t1.import(updB); noSub.push(env.now() - t0); t1.free();
        const t2 = A.doc.fork();
        let events = 0;
        const unsub = t2.subscribe((e) => { for (const ev of e.events) events += 1; });
        t0 = env.now(); t2.import(updB); await Promise.resolve(); withSub.push(env.now() - t0);
        unsub(); t2.free();
      }
      t = env.now(); const df = A.doc.diff(baseFrontiers, A.doc.frontiers(), false); const diffMs = env.now() - t;
      A.doc.import(updB); B.doc.import(updA);
      const converged = loroDigest(A.doc, A.ids) === loroDigest(B.doc, B.ids);
      out.merge[`loro_${N}opsEach`] = { appliedA, appliedB, applyMsPeerA: r1(applyMs), updateKB_B: kb(updB.byteLength), importMs: stats(noSub), importWithEventsMs: stats(withSub), diffSinceBaseMs: r1(diffMs), diffContainers: df.length, converged };
      A.doc.free(); B.doc.free();

      const ya = new Y.Doc(); ya.clientID = 2; Y.applyUpdate(ya, yupd);
      const yb = new Y.Doc(); yb.clientID = 3; Y.applyUpdate(yb, yupd);
      const ysv = Y.encodeStateVector(ya);
      const PA = { doc: ya, nodes: ya.getMap('nodes'), ids: s.map((x) => x.id) }, PB = { doc: yb, nodes: yb.getMap('nodes'), ids: s.map((x) => x.id) };
      t = env.now(); applyYjsOps(Y, PA, opsA); const yApply = env.now() - t;
      applyYjsOps(Y, PB, opsB);
      const yuB = Y.encodeStateAsUpdate(yb, ysv), yuA = Y.encodeStateAsUpdate(ya, ysv);
      const yaState = Y.encodeStateAsUpdate(ya);
      const yt = [], yto = [];
      for (let i = 0; i < env.reps; i++) {
        const c = new Y.Doc(); Y.applyUpdate(c, yaState);
        let t0 = env.now(); Y.applyUpdate(c, yuB); yt.push(env.now() - t0); c.destroy();
        const c2 = new Y.Doc(); Y.applyUpdate(c2, yaState);
        let deep = 0; c2.getMap('nodes').observeDeep((evs) => { deep += evs.length; });
        t0 = env.now(); Y.applyUpdate(c2, yuB); yto.push(env.now() - t0); c2.destroy();
      }
      Y.applyUpdate(ya, yuB); Y.applyUpdate(yb, yuA);
      out.merge[`yjs_${N}opsEach`] = { applyMsPeerA: r1(yApply), updateKB_B: kb(yuB.byteLength), importMs: stats(yt), importWithObserverMs: stats(yto), converged: JSON.stringify(ya.getMap('nodes').toJSON()) === JSON.stringify(yb.getMap('nodes').toJSON()) };
      ya.destroy(); yb.destroy();
    }
  }

  if (want('history')) {
    // age the doc with size-neutral edits (prop sets + moves), commit every 10 ops; full vs shallow snapshot
    const P = open(9);
    const yd = new Y.Doc(); yd.clientID = 9; Y.applyUpdate(yd, yupd);
    const YP = { doc: yd, nodes: yd.getMap('nodes'), ids: s.map((x) => x.id) };
    const allOps = generateOps(s, 400_000, 777).filter((o) => o.op === 'set' || o.op === 'move').slice(0, 200_000);
    const rows = [];
    let done = 0;
    for (const cp of [0, 10_000, 50_000, 100_000, 200_000]) {
      applyLoroOps(L, P, allOps.slice(done, cp), { commitEvery: 10 });
      applyYjsOps(Y, YP, allOps.slice(done, cp), { commitEvery: 10 });
      done = cp;
      const full = P.doc.export({ mode: 'snapshot' });
      const shallow = P.doc.export({ mode: 'shallow-snapshot', frontiers: P.doc.frontiers() });
      const openEdit = (bytes) => { const t = env.now(); const a = new L.LoroDoc(); a.import(bytes); const ti = env.now() - t; a.setPeerId(77); a.getTree(TREE).getNodeByID(P.ids[600]).data.set('spatial.x', 3); a.commit(); const te = env.now() - t; a.free(); return { ti, te }; };
      const f = [], sh = [];
      for (let i = 0; i < 3; i++) { f.push(openEdit(full)); sh.push(openEdit(shallow)); }
      rows.push({
        edits: cp, changes: P.doc.changeCount(), fullKB: kb(full.byteLength), shallowKB: kb(shallow.byteLength), yjsKB: kb(Y.encodeStateAsUpdate(yd).byteLength),
        fullImportMs: stats(f.map((x) => x.ti)).median, fullImportFirstEditMs: stats(f.map((x) => x.te)).median,
        shallowImportMs: stats(sh.map((x) => x.ti)).median, shallowImportFirstEditMs: stats(sh.map((x) => x.te)).median,
      });
    }
    out.historyGrowth = rows;
    yd.destroy();

    // "New document from milestone" on the aged doc
    let t = env.now();
    const canon = canonicalPart(L, P.doc);
    const canonMs = env.now() - t;
    const canonBytes = new TextEncoder().encode(canon.json);
    const comp = await env.gzip(canonBytes);
    t = env.now();
    const fresh = fromCanonical(L, JSON.parse(canon.json), 424242);
    const rebuildMs = env.now() - t;
    const freshSnap = fresh.export({ mode: 'snapshot' });
    const freshShallow = fresh.export({ mode: 'shallow-snapshot', frontiers: fresh.frontiers() });
    const same = canonicalPart(L, fresh).json === canon.json;
    t = env.now();
    const sh = P.doc.export({ mode: 'shallow-snapshot', frontiers: P.doc.frontiers() });
    const shallowExportMs = env.now() - t;
    t = env.now();
    const nd = new L.LoroDoc(); nd.import(sh); nd.setPeerId(515151);
    const shallowImportMs = env.now() - t;
    out.milestoneFork = {
      agedFullSnapshotKB: kb(P.doc.export({ mode: 'snapshot' }).byteLength),
      canonicalJsonKB: kb(canonBytes.byteLength), canonicalDeflateKB: kb(comp.deflateRaw), canonicalEncodeMs: r1(canonMs),
      rebuildFromCanonicalMs: r1(rebuildMs), rebuiltSnapshotKB: kb(freshSnap.byteLength), rebuiltShallowKB: kb(freshShallow.byteLength), rebuiltChanges: fresh.changeCount(), rebuiltRoundTripsCanonical: same,
      shallowSnapshotKB: kb(sh.byteLength), shallowExportMs: r1(shallowExportMs), shallowImportMs: r1(shallowImportMs), shallowIsShallow: nd.isShallow(),
      shallowVersionVectorPeers: [...(nd.oplogVersion().toJSON?.() ?? new Map())].length,
    };
    fresh.free(); nd.free(); P.doc.free();
  }
  return out;
}
