import { createInjector, createMemorySink, createTelemetry, ok } from '@staticflux/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope } from './envelope.js';
import { defineHandoff } from './slot.js';
import {
  createMemoryStorage,
  createWebStorage,
  detectHandoffStorages,
  type HandoffStorages,
  memoryHandoffStorages,
  probeWebStorage,
  STORAGE_PREFIX,
} from './storage.js';
import { createHandoffStore } from './store.js';
import { browserHandoffStoragesUnit, handoffSlotUnit, HandoffStoragesToken, HandoffStoreToken, handoffStoreUnit, memoryHandoffStoragesUnit } from './units.js';

interface Draft {
  readonly title: string;
}
const isDraft = (v: unknown): v is Draft => typeof v === 'object' && v !== null && typeof (v as Draft).title === 'string';

const DraftSlot = defineHandoff<Draft>({ key: 'studio/guest-draft', version: 1, lifetime: 'one-shot', scope: 'tab', schema: isDraft });
const ScrollSlot = defineHandoff<number>({ key: 'studio/scroll', version: 1, lifetime: { ttlMs: 1000 }, scope: 'tab' });
const WorkspaceSlot = defineHandoff<string>({ key: 'shell/workspace', version: 1, lifetime: 'session', scope: 'origin' });
const ViewSlot = defineHandoff<string>({ key: 'studio/view', version: 1, lifetime: 'session', scope: 'memory' });

function clock(start = 1_000_000): { now: () => number; advance(ms: number): void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

function webStorages(): HandoffStorages {
  return {
    memory: createMemoryStorage(),
    tab: createWebStorage(window.sessionStorage, 'session-storage'),
    origin: createWebStorage(window.localStorage, 'local-storage'),
    degraded: [],
  };
}

afterEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe('handoff store', () => {
  it('puts and takes a one-shot entry exactly once (consume-once)', async () => {
    const store = createHandoffStore({ storages: webStorages() });
    const put = await store.put(DraftSlot, { title: 'Hello' });
    expect(put.ok && put.value).toMatchObject({ v: 1, key: 'studio/guest-draft', version: 1, data: { title: 'Hello' } });
    expect(window.sessionStorage.getItem(`${STORAGE_PREFIX}studio/guest-draft`)).toContain('Hello');
    const [a, b] = await Promise.all([store.take(DraftSlot), store.take(DraftSlot)]);
    expect(a).toEqual(ok({ title: 'Hello' }));
    expect(b).toEqual(ok(undefined));
    expect(window.sessionStorage.getItem(`${STORAGE_PREFIX}studio/guest-draft`)).toBeNull();
    expect(store.inspect()).toContainEqual({ key: 'studio/guest-draft', scope: 'tab', lifetime: 'one-shot', state: 'consumed' });
  });

  it('peek does not consume; session entries survive until cleared', async () => {
    const store = createHandoffStore({ storages: webStorages() });
    await store.put(WorkspaceSlot, 'expert');
    expect(await store.peek(WorkspaceSlot)).toEqual(ok('expert'));
    expect(await store.peek(WorkspaceSlot)).toEqual(ok('expert'));
    expect(window.localStorage.getItem(`${STORAGE_PREFIX}shell/workspace`)).not.toBeNull();
    const envelope = await store.peekEnvelope(WorkspaceSlot);
    expect(envelope.ok && envelope.value?.data).toBe('expert');
  });

  it('expires TTL entries on read', async () => {
    const c = clock();
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'verbose' });
    telemetry.addSink(sink);
    const store = createHandoffStore({ storages: webStorages(), now: c.now, telemetry });
    await store.put(ScrollSlot, 420);
    c.advance(999);
    expect(await store.peek(ScrollSlot)).toEqual(ok(420));
    c.advance(1);
    expect(await store.peek(ScrollSlot)).toEqual(ok(undefined));
    expect(store.inspect().find((e) => e.key === 'studio/scroll')?.state).toBe('expired');
    expect(sink.records.some((r) => r.type === 'event' && r.name === 'handoff.expired')).toBe(true);
    expect(sink.records.some((r) => r.type === 'event' && r.name === 'lifecycle.handoff/entry.stored→expired')).toBe(true);
    // per-write TTL override
    await store.put(ScrollSlot, 1, { ttlMs: 10 });
    c.advance(10);
    expect(await store.take(ScrollSlot)).toEqual(ok(undefined));
  });

  it('discards malformed or invalid entries and reports them as errors', async () => {
    const store = createHandoffStore({ storages: webStorages() });
    window.sessionStorage.setItem(`${STORAGE_PREFIX}studio/guest-draft`, 'not json');
    const r1 = await store.take(DraftSlot);
    expect(!r1.ok && r1.error.code).toBe('SF-HANDOFF-001');
    expect(window.sessionStorage.getItem(`${STORAGE_PREFIX}studio/guest-draft`)).toBeNull();
    window.sessionStorage.setItem(`${STORAGE_PREFIX}studio/guest-draft`, JSON.stringify(createEnvelope({ key: 'studio/guest-draft', version: 1, data: { nope: 1 }, now: 0 })));
    const r2 = await store.peek(DraftSlot);
    expect(!r2.ok && r2.error.code).toBe('SF-HANDOFF-005');
    expect(store.inspect().find((e) => e.key === 'studio/guest-draft')?.state).toBe('invalid');
    expect(await store.peek(DraftSlot)).toEqual(ok(undefined));
  });

  it('migrates old entries on read', async () => {
    const storages = memoryHandoffStorages();
    await storages.tab.write('studio/guest-draft', createEnvelope({ key: 'studio/guest-draft', version: 1, data: 'Old title', now: 0 }));
    const V2 = defineHandoff<Draft>({ key: 'studio/guest-draft', version: 2, lifetime: 'one-shot', scope: 'tab', schema: isDraft, migrations: { 1: (d) => ({ title: d as string }) } });
    const store = createHandoffStore({ storages });
    expect(await store.take(V2)).toEqual(ok({ title: 'Old title' }));
  });

  it('detects slot key collisions', async () => {
    const store = createHandoffStore({ storages: memoryHandoffStorages(), slots: [DraftSlot] });
    expect(store.register(DraftSlot)).toEqual(ok());
    const Other = defineHandoff<number>({ key: 'studio/guest-draft', version: 1, lifetime: 'session', scope: 'tab' });
    const r = store.register(Other);
    expect(!r.ok && r.error.code).toBe('SF-HANDOFF-007');
    const put = await store.put(Other, 1);
    expect(!put.ok && put.error.code).toBe('SF-HANDOFF-007');
    const sink = createMemorySink();
    const telemetry = createTelemetry();
    telemetry.addSink(sink);
    createHandoffStore({ storages: memoryHandoffStorages(), slots: [DraftSlot, Other], telemetry });
    expect(sink.records.some((rec) => rec.type === 'event' && rec.name === 'handoff.slot-collision')).toBe(true);
  });

  it('clear() removes by lifetime/scope (logout clears session entries)', async () => {
    const store = createHandoffStore({ storages: webStorages() });
    await store.put(DraftSlot, { title: 'x' });
    await store.put(WorkspaceSlot, 'expert');
    await store.put(ViewSlot, 'comments');
    expect(await store.clear({ lifetime: 'session', scope: 'origin' })).toEqual(ok(1));
    expect(await store.peek(WorkspaceSlot)).toEqual(ok(undefined));
    expect(await store.peek(ViewSlot)).toEqual(ok('comments'));
    expect(await store.clear()).toEqual(ok(2));
    expect(await store.clear()).toEqual(ok(0));
  });

  it('discard() removes one entry', async () => {
    const store = createHandoffStore({ storages: memoryHandoffStorages() });
    await store.put(ViewSlot, 'a');
    expect(await store.discard(ViewSlot)).toEqual(ok());
    expect(await store.peek(ViewSlot)).toEqual(ok(undefined));
    expect(store.inspect()[0]?.state).toBe('discarded');
  });

  it('sweep() removes expired and malformed entries across storages, including orphans', async () => {
    const c = clock();
    const storages = webStorages();
    const store = createHandoffStore({ storages, now: c.now, slots: [ScrollSlot] });
    await store.put(ScrollSlot, 1);
    await store.put(WorkspaceSlot, 'w');
    window.sessionStorage.setItem(`${STORAGE_PREFIX}gone/orphan`, JSON.stringify(createEnvelope({ key: 'gone/orphan', version: 1, data: 0, now: 0, ttlMs: 1 })));
    window.sessionStorage.setItem(`${STORAGE_PREFIX}gone/garbage`, '{"x":1}');
    window.sessionStorage.setItem('unrelated', 'kept');
    c.advance(1000);
    expect(await store.sweep()).toEqual(ok(3));
    expect(window.sessionStorage.getItem('unrelated')).toBe('kept');
    expect(await store.peek(WorkspaceSlot)).toEqual(ok('w'));
    expect(await store.sweep()).toEqual(ok(0));
  });

  it('reports write failures (quota, non-serializable) as SF-HANDOFF-006', async () => {
    const full: Storage = {
      length: 0,
      clear: () => undefined,
      getItem: () => null,
      key: () => null,
      removeItem: () => undefined,
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
    };
    const store = createHandoffStore({ storages: { ...memoryHandoffStorages(), tab: createWebStorage(full, 'session-storage') } });
    const r = await store.put(DraftSlot, { title: 'x' });
    expect(!r.ok && r.error.code).toBe('SF-HANDOFF-006');
    const mem = createHandoffStore({ storages: memoryHandoffStorages() });
    const fnSlot = defineHandoff<() => void>({ key: 'x/fn', version: 1, lifetime: 'session', scope: 'memory' });
    const r2 = await mem.put(fnSlot, () => undefined);
    expect(!r2.ok && r2.error.code).toBe('SF-HANDOFF-006');
  });
});

describe('storages', () => {
  it('memory storage clones values', async () => {
    const storage = createMemoryStorage();
    const envelope = createEnvelope({ key: 'a/b', version: 1, data: { list: [1] }, now: 0 });
    await storage.write('a/b', envelope);
    (envelope.data.list as number[]).push(2);
    const read = await storage.read('a/b');
    expect(read.ok && (read.value as typeof envelope).data.list).toEqual([1]);
    expect(await storage.keys()).toEqual(ok(['a/b']));
    await storage.remove('a/b');
    expect(await storage.read('a/b')).toEqual(ok(undefined));
  });

  it('web storage maps access errors to results', async () => {
    const broken: Storage = {
      get length(): number {
        throw new DOMException('denied', 'SecurityError');
      },
      clear: () => undefined,
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      key: () => null,
      removeItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem: () => undefined,
    };
    const storage = createWebStorage(broken, 'session-storage');
    expect((await storage.read('a/b')).ok).toBe(false);
    expect((await storage.remove('a/b')).ok).toBe(false);
    expect((await storage.keys()).ok).toBe(false);
  });

  it('probes and degrades unavailable storage to memory', () => {
    expect(probeWebStorage(() => window.sessionStorage)).toBe(window.sessionStorage);
    expect(probeWebStorage(() => null)).toBeUndefined();
    expect(
      probeWebStorage(() => {
        throw new DOMException('sandboxed', 'SecurityError');
      }),
    ).toBeUndefined();
    const detected = detectHandoffStorages();
    expect(detected.tab.kind).toBe('session-storage');
    expect(detected.origin.kind).toBe('local-storage');
    expect(detected.degraded).toEqual([]);
    const sandboxed = detectHandoffStorages({} as typeof globalThis);
    expect(sandboxed.degraded).toEqual(['tab', 'origin']);
    expect(sandboxed.tab.durable).toBe(false);
    const store = createHandoffStore({ storages: sandboxed });
    expect(store.isDegraded('tab')).toBe(true);
    expect(store.isDegraded('memory')).toBe(false);
  });
});

describe('handoff DI units', () => {
  it('provides the store with contributed slots and sweeps on init', async () => {
    const storages = memoryHandoffStorages();
    await storages.tab.write('studio/scroll', createEnvelope({ key: 'studio/scroll', version: 1, data: 1, now: 0, ttlMs: 1 }));
    const injector = createInjector({
      units: [
        { ...memoryHandoffStoragesUnit, create: () => storages },
        handoffSlotUnit(DraftSlot),
        handoffSlotUnit(ScrollSlot),
        handoffStoreUnit,
      ],
    });
    const result = await injector.get(HandoffStoreToken);
    expect(result.ok).toBe(true);
    expect(await storages.tab.read('studio/scroll')).toEqual(ok(undefined)); // swept
    if (result.ok) {
      const clash = result.value.register(defineHandoff<number>({ key: 'studio/scroll', version: 1, lifetime: 'session', scope: 'tab' }));
      expect(clash.ok).toBe(false);
    }
  });

  it('browser storages unit detects web storage', async () => {
    const injector = createInjector({ units: [browserHandoffStoragesUnit] });
    const r = await injector.get(HandoffStoragesToken);
    expect(r.ok && r.value.tab.kind).toBe('session-storage');
  });
});
