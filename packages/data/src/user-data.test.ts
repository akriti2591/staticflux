import { createMemorySink, createTelemetry, watch } from '@staticflux/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { s } from './schema.js';
import { defineSlice, migrateRecord, SliceMachine, type SliceState } from './slices.js';
import { createIndexedDbBackend, createMemoryBackend, createMockRemoteSync, detectLocalBackend } from './storage.js';
import { createUserData, storageKeyFor, type UserIdentity } from './user-data.js';

const ThemeSlice = defineSlice({
  key: 'settings/theme',
  scope: 'user',
  version: 2,
  schema: s.object({ mode: s.enum(['light', 'dark', 'system']) }),
  default: () => ({ mode: 'system' as const }),
  migrations: { 2: (v1) => ({ mode: (v1 as { dark: boolean }).dark ? 'dark' : 'light' }) },
});
const ProgressSlice = defineSlice({
  key: 'onboarding/progress',
  scope: 'user',
  version: 1,
  schema: s.object({ done: s.array(s.string()) }),
  default: () => ({ done: [] as string[] }),
  conflict: { merge: (local, remote) => ({ done: [...new Set([...local.done, ...remote.done])].sort() }) },
});
const LastDocSlice = defineSlice({
  key: 'studio/last-doc',
  scope: 'device',
  version: 1,
  schema: s.nullable(s.string()),
  default: () => null,
  budgetBytes: 16,
});
const DraftSlice = defineSlice({ key: 'agent/draft', scope: 'session', version: 1, schema: s.string(), default: () => '' });
const WorkspaceSlice = defineSlice({ key: 'shell/layout', scope: 'workspace', version: 1, schema: s.object({ panel: s.boolean() }), default: () => ({ panel: false }) });

const alice: UserIdentity = { userId: 'alice', workspaceId: 'w1', deviceId: 'dev1' };

const tick = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe('slice definitions', () => {
  it('migrates step by step and validates', () => {
    expect(migrateRecord(ThemeSlice, { v: 1, value: { dark: true }, updatedAt: 1 })).toEqual({ ok: true, value: { mode: 'dark' } });
    expect(migrateRecord(ThemeSlice, { v: 2, value: { mode: 'light' }, updatedAt: 1 })).toEqual({ ok: true, value: { mode: 'light' } });
    expect(migrateRecord(ThemeSlice, { v: 3, value: {}, updatedAt: 1 })).toMatchObject({ ok: false, error: { code: 'SF-DATA-051' } });
    expect(migrateRecord(ThemeSlice, { v: 0, value: {}, updatedAt: 1 })).toMatchObject({ ok: false, error: { details: { from: 0, to: 1 } } });
    expect(migrateRecord(ThemeSlice, { v: 2, value: { mode: 'neon' }, updatedAt: 1 })).toMatchObject({ ok: false, error: { code: 'SF-DATA-051' } });
    const Throwing = defineSlice({ key: 'x/y', scope: 'device', version: 2, schema: s.number(), default: () => 0, migrations: { 2: () => { throw new Error('no'); } } });
    expect(migrateRecord(Throwing, { v: 1, value: 1, updatedAt: 1 })).toMatchObject({ ok: false, error: { code: 'SF-DATA-051' } });
  });

  it('machine mirrors LIFECYCLES §10', () => {
    expect(SliceMachine.transitions.loading).toEqual({ migrate: 'migrating', loaded: 'ready', fail: 'failed' });
    expect(SliceMachine.transitions.failed).toEqual({ recover: 'ready' });
    expect(SliceMachine.transitions.ready).toEqual({ save: 'saving', conflict: 'conflicted', flush: 'flushed' });
    expect(SliceMachine.transitions.flushed).toEqual({ clear: 'cleared' });
  });

  it('storage keys per scope', () => {
    expect(storageKeyFor(ThemeSlice, alice)).toBe('sf-ud/user/alice/settings/theme');
    expect(storageKeyFor(LastDocSlice, alice)).toBe('sf-ud/device/dev1/studio/last-doc');
    expect(storageKeyFor(WorkspaceSlice, alice)).toBe('sf-ud/workspace/alice@w1/shell/layout');
    expect(storageKeyFor(DraftSlice, alice)).toBe('sf-ud/session/session/agent/draft');
    expect(storageKeyFor(ThemeSlice, { userId: undefined, deviceId: 'd' })).toBe('sf-ud/user/guest/settings/theme');
  });
});

describe('user data', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads defaults, then migrates persisted values on read (unloaded → loading → migrating → ready)', async () => {
    const local = createMemoryBackend({ 'sf-ud/user/alice/settings/theme': { v: 1, value: { dark: true }, updatedAt: 5 } });
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'verbose', random: () => 0.5 });
    telemetry.addSink(sink);
    const data = createUserData({ identity: alice, local, telemetry });
    const theme = data.slice(ThemeSlice);
    const states: SliceState[] = [];
    const stop = watch(
      () => theme.state,
      (st) => states.push(st),
      { fireImmediately: true },
    );
    expect(theme.value).toEqual({ mode: 'system' });
    expect(await theme.whenReady()).toEqual({ ok: true, value: { mode: 'dark' } });
    expect(states).toEqual(['unloaded', 'loading', 'migrating', 'ready']);
    expect(sink.records.some((r) => r.type === 'event' && r.name === 'lifecycle.slice.migrating→ready')).toBe(true);
    expect(data.slice(ThemeSlice)).toBe(theme);
    stop();
  });

  it('failed migration → defaults + reported error, never a crash (R9.10)', async () => {
    const onError = vi.fn();
    const local = createMemoryBackend({ 'sf-ud/user/alice/settings/theme': { v: 7, value: 'future', updatedAt: 5 } });
    const data = createUserData({ identity: alice, local, onError });
    const theme = data.slice(ThemeSlice);
    expect(await theme.whenReady()).toEqual({ ok: true, value: { mode: 'system' } });
    expect(theme.state).toBe('ready');
    expect(theme.error?.code).toBe('SF-DATA-051');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(data.errors).toHaveLength(1);
    expect(local.records.get('sf-ud/user/alice/settings/theme')?.v).toBe(7); // untouched until next write
  });

  it('backend read failure → defaults + report', async () => {
    const local = createMemoryBackend();
    local.failNext();
    const data = createUserData({ identity: alice, local });
    const slice = data.slice(LastDocSlice);
    expect(await slice.whenReady()).toEqual({ ok: true, value: null });
    expect(slice.error?.code).toBe('SF-DATA-054');
  });

  it('rejects colliding keys (features never collide)', () => {
    const data = createUserData({ identity: alice });
    data.slice(ThemeSlice);
    const Impostor = defineSlice({ key: 'settings/theme', scope: 'device', version: 1, schema: s.string(), default: () => '' });
    expect(() => data.slice(Impostor)).toThrow(/same key/);
  });

  it('writes are validated, budgeted, reactive, and batched into one backend write', async () => {
    const local = createMemoryBackend();
    const write = vi.spyOn(local, 'write');
    const data = createUserData({ identity: alice, local, writeDelayMs: 100, now: () => 1000 });
    const theme = data.slice(ThemeSlice);
    const last = data.slice(LastDocSlice);
    expect(theme.set({ mode: 'dark' })).toMatchObject({ ok: false, error: { code: 'SF-DATA-053' } }); // not ready yet
    await theme.whenReady();
    await last.whenReady();
    expect(theme.set({ mode: 'dark' }).ok).toBe(true);
    expect(theme.set((prev) => ({ mode: prev.mode === 'dark' ? 'light' : 'dark' })).ok).toBe(true);
    expect(last.set('doc-42').ok).toBe(true);
    expect(theme.value).toEqual({ mode: 'light' });
    expect(theme.dirty).toBe(true);
    expect(theme.set({ mode: 'neon' } as never)).toMatchObject({ ok: false, error: { code: 'SF-DATA-030' } });
    expect(last.set('a-very-long-document-id')).toMatchObject({ ok: false, error: { code: 'SF-DATA-052', kind: 'quota' } });
    expect(last.value).toBe('doc-42');
    expect(Object.isFrozen(theme.value)).toBe(true);
    await tick(99);
    expect(write).not.toHaveBeenCalled();
    await tick(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toHaveLength(2);
    expect(local.records.get('sf-ud/user/alice/settings/theme')).toEqual({ v: 2, value: { mode: 'light' }, updatedAt: 1001 });
    expect(theme.dirty).toBe(false);
  });

  it('save failures keep values dirty and retry on the next flush', async () => {
    const local = createMemoryBackend();
    const data = createUserData({ identity: alice, local });
    const last = data.slice(LastDocSlice);
    await last.whenReady();
    last.set('d1');
    local.failNext();
    expect((await data.flush()).ok).toBe(false);
    expect(last.state).toBe('ready');
    expect(last.dirty).toBe(true);
    expect((await data.flush()).ok).toBe(true);
    expect(local.records.get('sf-ud/device/dev1/studio/last-doc')?.value).toBe('d1');
  });

  it('session slices never touch the local backend', async () => {
    const local = createMemoryBackend();
    const data = createUserData({ identity: alice, local });
    const draft = data.slice(DraftSlice);
    await draft.whenReady();
    draft.set('hello');
    await data.flush();
    expect(local.records.size).toBe(0);
    expect(data.document()['agent/draft']).toMatchObject({ scope: 'session', value: 'hello', state: 'ready' });
  });

  it('offline-first remote sync: pushes local, adopts newer remote, survives offline', async () => {
    let now = 100;
    const remote = createMockRemoteSync();
    const local = createMemoryBackend();
    const data = createUserData({ identity: alice, local, remote, now: () => now });
    const theme = data.slice(ThemeSlice);
    await theme.whenReady();
    await data.sync();
    theme.set({ mode: 'dark' });
    remote.setOffline(true);
    expect((await data.flush()).ok).toBe(false); // local saved, remote queued
    expect(local.records.get('sf-ud/user/alice/settings/theme')?.value).toEqual({ mode: 'dark' });
    expect(theme.dirty).toBe(true);
    remote.setOffline(false);
    expect((await data.flush()).ok).toBe(true);
    expect(remote.records.get('sf-ud/user/alice/settings/theme')?.value).toEqual({ mode: 'dark' });
    expect(theme.dirty).toBe(false);

    now = 500;
    remote.put('sf-ud/user/alice/settings/theme', { v: 2, value: { mode: 'light' }, updatedAt: 400 }); // another device
    await data.sync();
    expect(theme.value).toEqual({ mode: 'light' });
    expect(local.records.get('sf-ud/user/alice/settings/theme')?.value).toEqual({ mode: 'light' });
  });

  it('conflicts: LWW by timestamp, or the slice merge fn (ready → conflicted → ready)', async () => {
    let now = 100;
    const remote = createMockRemoteSync();
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'verbose', random: () => 0.5 });
    telemetry.addSink(sink);
    const data = createUserData({ identity: alice, remote, now: () => now, telemetry });
    const progress = data.slice(ProgressSlice);
    const theme = data.slice(ThemeSlice);
    await progress.whenReady();
    await theme.whenReady();
    await data.sync();
    remote.setOffline(true);
    now = 200;
    progress.set({ done: ['welcome'] });
    theme.set({ mode: 'dark' });
    await data.flush();
    remote.setOffline(false);
    remote.put('sf-ud/user/alice/onboarding/progress', { v: 1, value: { done: ['profile'] }, updatedAt: 150 });
    remote.put('sf-ud/user/alice/settings/theme', { v: 2, value: { mode: 'light' }, updatedAt: 300 });
    now = 400;
    await data.sync();
    expect(progress.value).toEqual({ done: ['profile', 'welcome'] }); // merged
    expect(theme.value).toEqual({ mode: 'light' }); // remote is newer → LWW
    const transitions = sink.records.filter((r) => r.type === 'event' && r.name.startsWith('lifecycle.slice.')).map((r) => (r.type === 'event' ? `${String(r.attrs.key)}:${r.name}` : ''));
    expect(transitions).toContain('onboarding/progress:lifecycle.slice.ready→conflicted');
    expect(transitions).toContain('onboarding/progress:lifecycle.slice.conflicted→ready');
    expect(progress.state).toBe('ready');
    expect(remote.records.get('sf-ud/user/alice/onboarding/progress')?.value).toEqual({ done: ['profile', 'welcome'] });
  });

  it('LWW keeps a newer local value and pushes it', async () => {
    let now = 100;
    const remote = createMockRemoteSync();
    const data = createUserData({ identity: alice, remote, now: () => now });
    const theme = data.slice(ThemeSlice);
    await theme.whenReady();
    await data.sync();
    remote.setOffline(true);
    now = 500;
    theme.set({ mode: 'dark' });
    await data.flush();
    remote.setOffline(false);
    remote.put('sf-ud/user/alice/settings/theme', { v: 1, value: { dark: false }, updatedAt: 300 }); // older, old version
    await data.sync();
    expect(theme.value).toEqual({ mode: 'dark' });
    expect(remote.records.get('sf-ud/user/alice/settings/theme')).toEqual({ v: 2, value: { mode: 'dark' }, updatedAt: 500 });
  });

  it('guest slices never sync remotely', async () => {
    const remote = createMockRemoteSync();
    const data = createUserData({ identity: { userId: undefined, deviceId: 'd' }, remote });
    const theme = data.slice(ThemeSlice);
    await theme.whenReady();
    theme.set({ mode: 'dark' });
    await data.sync();
    expect(remote.records.size).toBe(0);
    expect(remote.pushes).toBe(0);
  });

  it('logout: flushes (incl. remote), wipes user/workspace/session local copies, keeps device slices, continues as guest (R9.11)', async () => {
    const local = createMemoryBackend({ 'sf-ud/user/alice/old/unloaded-slice': { v: 1, value: 1, updatedAt: 1 } });
    const remote = createMockRemoteSync();
    const data = createUserData({ identity: alice, local, remote, writeDelayMs: 10_000 });
    const theme = data.slice(ThemeSlice);
    const last = data.slice(LastDocSlice);
    const layout = data.slice(WorkspaceSlice);
    const draft = data.slice(DraftSlice);
    await Promise.all([theme.whenReady(), last.whenReady(), layout.whenReady(), draft.whenReady()]);
    theme.set({ mode: 'dark' });
    last.set('doc-1');
    layout.set({ panel: true });
    draft.set('unsent');
    const states: SliceState[] = [];
    const stop = watch(
      () => theme.state,
      (st) => states.push(st),
    );
    expect((await data.logout()).ok).toBe(true);
    expect(remote.records.get('sf-ud/user/alice/settings/theme')?.value).toEqual({ mode: 'dark' }); // flushed first
    expect([...local.records.keys()]).toEqual(['sf-ud/device/dev1/studio/last-doc']);
    expect(states.slice(0, 5)).toEqual(['saving', 'ready', 'flushed', 'cleared', 'loading']);
    await theme.whenReady();
    expect(theme.value).toEqual({ mode: 'system' });
    expect(draft.value).toBe('');
    expect(last.value).toBe('doc-1');
    expect(data.identity.userId).toBeUndefined();
    stop();
  });

  it('logout policy override keeps user copies', async () => {
    const local = createMemoryBackend();
    const data = createUserData({ identity: alice, local, logoutPolicy: { wipe: ['session'] } });
    const theme = data.slice(ThemeSlice);
    await theme.whenReady();
    theme.set({ mode: 'dark' });
    await data.logout();
    expect(local.records.has('sf-ud/user/alice/settings/theme')).toBe(true);
  });

  it('setIdentity reloads affected slices for the new user without wiping', async () => {
    const local = createMemoryBackend({ 'sf-ud/user/bob/settings/theme': { v: 2, value: { mode: 'light' }, updatedAt: 1 } });
    const data = createUserData({ identity: alice, local });
    const theme = data.slice(ThemeSlice);
    const last = data.slice(LastDocSlice);
    await theme.whenReady();
    theme.set({ mode: 'dark' });
    await last.whenReady();
    last.set('x');
    await data.setIdentity({ userId: 'bob', deviceId: 'dev1' });
    expect(theme.value).toEqual({ mode: 'light' });
    expect(last.value).toBe('x');
    expect(local.records.get('sf-ud/user/alice/settings/theme')?.value).toEqual({ mode: 'dark' });
  });

  it('whenReady honours abort; dispose flushes', async () => {
    const local = createMemoryBackend();
    const data = createUserData({ identity: alice, local });
    const theme = data.slice(ThemeSlice);
    const controller = new AbortController();
    controller.abort();
    expect(await theme.whenReady(controller.signal)).toMatchObject({ ok: false, error: { kind: 'aborted' } });
    await theme.whenReady();
    theme.reset();
    theme.set({ mode: 'dark' });
    await data.dispose();
    expect(local.records.get('sf-ud/user/alice/settings/theme')?.value).toEqual({ mode: 'dark' });
  });
});

// ---------------------------------------------------------------- IndexedDB (minimal fake)

function fakeIndexedDb(): IDBFactory {
  const stores = new Map<string, Map<string, unknown>>();
  const req = <T>(fn: () => T): IDBRequest<T> => {
    const r = { result: undefined as T, error: null, onsuccess: null as null | (() => void), onerror: null } as unknown as IDBRequest<T> & { result: T };
    queueMicrotask(() => {
      (r as { result: T }).result = fn();
      (r.onsuccess as (() => void) | null)?.();
    });
    return r;
  };
  const db = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore: (name: string) => stores.set(name, new Map()),
    transaction: (name: string) => {
      const data = stores.get(name) as Map<string, unknown>;
      const tx = { oncomplete: null as null | (() => void), onerror: null, onabort: null, error: null } as unknown as IDBTransaction;
      let pending = 0;
      const track = <T>(fn: () => T): IDBRequest<T> => {
        pending += 1;
        return req(() => {
          const out = fn();
          pending -= 1;
          if (pending === 0) queueMicrotask(() => (tx.oncomplete as (() => void) | null)?.());
          return out;
        });
      };
      (tx as unknown as { objectStore: () => unknown }).objectStore = () => ({
        get: (key: string) => track(() => data.get(key)),
        put: (value: unknown, key: string) => track(() => data.set(key, structuredClone(value))),
        delete: (key: string) => track(() => data.delete(key)),
        getAllKeys: () => track(() => [...data.keys()]),
      });
      return tx;
    },
  };
  return {
    open: () => {
      const r = { result: db, error: null, onsuccess: null, onerror: null, onupgradeneeded: null } as unknown as IDBOpenDBRequest;
      queueMicrotask(() => {
        (r.onupgradeneeded as (() => void) | null)?.();
        (r.onsuccess as (() => void) | null)?.();
      });
      return r;
    },
  } as unknown as IDBFactory;
}

describe('IndexedDB backend', () => {
  it('feature-detects and degrades to memory', () => {
    expect(createIndexedDbBackend({ indexedDB: {} as IDBFactory })).toMatchObject({ ok: false, error: { code: 'SF-DATA-055' } });
    const detected = detectLocalBackend({ indexedDB: {} as IDBFactory });
    expect(detected.degraded).toBe(true);
    expect(detected.backend.id).toBe('memory');
    expect(detectLocalBackend({ indexedDB: fakeIndexedDb() }).backend.id).toBe('indexeddb');
  });

  it('round-trips records in batched transactions and lists keys by prefix', async () => {
    const backend = createIndexedDbBackend({ indexedDB: fakeIndexedDb() });
    expect(backend.ok).toBe(true);
    if (!backend.ok) return;
    const record = { v: 1, value: { a: 1 }, updatedAt: 3 };
    expect(await backend.value.write([{ key: 'sf-ud/user/a/x', record }, { key: 'sf-ud/device/d/y', record }], [])).toEqual({ ok: true, value: undefined });
    expect(await backend.value.get(['sf-ud/user/a/x', 'missing'])).toEqual({ ok: true, value: { 'sf-ud/user/a/x': record } });
    expect(await backend.value.keys('sf-ud/user/')).toEqual({ ok: true, value: ['sf-ud/user/a/x'] });
    await backend.value.write([], ['sf-ud/user/a/x']);
    expect(await backend.value.keys('sf-ud/')).toEqual({ ok: true, value: ['sf-ud/device/d/y'] });
  });

  it('works as the user-data local backend', async () => {
    const backend = createIndexedDbBackend({ indexedDB: fakeIndexedDb() });
    if (!backend.ok) throw backend.error;
    const data = createUserData({ identity: alice, local: backend.value });
    const last = data.slice(LastDocSlice);
    await last.whenReady();
    last.set('doc-9');
    await data.flush();
    const again = createUserData({ identity: alice, local: backend.value }).slice(LastDocSlice);
    expect(await again.whenReady()).toEqual({ ok: true, value: 'doc-9' });
  });
});
