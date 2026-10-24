import { createMemorySink, createTelemetry, err, type MetricRecord, ok, type Result } from '@staticflux/core';
import { createEpochSource, defineEndpoint, defineResource, defineStore, s } from '@staticflux/data';
import { type AsyncStore, createMemoryStore } from '@staticflux/storage';
import { describe, expect, it, vi } from 'vitest';
import {
  createSnapshotRegistry,
  migrateSnapshot,
  resourceSnapshotSource,
  SNAPSHOT_ENVELOPE_FORMAT,
  type SnapshotEnvelope,
  type SnapshotLifecycle,
  type SnapshotRegistryOptions,
  type SnapshotSource,
  storeSnapshotSource,
} from './index.js';

const DraftStore = defineStore({
  id: 'studio/drafts',
  version: 2,
  schema: s.object({ title: s.string(), tags: s.array(s.string()) }),
  initial: () => ({ title: '', tags: [] as string[] }),
  actions: {
    setTitle(state, title: string) {
      state.title = title;
    },
  },
});

const PrefsStore = defineStore({
  id: 'studio/prefs',
  version: 1,
  schema: s.object({ theme: s.string() }),
  initial: () => ({ theme: 'light' }),
  actions: {
    setTheme(state, theme: string) {
      state.theme = theme;
    },
  },
});

interface FakeLifecycle extends SnapshotLifecycle {
  hide(): void;
  tick(): void;
  readonly intervals: number[];
}

function fakeLifecycle(): FakeLifecycle {
  const hides = new Set<() => void>();
  const ticks = new Set<() => void>();
  const intervals: number[] = [];
  return {
    intervals,
    onHide(cb) {
      hides.add(cb);
      return () => hides.delete(cb);
    },
    every(ms, cb) {
      intervals.push(ms);
      ticks.add(cb);
      return () => ticks.delete(cb);
    },
    hide: () => hides.forEach((cb) => cb()),
    tick: () => ticks.forEach((cb) => cb()),
  };
}

function setup(extra: Partial<SnapshotRegistryOptions> & { identity?: () => string | undefined } = {}) {
  const store = (extra.store ?? createMemoryStore()) as AsyncStore;
  const lifecycle = fakeLifecycle();
  const epoch = createEpochSource();
  let wall = 1_000_000;
  const sink = createMemorySink();
  const telemetry = createTelemetry({ defaultLevel: 'debug' });
  telemetry.addSink(sink);
  const issues: string[] = [];
  const make = (overrides: Partial<SnapshotRegistryOptions> = {}) =>
    createSnapshotRegistry({
      store,
      lifecycle,
      epoch,
      clock: () => wall,
      telemetry,
      onIssue: (e) => issues.push(e.code),
      ...extra,
      ...overrides,
    });
  return {
    store,
    lifecycle,
    epoch,
    sink,
    issues,
    make,
    advance: (ms: number) => {
      wall += ms;
    },
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

describe('snapshot registry: save → restore round trip', () => {
  it('restores declared stores at boot before any network write, with provenance (age/epoch)', async () => {
    const env = setup({ identity: () => 'user-hash-1' });
    // Session 1
    const drafts1 = DraftStore.create();
    const prefs1 = PrefsStore.create();
    const r1 = env.make({ sources: [storeSnapshotSource(drafts1, { sensitivity: 'identity' }), storeSnapshotSource(prefs1, { sensitivity: 'public' })] });
    expect((await r1.restore()).ok).toBe(true);
    drafts1.actions.setTitle('Hello');
    prefs1.actions.setTheme('dark');
    const saved = await r1.save();
    expect(saved.ok && saved.value.saved).toEqual(['studio/drafts', 'studio/prefs']);
    const raw = await env.store.get('sf-snap/studio/drafts');
    expect(raw.ok && (raw.value as SnapshotEnvelope)).toMatchObject({
      format: SNAPSHOT_ENVELOPE_FORMAT,
      id: 'studio/drafts',
      version: 2,
      identity: 'user-hash-1',
      savedAt: 1_000_000,
      epoch: 0,
      data: { format: 1, storeId: 'studio/drafts', schemaVersion: 2, state: { title: 'Hello', tags: [] } },
    });
    expect((await env.store.get('sf-snap/studio/prefs')).ok).toBe(true);
    await r1.dispose();

    // Session 2 (reload)
    env.advance(5_000);
    env.epoch.bump();
    const drafts2 = DraftStore.create();
    const prefs2 = PrefsStore.create();
    const r2 = env.make({ sources: [storeSnapshotSource(drafts2, { sensitivity: 'identity' }), storeSnapshotSource(prefs2, { sensitivity: 'public' })] });
    const report = await r2.restore();
    expect(report.ok && report.value.restored).toEqual(['studio/drafts', 'studio/prefs']);
    expect(drafts2.state.title).toBe('Hello');
    expect(prefs2.state.theme).toBe('dark');
    expect(r2.provenance('studio/drafts')).toEqual({
      id: 'studio/drafts',
      source: 'snapshot',
      stale: true,
      savedAt: 1_000_000,
      ageMs: 5_000,
      savedEpoch: 0,
      epoch: 1,
      identity: 'user-hash-1',
      migratedFrom: undefined,
    });
    expect(r2.state).toBe('ready');
    const ages = env.sink.records.filter((r): r is MetricRecord => r.type === 'metric' && r.metric === 'hydrate/snapshot-age');
    expect(ages.map((r) => r.value)).toEqual([5_000, 5_000]);
    // A restored-but-unchanged store is not rewritten.
    const again = await r2.save();
    expect(again.ok && again.value.unchanged).toEqual(['studio/drafts', 'studio/prefs']);
  });

  it('missing snapshots are reported as missing (first boot)', async () => {
    const env = setup();
    const r = env.make({ sources: [storeSnapshotSource(PrefsStore.create(), { sensitivity: 'public' })] });
    const report = await r.restore();
    expect(report.ok && report.value).toMatchObject({ restored: [], missing: ['studio/prefs'], dropped: [], timedOut: false });
  });
});

describe('safety rules', () => {
  it('refuses to save before a restore ran (never clobbers the last snapshot)', async () => {
    const env = setup();
    const prefs = PrefsStore.create();
    const r = env.make({ sources: [storeSnapshotSource(prefs, { sensitivity: 'public' })] });
    const result = await r.save();
    expect(result.ok && result.value.skipped).toEqual([{ id: 'studio/prefs', why: 'not-restored' }]);
    expect((await env.store.has('sf-snap/studio/prefs')).ok && (await env.store.has('sf-snap/studio/prefs'))).toEqual({ ok: true, value: false });
  });

  it('never restores identity-bound snapshots across identities (dropped + reported)', async () => {
    let identity: string | undefined = 'alice';
    const env = setup({ identity: () => identity });
    const d1 = DraftStore.create();
    const r1 = env.make({ sources: [storeSnapshotSource(d1, { sensitivity: 'identity' })] });
    await r1.restore();
    d1.actions.setTitle('secret');
    await r1.save();
    identity = 'bob';
    const d2 = DraftStore.create();
    const r2 = env.make({ sources: [storeSnapshotSource(d2, { sensitivity: 'identity' })] });
    const report = await r2.restore();
    expect(report.ok && report.value.dropped).toEqual([{ id: 'studio/drafts', reason: 'identity' }]);
    expect(d2.state.title).toBe('');
    expect(env.issues).toContain('SF-HYD-021');
    expect((await env.store.get('sf-snap/studio/drafts'))).toEqual({ ok: true, value: undefined });
  });

  it('does not save identity-bound sources without an identity', async () => {
    const env = setup();
    const r = env.make({ sources: [storeSnapshotSource(DraftStore.create(), { sensitivity: 'identity' })] });
    await r.restore();
    const result = await r.save();
    expect(result.ok && result.value.skipped).toEqual([{ id: 'studio/drafts', why: 'no-identity' }]);
  });

  it('a restored identity-bound snapshot is re-saved after an identity switch', async () => {
    let identity: string | undefined = 'alice';
    const env = setup({ identity: () => identity });
    const d = DraftStore.create();
    const r = env.make({ sources: [storeSnapshotSource(d, { sensitivity: 'identity' })] });
    await r.restore();
    d.actions.setTitle('x');
    await r.save();
    identity = 'bob';
    const result = await r.save();
    expect(result.ok && result.value.saved).toEqual(['studio/drafts']);
  });

  it('clearIdentityBound() removes identity-bound snapshots and provenance', async () => {
    const env = setup({ identity: () => 'alice' });
    const d = DraftStore.create();
    const p = PrefsStore.create();
    const r = env.make({ sources: [storeSnapshotSource(d, { sensitivity: 'identity' }), storeSnapshotSource(p, { sensitivity: 'public' })] });
    await r.restore();
    d.actions.setTitle('x');
    p.actions.setTheme('dark');
    await r.save();
    const cleared = await r.clearIdentityBound();
    expect(cleared).toEqual({ ok: true, value: ['studio/drafts'] });
    expect(await env.store.get('sf-snap/studio/drafts')).toEqual({ ok: true, value: undefined });
    expect((await env.store.get('sf-snap/studio/prefs')).ok).toBe(true);
    // Revision memory was cleared too: the next save writes again.
    const again = await r.save();
    expect(again.ok && again.value.saved).toEqual(['studio/drafts']);
  });

  it('a store written before the snapshot arrived is not overwritten (superseded)', async () => {
    const env = setup();
    const seed = PrefsStore.create();
    const r1 = env.make({ sources: [storeSnapshotSource(seed, { sensitivity: 'public' })] });
    await r1.restore();
    seed.actions.setTheme('dark');
    await r1.save();

    const fresh = PrefsStore.create();
    const r2 = env.make({ sources: [storeSnapshotSource(fresh, { sensitivity: 'public' })] });
    fresh.actions.setTheme('network'); // e.g. a fast response wrote first
    const report = await r2.restore();
    expect(report.ok && report.value.superseded).toEqual(['studio/prefs']);
    expect(fresh.state.theme).toBe('network');
    expect(r2.provenance('studio/prefs')).toBeUndefined();
  });

  it('an epoch change during the restore makes the snapshot a stale response (skipped, kept)', async () => {
    const memory = createMemoryStore();
    const env = setup();
    const seedReg = env.make({ store: memory, sources: [storeSnapshotSource(PrefsStore.create(), { sensitivity: 'public' })] });
    await seedReg.restore();
    await seedReg.save();
    const slow: AsyncStore = {
      ...memory,
      get: async (key, options) => {
        env.epoch.bump(); // refresh happens while the read is in flight
        return memory.get(key, options);
      },
    };
    const target = PrefsStore.create();
    const r = env.make({ store: slow, sources: [storeSnapshotSource(target, { sensitivity: 'public' })] });
    const report = await r.restore();
    expect(report.ok && report.value.staleEpoch).toEqual(['studio/prefs']);
    expect(target.version).toBe(0);
    expect((await memory.has('sf-snap/studio/prefs'))).toEqual({ ok: true, value: true });
  });

  it('time-boxes the restore; late reads are never applied', async () => {
    vi.useFakeTimers();
    try {
      const memory = createMemoryStore();
      const env = setup();
      const seed = PrefsStore.create();
      const seedReg = env.make({ store: memory, sources: [storeSnapshotSource(seed, { sensitivity: 'public' })] });
      await seedReg.restore();
      seed.actions.setTheme('dark');
      await seedReg.save();
      let release: () => void = () => undefined;
      const stuck: AsyncStore = {
        ...memory,
        get: (key, options) => new Promise((resolve) => {
          release = () => void memory.get(key, options).then(resolve);
        }),
      };
      const target = PrefsStore.create();
      const r = env.make({ store: stuck, restoreTimeoutMs: 50, sources: [storeSnapshotSource(target, { sensitivity: 'public' })] });
      const pending = r.restore();
      await vi.advanceTimersByTimeAsync(60);
      const report = await pending;
      expect(report.ok && report.value.timedOut).toBe(true);
      expect(env.issues).toContain('SF-HYD-027');
      expect(r.state).toBe('ready');
      release();
      await vi.advanceTimersByTimeAsync(1);
      expect(target.state.theme).toBe('light');
    } finally {
      vi.useRealTimers();
    }
  });

  it('restore is cancellable', async () => {
    const env = setup();
    const r = env.make({ sources: [storeSnapshotSource(PrefsStore.create(), { sensitivity: 'public' })] });
    const controller = new AbortController();
    controller.abort();
    const result = await r.restore(controller.signal);
    expect(result.ok).toBe(false);
  });
});

describe('versioning and migrations', () => {
  async function seedEnvelope(store: AsyncStore, id: string, envelope: Partial<SnapshotEnvelope> & { data: unknown }): Promise<void> {
    await store.set(`sf-snap/${id}`, {
      format: SNAPSHOT_ENVELOPE_FORMAT,
      id,
      version: 1,
      identity: null,
      savedAt: 1_000_000,
      epoch: 0,
      bytes: 10,
      ...envelope,
    });
  }

  it('migrates an older store snapshot (state transform per schema version)', async () => {
    const env = setup({ identity: () => 'u' });
    await seedEnvelope(env.store, 'studio/drafts', {
      version: 1,
      identity: 'u',
      data: { format: 1, storeId: 'studio/drafts', schemaVersion: 1, epoch: 0, version: 3, state: { title: 'old' } },
    });
    const d = DraftStore.create();
    const r = env.make({
      sources: [storeSnapshotSource(d, { sensitivity: 'identity', migrations: { 1: (state) => ({ ...(state as object), tags: ['migrated'] }) } })],
    });
    const report = await r.restore();
    expect(report.ok && report.value.restored).toEqual(['studio/drafts']);
    expect(d.state).toEqual({ title: 'old', tags: ['migrated'] });
    expect(r.provenance('studio/drafts')?.migratedFrom).toBe(1);
  });

  it('drops snapshots without a migration path, from a newer version, or failing validation', async () => {
    const env = setup();
    await seedEnvelope(env.store, 'studio/drafts', { version: 1, data: { format: 1, storeId: 'studio/drafts', schemaVersion: 1, epoch: 0, version: 1, state: {} } });
    await seedEnvelope(env.store, 'studio/prefs', { version: 9, data: {} });
    await seedEnvelope(env.store, 'app/bad', { version: 1, data: { format: 1, storeId: 'app/bad', schemaVersion: 1, epoch: 0, version: 1, state: { theme: 42 } } });
    const BadStore = defineStore({ id: 'app/bad', version: 1, schema: s.object({ theme: s.string() }), initial: () => ({ theme: 'x' }), actions: {} });
    const r = env.make({
      sources: [
        storeSnapshotSource(DraftStore.create(), { sensitivity: 'public' }),
        storeSnapshotSource(PrefsStore.create(), { sensitivity: 'public' }),
        storeSnapshotSource(BadStore.create(), { sensitivity: 'public' }),
      ],
    });
    const report = await r.restore();
    expect(report.ok && report.value.dropped).toEqual([
      { id: 'studio/drafts', reason: 'version' },
      { id: 'studio/prefs', reason: 'version' },
      { id: 'app/bad', reason: 'invalid' },
    ]);
    expect(env.issues).toEqual(['SF-HYD-020', 'SF-HYD-020', 'SF-HYD-024']);
    const keys = await env.store.seek({ prefix: 'sf-snap/' }).keys();
    expect(keys).toEqual({ ok: true, value: [] });
  });

  it('drops corrupt envelopes and envelopes under the wrong id', async () => {
    const env = setup();
    await env.store.set('sf-snap/studio/prefs', { nope: true });
    await seedEnvelope(env.store, 'studio/drafts', { id: 'other/id', data: {} });
    await env.store.set('sf-snap/studio/drafts', { format: SNAPSHOT_ENVELOPE_FORMAT, id: 'other/id', version: 1, identity: null, savedAt: 0, epoch: 0, bytes: 0, data: {} });
    const r = env.make({ sources: [storeSnapshotSource(PrefsStore.create(), { sensitivity: 'public' }), storeSnapshotSource(DraftStore.create(), { sensitivity: 'public' })] });
    const report = await r.restore();
    expect(report.ok && report.value.dropped.map((d) => d.reason)).toEqual(['corrupt', 'corrupt']);
    expect(env.issues).toEqual(['SF-HYD-023', 'SF-HYD-023']);
  });

  it('drops snapshots older than maxAgeMs', async () => {
    const env = setup();
    await seedEnvelope(env.store, 'studio/prefs', { savedAt: 0, data: { format: 1, storeId: 'studio/prefs', schemaVersion: 1, epoch: 0, version: 1, state: { theme: 'dark' } } });
    const p = PrefsStore.create();
    const r = env.make({ sources: [storeSnapshotSource(p, { sensitivity: 'public', maxAgeMs: 1000 })] });
    const report = await r.restore();
    expect(report.ok && report.value.dropped).toEqual([{ id: 'studio/prefs', reason: 'expired' }]);
    expect(p.state.theme).toBe('light');
  });

  it('migrateSnapshot chains steps and reports missing/throwing steps', () => {
    expect(migrateSnapshot(1, 1, 3, { 1: (n) => (n as number) + 1, 2: (n) => (n as number) * 10 })).toEqual({ ok: true, value: 20 });
    expect(migrateSnapshot(1, 1, 1, undefined)).toEqual({ ok: true, value: 1 });
    expect(migrateSnapshot(1, 1, 3, { 1: (n) => n }).ok).toBe(false);
    expect(migrateSnapshot(1, 1, 2, { 1: () => { throw new Error('x'); } }).ok).toBe(false);
    expect(migrateSnapshot(1, 3, 2, {}).ok).toBe(false);
  });
});

describe('saving', () => {
  it('saves on hide and on the interval; one batch per save', async () => {
    const env = setup();
    const p = PrefsStore.create();
    const batchSpy = vi.spyOn(env.store, 'batch');
    const r = env.make({ intervalMs: 10_000, sources: [storeSnapshotSource(p, { sensitivity: 'public' })] });
    await r.restore();
    r.start();
    r.start(); // idempotent
    expect(env.lifecycle.intervals).toEqual([10_000]);
    p.actions.setTheme('dark');
    env.lifecycle.hide();
    await flush();
    expect(batchSpy).toHaveBeenCalledTimes(1);
    env.lifecycle.tick();
    await flush();
    expect(batchSpy).toHaveBeenCalledTimes(1); // unchanged → no write
    p.actions.setTheme('blue');
    env.lifecycle.tick();
    await flush();
    expect(batchSpy).toHaveBeenCalledTimes(2);
    await r.dispose();
    p.actions.setTheme('red');
    env.lifecycle.hide();
    await flush();
    expect(batchSpy).toHaveBeenCalledTimes(2);
  });

  it('enforces the per-snapshot byte budget (not written; stale one removed)', async () => {
    const env = setup();
    const d = DraftStore.create();
    const r = env.make({ sources: [storeSnapshotSource(d, { sensitivity: 'public', maxBytes: 200 })] });
    await r.restore();
    d.actions.setTitle('ok');
    await r.save();
    expect((await env.store.has('sf-snap/studio/drafts'))).toEqual({ ok: true, value: true });
    d.actions.setTitle('x'.repeat(500));
    const result = await r.save();
    expect(result.ok && result.value.skipped).toEqual([{ id: 'studio/drafts', why: 'over-budget' }]);
    expect(env.issues).toContain('SF-HYD-022');
    expect((await env.store.has('sf-snap/studio/drafts'))).toEqual({ ok: true, value: false });
  });

  it('capture() → undefined removes the entry; a throwing capture is reported', async () => {
    const env = setup();
    let value: unknown = { a: 1 };
    const source: SnapshotSource = { id: 'app/custom', version: 1, sensitivity: 'public', capture: () => value, restore: () => ok('applied') };
    const throwing: SnapshotSource = { id: 'app/throws', version: 1, sensitivity: 'public', capture: () => { throw new Error('x'); }, restore: () => ok('applied') };
    const r = env.make({ sources: [source, throwing] });
    await r.restore();
    await r.save();
    expect((await env.store.has('sf-snap/app/custom'))).toEqual({ ok: true, value: true });
    value = undefined;
    const result = await r.save();
    expect(result.ok && result.value.removed).toEqual(['app/custom']);
    expect((await env.store.has('sf-snap/app/custom'))).toEqual({ ok: true, value: false });
    expect(env.issues).toContain('SF-CORE-000');
  });

  it('concurrent saves are single-flight', async () => {
    const env = setup();
    const batchSpy = vi.spyOn(env.store, 'batch');
    const r = env.make({ sources: [storeSnapshotSource(PrefsStore.create(), { sensitivity: 'public' })] });
    await r.restore();
    const [a, b] = await Promise.all([r.save(), r.save()]);
    expect(a).toBe(b);
    expect(batchSpy).toHaveBeenCalledTimes(1);
  });

  it('storage failures are reported, never thrown', async () => {
    const memory = createMemoryStore();
    const failing: AsyncStore = {
      ...memory,
      get: async () => err(new (await import('@staticflux/core')).SfError({ code: 'SF-STORE-008', kind: 'unavailable', message: 'io' })),
      batch: async (): Promise<Result<void>> => err(new (await import('@staticflux/core')).SfError({ code: 'SF-STORE-008', kind: 'unavailable', message: 'io' })),
    };
    const env = setup({ store: failing });
    const r = env.make({ sources: [storeSnapshotSource(PrefsStore.create(), { sensitivity: 'public' })] });
    const report = await r.restore();
    expect(report.ok && report.value.dropped).toEqual([{ id: 'studio/prefs', reason: 'storage' }]);
    const saved = await r.save();
    expect(saved.ok).toBe(false);
    expect(env.issues).toEqual(['SF-HYD-025', 'SF-HYD-025']);
    expect(r.state).toBe('ready');
  });
});

describe('registration', () => {
  it('rejects duplicate sources; late sources restore with restoreOne()', async () => {
    const env = setup();
    const seed = PrefsStore.create();
    const seedReg = env.make({ sources: [storeSnapshotSource(seed, { sensitivity: 'public' })] });
    await seedReg.restore();
    seed.actions.setTheme('dark');
    await seedReg.save();

    const r = env.make({ sources: [] });
    await r.restore();
    const late = PrefsStore.create();
    const registered = r.register(storeSnapshotSource(late, { sensitivity: 'public' }));
    expect(registered.ok).toBe(true);
    expect(r.register(storeSnapshotSource(late, { sensitivity: 'public' })).ok).toBe(false);
    expect(env.issues).toContain('SF-HYD-026');
    const report = await r.restoreOne('studio/prefs');
    expect(report.ok && report.value.restored).toEqual(['studio/prefs']);
    expect(late.state.theme).toBe('dark');
    expect((await r.restoreOne('nope/x')).ok).toBe(false);
    if (registered.ok) registered.value();
    expect(r.sources).toEqual([]);
  });

  it('duplicate ids in the initial list are reported', () => {
    const env = setup();
    const p = PrefsStore.create();
    const r = env.make({ sources: [storeSnapshotSource(p, { sensitivity: 'public' }), storeSnapshotSource(p, { sensitivity: 'public' })] });
    expect(r.sources).toEqual(['studio/prefs']);
    expect(env.issues).toEqual(['SF-HYD-026']);
  });

  it('prune() deletes entries no source owns', async () => {
    const env = setup();
    await env.store.set('sf-snap/old/removed-store', { x: 1 });
    await env.store.set('other/key', 1);
    const r = env.make({ sources: [storeSnapshotSource(PrefsStore.create(), { sensitivity: 'public' })] });
    await r.restore();
    await r.save();
    expect(await r.prune()).toEqual({ ok: true, value: ['sf-snap/old/removed-store'] });
    expect((await env.store.has('other/key'))).toEqual({ ok: true, value: true });
    expect((await env.store.has('sf-snap/studio/prefs'))).toEqual({ ok: true, value: true });
  });

  it('a throwing restore() is captured as SF-HYD-024', async () => {
    const env = setup();
    await env.store.set('sf-snap/app/x', { format: SNAPSHOT_ENVELOPE_FORMAT, id: 'app/x', version: 1, identity: null, savedAt: 0, epoch: 0, bytes: 1, data: 1 });
    const source: SnapshotSource = { id: 'app/x', version: 1, sensitivity: 'public', capture: () => 1, restore: () => { throw new Error('x'); } };
    const r = env.make({ sources: [source] });
    const report = await r.restore();
    expect(report.ok && report.value.dropped).toEqual([{ id: 'app/x', reason: 'invalid' }]);
  });

  it('disposed registries refuse work', async () => {
    const env = setup();
    const r = env.make({ sources: [] });
    await r.dispose();
    await r.dispose();
    expect(r.state).toBe('disposed');
    expect((await r.restore()).ok).toBe(false);
    expect((await r.save()).ok).toBe(false);
  });
});

describe('resourceSnapshotSource', () => {
  const ProfileGet = defineEndpoint<{ id: string }, { name: string }>({ id: 'users/get', path: (i) => `/users/${i.id}`, response: s.object({ name: s.string() }) });
  const ProfileResource = defineResource({ id: 'users/profile', endpoint: ProfileGet, key: (i) => [i.id] });

  function fakeResources() {
    const data = new Map<string, unknown>();
    const calls: string[] = [];
    return {
      calls,
      data,
      getData: (_r: unknown, input: { id: string }) => data.get(input.id) as never,
      setData: (_r: unknown, input: { id: string }, value: unknown) => {
        calls.push(`set:${input.id}`);
        data.set(input.id, value);
      },
      invalidate: (_r?: unknown, input?: unknown) => {
        calls.push(`invalidate:${(input as { id: string }).id}`);
      },
    };
  }

  it('seeds the SWR cache from the snapshot AND invalidates it (revalidate in background)', async () => {
    const env = setup();
    const before = fakeResources();
    before.data.set('me', { name: 'Ada' });
    const r1 = env.make({ sources: [resourceSnapshotSource(before as never, ProfileResource, { id: 'users/me', version: 1, sensitivity: 'public', input: { id: 'me' } })] });
    await r1.restore();
    await r1.save();

    const after = fakeResources();
    const r2 = env.make({ sources: [resourceSnapshotSource(after as never, ProfileResource, { id: 'users/me', version: 1, sensitivity: 'public', input: { id: 'me' } })] });
    const report = await r2.restore();
    expect(report.ok && report.value.restored).toEqual(['users/me']);
    expect(after.data.get('me')).toEqual({ name: 'Ada' });
    expect(after.calls).toEqual(['set:me', 'invalidate:me']);
    expect(r2.provenance('users/me')?.stale).toBe(true);
  });

  it('never overwrites already cached data; validates with the endpoint response schema', async () => {
    const env = setup();
    await env.store.set('sf-snap/users/me', { format: SNAPSHOT_ENVELOPE_FORMAT, id: 'users/me', version: 1, identity: null, savedAt: 0, epoch: 0, bytes: 1, data: { name: 'Old' } });
    await env.store.set('sf-snap/users/bad', { format: SNAPSHOT_ENVELOPE_FORMAT, id: 'users/bad', version: 1, identity: null, savedAt: 0, epoch: 0, bytes: 1, data: { name: 5 } });
    const res = fakeResources();
    res.data.set('me', { name: 'Fresh' });
    const r = env.make({
      sources: [
        resourceSnapshotSource(res as never, ProfileResource, { id: 'users/me', version: 1, sensitivity: 'public', input: { id: 'me' } }),
        resourceSnapshotSource(res as never, ProfileResource, { id: 'users/bad', version: 1, sensitivity: 'public', input: { id: 'bad' } }),
      ],
    });
    const report = await r.restore();
    expect(report.ok && report.value.superseded).toEqual(['users/me']);
    expect(report.ok && report.value.dropped).toEqual([{ id: 'users/bad', reason: 'invalid' }]);
    expect(res.data.get('me')).toEqual({ name: 'Fresh' });
    expect(res.calls).toEqual([]);
  });
});

describe('storeSnapshotSource', () => {
  it('calls onRestored with the provenance and rejects non-snapshot data', async () => {
    const onRestored = vi.fn();
    const p = PrefsStore.create();
    const source = storeSnapshotSource(p, { sensitivity: 'public', onRestored, maxBytes: 10, maxAgeMs: 5 });
    expect(source).toMatchObject({ id: 'studio/prefs', version: 1, maxBytes: 10, maxAgeMs: 5 });
    const meta = { id: 'studio/prefs', source: 'snapshot', stale: true, savedAt: 0, ageMs: 0, savedEpoch: 0, epoch: 0, identity: null, migratedFrom: undefined } as const;
    expect(source.restore(null as never, meta).ok).toBe(false);
    const snapshot = { ...p.getSnapshot(), state: { theme: 'dark' } };
    expect(source.restore(snapshot, meta)).toEqual({ ok: true, value: 'applied' });
    expect(onRestored).toHaveBeenCalledWith(meta);
    expect(p.state.theme).toBe('dark');
  });

  it('rejects a snapshot of another store (header check)', () => {
    const p = PrefsStore.create();
    const source = storeSnapshotSource(p, { sensitivity: 'public' });
    const meta = { id: 'studio/prefs', source: 'snapshot', stale: true, savedAt: 0, ageMs: 0, savedEpoch: 0, epoch: 0, identity: null, migratedFrom: undefined } as const;
    const foreign = { ...p.getSnapshot(), storeId: 'studio/drafts' as const };
    expect(source.restore(foreign, meta).ok).toBe(false);
  });
});
