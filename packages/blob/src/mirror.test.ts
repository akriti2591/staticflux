import { describe, expect, it } from 'vitest';
import { utf8 } from './codec.js';
import { encodeHead } from './heads.js';
import { createMemoryLocks } from './locks.js';
import { createMemoryDirectory } from './memory-fs.js';
import { createFolderMirror, DEFAULT_MIRROR_POLICY, type FolderMirror, type FolderMirrorState, type MirrorClock } from './mirror.js';
import { createWorkspaceStore, type WorkspaceStore } from './opfs.js';

const realTick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function fakeClock(): MirrorClock & { advance(ms: number): Promise<void> } {
  let now = 0;
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      id += 1;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (next === undefined || next[1].at > end) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
        for (let i = 0; i < 20; i++) await realTick();
      }
      now = end;
      for (let i = 0; i < 20; i++) await realTick();
    },
  };
}

function setup(options: { syncAvailable?: boolean } = {}) {
  const source = createMemoryDirectory({ name: 'opfs' });
  const target = createMemoryDirectory({ name: 'folder' });
  const locks = createMemoryLocks();
  const clock = fakeClock();
  const errors: string[] = [];
  const states: FolderMirrorState[] = [];
  const mirror: FolderMirror = createFolderMirror({
    source: source.root,
    target: target.root,
    locks: locks.forTab('A'),
    lockPrefix: 'ws_1',
    clock,
    onError: (e) => errors.push(e.code),
  });
  mirror.onStateChange((s) => states.push(s));
  const created = createWorkspaceStore(source.root, {
    lockPrefix: 'ws_1',
    peer: 'A',
    locks: locks.forTab('A'),
    observer: mirror.notify,
    syncAvailable: options.syncAvailable ?? true,
  });
  if (!created.ok) throw new Error(created.error.code);
  const ws: WorkspaceStore = created.value;
  return { source, target, clock, mirror, ws, errors, states };
}

const blobPaths = (paths: string[]): string[] => paths.filter((p) => p.startsWith('blobs/'));

describe('createFolderMirror', () => {
  it('batches: 50 head swaps and 20 objects become one flush after the idle delay', async () => {
    const { target, clock, mirror, ws } = setup();
    for (let i = 0; i < 20; i++) await ws.blobs.put(utf8(`object ${i}`));
    for (let g = 0; g < 50; g++) await ws.heads.cas('as_1', g, { n: g });
    expect(mirror.state).toBe('scheduled');
    expect(target.paths()).toEqual([]);
    await clock.advance(DEFAULT_MIRROR_POLICY.idleMs - 1);
    expect(target.paths()).toEqual([]);
    await clock.advance(1);
    expect(blobPaths(target.paths())).toHaveLength(20);
    expect(target.read('heads/as_1.json')).toEqual(encodeHead({ n: 49, generation: 50 }));
    expect(target.moves).toBe(21);
    expect(mirror.state).toBe('idle');
    expect(mirror.pending).toBe(0);
  });

  it('flushes at most once per minIntervalMs, and within maxDelayMs under continuous edits', async () => {
    const { target, clock, ws } = setup();
    await ws.heads.cas('h', 0, { n: 0 });
    await clock.advance(300);
    expect(target.read('heads/h.json')).toBeDefined();
    const flushedAt: number[] = [];
    let last = target.read('heads/h.json');
    for (let i = 1; i <= 80; i++) {
      await ws.heads.cas('h', i, { n: i });
      await clock.advance(100);
      const now = target.read('heads/h.json');
      if (now !== undefined && last !== undefined && now.some((b, j) => b !== last?.[j])) flushedAt.push(i * 100);
      last = now;
    }
    expect(flushedAt.length).toBeGreaterThan(0);
    expect(flushedAt[0]).toBeLessThanOrEqual(DEFAULT_MIRROR_POLICY.maxDelayMs + 100);
    for (let i = 1; i < flushedAt.length; i++) {
      expect((flushedAt[i] ?? 0) - (flushedAt[i - 1] ?? 0)).toBeGreaterThanOrEqual(DEFAULT_MIRROR_POLICY.minIntervalMs);
    }
  });

  it('flush() runs immediately (milestones) and copies log segments and deletions', async () => {
    const { target, mirror, ws } = setup();
    const journal = ws.journal('as_1');
    await journal.open(0);
    await journal.append([utf8('commit 1')]);
    const ref = await ws.blobs.put(utf8('to be collected'));
    const first = await mirror.flush();
    expect(first.ok && first.value).toEqual({ objects: 1, logs: 1, deletes: 0, heads: 0 });
    await journal.append([utf8('commit 2')]);
    if (ref.ok) await ws.blobs.delete(ref.value.digest);
    const second = await mirror.flush();
    expect(second.ok && second.value).toEqual({ objects: 0, logs: 1, deletes: 1, heads: 0 });
    expect(blobPaths(target.paths())).toEqual([]);
    const segment = target.paths().find((p) => p.startsWith('log/as_1/'));
    expect(segment === undefined ? 0 : target.read(segment)?.length).toBeGreaterThan(20);
    await journal.close();
  });

  it('never swaps a folder head before its objects are written; a failed flush is retried', async () => {
    const { target, mirror, ws, errors } = setup();
    await ws.blobs.put(utf8('part'));
    await ws.heads.cas('as_1', 0, { parts: 'x' });
    target.inject({ op: 'move', name: /^[0-9a-f]{64}$/, error: 'InvalidStateError' });
    const failed = await mirror.flush();
    expect(failed.ok ? '' : failed.error.code).toBe('SF-BLOB-007');
    expect(errors).toEqual(['SF-BLOB-007']);
    expect(target.read('heads/as_1.json')).toBeUndefined();
    expect(mirror.pending).toBe(2);
    expect(mirror.lastError?.code).toBe('SF-BLOB-007');
    const retried = await mirror.flush();
    expect(retried.ok && retried.value).toEqual({ objects: 1, logs: 0, deletes: 0, heads: 1 });
    expect(mirror.lastError).toBeUndefined();
  });

  it('a permission lapse pauses the mirror read-only (SF-BLOB-004); regrant() resumes with a full sync', async () => {
    const { target, mirror, ws, states } = setup();
    await ws.blobs.put(utf8('before'));
    await mirror.flush();
    target.setPermission('prompt', 'denied');
    await ws.blobs.put(utf8('while paused'));
    const blocked = await mirror.flush();
    expect(blocked.ok ? '' : blocked.error.code).toBe('SF-BLOB-004');
    expect(mirror.readOnly).toBe(true);
    expect(mirror.state).toBe('paused');
    expect(await mirror.regrant()).toEqual({ ok: true, value: false });
    expect(mirror.readOnly).toBe(true);
    target.setPermission('prompt', 'granted');
    expect(await mirror.regrant()).toEqual({ ok: true, value: true });
    expect(mirror.readOnly).toBe(false);
    expect(blobPaths(target.paths())).toHaveLength(2);
    expect(states).toContain('paused');
    expect(states.at(-1)).toBe('idle');
  });

  it('checkPermission detects a lapse without writing', async () => {
    const { target, mirror } = setup();
    expect(await mirror.checkPermission()).toEqual({ ok: true, value: true });
    target.setPermission('denied');
    expect(await mirror.checkPermission()).toEqual({ ok: true, value: false });
    expect(mirror.readOnly).toBe(true);
  });

  it('fullSync copies a workspace that existed before the mirror (skipping quarantine)', async () => {
    const source = createMemoryDirectory();
    const target = createMemoryDirectory();
    const locks = createMemoryLocks();
    const ws = createWorkspaceStore(source.root, { lockPrefix: 'ws', peer: 'A', locks: locks.forTab('A'), syncAvailable: false });
    if (!ws.ok) throw new Error('ws');
    const ref = await ws.value.blobs.put(utf8('quarantined soon'));
    await ws.value.blobs.put(utf8('kept'));
    await ws.value.heads.cas('as_1', 0, {});
    const journal = ws.value.journal('as_1');
    await journal.open(0);
    await journal.append([utf8('c')]);
    if (ref.ok) await ws.value.objects.quarantineObject(ref.value.digest);
    const mirror = createFolderMirror({ source: source.root, target: target.root, locks: locks.forTab('A'), lockPrefix: 'ws' });
    const synced = await mirror.fullSync();
    expect(synced.ok && synced.value).toEqual({ objects: 1, logs: 1, deletes: 0, heads: 1 });
    expect(target.paths().some((p) => p.startsWith('quarantine'))).toBe(false);
    const again = await mirror.fullSync();
    expect(again.ok && again.value).toEqual({ objects: 0, logs: 0, deletes: 0, heads: 0 });
    mirror.dispose();
  });

  it('checkExternal reports folder heads advanced by someone else', async () => {
    const { target, mirror, ws } = setup();
    await ws.heads.cas('as_1', 0, { v: 1 });
    await mirror.flush();
    expect(await mirror.checkExternal()).toEqual({ ok: true, value: [] });
    target.write('heads/as_1.json', encodeHead({ v: 'other device', generation: 9 }));
    expect(await mirror.checkExternal()).toEqual({ ok: true, value: [{ name: 'as_1', folderGeneration: 9, knownGeneration: 1 }] });
  });

  it('close() flushes and disposes; later notifications are ignored', async () => {
    const { target, mirror, ws } = setup();
    await ws.blobs.put(utf8('last edit'));
    const closed = await mirror.close();
    expect(closed.ok && closed.value.objects).toBe(1);
    expect(mirror.state).toBe('disposed');
    await ws.blobs.put(utf8('after close'));
    expect(mirror.pending).toBe(0);
    expect(blobPaths(target.paths())).toHaveLength(1);
    expect(await mirror.flush()).toEqual({ ok: true, value: { objects: 0, logs: 0, deletes: 0, heads: 0 } });
    expect(await mirror.regrant()).toEqual({ ok: true, value: false });
    mirror.dispose();
  });

  it('close() while paused reports SF-BLOB-004', async () => {
    const { target, mirror, ws } = setup();
    target.setPermission('denied');
    await mirror.checkPermission();
    await ws.blobs.put(utf8('x'));
    const closed = await mirror.close();
    expect(closed.ok ? '' : closed.error.code).toBe('SF-BLOB-004');
  });
});
