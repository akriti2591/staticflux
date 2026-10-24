import { err, ok } from '@staticflux/core';
import { describe, expect, it, vi } from 'vitest';
import {
  assignVariant,
  createExperimentLayer,
  createLocalOverrideLayer,
  createRemoteLayer,
  createStaticLayer,
  defineExperiment,
  defineFlag,
  flagType,
  flagValue,
  fnv1a,
  isIdentityBound,
  layerRank,
  type LayerEvent,
  parseDevValue,
  parseFlagParams,
  RemoteConfigLoadError,
  type StorageLike,
} from './index.js';

const Bool = defineFlag({ key: 'layers/bool', type: flagType.boolean(), default: false, owner: 't', preAuthSafe: true, description: '' });
const Arm = defineFlag({ key: 'layers/arm', type: flagType.enum(['A', 'B', 'C']), default: 'A', owner: 't', preAuthSafe: false, description: '' });

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
    removeItem: (k) => {
      data.delete(k);
    },
  };
}

describe('layer ordering', () => {
  it('ranks layers per R8.5', () => {
    const order = (['local', 'app', 'experiment', 'default', 'remote', 'workspace'] as const).slice().sort((a, b) => layerRank(a) - layerRank(b));
    expect(order).toEqual(['default', 'app', 'workspace', 'remote', 'experiment', 'local']);
  });

  it('identity-bound defaults', () => {
    expect(isIdentityBound(createStaticLayer({ id: 'a', layer: 'app' }))).toBe(false);
    expect(isIdentityBound(createStaticLayer({ id: 'r', layer: 'remote' }))).toBe(true);
    expect(isIdentityBound(createStaticLayer({ id: 'e', layer: 'experiment' }))).toBe(true);
    expect(isIdentityBound(createStaticLayer({ id: 'r2', layer: 'remote', identityBound: false }))).toBe(false);
  });
});

describe('static layer', () => {
  it('looks up values and emits change events', () => {
    const layer = createStaticLayer({ id: 'app/config', layer: 'app', values: { 'layers/bool': true }, entries: [flagValue(Arm, 'B')] });
    expect(layer.lookup(Bool, {})).toEqual(ok({ value: true, reason: 'STATIC' }));
    expect(layer.lookup(Arm, {})).toEqual(ok({ value: 'B', reason: 'STATIC' }));
    const events: LayerEvent[] = [];
    const off = layer.subscribe?.((e) => events.push(e)) ?? (() => undefined);
    layer.set(Bool, false);
    layer.setByKey('layers/arm', 'C');
    layer.unset(Bool);
    layer.unset('layers/missing');
    layer.replace({ 'layers/arm': 'A' });
    expect(layer.entries()).toEqual({ 'layers/arm': 'A' });
    expect(events).toEqual([
      { type: 'configuration-changed', keys: ['layers/bool'] },
      { type: 'configuration-changed', keys: ['layers/arm'] },
      { type: 'configuration-changed', keys: ['layers/bool'] },
      { type: 'configuration-changed' },
    ]);
    expect(layer.lookup(Bool, {})).toEqual(ok(undefined));
    off();
    layer.set(Bool, true);
    expect(events).toHaveLength(4);
    void layer.dispose?.();
  });
});

describe('local override layer', () => {
  it('merges storage and URL (URL wins) and persists writes', () => {
    const storage = memoryStorage({ 'sf-flags': JSON.stringify({ 'layers/bool': false, 'layers/arm': 'C' }) });
    const layer = createLocalOverrideLayer({ storage, search: '?sf-flag=layers/bool:true' });
    expect(layer.layer).toBe('local');
    expect(isIdentityBound(layer)).toBe(false);
    expect(layer.entries()).toEqual({ 'layers/bool': true, 'layers/arm': 'C' });
    layer.set(Arm, 'B');
    expect(JSON.parse(storage.data.get('sf-flags') ?? '{}')).toEqual({ 'layers/bool': true, 'layers/arm': 'B' });
    layer.replace({});
    expect(storage.data.has('sf-flags')).toBe(false);
  });

  it('survives broken or throwing storage', () => {
    const broken = memoryStorage({ 'sf-flags': '{not json' });
    expect(createLocalOverrideLayer({ storage: broken }).entries()).toEqual({});
    expect(createLocalOverrideLayer({ storage: memoryStorage({ 'sf-flags': '[1]' }) }).entries()).toEqual({});
    const throwing: StorageLike = {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
      removeItem: () => undefined,
    };
    const layer = createLocalOverrideLayer({ storage: throwing, storageKey: 'k' });
    expect(() => layer.set(Bool, true)).not.toThrow();
    expect(layer.lookup(Bool, {})).toEqual(ok({ value: true, reason: 'STATIC' }));
    expect(createLocalOverrideLayer().id).toBe('config/local-override');
  });

  it('parses dev values and URL params', () => {
    expect(parseDevValue('true')).toBe(true);
    expect(parseDevValue('3')).toBe(3);
    expect(parseDevValue('{"a":1}')).toEqual({ a: 1 });
    expect(parseDevValue('B')).toBe('B');
    expect(parseFlagParams('?sf-flag=a/b:true&sf-flag=c/d:B&sf-flag=bad&sf-flag=:x&x=1')).toEqual({ 'a/b': true, 'c/d': 'B' });
    expect(parseFlagParams('?f=a/b:1', 'f')).toEqual({ 'a/b': 1 });
  });
});

describe('remote layer', () => {
  it('loads on initialize and reloads on context change', async () => {
    const load = vi.fn(async (context: { targetingKey?: string }) => ok({ 'layers/bool': context.targetingKey === 'u1' }));
    const layer = createRemoteLayer({ id: 'remote/flags', load });
    expect(layer.loaded).toBe(false);
    expect(layer.lookup(Bool, {})).toEqual(ok(undefined));
    expect(await layer.initialize?.({ targetingKey: 'u1' }, new AbortController().signal)).toEqual(ok());
    expect(layer.loaded).toBe(true);
    expect(layer.lookup(Bool, {})).toEqual(ok({ value: true, reason: 'CACHED' }));
    await layer.onContextChange?.({}, { targetingKey: 'u2' }, new AbortController().signal);
    expect(layer.lookup(Bool, {})).toEqual(ok({ value: false, reason: 'CACHED' }));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('wraps failures, retries, and keeps values on failed refresh (stale)', async () => {
    let calls = 0;
    const layer = createRemoteLayer({
      id: 'remote/flags',
      retry: { attempts: 2, baseDelayMs: 0, jitter: 'none' },
      load: async () => {
        calls += 1;
        if (calls === 1) return err(RemoteConfigLoadError({ message: 'flaky' }));
        if (calls === 2) return ok({ 'layers/arm': 'B' });
        throw new Error('down');
      },
    });
    const signal = new AbortController().signal;
    expect(await layer.initialize?.({}, signal)).toEqual(ok());
    expect(calls).toBe(2);
    const events: LayerEvent[] = [];
    layer.subscribe?.((e) => events.push(e));
    const failed = await layer.refresh({}, signal);
    expect(!failed.ok && failed.error.code).toBe('SF-CFG-008');
    expect(events).toEqual([{ type: 'stale' }]);
    expect(layer.lookup(Arm, {})).toEqual(ok({ value: 'B', reason: 'CACHED' }));
  });

  it('refresh success emits configuration-changed; failure before first load emits error; aborts are silent', async () => {
    let mode: 'ok' | 'fail' = 'fail';
    const layer = createRemoteLayer({
      id: 'remote/x',
      reloadOnContextChange: false,
      load: async (_c, signal) => {
        if (signal.aborted) return err(new (class extends Error {})() as never);
        return mode === 'ok' ? ok({}) : err(RemoteConfigLoadError());
      },
    });
    const events: string[] = [];
    layer.subscribe?.((e) => events.push(e.type));
    await layer.refresh({}, new AbortController().signal);
    expect(events).toEqual(['error']);
    mode = 'ok';
    await layer.refresh({}, new AbortController().signal);
    expect(events).toEqual(['error', 'configuration-changed']);
    expect(await layer.onContextChange?.({}, { a: 1 }, new AbortController().signal)).toEqual(ok());
    const aborting = createRemoteLayer({ id: 'remote/y', load: async () => err(new DOMException('x', 'AbortError') as never) });
    const abortEvents: string[] = [];
    aborting.subscribe?.((e) => abortEvents.push(e.type));
    const aborted = await aborting.refresh({}, new AbortController().signal);
    expect(!aborted.ok).toBe(true);
    void layer.dispose?.();
  });

  it('propagates aborted loads as aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const layer = createRemoteLayer({
      id: 'remote/z',
      load: async () => {
        throw new DOMException('aborted', 'AbortError');
      },
    });
    const result = await layer.initialize?.({}, controller.signal);
    expect(result !== undefined && !result.ok && result.error.kind).toBe('aborted');
  });
});

describe('experiment layer', () => {
  it('fnv1a is stable', () => {
    expect(fnv1a('')).toBe(0x811c9dc5);
    expect(fnv1a('a')).toBe(0xe40c292c);
  });

  it('assigns deterministically and roughly by weight', () => {
    const experiment = defineExperiment({ flag: Arm, allocation: { A: 1, B: 1 } });
    expect(experiment.salt).toBe('layers/arm');
    const first = assignVariant(experiment, 'user-1');
    expect(assignVariant(experiment, 'user-1')).toBe(first);
    const counts: Record<string, number> = {};
    for (let i = 0; i < 2000; i += 1) {
      const v = assignVariant(experiment, `user-${i}`) ?? 'none';
      counts[v] = (counts[v] ?? 0) + 1;
    }
    expect(Object.keys(counts).sort()).toEqual(['A', 'B']);
    expect(counts.A).toBeGreaterThan(800);
    expect(counts.B).toBeGreaterThan(800);
    expect(assignVariant(defineExperiment({ flag: Arm, allocation: {} }), 'u')).toBeUndefined();
    expect(assignVariant(defineExperiment({ flag: Arm, allocation: { C: 1, A: 0 } }), 'u')).toBe('C');
  });

  it('serves SPLIT values for enrolled users only', () => {
    const layer = createExperimentLayer({
      experiments: [
        defineExperiment({ flag: Arm, allocation: { B: 1 }, salt: 's1', include: (ctx) => ctx.country === 'DE' }),
        defineExperiment({ flag: Bool, allocation: { true: 1 } }),
      ],
    });
    expect(layer.id).toBe('config/experiments');
    expect(layer.lookup(Arm, { targetingKey: 'u', country: 'DE' })).toEqual(
      ok({ value: 'B', variant: 'B', reason: 'SPLIT', flagMetadata: { experiment: 's1' } }),
    );
    expect(layer.lookup(Arm, { targetingKey: 'u', country: 'FR' })).toEqual(ok(undefined));
    expect(layer.lookup(Arm, { country: 'DE' })).toEqual(ok(undefined));
    expect(layer.lookup(Arm, { targetingKey: '', country: 'DE' })).toEqual(ok(undefined));
    const bool = layer.lookup(Bool, { targetingKey: 'u' });
    expect(bool.ok && bool.value?.value).toBe(true);
    const none = createExperimentLayer({ experiments: [defineExperiment({ flag: Bool, allocation: {} })] });
    expect(none.lookup(Bool, { targetingKey: 'u' })).toEqual(ok(undefined));
    expect(none.lookup(Arm, { targetingKey: 'u' })).toEqual(ok(undefined));
  });
});
