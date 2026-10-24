// Per-tab dedicated store worker. Exactly one worker in the origin holds the Web Lock `iflow:<ws>:leader`
// and owns the sync access handles; the others forward commits over BroadcastChannel and resend until acked.
import { Backend, readHead, summarize } from './core.js';
import { LatestStore } from './latest.js';

let cfg, be, probeBe, bc, store = null, role = 'follower';
const pending = new Map();          // id -> { c, sentAt, firstAt }
const queue = [];                   // leader: commits waiting for the next durable batch
let flushing = false;
const lat = [];
const probe = { reads: 0, ok: 0, missing: 0, torn: 0, regress: 0, lastGen: 0, tornSamples: [] };

const post = (m) => self.postMessage(m);

async function openWs(ws) {
  const opfs = await navigator.storage.getDirectory();
  return (await opfs.getDirectoryHandle('instaflow', { create: true })).getDirectoryHandle(ws, { create: true });
}

function ackLocal(ids) {
  const done = [];
  for (const id of ids) { const p = pending.get(id); if (p) { pending.delete(id); done.push(id); lat.push(performance.now() - p.firstAt); } }
  if (done.length) post({ type: 'ack', ids: done });
}

function enqueue(c) { queue.push(c); if (!flushing) { flushing = true; setTimeout(flush, 0); } }
async function flush() {
  try {
    while (queue.length) {
      const batch = queue.splice(0, queue.length);
      await store.append(batch);                       // resolves after flush(); only then ack
      const ids = batch.map((c) => c.id).filter((id) => store.ids.has(id));
      bc.postMessage({ type: 'ack', ids });
      ackLocal(ids);
    }
  } catch (e) { post({ type: 'error', where: 'flush', message: String(e?.stack ?? e) }); }
  finally { flushing = false; }
}

async function becomeLeader() {
  role = 'recovering';
  const t0 = performance.now();
  store = new LatestStore(be, { lockPrefix: `iflow:${cfg.ws}`, asset: cfg.asset, peer: cfg.peer });
  const rec = await store.recover();
  if (cfg.verify) {
    post({ type: 'verify', rec, ids: [...store.ids], head: store.head });
    return new Promise(() => {});
  }
  role = 'leader';
  post({ type: 'leader', rec, readyMs: performance.now() - t0, generation: store.head.generation });
  bc.postMessage({ type: 'leader', peer: cfg.peer });
  for (const p of pending.values()) enqueue(p.c);
  const tick = async () => {
    try { await store.compact(cfg.slowHead ? { beforeMove: () => new Promise((r) => setTimeout(r, 2)) } : {}); }
    catch (e) { post({ type: 'error', where: 'compact', message: String(e?.sf?.code ?? e) }); }
    setTimeout(tick, cfg.compactEveryMs);
  };
  setTimeout(tick, cfg.compactEveryMs);
  const t1 = performance.now();
  setInterval(() => post({ type: 'leaderStats', generation: store.head.generation, compactions: store.compactions, appended: store.appended, dutyCycle: store.busyMs / (performance.now() - t1), casConflicts: store.casConflicts }), 1000);
  return new Promise(() => {});                        // hold the lock until this worker dies
}

async function probeLoop() {
  // Unlocked concurrent reader: a torn or regressed head here is a failure.
  for (;;) {
    await new Promise((r) => setTimeout(r, 20));
    try {
      const h = await readHead(probeBe, cfg.asset);
      probe.reads++;
      if (h.status === 'ok') {
        probe.ok++;
        if (h.head.generation < probe.lastGen) probe.regress++;
        probe.lastGen = Math.max(probe.lastGen, h.head.generation);
      } else if (h.status === 'missing') probe.missing++;
      else { probe.torn++; if (probe.tornSamples.length < 5) probe.tornSamples.push(h); }
    } catch (e) { probe.missing++; }
  }
}

self.onmessage = async (ev) => {
  const m = ev.data;
  if (m.type === 'init') {
    cfg = m;
    bc = new BroadcastChannel(`iflow:${cfg.ws}`);
    const wsDir = await openWs(cfg.ws);
    be = new Backend(wsDir, cfg.backend);
    probeBe = new Backend(wsDir, 'async');
    bc.onmessage = (e) => {
      const x = e.data;
      if (x.type === 'commit' && role === 'leader') { if (store.ids.has(x.c.id)) bc.postMessage({ type: 'ack', ids: [x.c.id] }); else enqueue(x.c); }
      else if (x.type === 'ack') ackLocal(x.ids);
      else if (x.type === 'leader') { for (const p of pending.values()) { p.sentAt = performance.now(); bc.postMessage({ type: 'commit', c: p.c }); } }
    };
    // resend anything unacked (covers commits lost with a dead leader)
    setInterval(() => {
      if (role === 'leader') return;
      const now = performance.now();
      for (const p of pending.values()) if (now - p.sentAt > 300) { p.sentAt = now; bc.postMessage({ type: 'commit', c: p.c }); }
    }, 100);
    setInterval(() => { post({ type: 'stats', role, pending: pending.size, probe: { ...probe, tornSamples: undefined }, tornSamples: probe.tornSamples, lat: summarize(lat.splice(0)) }); }, 1000);
    if (!cfg.verify) probeLoop();
    navigator.locks.request(`iflow:${cfg.ws}:leader`, () => becomeLeader().catch((e) => post({ type: 'error', where: 'leader', message: String(e?.stack ?? e) })));
    post({ type: 'ready' });
  } else if (m.type === 'commit') {
    const now = performance.now();
    pending.set(m.c.id, { c: m.c, sentAt: now, firstAt: now });
    if (role === 'leader') enqueue(m.c); else bc.postMessage({ type: 'commit', c: m.c });
  } else if (m.type === 'pending') post({ type: 'pending', n: pending.size, role });
};
