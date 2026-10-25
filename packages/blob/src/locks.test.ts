import { ok } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { createLocalLocks, createMemoryLocks, detectLocks, isLockFree, type LockManagerLike, withExclusiveLock } from './locks.js';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function serializes(locks: LockManagerLike): Promise<string[]> {
  const log: string[] = [];
  await Promise.all(
    ['a', 'b', 'c'].map((who) =>
      withExclusiveLock(locks, 'L', async () => {
        log.push(`${who}+`);
        await tick();
        log.push(`${who}-`);
        return ok();
      }),
    ),
  );
  return log;
}

describe('detectLocks', () => {
  it('returns navigator.locks only when it has request()', () => {
    const nav = globalThis.navigator as unknown as { locks?: unknown };
    const original = Object.getOwnPropertyDescriptor(nav, 'locks');
    Object.defineProperty(nav, 'locks', { value: { request: () => Promise.resolve() }, configurable: true });
    expect(detectLocks()).toBeDefined();
    Object.defineProperty(nav, 'locks', { value: null, configurable: true });
    expect(detectLocks()).toBeUndefined();
    if (original === undefined) delete nav.locks;
    else Object.defineProperty(nav, 'locks', original);
  });
});

describe('createLocalLocks', () => {
  it('serializes holders of one name and survives a throwing holder', async () => {
    const locks = createLocalLocks();
    expect(await serializes(locks)).toEqual(['a+', 'a-', 'b+', 'b-', 'c+', 'c-']);
    await expect(locks.request('L', {}, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await serializes(locks)).toEqual(['a+', 'a-', 'b+', 'b-', 'c+', 'c-']);
    const aborted = new AbortController();
    aborted.abort();
    await expect(locks.request('L', { signal: aborted.signal }, async () => 1)).rejects.toBeDefined();
  });
});

describe('withExclusiveLock', () => {
  it('returns SF-BLOB-006 without running fn when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let ran = false;
    const result = await withExclusiveLock(
      createMemoryLocks().forTab('t'),
      'L',
      async () => {
        ran = true;
        return ok();
      },
      controller.signal,
    );
    expect(result.ok ? '' : result.error.code).toBe('SF-BLOB-006');
    expect(ran).toBe(false);
  });

  it('maps a rejected request to SF-BLOB-006', async () => {
    const rejecting: LockManagerLike = { request: () => Promise.reject(new DOMException('x', 'AbortError')) };
    const result = await withExclusiveLock(rejecting, 'L', async () => ok(1));
    expect(result.ok ? '' : result.error.code).toBe('SF-BLOB-006');
  });
});

describe('createMemoryLocks', () => {
  it('grants exclusively across tabs in request order', async () => {
    const locks = createMemoryLocks();
    const log: string[] = [];
    let releaseA!: () => void;
    const a = locks.forTab('A').request('L', {}, () => new Promise<void>((r) => (releaseA = () => (log.push('A done'), r()))));
    const b = locks.forTab('B').request('L', {}, async () => void log.push('B ran'));
    await tick();
    expect(locks.holders('L')).toEqual(['A']);
    expect(locks.queue('L')).toEqual(['B']);
    releaseA();
    await Promise.all([a, b]);
    expect(log).toEqual(['A done', 'B ran']);
    expect(locks.holders('L')).toEqual([]);
  });

  it('shares shared locks', async () => {
    const locks = createMemoryLocks();
    const holders: string[][] = [];
    await Promise.all(
      ['A', 'B'].map((tab) =>
        locks.forTab(tab).request('S', { mode: 'shared' }, async () => {
          await tick();
          holders.push([...locks.holders('S')]);
        }),
      ),
    );
    expect(holders[0]).toEqual(['A', 'B']);
  });

  it('crashTab releases held locks and drops queued requests; the next tab gets the lock', async () => {
    const locks = createMemoryLocks();
    void locks.forTab('A').request('leader', {}, () => new Promise(() => undefined));
    void locks.forTab('C').request('other', {}, () => new Promise(() => undefined));
    const gotLock: string[] = [];
    void locks.forTab('B').request('leader', {}, async () => void gotLock.push('B'));
    await tick();
    expect(locks.holders('leader')).toEqual(['A']);
    locks.crashTab('A');
    await tick();
    expect(gotLock).toEqual(['B']);
    let crashedRan = false;
    void locks.forTab('A').request('x', {}, async () => void (crashedRan = true));
    await tick();
    expect(crashedRan).toBe(false);
  });

  it('honours ifAvailable and abort while queued', async () => {
    const locks = createMemoryLocks();
    void locks.forTab('A').request('L', {}, () => new Promise(() => undefined));
    await tick();
    expect(await locks.forTab('B').request('L', { ifAvailable: true }, async (lock) => lock)).toBeNull();
    const controller = new AbortController();
    const queued = locks.forTab('B').request('L', { signal: controller.signal }, async () => 'ran');
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(locks.queue('L')).toEqual([]);
    const pre = new AbortController();
    pre.abort();
    await expect(locks.forTab('B').request('L', { signal: pre.signal }, async () => 1)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('isLockFree', () => {
  it('reports whether a lock is held right now', async () => {
    const locks = createMemoryLocks();
    expect(await isLockFree(locks.forTab('A'), 'L')).toEqual({ ok: true, value: true });
    void locks.forTab('A').request('L', {}, () => new Promise(() => undefined));
    await tick();
    expect(await isLockFree(locks.forTab('B'), 'L')).toEqual({ ok: true, value: false });
    const failing: LockManagerLike = { request: () => Promise.reject(new Error('x')) };
    const failed = await isLockFree(failing, 'L');
    expect(failed.ok ? '' : failed.error.code).toBe('SF-BLOB-006');
  });
});
