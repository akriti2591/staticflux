/**
 * Real Chromium, main thread, real OPFS (writable write path, `segments`
 * journal). Run: `pnpm test:browser` (tooling/browser-test).
 */
import { describe, expect, it } from '@staticflux/browser-test';
import {
  checkBundleMimetype,
  collectGarbage,
  createArraySink,
  createBlobStore,
  createDirectoryObjectStore,
  createFolderMirror,
  createHeadStore,
  createMemoryCatalog,
  createWorkspaceStore,
  createZipWriter,
  detectLocks,
  detectOpfs,
  encodeHead,
  estimateStorage,
  fromUtf8,
  headRootSource,
  importZipBlob,
  addBlobToZip,
  openZip,
  readFile,
  requestPersistence,
  utf8,
  writeBundleMimetype,
} from '../index.js';
import { freshOpfsDir, runFaultInjection, runTornLogTail } from './fixtures.js';

describe('OPFS facts on the main thread (S6 probes)', () => {
  it('OPFS, move() on FileSystemFileHandle.prototype, Web Locks; no sync handles outside workers', () => {
    const support = detectOpfs();
    expect(support).toEqual({ opfs: true, syncAccessHandles: false, move: true, locks: true, broadcastChannel: true });
    expect('move' in FileSystemHandle.prototype, 'move on FileSystemHandle.prototype').toBe(false);
  });

  it('move() overwrites an existing target and the source disappears', async () => {
    const dir = await freshOpfsDir('probe-move');
    for (const [name, text] of [['target', 'old'], ['source', 'new']] as const) {
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await w.write(utf8(text));
      await w.close();
    }
    await (await dir.getFileHandle('source')).move?.(dir, 'target');
    const names: string[] = [];
    for await (const entry of dir.values()) names.push(entry.name);
    expect(names).toEqual(['target']);
    const read = await readFile(dir, 'target');
    expect(read.ok && fromUtf8(read.value)).toBe('new');
  });

  it('a File snapshot taken before a swap is NotReadable afterwards; readFile retries', async () => {
    const dir = await freshOpfsDir('probe-snapshot');
    const heads = createHeadStore(dir, { locks: navigator.locks as never, lockPrefix: `p-${crypto.randomUUID()}` });
    await heads.cas('h', 0, { v: 1 });
    const stale = await (await (await dir.getDirectoryHandle('heads')).getFileHandle('h.json')).getFile();
    await heads.cas('h', 1, { v: 2 });
    let name = 'resolved';
    await stale.arrayBuffer().catch((e: unknown) => (name = (e as DOMException).name));
    expect(name).toBe('NotReadableError');
    expect(await heads.read('h')).toEqual({ ok: true, value: { v: 2, generation: 2 } });
  });
});

describe('heads on real OPFS', () => {
  it('compare-and-swap under a Web Lock: exactly 1 of 16 racers wins (S6)', async () => {
    const dir = await freshOpfsDir('cas-race');
    const locks = detectLocks();
    if (locks === undefined) throw new Error('no Web Locks');
    const prefix = `race-${crypto.randomUUID()}`;
    const racers = Array.from({ length: 16 }, () => createHeadStore(dir, { locks, lockPrefix: prefix }));
    await racers[0]?.cas('as_x', 0, { v: 'start' });
    const results = await Promise.all(racers.map((heads, i) => heads.cas('as_x', 1, { v: i })));
    expect(results.filter((r) => r.ok).length, 'winners').toBe(1);
    expect(results.filter((r) => !r.ok && r.error.code === 'SF-BLOB-003').length, 'conflicts').toBe(15);
    const final = await racers[0]?.read('as_x');
    expect(final?.ok && final.value?.generation).toBe(2);
  });

  it('a head written in place and torn halfway is detected', async () => {
    const dir = await freshOpfsDir('torn-head');
    const heads = createHeadStore(dir, { locks: navigator.locks as never, lockPrefix: `t-${crypto.randomUUID()}` });
    await heads.cas('as_t', 0, { parts: {} });
    const bytes = encodeHead({ parts: { root: 'x' }, generation: 2 });
    const w = await (await (await dir.getDirectoryHandle('heads')).getFileHandle('as_t.json')).createWritable();
    await w.write(bytes.subarray(0, bytes.length >> 1));
    await w.close();
    const read = await heads.read('as_t');
    expect(read.ok ? '' : read.error.code).toBe('SF-BLOB-010');
  });
});

describe('Latest store fault injection on real OPFS (writable path, segments journal)', () => {
  for (const failAt of ['afterBlobs', 'beforeMove', 'afterHead'] as const) {
    it(`crash ${failAt}: no acknowledged commit lost, no temp head left`, async () => {
      const result = await runFaultInjection('segments', failAt);
      expect(result.recovered).toBe(100);
      expect(result.tempsLeft).toBe(0);
    });
  }

  it('torn log tail: whole records kept, the torn one dropped', async () => {
    expect(await runTornLogTail('segments')).toEqual({ tornTails: 1, goodKept: true, tornDropped: true });
  });
});

describe('GC on real OPFS', () => {
  it('sweeps from the catalog inventory with a grace period; no live blob lost', async () => {
    const dir = await freshOpfsDir('gc');
    const catalog = createMemoryCatalog();
    let now = 0;
    const ws = createWorkspaceStore(dir, { lockPrefix: `gc-${crypto.randomUUID()}`, peer: 'A', catalog, now: () => now });
    if (!ws.ok) throw ws.error;
    const live = [];
    for (let i = 0; i < 60; i++) {
      const ref = await ws.value.blobs.put(utf8(`blob ${i}`));
      if (!ref.ok) throw ref.error;
      if (i % 3 !== 0) live.push(ref.value);
    }
    await ws.value.heads.cas('as_live', 0, { parts: Object.fromEntries(live.map((r, i) => [`page:${i}`, r])) });
    now = 40 * 24 * 3600 * 1000;
    const young = await ws.value.blobs.put(utf8('written during the mark'));
    const report = await collectGarbage({ blobs: ws.value.blobs, catalog, roots: [headRootSource(ws.value.heads)], now: () => now });
    if (!report.ok) throw report.error;
    expect(report.value.deleted).toBe(20);
    expect(report.value.young).toBe(1);
    for (const ref of live) expect((await ws.value.blobs.has(ref.digest)).ok).toBe(true);
    expect(young.ok && (await ws.value.blobs.has(young.value.digest))).toEqual({ ok: true, value: true });
  });
});

describe('folder mirror on real directory handles', () => {
  it('batches many commits into one flush; the folder head appears only after its objects', async () => {
    const source = await freshOpfsDir('mirror-src');
    const folder = await freshOpfsDir('mirror-folder');
    const locks = detectLocks();
    if (locks === undefined) throw new Error('no Web Locks');
    const prefix = `m-${crypto.randomUUID()}`;
    const mirror = createFolderMirror({ source, target: folder, locks, lockPrefix: prefix, policy: { idleMs: 50, minIntervalMs: 200, maxDelayMs: 1000 } });
    const ws = createWorkspaceStore(source, { lockPrefix: prefix, peer: 'A', locks, observer: mirror.notify });
    if (!ws.ok) throw ws.error;
    for (let g = 0; g < 30; g++) {
      const ref = await ws.value.blobs.put(utf8(`part ${g}`));
      if (!ref.ok) throw ref.error;
      await ws.value.heads.cas('as_1', g, { parts: { [`page:${g}`]: ref.value } });
    }
    expect(mirror.state).toBe('scheduled');
    await new Promise((r) => setTimeout(r, 400));
    expect(mirror.state).toBe('idle');
    const folderHeads = createHeadStore(folder, { locks, lockPrefix: `${prefix}:folder` });
    const head = await folderHeads.read('as_1');
    expect(head.ok && head.value?.generation).toBe(30);
    const folderBlobs = createBlobStore(createDirectoryObjectStore(folder));
    let count = 0;
    for await (const item of folderBlobs.list()) if (item.ok) count += 1;
    expect(count).toBe(30);
    const closed = await mirror.close();
    expect(closed.ok).toBe(true);
  });
});

describe('.iflow zip on real Blob/File', () => {
  it('writes a bundle, reads it in place, and imports blobs without recompression', async () => {
    const dir = await freshOpfsDir('zip');
    const ws = createWorkspaceStore(dir, { lockPrefix: `z-${crypto.randomUUID()}`, peer: 'A' });
    if (!ws.ok) throw ws.error;
    const part = await ws.value.blobs.put(utf8('{"schema":"instaflow.part/1","nodes":[]}'.repeat(100)), { encoding: 'deflate-raw', mime: 'application/json' });
    if (!part.ok) throw part.error;
    const sink = createArraySink();
    const zip = createZipWriter(sink);
    await writeBundleMimetype(zip, 'application/vnd.instaflow.bundle+zip');
    const added = await addBlobToZip(zip, ws.value.blobs, part.value, `blobs/sha256/${part.value.digest.slice(7)}`);
    expect(added.ok).toBe(true);
    await zip.finish();
    const file = new File([sink.bytes()], 'test.iflow');
    const reader = await openZip(file);
    if (!reader.ok) throw reader.error;
    expect((await checkBundleMimetype(reader.value, 'application/vnd.instaflow.bundle+zip')).ok).toBe(true);
    const entry = reader.value.entries[1];
    if (entry === undefined) throw new Error('entry missing');
    const target = await freshOpfsDir('zip-import');
    const imported = createWorkspaceStore(target, { lockPrefix: `zi-${crypto.randomUUID()}`, peer: 'B' });
    if (!imported.ok) throw imported.error;
    expect((await importZipBlob(reader.value, entry, imported.value.blobs, part.value)).ok).toBe(true);
    const stored = await imported.value.blobs.get(part.value.digest);
    const original = await ws.value.blobs.get(part.value.digest);
    expect(stored.ok && original.ok && stored.value).toEqual(original.ok ? original.value : undefined);
  });
});

describe('quota and persistence', () => {
  it('estimate and persist() answer without throwing', async () => {
    const facts = await estimateStorage();
    expect(facts.ok && facts.value.quota).toBeGreaterThan(0);
    const persisted = await requestPersistence();
    expect(persisted.ok).toBe(true);
  });
});
