// S6 benchmarks + correctness tests (dedicated worker). Posts {type:'done', result}.
import { Backend, enc, dec, readHead, casHead, encodeHead, decodeHead, frame, putBlob, sha256Hex, deflateRaw, summarize, canonicalJSON } from './core.js';
import { LatestStore } from './latest.js';
import { createMilestone, gc, exportMilestone, importBundle } from './milestone.js';
import { makeDoc, editPages, prng } from './doc.js';

const log = (msg) => self.postMessage({ type: 'log', msg });
let opfs, base;
async function freshWs(name) {
  const n = `${name}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  return base.getDirectoryHandle(n, { create: true });
}
const t = () => performance.now();
const r2 = (x) => Math.round(x * 100) / 100;

async function probe() {
  const d = await freshWs('probe');
  const w = async (name, s) => { const fh = await d.getFileHandle(name, { create: true }); const x = await fh.createWritable(); await x.write(s); await x.close(); return fh; };
  const read = async (name) => (await (await d.getFileHandle(name)).getFile()).text();
  const out = {
    api: { 'FileSystemHandle.prototype.move': 'move' in FileSystemHandle.prototype, 'FileSystemFileHandle.prototype.move': 'move' in FileSystemFileHandle.prototype, 'FileSystemDirectoryHandle.prototype.move': 'move' in FileSystemDirectoryHandle.prototype, moveOwner: (() => { let o = FileSystemFileHandle.prototype; while (o && !Object.prototype.hasOwnProperty.call(o, 'move')) o = Object.getPrototypeOf(o); return o?.constructor?.name ?? null; })(), 'FileSystemHandle.prototype.remove': 'remove' in FileSystemHandle.prototype,
      createSyncAccessHandle: 'createSyncAccessHandle' in FileSystemFileHandle.prototype, createWritable: 'createWritable' in FileSystemFileHandle.prototype,
      FileSystemObserver: typeof self.FileSystemObserver !== 'undefined', 'navigator.locks': !!navigator.locks, BroadcastChannel: typeof BroadcastChannel !== 'undefined',
      CompressionStream_deflateRaw: (() => { try { new CompressionStream('deflate-raw'); return true; } catch { return false; } })(), userAgent: navigator.userAgent },
  };
  // move over an existing file
  const a = await w('a.txt', 'AAAA'); await w('b.txt', 'BBBB');
  try { await a.move(d, 'b.txt'); out.moveOverwritesExisting = (await read('b.txt')) === 'AAAA'; out.sourceGoneAfterMove = await d.getFileHandle('a.txt').then(() => false, () => true); }
  catch (e) { out.moveOverwritesExisting = `throws ${e.name}: ${e.message}`; }
  // a File snapshot taken before the move
  const c = await w('c.txt', 'CCCC'); const snap = await (await d.getFileHandle('b.txt')).getFile();
  await c.move(d, 'b.txt');
  out.fileSnapshotAfterTargetReplaced = await snap.text().then((s) => `reads '${s}'`, (e) => `throws ${e.name}`);
  // move onto a target that has an open sync access handle
  const e1 = await w('e.txt', 'EEEE'); const tgt = await d.getFileHandle('b.txt'); const sah = await tgt.createSyncAccessHandle();
  out.moveOntoTargetWithOpenSyncHandle = await e1.move(d, 'b.txt').then(() => 'succeeds', (e) => `throws ${e.name}`); sah.close();
  // move of a source with an open sync handle
  const f1 = await w('f.txt', 'FFFF'); const sah2 = await f1.createSyncAccessHandle();
  out.moveSourceWithOpenSyncHandle = await f1.move(d, 'g.txt').then(() => 'succeeds', (e) => `throws ${e.name}`); sah2.close();
  // readwrite-unsafe mode
  try { const h = await (await d.getFileHandle('g.txt', { create: true })).createSyncAccessHandle({ mode: 'readwrite-unsafe' }); out.syncHandleModeOption = h.mode ?? 'no mode attr'; h.close(); } catch (e) { out.syncHandleModeOption = `throws ${e.name}`; }
  // timing of the primitive ops (n=200)
  const be = new Backend(await d.getDirectoryHandle('ops', { create: true }), 'sync');
  const beA = new Backend(await d.getDirectoryHandle('opsA', { create: true }), 'async');
  const bytes = new Uint8Array(4096).fill(7);
  const time = async (fn, n = 200) => { const xs = []; for (let i = 0; i < n; i++) { const s = t(); await fn(i); xs.push(t() - s); } return summarize(xs); };
  out.opsMs = {
    syncWriteRaw4k: await time(async (i) => be.writeRaw(await be.dir(['x']), `r${i}`, bytes)),
    syncWriteAtomic4k_tmpMove: await time((i) => be.writeAtomic(['y'], `a${i}`, bytes)),
    asyncWriteRaw4k_createWritable: await time(async (i) => beA.writeRaw(await beA.dir(['x']), `r${i}`, bytes)),
    asyncWriteAtomic4k_tmpMove: await time((i) => beA.writeAtomic(['y'], `a${i}`, bytes)),
    existsHit: await time((i) => be.exists(['y'], `a${i}`)),
    existsMiss: await time((i) => be.exists(['y'], `zz${i}`)),
    sha256_4k: await time(() => sha256Hex(bytes), 500),
  };
  const big = crypto.getRandomValues(new Uint8Array(65536)); const mb = new Uint8Array(8 << 20); for (let o = 0; o < mb.length; o += 65536) mb.set(big, o);
  const s = t(); await sha256Hex(mb); out.sha256_MBps = r2(8 / ((t() - s) / 1000));
  return out;
}

async function casTests(kind) {
  const be = new Backend(await freshWs(`cas_${kind}`), kind); const lp = `cas-${Math.random()}`;
  const res = {};
  const a = await casHead(be, lp, 'as_x', 0, { v: 1, parts: {} }); const b = await casHead(be, lp, 'as_x', 0, { v: 2, parts: {} }); const c = await casHead(be, lp, 'as_x', 1, { v: 3, parts: {} });
  res.sequential = { firstOk: a.ok, staleRejected: !b.ok && b.error.code === 'IF-STORE-003', nextOk: c.ok && c.head.generation === 2 };
  const race = await Promise.all(Array.from({ length: 16 }, (_, i) => casHead(be, lp, 'as_x', 2, { v: 10 + i, parts: {} })));
  res.race16_withLock = { winners: race.filter((x) => x.ok).length, conflicts: race.filter((x) => !x.ok && x.error.code === 'IF-STORE-003').length };
  // the same race without the Web Lock (read-compare-write): shows why the lock is required
  const noLock = await Promise.all(Array.from({ length: 16 }, async (_, i) => {
    const cur = await readHead(be, 'as_x'); if (cur.head.generation !== 3) return false;
    try { await be.writeAtomic(['heads'], 'as_x.json', encodeHead({ ...cur.head, v: 100 + i, generation: 4 })); return true; }
    catch (e) { return e.name; }
  }));
  res.race16_withoutLock = { winnersThatBelievedTheyWon: noLock.filter((x) => x === true).length, moveErrors: noLock.filter((x) => typeof x === 'string').length, errorNames: [...new Set(noLock.filter((x) => typeof x === 'string'))] };
  const fin = await readHead(be, 'as_x'); res.finalHeadOk = fin.status === 'ok';
  res.pass = res.sequential.firstOk && res.sequential.staleRejected && res.sequential.nextOk && res.race16_withLock.winners === 1 && res.finalHeadOk;
  return res;
}

async function faultTests(kind) {
  const out = {};
  for (const failAt of ['afterBlobs', 'beforeMove', 'afterHead']) {
    const be = new Backend(await freshWs(`fault_${kind}_${failAt}`), kind); const lp = `f-${Math.random()}`;
    const A = new LatestStore(be, { lockPrefix: lp, asset: 'as_f', peer: 'A' }); await A.recover();
    const acked = [];
    const batch = async (k) => { const cs = Array.from({ length: 10 }, (_, i) => ({ id: `A:${k}:${i}`, part: `page:${(k + i) % 7}` })); await A.append(cs); acked.push(...cs.map((c) => c.id)); };
    for (let k = 0; k < 5; k++) await batch(k);
    await A.compact();
    for (let k = 5; k < 10; k++) await batch(k);
    const crash = () => { throw new Error('simulated crash'); };
    let crashed = false;
    try { await A.compact({ [failAt]: crash }); } catch { crashed = true; }
    await A.close();                               // process death releases handles; data was already flushed
    const B = new LatestStore(be, { lockPrefix: lp, asset: 'as_f', peer: 'B' }); const rep = await B.recover();
    const missing = acked.filter((id) => !B.ids.has(id)).length;
    out[failAt] = { crashed, headStatus: rep.headStatus, generation: rep.generation, recovered: rep.recoveredIds, acked: acked.length, missing, tmpCleaned: rep.tmpCleaned, staleSegments: rep.staleSegments, pass: crashed && rep.headStatus === 'ok' && missing === 0 };
    if (failAt === 'afterHead') {
      // torn log tail: B writes 3 good batches then half a record, dies; C must keep the good ones and stop at the tear
      const good = Array.from({ length: 30 }, (_, i) => ({ id: `B:${i}`, part: 'page:1' }));
      for (let i = 0; i < 3; i++) await B.append(good.slice(i * 10, i * 10 + 10));
      const rec = frame(enc.encode(JSON.stringify([{ id: 'B:torn', part: 'page:1' }])));
      if (kind === 'sync') { B.seg.h.write(rec.subarray(0, rec.length - 5), { at: B.seg.off }); B.seg.h.flush(); }
      else await be.writeRaw(await be.dir(['log', 'as_f']), `99999999-B.bin`, rec.subarray(0, rec.length - 5));
      await B.close();
      const C = new LatestStore(be, { lockPrefix: lp, asset: 'as_f', peer: 'C' }); const rc = await C.recover();
      out.tornLogTail = { tornTails: rc.tornTails, goodKept: good.every((c) => C.ids.has(c.id)), tornDropped: !C.ids.has('B:torn'), allAckedKept: acked.every((id) => C.ids.has(id)) };
      out.tornLogTail.pass = out.tornLogTail.tornTails === 1 && out.tornLogTail.goodKept && out.tornLogTail.tornDropped && out.tornLogTail.allAckedKept;
      await C.close();
      // an in-place (non-atomic) head write torn halfway IS detected by the crc/parse check
      const hb = encodeHead({ asset: 'as_t', generation: 5, parts: {} });
      out.tornInPlaceHeadDetected = decodeHead(hb.subarray(0, hb.length >> 1)).status === 'torn' && decodeHead(hb).status === 'ok';
    }
  }
  out.pass = out.afterBlobs.pass && out.beforeMove.pass && out.afterHead.pass && out.tornLogTail.pass && out.tornInPlaceHeadDetected;
  return out;
}

async function milestoneBench(kind, iters) {
  const be = new Backend(await freshWs(`ms_${kind}`), kind); const lp = `m-${Math.random()}`;
  const parts = makeDoc(200, 60, 7); const r = prng(99);
  const canonBytes = [...parts.values()].reduce((a, p) => a + enc.encode(canonicalJSON(p)).length, 0);
  const first = await createMilestone(be, { lockPrefix: lp, asset: 'as_doc', parts, name: 'm0' });
  const runs = { k0: [], k1: [], k5: [], k20: [], k200: [] };
  let parent = first.id;
  const plan = [...Array(iters).fill(5), ...Array(Math.ceil(iters / 2)).fill(1), ...Array(Math.ceil(iters / 4)).fill(0), ...Array(Math.ceil(iters / 4)).fill(20), ...Array(3).fill(200)];
  for (const k of plan) {
    editPages(parts, k, r);
    const m = await createMilestone(be, { lockPrefix: lp, asset: 'as_doc', parts, name: `k${k}`, parent });
    parent = m.id; runs[`k${k}`].push(m);
  }
  const sum = (xs) => ({ n: xs.length, totalMs: summarize(xs.map((x) => x.ms.total)), canonicalizeMs: summarize(xs.map((x) => x.ms.canonicalize)), hashMs: summarize(xs.map((x) => x.ms.hash)),
    blobsMs: summarize(xs.map((x) => x.ms.blobs)), recordHeadMs: summarize(xs.map((x) => x.ms.recordAndHead)), newBlobs: summarize(xs.map((x) => x.newBlobs)), bytesWritten: summarize(xs.map((x) => x.bytesWritten)), filesWritten: summarize(xs.map((x) => x.filesWritten)) });
  const out = { doc: { parts: parts.size, canonicalBytes: canonBytes }, first: { ms: first.ms, newBlobs: first.newBlobs, bytesWritten: first.bytesWritten }, changed: {} };
  for (const [k, xs] of Object.entries(runs)) out.changed[k] = sum(xs);
  out.writesOnlyChangedParts = runs.k5.every((m) => m.newBlobs <= 5) && runs.k0.every((m) => m.newBlobs === 0) && runs.k1.every((m) => m.newBlobs <= 1);
  out.lastMilestone = parent;
  return { out, be, lp };
}

async function gcBench(kind, runs) {
  const be = new Backend(await freshWs(`gc_${kind}`), kind); const lp = `g-${Math.random()}`;
  const s0 = t(); const live = [];
  const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
  const put = async () => { const b = rnd(512); const hex = await sha256Hex(b); await putBlob(be, hex, b, { direct: true }); return hex; };
  for (let a = 0; a < 5; a++) {
    const ms = [];
    for (let m = 0; m < 7; m++) {
      const parts = {}; for (let p = 0; p < 200; p++) { const hex = await put(); live.push(hex); parts[`page:${p}`] = { digest: `sha256:${hex}`, size: 512, mime: 'x' }; }
      const id = `ms_${(await sha256Hex(enc.encode(`${a}-${m}-${Math.random()}`)))}`;
      await be.writeAtomic(['records', 'ms', id.slice(3, 5)], `${id}.json`, enc.encode(canonicalJSON({ schema: 'instaflow.milestone/1', id, parts })));
      ms.push(id);
    }
    await casHead(be, lp, `as_${a}`, 0, { schema: 'instaflow.head/1', asset: `as_${a}`, parts: {}, milestones: ms, pinned: [] });
  }
  const garbage = async () => { const g = []; for (let i = 0; i < 3000; i++) g.push(await put()); return g; };
  let g = await garbage();
  const setupMs = t() - s0;
  const results = [];
  for (let i = 0; i < runs; i++) {
    if (i > 0) g = await garbage();
    const res = await gc(be, { graceMs: 0 });
    results.push(res);
  }
  // correctness: every live blob still there, no garbage left
  let liveMissing = 0; for (const hex of live) if (!(await be.exists(['blobs', 'sha256', hex.slice(0, 2)], hex))) liveMissing++;
  let garbageLeft = 0; for (const hex of g) if (await be.exists(['blobs', 'sha256', hex.slice(0, 2)], hex)) garbageLeft++;
  // grace path: 3000 young garbage blobs survive a gc with a 1 h grace (lastModified check)
  await garbage(); const graceRun = await gc(be, { graceMs: 3600e3 });
  return { blobsAtStart: live.length + 3000, setupMs: r2(setupMs), runs: results.length, deletedPerRun: summarize(results.map((x) => x.deleted)), scannedPerRun: summarize(results.map((x) => x.scanned)),
    markMs: summarize(results.map((x) => x.ms.mark)), sweepMs: summarize(results.map((x) => x.ms.sweep)), totalMs: summarize(results.map((x) => x.ms.total)),
    liveMissing, garbageLeft, graceRun: { young: graceRun.young, deleted: graceRun.deleted, totalMs: r2(graceRun.ms.total) }, pass: liveMissing === 0 && garbageLeft === 0 && results.every((x) => x.deleted === 3000) };
}

async function zipTest(be, lp, msId, iters, wantBytes) {
  const exportsDir = await base.getDirectoryHandle('exports', { create: true });
  const ex = [], im = []; let bundle = null, info = null, first = null, second = null, same = null, bad = null;
  for (let i = 0; i < iters; i++) {
    const fh = await exportsDir.getFileHandle(`b${i}.iflow`, { create: true });
    const w = await fh.createWritable();
    const res = await exportMilestone(be, msId, (chunk) => w.write(chunk));
    await w.close(); if (!res.ok) return { result: { exportError: res.error } }; ex.push(res.ms); info = res;
    const file = await fh.getFile();
    const target = new Backend(await freshWs('import'), be.kind);
    const r1 = await importBundle(target, file, { lockPrefix: lp, newAsset: `as_imp${i}` }); im.push(r1.ms);
    if (i === 0) {
      second = await importBundle(target, file, { lockPrefix: lp, newAsset: 'as_imp_again' });
      same = await importBundle(be, file, { lockPrefix: lp, newAsset: 'as_imp_same' });
      bad = await importBundle(target, new Blob([new Uint8Array(1000)]), { lockPrefix: lp, newAsset: 'as_bad' });
      first = r1;
      if (wantBytes) bundle = new Uint8Array(await file.arrayBuffer());
    }
  }
  return { result: { bundleBytes: info.bytes, entries: info.entries, exportMs: summarize(ex), importMs: summarize(im), firstImport: first, reimportSameTarget: second, importIntoSourceWorkspace: same, notABundle: bad?.error?.code,
    pass: first.ok && second.blobsWritten === 0 && same.blobsWritten === 0 && bad?.error?.code === 'IF-BUNDLE-001' }, bundle };
}

self.onmessage = async (ev) => {
  const cfg = ev.data;
  try {
    opfs = await navigator.storage.getDirectory();
    base = await (await opfs.getDirectoryHandle('instaflow', { create: true })).getDirectoryHandle('bench', { create: true });
    const result = { config: cfg };
    if (cfg.tests.includes('probe')) { log('probe'); result.probe = await probe(); }
    for (const kind of cfg.backends) {
      const R = (result[kind] = {});
      if (cfg.tests.includes('cas')) { log(`cas ${kind}`); R.cas = await casTests(kind); }
      if (cfg.tests.includes('fault')) { log(`fault ${kind}`); R.fault = await faultTests(kind); }
      if (cfg.tests.includes('milestone')) {
        log(`milestone ${kind}`); const m = await milestoneBench(kind, cfg.iters); R.milestone = m.out;
        if (cfg.tests.includes('zip')) { log(`zip ${kind}`); const z = await zipTest(m.be, m.lp, m.out.lastMilestone, Math.max(3, cfg.iters >> 2), cfg.wantBundle && kind === 'sync'); R.zip = z.result; if (z.bundle) result.bundleB64 = btoa(Array.from(z.bundle, (c) => String.fromCharCode(c)).join('')); }
      }
      if (cfg.tests.includes('gc')) { log(`gc ${kind}`); R.gc = await gcBench(kind, cfg.gcRuns); }
    }
    if (cfg.cleanup) await opfs.removeEntry('instaflow', { recursive: true }).catch(() => {});
    self.postMessage({ type: 'done', result });
  } catch (e) { self.postMessage({ type: 'done', result: { error: String(e?.stack ?? e) } }); }
};
