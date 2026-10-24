import { box, createInjector, createMemorySink, createTelemetry } from '@staticflux/core';
import { describe, expect, it, vi } from 'vitest';
import {
  createFeatureHost,
  createResourceManager,
  defineFeature,
  type FeatureId,
  type FeatureManifest,
  featureRef,
  type MemoryPressure,
  type ResourceManagerOptions,
  type Timers,
} from './index.js';

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
};

function feature(id: FeatureId, extra: Partial<FeatureManifest> = {}): FeatureManifest {
  return defineFeature({ id, weight: 'warm', load: async () => ({ mount: () => undefined, snapshot: () => ({ id }) }), ...extra });
}

function fakeTimers(): Timers & { fire(): void; count(): number } {
  const pending = new Map<number, () => void>();
  let next = 0;
  return {
    set(callback) {
      next += 1;
      pending.set(next, callback);
      return next;
    },
    clear(handle) {
      pending.delete(handle as number);
    },
    fire() {
      for (const [key, callback] of [...pending]) {
        pending.delete(key);
        callback();
      }
    },
    count: () => pending.size,
  };
}

function setup(features: FeatureManifest[], options: Partial<ResourceManagerOptions> = {}) {
  let time = 0;
  const host = createFeatureHost({ injector: createInjector(), features, now: () => (time += 1) });
  const manager = createResourceManager({ host, ...options });
  return { host, manager };
}

describe('resource manager: weight policy', () => {
  it('cheap: unmount → deactivate → evict immediately', async () => {
    const { host } = setup([feature('test/settings', { weight: 'cheap' })]);
    await host.mount('test/settings');
    await host.unmount('test/settings');
    await settle();
    expect(host.stateOf('test/settings')).toBe('evicted');
  });

  it('warm: unmount keeps logic activated until the warm budget is exceeded (LRU)', async () => {
    const { host, manager } = setup([feature('test/a'), feature('test/b'), feature('test/c')], { budgets: { maxWarm: 2 } });
    for (const id of ['test/a', 'test/b', 'test/c'] as const) {
      await host.mount(id);
      await host.unmount(id);
    }
    await settle();
    expect(host.stateOf('test/a')).toBe('loaded'); // least recently used → deactivated
    expect(host.stateOf('test/b')).toBe('activated');
    expect(host.stateOf('test/c')).toBe('activated');
    expect(manager.history()).toEqual([expect.objectContaining({ id: 'test/a', action: 'deactivate', reason: 'maxWarm', ok: true })]);
  });

  it('heavy: archived under memory pressure (reactive input)', async () => {
    const pressure = box<MemoryPressure>('nominal');
    const { host, manager } = setup([feature('test/studio', { weight: 'heavy' })], { pressure });
    await host.mount('test/studio');
    await host.unmount('test/studio');
    await settle();
    expect(host.stateOf('test/studio')).toBe('activated');
    pressure.set('moderate');
    await settle();
    expect(host.stateOf('test/studio')).toBe('activated'); // maxWarm 1 under moderate still fits
    pressure.set('critical');
    await settle();
    expect(host.stateOf('test/studio')).toBe('archived');
    expect(manager.pressure).toBe('critical');
    expect(manager.budgets.maxWarm).toBe(0);
  });

  it('retention.keepAliveMs demotes after the timer; remounting cancels it', async () => {
    const timers = fakeTimers();
    const { host } = setup([feature('test/a', { retention: { keepAliveMs: 1000 } })], { timers });
    await host.mount('test/a');
    await host.unmount('test/a');
    await settle();
    expect(timers.count()).toBe(1);
    await host.mount('test/a');
    expect(timers.count()).toBe(0);
    await host.unmount('test/a');
    await settle();
    timers.fire();
    await settle();
    expect(host.stateOf('test/a')).toBe('loaded');
  });

  it('keepAliveMs: 0 demotes warm features immediately on unmount', async () => {
    const { host } = setup([feature('test/a', { retention: { keepAliveMs: 0 } })]);
    await host.mount('test/a');
    await host.unmount('test/a');
    await settle();
    expect(host.stateOf('test/a')).toBe('loaded');
  });
});

describe('resource manager: budgets', () => {
  it('never demotes features in use; framework budgets still win over priority', async () => {
    const { host } = setup(
      [
        feature('test/studio', { retention: { priority: 'high' } }),
        feature('test/chat', { requires: { features: [featureRef('test/studio')] } }),
        feature('test/sync', { headless: true }),
        feature('test/extra', { retention: { priority: 'high' } }),
      ],
      { budgets: { maxWarm: 0 } },
    );
    await host.mount('test/chat'); // studio in use via ref-count
    await host.activate('test/sync'); // explicit headless: in use
    await host.activate('test/extra'); // warm, high priority, but budget is 0
    await settle();
    expect(host.stateOf('test/studio')).toBe('activated');
    expect(host.stateOf('test/sync')).toBe('activated');
    expect(host.stateOf('test/extra')).toBe('loaded');
  });

  it('a cheap dependency is evicted when its last dependent goes away', async () => {
    const { host } = setup([
      feature('test/billing-data', { weight: 'cheap' }),
      feature('test/billing', { requires: { features: [featureRef('test/billing-data')] } }),
    ]);
    await host.mount('test/billing');
    await host.unmount('test/billing');
    await settle();
    expect(host.stateOf('test/billing-data')).toBe('activated');
    await host.deactivate('test/billing');
    await settle();
    expect(host.stateOf('test/billing-data')).toBe('evicted');
  });

  it('demotes low-priority features first, then LRU', async () => {
    const { host } = setup(
      [feature('test/a'), feature('test/b', { retention: { priority: 'low' } }), feature('test/c')],
      { budgets: { maxWarm: 1 } },
    );
    await host.activate('test/b');
    await host.activate('test/a');
    await host.activate('test/c');
    await settle();
    expect(host.stateOf('test/b')).toBe('loaded');
    expect(host.stateOf('test/a')).toBe('loaded');
    expect(host.stateOf('test/c')).toBe('activated');
  });

  it('an advisor rank hook reorders candidates but cannot change the count', async () => {
    const rank = vi.fn((candidates: readonly { id: FeatureId }[]) => [...candidates].reverse().map((c) => c.id));
    const { host } = setup([feature('test/a'), feature('test/b'), feature('test/c')], { budgets: { maxWarm: 2 }, rank });
    await host.activate('test/a');
    await host.activate('test/b');
    await host.activate('test/c');
    await settle();
    expect(rank).toHaveBeenCalled();
    const states = ['test/a', 'test/b', 'test/c'].map((id) => host.stateOf(id as FeatureId));
    expect(states.filter((s) => s === 'loaded')).toHaveLength(1);
  });

  it('caps hidden features (unmount LRU) and loaded modules (evict / archive)', async () => {
    const { host } = setup(
      [feature('test/a'), feature('test/b'), feature('test/heavy', { weight: 'heavy' }), feature('test/d')],
      { budgets: { maxHidden: 1, maxLoaded: 1, maxWarm: 5 } },
    );
    await host.mount('test/a', { hidden: true });
    await host.mount('test/b', { hidden: true });
    await settle();
    expect(host.stateOf('test/a')).toBe('activated');
    expect(host.stateOf('test/b')).toBe('hidden');
    await host.load('test/heavy');
    await host.load('test/d');
    await settle();
    expect(host.stateOf('test/heavy')).toBe('archived');
    expect(host.stateOf('test/d')).toBe('loaded');
  });

  it('maxActive demotes warm, then unmounts hidden features', async () => {
    const { host } = setup([feature('test/a'), feature('test/b'), feature('test/c')], {
      budgets: { maxActive: 1, maxWarm: 5, maxHidden: 5 },
    });
    await host.mount('test/a', { hidden: true });
    await host.activate('test/b');
    await host.mount('test/c');
    await settle();
    expect(host.stateOf('test/b')).toBe('loaded');
    expect(host.stateOf('test/a')).toBe('loaded');
    expect(host.stateOf('test/c')).toBe('mounted'); // visible UI is never touched
  });

  it('setBudgets re-enforces; telemetry records demotions; dispose stops reacting', async () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'debug' });
    telemetry.addSink(sink);
    const { host, manager } = setup([feature('test/a'), feature('test/b')], { telemetry });
    await host.activate('test/a');
    await host.activate('test/b');
    await settle();
    expect(host.stateOf('test/a')).toBe('activated');
    manager.setBudgets({ maxWarm: 1 });
    await settle();
    expect(host.stateOf('test/a')).toBe('loaded');
    expect(sink.records.some((r) => r.type === 'event' && r.name === 'resources.demote')).toBe(true);
    expect(sink.records.some((r) => r.type === 'metric' && r.metric === 'runtime/feature-demotions')).toBe(true);
    manager.dispose();
    await host.activate('test/a');
    manager.setBudgets({ maxWarm: 0 });
    await settle();
    expect(host.stateOf('test/a')).toBe('activated');
  });

  it('enforce() can be called directly and coalesces concurrent runs', async () => {
    const { host, manager } = setup([feature('test/a')], { budgets: { maxWarm: 0 } });
    manager.dispose(); // stop automatic runs; drive manually
    const fresh = createResourceManager({ host, budgets: { maxWarm: 0 } });
    await host.activate('test/a');
    const [first, second] = await Promise.all([fresh.enforce(), fresh.enforce()]);
    expect(first).toBe(second);
    await settle();
    expect(host.stateOf('test/a')).toBe('loaded');
    fresh.dispose();
  });
});
