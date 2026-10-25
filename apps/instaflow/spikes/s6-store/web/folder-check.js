// Human-run checks on a REAL folder picked via showDirectoryPicker (File System Access). Not automatable headless.
// Runs the 'async' backend (createWritable + FileSystemHandle.move) against the real directory handle.
import { Backend, readHead, casHead, summarize } from './core.js';
import { createMilestone } from './milestone.js';
import { makeDoc, editPages, prng } from './doc.js';

export async function folderCheck(picked, log) {
  const root = await picked.getDirectoryHandle('instaflow-s6-check', { create: true });
  const out = { api: { handleMove: 'move' in FileSystemHandle.prototype, fileHandleMove: 'move' in FileSystemFileHandle.prototype } };
  // 1. does move() exist and overwrite an existing file in a real folder?
  const w = async (name, s) => { const fh = await root.getFileHandle(name, { create: true }); const x = await fh.createWritable(); await x.write(s); await x.close(); return fh; };
  const a = await w('a.txt', 'AAAA'); await w('b.txt', 'BBBB');
  out.moveOverwritesExisting = await a.move(root, 'b.txt').then(async () => (await (await (await root.getFileHandle('b.txt')).getFile()).text()) === 'AAAA', (e) => `throws ${e.name}: ${e.message}`);
  log(`move overwrite: ${out.moveOverwritesExisting}`);
  // 2. previous run killed mid-loop? verify the head is intact and list leftovers
  const be = new Backend(root, 'async');
  const prev = await readHead(be, 'as_loop');
  out.previousLoopHead = { status: prev.status, generation: prev.head?.generation };
  out.leftovers = (await be.list(['heads'])).map(([n]) => n).filter((n) => n !== 'as_loop.json');
  log(`previous loop head: ${JSON.stringify(out.previousLoopHead)} leftovers: ${out.leftovers.length}`);
  // 3. CAS swap timing on the real folder
  const lp = `folder-${Math.random()}`; const xs = [];
  let gen = prev.head?.generation ?? 0;
  for (let i = 0; i < 50; i++) { const s = performance.now(); const r = await casHead(be, lp, 'as_bench', gen, { parts: {}, i }); if (!r.ok) { gen = r.current?.generation ?? 0; continue; } gen = r.head.generation; xs.push(performance.now() - s); }
  out.casSwapMs = summarize(xs);
  // 4. milestone of a 200-page doc on the real folder
  const parts = makeDoc(200, 60, 7); const r = prng(3); const ms = [];
  await createMilestone(be, { lockPrefix: lp, asset: 'as_doc', parts, name: 'm0' }).then((m) => { out.firstMilestone = { ms: m.ms.total, bytes: m.bytesWritten }; });
  for (let i = 0; i < 10; i++) { editPages(parts, 5, r); const m = await createMilestone(be, { lockPrefix: lp, asset: 'as_doc', parts, name: `m${i}` }); ms.push(m.ms.total); }
  out.milestoneK5Ms = summarize(ms);
  log(`milestone k=5: ${JSON.stringify(out.milestoneK5Ms)}`);
  // 5. kill loop: swap the head as fast as possible for 60 s. Kill the browser process (kill -9) during it, then
  //    reopen this page and click again: step 2 reports whether the head survived intact.
  log('head swap loop running for 60 s: kill the browser now (kill -9 <chrome pid>), then reopen and re-run');
  const loopGen0 = (await readHead(be, 'as_loop')).head?.generation ?? 0; let g = loopGen0; const t0 = performance.now();
  while (performance.now() - t0 < 60_000) { const res = await casHead(be, lp, 'as_loop', g, { parts: {}, pad: 'x'.repeat(4000) }); g = res.ok ? res.head.generation : (res.current?.generation ?? g); }
  out.loopSwaps = g - loopGen0;
  return out;
}
