/**
 * Latest store tests, including the S6 fault-injection suite ported to the
 * production code: crash after blobs / before the head move / after the head,
 * a torn log tail, a torn head, and compaction starvation under repeated kills.
 *
 * The "document" is the S6 synthetic CRDT: a part's state is the set of commit
 * ids applied to it (idempotent and commutative, which is what durability needs).
 */
import { err, ok, type Result } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { fromUtf8, utf8 } from './codec.js';
import { BlobIoError } from './errors.js';
import type { JournalMode } from './journal.js';
import { createLatestStore, decodeLatestRecord, encodeLatestRecord, type LatestHead, type LatestStore } from './latest.js';
import { createMemoryLocks, type MemoryLocks } from './locks.js';
import { createMemoryDirectory, type MemoryFileSystem } from './memory-fs.js';
import { createWorkspaceStore } from './opfs.js';

interface Node {
  readonly latest: LatestStore;
  readonly state: Map<string, Set<string>>;
  readonly ids: () => Set<string>;
  commit(batch: readonly { id: string; part: string }[]): Promise<void>;
}

async function openNode(fs: MemoryFileSystem, locks: MemoryLocks, peer: string, mode: JournalMode, maxPartsPerSwap = 16): Promise<Node & { recovery: Awaited<ReturnType<LatestStore['recover']>> }> {
  const ws = createWorkspaceStore(fs.root, { lockPrefix: 'ws_f', peer, locks: locks.forTab(peer), journalMode: mode, syncAvailable: true });
  if (!ws.ok) throw new Error(ws.error.code);
  const state = new Map<string, Set<string>>();
  const apply = (id: string, part: string): void => {
    let set = state.get(part);
    if (set === undefined) state.set(part, (set = new Set()));
    set.add(id);
  };
  const latest = createLatestStore({
    blobs: ws.value.blobs,
    heads: ws.value.heads,
    journal: ws.value.journal('as_f'),
    name: 'as_f',
    maxPartsPerSwap,
    encoding: 'deflate-raw',
    mime: 'application/x-test-part',
    initialHead: () => ({ schema: 'test.head/1', milestones: [] }),
    snapshot: (part) => ok(utf8(JSON.stringify([...(state.get(part) ?? [])].sort()))),
  });
  const recovery = await latest.recover();
  if (recovery.ok) {
    for (const [part, ref] of Object.entries(recovery.value.head?.parts ?? {})) {
      const bytes = await ws.value.blobs.get(ref);
      if (!bytes.ok) throw new Error(`part ${part} unreadable: ${bytes.error.code}`);
      for (const id of JSON.parse(fromUtf8(bytes.value)) as string[]) apply(id, part);
    }
    for (const record of recovery.value.records) for (const part of record.parts) apply(record.id, part);
  }
  return {
    latest,
    state,
    recovery,
    ids: () => new Set([...state.values()].flatMap((s) => [...s])),
    async commit(batch) {
      for (const c of batch) apply(c.id, c.part);
      const appended = await latest.append(batch.map((c) => ({ id: c.id, parts: [c.part], data: utf8(c.id) })));
      if (!appended.ok) throw new Error(appended.error.code);
    },
  };
}

const batch = (peer: string, k: number, parts = 7) => Array.from({ length: 10 }, (_, i) => ({ id: `${peer}:${k}:${i}`, part: `page:${(k + i) % parts}` }));

describe('latest record codec', () => {
  it('round-trips id, parts and data', () => {
    const encoded = encodeLatestRecord({ id: 'c1', parts: ['root', 'page:2'], data: utf8('payload') });
    const decoded = decodeLatestRecord(encoded);
    expect(decoded.ok && { ...decoded.value, data: fromUtf8(decoded.value.data) }).toEqual({ id: 'c1', parts: ['root', 'page:2'], data: 'payload' });
  });

  it('rejects malformed records', () => {
    for (const bad of [new Uint8Array([1]), new Uint8Array([2, 0, 0, 0, 0x7b, 0x7d]), (() => {
      const header = utf8('{"i":1,"p":[]}');
      const out = new Uint8Array(4 + header.length);
      new DataView(out.buffer).setUint32(0, header.length, true);
      out.set(header, 4);
      return out;
    })()]) {
      const decoded = decodeLatestRecord(bad);
      expect(decoded.ok ? '' : decoded.error.code).toBe('SF-BLOB-008');
    }
  });
});

describe.each(['append', 'segments'] as JournalMode[])('createLatestStore (journal %s)', (mode) => {
  it('a new asset recovers empty; append dedupes by id; compaction writes the head', async () => {
    const fs = createMemoryDirectory();
    const locks = createMemoryLocks();
    const node = await openNode(fs, locks, 'A', mode);
    expect(node.recovery.ok && node.recovery.value.head).toBeUndefined();
    await node.commit(batch('A', 0));
    const again = await node.latest.append([{ id: 'A:0:0', parts: ['page:0'], data: utf8('dup') }]);
    expect(again.ok && again.value).toEqual({ fresh: [], durable: ['A:0:0'] });
    expect(node.latest.has('A:0:3')).toBe(true);
    expect([...node.latest.dirty].sort()).toEqual(['page:0', 'page:1', 'page:2', 'page:3', 'page:4', 'page:5', 'page:6']);
    const compacted = await node.latest.compact();
    expect(compacted.ok && !compacted.value.skipped && compacted.value.generation).toBe(1);
    expect(node.latest.head?.['schema']).toBe('test.head/1');
    expect(node.latest.dirty).toEqual([]);
    expect(await node.latest.compact()).toEqual({ ok: true, value: { skipped: true, reason: 'clean' } });
  });

  for (const failAt of ['afterBlobs', 'beforeMove', 'afterHead'] as const) {
    it(`S6 fault: a crash ${failAt} loses no acknowledged commit and leaves a readable head`, async () => {
      const fs = createMemoryDirectory();
      const locks = createMemoryLocks();
      const a = await openNode(fs, locks, 'A', mode);
      const acked: string[] = [];
      for (let k = 0; k < 5; k++) {
        await a.commit(batch('A', k));
        acked.push(...batch('A', k).map((c) => c.id));
      }
      expect((await a.latest.compact()).ok).toBe(true);
      for (let k = 5; k < 10; k++) {
        await a.commit(batch('A', k));
        acked.push(...batch('A', k).map((c) => c.id));
      }
      const crashed = await a.latest.compact({
        hooks: {
          [failAt]: () => {
            throw new Error('simulated crash');
          },
        },
      });
      expect(crashed.ok).toBe(false);
      await a.latest.close();
      locks.crashTab('A');
      const b = await openNode(fs, locks, 'B', mode);
      if (!b.recovery.ok) throw new Error(b.recovery.error.code);
      expect(b.recovery.value.head?.generation).toBe(failAt === 'afterHead' ? 2 : 1);
      expect(acked.filter((id) => !b.ids().has(id))).toEqual([]);
      if (failAt === 'beforeMove') expect(fs.paths().some((p) => p.includes('.tmp-'))).toBe(false);
      expect((await b.latest.compact()).ok).toBe(true);
    });
  }

  it('S6 fault: a torn log tail keeps the whole records and drops the torn one', async () => {
    const fs = createMemoryDirectory();
    const locks = createMemoryLocks();
    const b = await openNode(fs, locks, 'B', mode);
    const good = Array.from({ length: 30 }, (_, i) => ({ id: `B:${i}`, part: 'page:1' }));
    for (let i = 0; i < 3; i++) await b.commit(good.slice(i * 10, i * 10 + 10));
    await b.latest.close();
    // The crash left half a record at the end of the newest segment.
    const segments = fs.paths().filter((p) => p.startsWith('log/as_f/'));
    const last = segments.at(-1) ?? '';
    const tornRecord = encodeLatestRecord({ id: 'B:torn', parts: ['page:1'], data: utf8('x') });
    const { frameRecord } = await import('./journal.js');
    const frame = frameRecord(tornRecord);
    fs.write(last, new Uint8Array([...(fs.read(last) ?? []), ...frame.subarray(0, frame.length - 5)]));
    locks.crashTab('B');
    const c = await openNode(fs, locks, 'C', mode);
    if (!c.recovery.ok) throw new Error(c.recovery.error.code);
    expect(c.recovery.value.report.tornTails).toBe(1);
    expect(good.every((g) => c.ids().has(g.id))).toBe(true);
    expect(c.ids().has('B:torn')).toBe(false);
  });

  it('S6 fault: a head torn in place is reported (SF-BLOB-010), never silently replaced', async () => {
    const fs = createMemoryDirectory();
    const locks = createMemoryLocks();
    const a = await openNode(fs, locks, 'A', mode);
    await a.commit(batch('A', 0));
    await a.latest.compact();
    const head = fs.read('heads/as_f.json') ?? new Uint8Array();
    fs.write('heads/as_f.json', head.subarray(0, head.length >> 1));
    const b = await openNode(fs, locks, 'B', mode);
    expect(b.recovery.ok ? '' : b.recovery.error.code).toBe('SF-BLOB-010');
  });

  it('compaction is incremental: at most N parts per head swap, logFrom advances only when clean', async () => {
    const fs = createMemoryDirectory();
    const locks = createMemoryLocks();
    const a = await openNode(fs, locks, 'A', mode, 16);
    await a.commit(Array.from({ length: 40 }, (_, i) => ({ id: `A:${i}`, part: `page:${i}` })));
    const first = await a.latest.compact();
    expect(first.ok && !first.value.skipped && first.value.parts.length).toBe(16);
    expect(first.ok && !first.value.skipped && first.value.logFrom).toBe(0);
    const second = await a.latest.compact({ maxParts: 16 });
    expect(second.ok && !second.value.skipped && second.value.logFrom).toBe(0);
    const third = await a.latest.compact();
    expect(third.ok && !third.value.skipped && third.value.parts.length).toBe(8);
    expect(third.ok && !third.value.skipped && third.value.logFrom).toBeGreaterThan(0);
    expect(Object.keys(a.latest.head?.parts ?? {})).toHaveLength(40);
  });

  it('cover: recovery marks a part dirty only for records newer than its snapshot', async () => {
    const fs = createMemoryDirectory();
    const locks = createMemoryLocks();
    const a = await openNode(fs, locks, 'A', mode, 1);
    await a.commit([{ id: 'x1', part: 'page:x' }]);
    await a.commit([{ id: 'y1', part: 'page:y' }]);
    const compacted = await a.latest.compact();
    const snapshotted = compacted.ok && !compacted.value.skipped ? compacted.value.parts[0] : '';
    await a.latest.close();
    locks.crashTab('A');
    const b = await openNode(fs, locks, 'B', mode, 1);
    if (!b.recovery.ok) throw new Error(b.recovery.error.code);
    expect([...b.recovery.value.records.map((r) => r.id)].sort()).toEqual(['x1', 'y1']);
    expect(b.recovery.value.dirtyParts).toEqual(['page:x', 'page:y'].filter((p) => p !== snapshotted));
  });

  it('a part re-dirtied after an older uncovered record keeps logFrom from skipping it', async () => {
    const fs = createMemoryDirectory();
    const locks = createMemoryLocks();
    const a = await openNode(fs, locks, 'A', mode, 1);
    await a.commit([{ id: 'q-1', part: 'page:q' }]);
    await a.commit([{ id: 'p-old', part: 'page:p' }]);
    // This compaction snapshots only page:q. While it runs, page:p gets a record in the NEW segment:
    // its newest position is past the roll but its oldest (p-old) is not, so logFrom must not advance.
    const compacted = await a.latest.compact({ hooks: { afterBlobs: () => a.commit([{ id: 'p-new', part: 'page:p' }]) } });
    expect(compacted.ok && !compacted.value.skipped && compacted.value.parts).toEqual(['page:q']);
    expect(compacted.ok && !compacted.value.skipped && compacted.value.logFrom).toBe(0);
    await a.latest.close();
    locks.crashTab('A');
    const b = await openNode(fs, locks, 'B', mode, 1);
    expect(['q-1', 'p-old', 'p-new'].every((id) => b.ids().has(id))).toBe(true);
  });

  it('compaction under repeated leader kills converges (S6 starvation fix)', async () => {
    const fs = createMemoryDirectory();
    const locks = createMemoryLocks();
    const acked = new Set<string>();
    let node = await openNode(fs, locks, 'L0', mode, 16);
    await node.commit(Array.from({ length: 100 }, (_, i) => ({ id: `seed:${i}`, part: `page:${i}` })));
    for (let i = 0; i < 100; i++) acked.add(`seed:${i}`);
    const dirtyAfterRecovery: number[] = [];
    for (let leader = 1; leader <= 10; leader++) {
      // Each leader commits a little, compacts once, then is killed.
      const fresh = [{ id: `L${leader}:edit`, part: `page:${leader % 3}` }];
      await node.commit(fresh);
      acked.add(fresh[0]?.id ?? '');
      await node.latest.compact();
      await node.latest.close();
      locks.crashTab(`L${leader - 1}`);
      node = await openNode(fs, locks, `L${leader}`, mode, 16);
      if (!node.recovery.ok) throw new Error(node.recovery.error.code);
      dirtyAfterRecovery.push(node.recovery.value.dirtyParts.length);
      expect([...acked].filter((id) => !node.ids().has(id))).toEqual([]);
    }
    expect(dirtyAfterRecovery.at(-1)).toBeLessThanOrEqual(1);
    expect((node.latest.head?.logFrom ?? 0) > 0).toBe(true);
  });

  it('a CAS conflict with a concurrent head update is merged, not lost', async () => {
    const fs = createMemoryDirectory();
    const locks = createMemoryLocks();
    const a = await openNode(fs, locks, 'A', mode);
    await a.commit(batch('A', 0));
    await a.latest.compact();
    await a.commit(batch('A', 1));
    const compacted = await a.latest.compact({
      hooks: {
        afterBlobs: async () => {
          const milestone = await a.latest.updateHead((current) => ok({ ...(current ?? {}), milestones: ['ms_1'] } as never));
          expect(milestone.ok).toBe(true);
        },
      },
    });
    expect(compacted.ok).toBe(true);
    const head = a.latest.head as (LatestHead & { milestones: string[] }) | undefined;
    expect(head?.milestones).toEqual(['ms_1']);
    expect(head?.generation).toBe(3);
  });

  it('a failed snapshot keeps the parts dirty', async () => {
    const fs = createMemoryDirectory();
    const locks = createMemoryLocks();
    const ws = createWorkspaceStore(fs.root, { lockPrefix: 'ws', peer: 'A', locks: locks.forTab('A'), journalMode: mode, syncAvailable: true });
    if (!ws.ok) throw new Error('ws');
    let fail = true;
    const latest = createLatestStore({
      blobs: ws.value.blobs,
      heads: ws.value.heads,
      journal: ws.value.journal('as_s'),
      name: 'as_s',
      snapshot: (): Result<Uint8Array> => (fail ? err(BlobIoError()) : ok(utf8('snap'))),
    });
    const early = await latest.compact();
    expect(early.ok ? '' : early.error.code).toBe('SF-BLOB-008');
    await latest.recover();
    await latest.append([{ id: 'r1', parts: ['root'], data: utf8('x') }]);
    const noParts = await latest.append([{ id: 'r2', parts: [], data: utf8('x') }]);
    expect(noParts.ok ? '' : noParts.error.code).toBe('SF-BLOB-008');
    const failed = await latest.compact();
    expect(failed.ok ? '' : failed.error.code).toBe('SF-BLOB-007');
    expect(latest.dirty).toEqual(['root']);
    fail = false;
    expect((await latest.compact()).ok).toBe(true);
    await latest.close();
    const closed = await latest.append([{ id: 'r3', parts: ['root'], data: utf8('x') }]);
    expect(closed.ok ? '' : closed.error.code).toBe('SF-BLOB-013');
    const reRecover = await latest.recover();
    expect(reRecover.ok ? '' : reRecover.error.code).toBe('SF-BLOB-013');
  });
});
