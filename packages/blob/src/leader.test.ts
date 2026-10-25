import { err, ok, type Result } from '@staticflux/core';
import { createBroadcastHub } from '@staticflux/storage';
import { describe, expect, it } from 'vitest';
import { utf8 } from './codec.js';
import { BlobIoError } from './errors.js';
import { createLatestStore, type LatestStore } from './latest.js';
import { createStoreLeader, type LeaderSession, type StoreLeader, type StoreLeaderState } from './leader.js';
import { createMemoryLocks, type MemoryLocks } from './locks.js';
import { createMemoryDirectory, type MemoryFileSystem } from './memory-fs.js';
import { createWorkspaceStore } from './opfs.js';

interface Commit {
  readonly id: string;
  readonly part: string;
}

interface World {
  readonly fs: MemoryFileSystem;
  readonly locks: MemoryLocks;
  readonly hub: ReturnType<typeof createBroadcastHub>;
}

const world = (): World => ({ fs: createMemoryDirectory(), locks: createMemoryLocks(), hub: createBroadcastHub() });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(condition: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await sleep(2);
  }
}

function openLatest(w: World, peer: string): LatestStore {
  const ws = createWorkspaceStore(w.fs.root, { lockPrefix: 'ws', peer, locks: w.locks.forTab(peer), journalMode: 'append', syncAvailable: true });
  if (!ws.ok) throw new Error(ws.error.code);
  return createLatestStore({ blobs: ws.value.blobs, heads: ws.value.heads, journal: ws.value.journal('as_1'), name: 'as_1', snapshot: () => ok(utf8('[]')) });
}

function sessionOf(latest: LatestStore): LeaderSession<Commit> {
  return {
    async apply(batch) {
      const appended = await latest.append(batch.map((c) => ({ id: c.id, parts: [c.part], data: utf8(c.id) })));
      return appended.ok ? ok(appended.value.durable) : appended;
    },
    close: () => latest.close(),
  };
}

interface Tab {
  readonly name: string;
  readonly leader: StoreLeader<Commit>;
  readonly states: StoreLeaderState[];
  crash(): Promise<void>;
}

function openTab(w: World, name: string, lead?: (signal: AbortSignal) => Promise<Result<LeaderSession<Commit>>>): Tab {
  const channels: { close(): void }[] = [];
  const created = createStoreLeader<Commit>({
    name: 'iflow:ws',
    peer: name,
    locks: w.locks.forTab(name),
    channels: (n) => {
      const channel = w.hub(n);
      if (channel !== undefined) channels.push(channel);
      return channel;
    },
    idOf: (c) => c.id,
    resendMs: 15,
    retryMs: 5,
    lead:
      lead ??
      (async () => {
        const latest = openLatest(w, name);
        const recovered = await latest.recover();
        return recovered.ok ? ok(sessionOf(latest)) : recovered;
      }),
  });
  if (!created.ok) throw new Error(created.error.code);
  const states: StoreLeaderState[] = [];
  created.value.onStateChange((s) => states.push(s));
  return {
    name,
    leader: created.value,
    states,
    async crash() {
      w.locks.crashTab(name);
      for (const channel of channels) channel.close();
      await created.value.dispose();
    },
  };
}

async function recoveredIds(w: World): Promise<Set<string>> {
  const latest = openLatest(w, `verifier-${Math.random()}`);
  const recovered = await latest.recover();
  if (!recovered.ok) throw new Error(recovered.error.code);
  await latest.close();
  return new Set(recovered.value.records.map((r) => r.id));
}

describe('createStoreLeader', () => {
  it('the first tab leads; its commits resolve once durable', async () => {
    const w = world();
    const a = openTab(w, 'A');
    await until(() => a.leader.isLeader);
    expect(a.states).toEqual(['recovering', 'leading']);
    expect(await a.leader.commit({ id: 'c1', part: 'root' })).toEqual({ ok: true, value: undefined });
    expect(a.leader.pending).toBe(0);
    expect((await recoveredIds(w)).has('c1')).toBe(true);
    await a.leader.dispose();
    expect(a.leader.state).toBe('disposed');
  });

  it('followers relay commits over BroadcastChannel and get acks', async () => {
    const w = world();
    const a = openTab(w, 'A');
    await until(() => a.leader.isLeader);
    const b = openTab(w, 'B');
    expect(b.leader.state).toBe('waiting');
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => b.leader.commit({ id: `b${i}`, part: `page:${i % 3}` })));
    expect(results.every((r) => r.ok)).toBe(true);
    const ids = await recoveredIds(w);
    expect(Array.from({ length: 20 }, (_, i) => ids.has(`b${i}`)).every(Boolean)).toBe(true);
    await a.leader.dispose();
    await b.leader.dispose();
  });

  it('when the leader dies, a follower recovers, takes over and its pending commits are resent', async () => {
    const w = world();
    const a = openTab(w, 'A');
    await until(() => a.leader.isLeader);
    const b = openTab(w, 'B');
    expect((await b.leader.commit({ id: 'before', part: 'root' })).ok).toBe(true);
    await a.crash();
    const after = b.leader.commit({ id: 'after', part: 'root' });
    expect((await after).ok).toBe(true);
    expect(b.leader.isLeader).toBe(true);
    const ids = await recoveredIds(w);
    expect(ids.has('before') && ids.has('after')).toBe(true);
    await b.leader.dispose();
  });

  it('scaled leader-kill loop: 20 kills under continuous commits lose no acknowledged commit', async () => {
    const w = world();
    const acked = new Set<string>();
    let tabs = [openTab(w, 't0'), openTab(w, 't1'), openTab(w, 't2')];
    let next = 3;
    let stop = false;
    const writers = tabs.map(async (_, slot) => {
      for (let k = 0; !stop; k++) {
        const tab = tabs[slot];
        if (tab === undefined) break;
        const id = `${tab.name}:${k}`;
        void tab.leader.commit({ id, part: `page:${k % 5}` }).then((r) => {
          if (r.ok) acked.add(id);
        });
        await sleep(1);
      }
    });
    for (let kill = 0; kill < 20; kill++) {
      await until(() => tabs.some((t) => t.leader.isLeader));
      await sleep(5 + (kill % 4) * 3);
      const victim = tabs.findIndex((t) => t.leader.isLeader);
      await tabs[victim]?.crash();
      tabs = tabs.map((t, i) => (i === victim ? openTab(w, `t${next++}`) : t));
    }
    stop = true;
    await Promise.all(writers);
    await until(() => tabs.every((t) => t.leader.pending === 0), 5000);
    for (const tab of tabs) await tab.leader.dispose();
    const ids = await recoveredIds(w);
    const missing = [...acked].filter((id) => !ids.has(id));
    expect(acked.size).toBeGreaterThan(50);
    expect(missing).toEqual([]);
  });

  it('a failed lead() releases the lock and retries', async () => {
    const w = world();
    let attempts = 0;
    const errors: string[] = [];
    const created = createStoreLeader<Commit>({
      name: 'iflow:ws',
      peer: 'A',
      locks: w.locks.forTab('A'),
      channels: w.hub,
      idOf: (c) => c.id,
      retryMs: 1,
      onError: (_e, where) => errors.push(where),
      lead: async () => {
        attempts += 1;
        if (attempts < 3) return err(BlobIoError());
        const latest = openLatest(w, 'A');
        await latest.recover();
        return ok(sessionOf(latest));
      },
    });
    if (!created.ok) throw new Error('create');
    await until(() => created.value.isLeader);
    expect(attempts).toBe(3);
    expect(errors).toEqual(['lead', 'lead']);
    await created.value.dispose();
  });

  it('a failed apply() is retried and reported', async () => {
    const w = world();
    let failures = 1;
    const errors: string[] = [];
    const latest = openLatest(w, 'A');
    await latest.recover();
    const inner = sessionOf(latest);
    const created = createStoreLeader<Commit>({
      name: 'iflow:ws',
      peer: 'A',
      locks: w.locks.forTab('A'),
      channels: w.hub,
      idOf: (c) => c.id,
      retryMs: 1,
      onError: (_e, where) => errors.push(where),
      lead: async () =>
        ok({
          apply: (batch) => (failures-- > 0 ? Promise.resolve(err(BlobIoError())) : inner.apply(batch)),
          close: inner.close,
        }),
    });
    if (!created.ok) throw new Error('create');
    await until(() => created.value.isLeader);
    expect((await created.value.commit({ id: 'x', part: 'root' })).ok).toBe(true);
    expect(errors).toEqual(['apply']);
    await created.value.dispose();
  });

  it('abort, duplicate ids, dispose and a missing BroadcastChannel', async () => {
    const w = world();
    const a = openTab(w, 'A', () => new Promise(() => undefined));
    const controller = new AbortController();
    const aborted = a.leader.commit({ id: 'x', part: 'root' }, { signal: controller.signal });
    controller.abort();
    expect(((await aborted) as { error: { code: string } }).error.code).toBe('SF-BLOB-006');
    const pre = new AbortController();
    pre.abort();
    const preAborted = await a.leader.commit({ id: 'y', part: 'root' }, { signal: pre.signal });
    expect(preAborted.ok ? '' : preAborted.error.code).toBe('SF-BLOB-006');
    const first = a.leader.commit({ id: 'same', part: 'root' });
    const second = a.leader.commit({ id: 'same', part: 'root' });
    expect(a.leader.pending).toBe(1);
    await a.leader.dispose();
    for (const result of await Promise.all([first, second])) expect(result.ok ? '' : result.error.code).toBe('SF-BLOB-013');
    const late = await a.leader.commit({ id: 'z', part: 'root' });
    expect(late.ok ? '' : late.error.code).toBe('SF-BLOB-013');
    await a.leader.dispose();
    const none = createStoreLeader<Commit>({ name: 'n', peer: 'p', locks: w.locks.forTab('p'), channels: () => undefined, idOf: (c) => c.id, lead: async () => err(BlobIoError()) });
    expect(none.ok ? '' : none.error.code).toBe('SF-BLOB-009');
  });
});
