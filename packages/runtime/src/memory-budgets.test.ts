import { box, createInjector, createMemorySink, createTelemetry } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { createFeatureHost, createResourceManager, defineFeature, type MemoryPressure, nominalMemoryPressureUnit } from './index.js';
import { createMemoryBudgets, DEFAULT_MEMORY_BUDGETS, type MemoryCacheHandle, MemoryBudgetsToken, memoryBudgetsUnit, memoryBudgetsUnitWith, MiB } from './memory.js';

/** A fake LRU cache of fixed-size items that reports to the ledger. */
function fakeCache(itemBytes: number) {
  const items: number[] = [];
  let handle: MemoryCacheHandle | undefined;
  const cache = {
    evicted: [] as number[],
    calls: 0,
    attach(h: MemoryCacheHandle) {
      handle = h;
    },
    add(id: number) {
      items.push(id);
      handle?.report(items.length * itemBytes);
    },
    get ids() {
      return [...items];
    },
    evict(bytes: number): number {
      cache.calls += 1;
      let freed = 0;
      while (freed < bytes && items.length > 0) {
        cache.evicted.push(items.shift()!);
        freed += itemBytes;
      }
      handle?.report(items.length * itemBytes);
      return freed;
    },
  };
  return cache;
}

describe('createMemoryBudgets', () => {
  it('keeps a kind under budget by evicting LRU items when a cache reports growth', () => {
    const memory = createMemoryBudgets({ budgets: { gpu: 4 * MiB } });
    const tiles = fakeCache(MiB);
    const handle = memory.register({ id: 'render/tiles', kind: 'gpu', evict: (b) => tiles.evict(b) });
    expect(handle.ok).toBe(true);
    if (!handle.ok) return;
    tiles.attach(handle.value);
    for (let i = 1; i <= 6; i++) tiles.add(i);
    expect(tiles.ids).toEqual([3, 4, 5, 6]);
    expect(tiles.evicted).toEqual([1, 2]);
    expect(handle.value.bytes).toBe(4 * MiB);
    expect(handle.value.headroom()).toBe(0);
    expect(memory.usage('gpu')).toMatchObject({ kind: 'gpu', bytes: 4 * MiB, budget: 4 * MiB, caches: [{ id: 'render/tiles', bytes: 4 * MiB, priority: 'normal' }] });
    expect(memory.history().map((e) => e.reason)).toEqual(['budget', 'budget']);
  });

  it('evicts lower priority caches first, then the largest cache', () => {
    const memory = createMemoryBudgets({ budgets: { gpu: 6 * MiB } });
    const low = fakeCache(MiB);
    const big = fakeCache(MiB);
    const small = fakeCache(MiB);
    const reg = (id: string, cache: ReturnType<typeof fakeCache>, priority: 'low' | 'normal') => {
      const r = memory.register({ id, kind: 'gpu', priority, evict: (b) => cache.evict(b) });
      if (!r.ok) throw r.error;
      cache.attach(r.value);
    };
    reg('a/low', low, 'low');
    reg('b/big', big, 'normal');
    reg('c/small', small, 'normal');
    low.add(1);
    big.add(1);
    big.add(2);
    big.add(3);
    small.add(1);
    small.add(2); // 6 MiB: fits
    expect(memory.history()).toEqual([]);
    small.add(3); // 7 MiB → the low-priority cache goes first
    expect(low.ids).toEqual([]);
    expect(big.ids).toEqual([1, 2, 3]);
    small.add(4); // 7 MiB again → largest normal cache (big: 3 vs small: 4 → small)
    expect(small.ids).toEqual([2, 3, 4]);
    expect(big.ids).toEqual([1, 2, 3]);
  });

  it('tightens budgets under memory pressure and evicts synchronously on the change', () => {
    const pressure = box<MemoryPressure>('nominal');
    const memory = createMemoryBudgets({ budgets: { gpu: 8 * MiB, media: 8 * MiB }, pressure });
    const gpu = fakeCache(MiB);
    const media = fakeCache(MiB);
    for (const [id, kind, cache] of [
      ['render/tiles', 'gpu', gpu],
      ['media/frames', 'media', media],
    ] as const) {
      const r = memory.register({ id, kind, evict: (b) => cache.evict(b) });
      if (!r.ok) throw r.error;
      cache.attach(r.value);
      for (let i = 0; i < 8; i++) cache.add(i);
    }
    pressure.set('moderate');
    expect(memory.budget('gpu')).toBe(4 * MiB);
    expect(gpu.ids).toHaveLength(4);
    expect(media.ids).toHaveLength(4);
    pressure.set('critical');
    expect(memory.budget('media')).toBe(2 * MiB);
    expect(gpu.ids).toHaveLength(2);
    expect(memory.history().every((e) => e.reason === 'pressure')).toBe(true);
    pressure.set('nominal');
    expect(memory.budget('gpu')).toBe(8 * MiB);
  });

  it('relieve() evicts down to a fraction of the budget and reports bytes freed', () => {
    const memory = createMemoryBudgets({ budgets: { gpu: 10 * MiB } });
    const tiles = fakeCache(MiB);
    const r = memory.register({ id: 'render/tiles', kind: 'gpu', evict: (b) => tiles.evict(b) });
    if (!r.ok) throw r.error;
    tiles.attach(r.value);
    for (let i = 0; i < 8; i++) tiles.add(i);
    expect(memory.relieve()).toBe(0); // under budget
    expect(memory.relieve({ reason: 'manual', targetFraction: 0.5 })).toBe(3 * MiB);
    expect(tiles.ids).toHaveLength(5);
    expect(memory.relieve({ reason: 'manual', targetFraction: 0 })).toBe(5 * MiB);
    expect(tiles.ids).toEqual([]);
  });

  it('caches that cannot free anything are skipped; over-budget is reported once', () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'debug' });
    telemetry.addSink(sink);
    const memory = createMemoryBudgets({ budgets: { gpu: MiB }, telemetry });
    const r = memory.register({ id: 'stuck', kind: 'gpu', evict: () => 0 });
    if (!r.ok) throw r.error;
    r.value.report(3 * MiB); // the cache keeps its bytes
    expect(r.value.bytes).toBe(3 * MiB);
    const events = sink.records.filter((x) => x.type === 'event').map((x) => x.name);
    expect(events).toContain('resources.memory-over-budget');
  });

  it('applies the freed count when a cache does not report its new size itself', () => {
    const memory = createMemoryBudgets({ budgets: { gpu: 2 * MiB } });
    let held = 0;
    const r = memory.register({ id: 'quiet', kind: 'gpu', evict: (b) => {
      held -= b;
      return b;
    } });
    if (!r.ok) throw r.error;
    held = 5 * MiB;
    r.value.report(held);
    expect(r.value.bytes).toBe(2 * MiB);
  });

  it('an eviction callback that throws is contained and logged', () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'debug' });
    telemetry.addSink(sink);
    const memory = createMemoryBudgets({ budgets: { gpu: MiB }, telemetry });
    const r = memory.register({ id: 'boom', kind: 'gpu', evict: () => {
      throw new Error('boom');
    } });
    if (!r.ok) throw r.error;
    expect(() => r.value.report(2 * MiB)).not.toThrow();
    expect(sink.records.some((x) => x.type === 'event' && x.name === 'resources.cache-evict-failed')).toBe(true);
  });

  it('rejects duplicate ids, unknown kinds and registrations after dispose (SF-MEM-001)', () => {
    const memory = createMemoryBudgets();
    expect(memory.register({ id: 'x', kind: 'gpu', evict: () => 0 }).ok).toBe(true);
    const dup = memory.register({ id: 'x', kind: 'gpu', evict: () => 0 });
    expect(!dup.ok && dup.error.code).toBe('SF-MEM-001');
    const unknown = memory.register({ id: 'y', kind: 'disk' as 'gpu', evict: () => 0 });
    expect(!unknown.ok && unknown.error.code).toBe('SF-MEM-001');
    memory.dispose();
    const late = memory.register({ id: 'z', kind: 'gpu', evict: () => 0 });
    expect(!late.ok && late.error.code).toBe('SF-MEM-001');
  });

  it('dispose() of a handle frees its bytes and allows re-registering the id', () => {
    const memory = createMemoryBudgets({ budgets: { gpu: 4 * MiB } });
    const first = memory.register({ id: 'render/tiles', kind: 'gpu', evict: () => 0 });
    if (!first.ok) throw first.error;
    first.value.report(3 * MiB);
    first.value.dispose();
    first.value.dispose();
    first.value.report(9 * MiB); // ignored after dispose
    expect(memory.usage('gpu').bytes).toBe(0);
    expect(memory.register({ id: 'render/tiles', kind: 'gpu', evict: () => 0 }).ok).toBe(true);
  });

  it('setBudgets() lowers a budget and evicts to fit', () => {
    const memory = createMemoryBudgets({ budgets: { gpu: 8 * MiB } });
    const tiles = fakeCache(MiB);
    const r = memory.register({ id: 'render/tiles', kind: 'gpu', evict: (b) => tiles.evict(b) });
    if (!r.ok) throw r.error;
    tiles.attach(r.value);
    for (let i = 0; i < 8; i++) tiles.add(i);
    memory.setBudgets({ gpu: 3 * MiB });
    expect(tiles.ids).toEqual([5, 6, 7]);
  });

  it('defaults follow IF-15.7 (GPU 512 MiB, media 1 GiB)', () => {
    expect(DEFAULT_MEMORY_BUDGETS).toEqual({ gpu: 512 * MiB, media: 1024 * MiB });
    expect(createMemoryBudgets().pressure).toBe('nominal');
  });
});

describe('resource manager + memory budgets', () => {
  it('relieves caches before demoting features under pressure', async () => {
    const pressure = box<MemoryPressure>('nominal');
    const memory = createMemoryBudgets({ budgets: { gpu: 8 * MiB }, pressure });
    const order: string[] = [];
    const tiles = fakeCache(MiB);
    const r = memory.register({ id: 'render/tiles', kind: 'gpu', evict: (b) => {
      order.push('evict-cache');
      return tiles.evict(b);
    } });
    if (!r.ok) throw r.error;
    tiles.attach(r.value);
    for (let i = 0; i < 8; i++) tiles.add(i);
    const host = createFeatureHost({
      injector: createInjector(),
      features: [defineFeature({ id: 'test/heavy', weight: 'heavy', load: async () => ({ mount: () => undefined, snapshot: () => ({}) }) })],
    });
    const manager = createResourceManager({ host, pressure, memory });
    host.onTransition(({ to }) => {
      if (to === 'deactivating' || to === 'archived') order.push('demote-feature');
    });
    await host.mount('test/heavy');
    await host.unmount('test/heavy');
    pressure.set('critical');
    await manager.enforce();
    expect(order[0]).toBe('evict-cache');
    expect(order).toContain('demote-feature');
    expect(tiles.ids).toHaveLength(2);
    manager.dispose();
  });
});

describe('memoryBudgetsUnit', () => {
  it('provides the ledger per injector and disposes it with the scope', async () => {
    const injector = createInjector({ units: [nominalMemoryPressureUnit, memoryBudgetsUnitWith({ budgets: { gpu: 64 * MiB } })] });
    const memory = await injector.get(MemoryBudgetsToken);
    expect(memory.ok && memory.value.budget('gpu')).toBe(64 * MiB);
    await injector.dispose();
    expect(memoryBudgetsUnit.provides).toBe(MemoryBudgetsToken);
  });
});
