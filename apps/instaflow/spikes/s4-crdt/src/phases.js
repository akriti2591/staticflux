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

/** global spec index → { page, local } for the page partition; groups per page for move remapping. */
function pageLocator(s) {
  const pages = s.map((x, i) => i).filter((i) => s[i].kind === 'page');
  const loc = new Array(s.length);
  const groupsOf = pages.map(() => []);
  pages.forEach((pi, k) => {
    const local = new Map();
    for (let i = 0; i < s.length; i++) {
      if (i === pi || local.has(s[i].parentIdx)) { local.set(i, local.size); loc[i] = { page: k, local: local.get(i) }; if (s[i].kind === 'group') groupsOf[k].push(local.get(i)); }
    }
  });
  return { loc, groupsOf };
}
function remapToPage(op, { loc, groupsOf }) {
  const anchor = op.node ?? op.parent;
  const l = loc[anchor]; if (!l) return null;
  const o = { ...op };
  if (op.node !== undefined) o.node = l.local;
  if (op.parent !== undefined) { const g = groupsOf[l.page]; o.parent = g[(loc[op.parent]?.local ?? 0) % g.length]; }
  return { page: l.page, op: o };
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
  const pageIds = [];
  pages.forEach((pi, k) => { const p = buildLoro(L, pageSpecs(s, pi), 100 + k); f[`loro-page-${k}.snapshot`] = p.doc.export({ mode: 'snapshot' }); pageIds.push(p.ids); });
  f['loro-pages.ids.json'] = enc(pageIds);
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
  for (let i = 0; i < ids.length; i += 50) { const n = tree.getNodeByID(ids[i]); if (n && !tree.isNodeDeleted(ids[i])) { const m = n.data; parts.push(JSON.stringify(m.toJSON())); m.free(); } else parts.push('x'); n?.free(); }
  tree.free();
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
    const t = env.now(); const p = buildLoro(L, s, 50); const lb = env.now() - t; (p.tree?.free(), p.doc.free());
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

  if (want('merge')) out.merge = 'use mergeOne() — one sample per fresh process/worker (a long-lived instance degrades, see README)';

  if (want('history')) {
    // age the doc with size-neutral edits (prop sets + moves), commit every 10 ops; full vs shallow snapshot
    const P = open(9);
    const yd = new Y.Doc(); yd.clientID = 9; Y.applyUpdate(yd, yupd);
    const YP = { doc: yd, nodes: yd.getMap('nodes'), ids: s.map((x) => x.id) };
    const allOps = generateOps(s, 400_000, 777).filter((o) => o.op === 'set' || o.op === 'move').slice(0, 200_000);
    const rows = [];
    let done = 0;
    for (const cp of env.checkpoints ?? [0, 10_000, 50_000, 100_000, 200_000]) {
      applyLoroOps(L, P, allOps.slice(done, cp), { commitEvery: 10 });
      applyYjsOps(Y, YP, allOps.slice(done, cp), { commitEvery: 10 });
      done = cp;
      const full = P.doc.export({ mode: 'snapshot' });
      const shallow = P.doc.export({ mode: 'shallow-snapshot', frontiers: P.doc.frontiers() });
      const openEdit = (bytes) => { const t = env.now(); const a = new L.LoroDoc(); a.import(bytes); const ti = env.now() - t; a.setPeerId(77); const tr = a.getTree(TREE); const nn = tr.getNodeByID(P.ids[600]); const dm = nn.data; dm.set('spatial.x', 3); a.commit(); const te = env.now() - t; dm.free(); nn.free(); tr.free(); a.free(); return { ti, te }; };
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
    if (env.milestone === false) { (P.tree?.free(), P.doc.free()); return out; }

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
    fresh.free(); nd.free(); (P.tree?.free(), P.doc.free());
  }
  return out;
}

// One divergent-merge sample in a fresh instance. kind: 'loro-cold' | 'loro-warm' | 'loro-pages' | 'yjs'
export async function mergeOne(env, kind, N) {
  const { L, Y } = env;
  const s = specs();
  const opsA = generateOps(s, N, 1001), opsB = generateOps(s, N, 2002);
  if (kind === 'yjs') {
    const yupd = await env.fixture('yjs-50k.update');
    const ybase = new Y.Doc(); Y.applyUpdate(ybase, yupd); const ysv = Y.encodeStateVector(ybase); ybase.destroy();
    const mk = (c) => { const d = new Y.Doc(); d.clientID = c; Y.applyUpdate(d, yupd); return { doc: d, nodes: d.getMap('nodes'), ids: s.map((x) => x.id) }; };
    const B = mk(3); applyYjsOps(Y, B, opsB); const uB = Y.encodeStateAsUpdate(B.doc, ysv);
    const A = mk(2); let t = env.now(); applyYjsOps(Y, A, opsA); const applyMs = env.now() - t;
    let deep = 0; A.nodes.observeDeep((evs) => { deep += evs.length; });
    t = env.now(); Y.applyUpdate(A.doc, uB); const importMs = env.now() - t;
    t = env.now(); Y.applyUpdate(B.doc, Y.encodeStateAsUpdate(A.doc, ysv)); const reverseMs = env.now() - t;
    const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
    const converged = canon(A.nodes.toJSON()) === canon(B.nodes.toJSON());
    return { kind, N, updateKB: kb(uB.byteLength), applyLocalMs: r1(applyMs), importMs: r1(importMs), reverseMs: r1(reverseMs), converged };
  }
  if (kind === 'loro-pages') {
    const pageIds = dec(await env.fixture('loro-pages.ids.json'));
    const pageBytes = []; for (let k = 0; k < 50; k++) pageBytes.push(await env.fixture(`loro-page-${k}.snapshot`));
    const loc = pageLocator(s);
    const split = (ops) => { const per = Array.from({ length: 50 }, () => []); for (const o of ops) { const r = remapToPage(o, loc); if (r) per[r.page].push(r.op); } return per; };
    const perA = split(opsA), perB = split(opsB);
    const openPart = (k, peer) => { const d = new L.LoroDoc(); d.import(pageBytes[k]); d.setPeerId(peer); d.configTextStyle({ bold: { expand: 'after' }, italic: { expand: 'after' } }); return { doc: d, tree: d.getTree(TREE), ids: pageIds[k] }; };
    let sum = 0, worst = 0, rev = 0, kbs = 0, converged = true;
    for (let k = 0; k < 50; k++) {
      const B = openPart(k, 3), A = openPart(k, 2); const vv = A.doc.oplogVersion();
      applyLoroOps(L, B, perB[k]); applyLoroOps(L, A, perA[k]);
      const uB = B.doc.export({ mode: 'update', from: vv }); kbs += uB.byteLength;
      let t = env.now(); A.doc.import(uB); const dt = env.now() - t; sum += dt; worst = Math.max(worst, dt);
      t = env.now(); B.doc.import(A.doc.export({ mode: 'update', from: vv })); rev += env.now() - t;
      converged &&= loroDigest(A.doc, A.ids) === loroDigest(B.doc, B.ids);
      (A.tree?.free(), A.doc.free()); (B.tree?.free(), B.doc.free());
    }
    return { kind, N, parts: 50, updateKB: kb(kbs), importMsTotal: r1(sum), worstPartMs: r1(worst), reverseMsTotal: r1(rev), converged };
  }
  const open = await opener(env);
  const B = open(3); const baseVV = B.doc.oplogVersion();
  applyLoroOps(L, B, opsB);
  const uB = B.doc.export({ mode: 'update', from: baseVV });
  const W = open(4); applyLoroOps(L, W, generateOps(s, 10, 3003)); const uW = W.doc.export({ mode: 'update', from: baseVV }); (W.tree?.free(), W.doc.free());
  const A = open(2); const baseFrontiers = A.doc.frontiers();
  let t = env.now(); applyLoroOps(L, A, opsA); const applyMs = env.now() - t;
  let warmupMs = null;
  if (kind === 'loro-warm') { t = env.now(); A.doc.import(uW); warmupMs = r1(env.now() - t); }
  let events = 0; const unsub = A.doc.subscribe((e) => { events += e.events.length; });
  t = env.now(); A.doc.import(uB); await Promise.resolve(); const importMs = env.now() - t; unsub();
  let diffMs = null;
  if (N <= 1000) { t = env.now(); A.doc.diff(baseFrontiers, A.doc.frontiers(), false); diffMs = r1(env.now() - t); }
  // cheaper stale-field primitive: the ops since base as JSON (proportional to the ops since base, not the doc)
  t = env.now();
  const spans = A.doc.findIdSpansBetween(baseFrontiers, A.doc.frontiers());
  let opsSince = 0; for (const sp of spans.forward) for (const c of A.doc.exportJsonInIdSpan(sp)) opsSince += c.ops.length;
  const opsSinceMs = r1(env.now() - t);
  if (kind !== 'loro-warm') A.doc.import(uW);
  t = env.now(); B.doc.import(uW); B.doc.import(A.doc.export({ mode: 'update', from: baseVV })); const reverseMs = env.now() - t;
  const converged = loroDigest(A.doc, A.ids) === loroDigest(B.doc, B.ids);
  return { kind, N, updateKB: kb(uB.byteLength), applyLocalMs: r1(applyMs), warmupMs, importMs: r1(importMs), events, reverseMs: r1(reverseMs), diffSinceBaseMs: diffMs, opsSinceBaseJsonMs: opsSinceMs, opsSinceBase: opsSince, converged, wasmMBAfter: env.mem().wasmMB };
}
