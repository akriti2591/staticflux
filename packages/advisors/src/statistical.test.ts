import { err, ok, SfError } from '@staticflux/core';
import { describe, expect, it, vi } from 'vitest';
import {
  type AdvisorStoragePort,
  createMarkovAdvisor,
  createMarkovModel,
  createMemoryAdvisorStorage,
  defineDecisionPoint,
  MARKOV_SNAPSHOT_VERSION,
} from './index.js';

const sync = (fn: () => void): void => fn();

const Point = defineDecisionPoint({
  id: 'loader/next-route',
  purpose: 'warmup',
  options: ['home', 'studio', 'billing'] as const,
  latency: 'sync',
  heuristic: () => 'home',
});

describe('markov model', () => {
  it('learns transitions from a sequence and predicts next states', () => {
    const model = createMarkovModel({ storage: createMemoryAdvisorStorage(), key: 'k', schedule: sync });
    for (const state of ['home', 'studio', 'home', 'studio', 'home', 'billing']) model.observe(state);
    expect(model.count('home')).toBe(3);
    expect(model.predict('home')).toEqual({ studio: 2 / 3, billing: 1 / 3 });
    expect(model.predict('nowhere')).toEqual({});
    model.observe('billing'); // self-repeat is ignored
    expect(model.count('billing')).toBe(0);
  });

  it('persists coalesced snapshots and restores them', async () => {
    const storage = createMemoryAdvisorStorage();
    const scheduled: (() => void)[] = [];
    const model = createMarkovModel({ storage, key: 'k', schedule: (fn) => scheduled.push(fn) });
    model.transition('a', 'b');
    model.transition('a', 'c');
    expect(scheduled).toHaveLength(1); // coalesced
    scheduled[0]?.();
    await Promise.resolve();
    expect(storage.data.get('k')).toEqual({ version: MARKOV_SNAPSHOT_VERSION, transitions: { a: { b: 1, c: 1 } }, last: undefined });

    const restored = createMarkovModel({ storage, key: 'k', schedule: sync });
    expect(await restored.load()).toEqual(ok());
    expect(restored.predict('a')).toEqual({ b: 0.5, c: 0.5 });
  });

  it('bounds states and transitions, and applies decay', () => {
    const model = createMarkovModel({ storage: createMemoryAdvisorStorage(), key: 'k', maxStates: 2, maxTransitions: 2, decay: 0.5, schedule: () => undefined });
    model.transition('s1', 'x');
    model.transition('s2', 'x');
    model.transition('s3', 'x');
    expect(Object.keys(model.snapshot().transitions)).toEqual(['s2', 's3']);
    model.transition('s3', 'y'); // x decays to 0.5, y = 1
    model.transition('s3', 'z'); // x 0.25, y 0.5, z 1 → drop x
    expect(model.snapshot().transitions['s3']).toEqual({ y: 0.5, z: 1 });
  });

  it('resets on corrupt history and reports storage failures', async () => {
    const onError = vi.fn();
    const corrupt = createMarkovModel({
      storage: createMemoryAdvisorStorage({ k: { version: 99, transitions: {} } }),
      key: 'k',
      onError,
      schedule: sync,
    });
    expect(await corrupt.load()).toMatchObject({ ok: false, error: { code: 'SF-ADV-005' } });
    const bad = createMarkovModel({ storage: createMemoryAdvisorStorage({ k: { version: 1, transitions: { a: { b: -1 } } } }), key: 'k', schedule: sync });
    expect((await bad.load()).ok).toBe(false);

    const failing: AdvisorStoragePort = {
      get: async () => err(new SfError({ code: 'SF-X-1', kind: 'unavailable', message: 'x' })),
      set: async () => {
        throw new Error('quota');
      },
      delete: async () => ok(),
    };
    const model = createMarkovModel({ storage: failing, key: 'k', onError, schedule: sync });
    expect(await model.load()).toMatchObject({ ok: false, error: { code: 'SF-ADV-004' } });
    expect(await model.flush()).toMatchObject({ ok: false, error: { code: 'SF-ADV-004' } });
    expect(onError).toHaveBeenCalledTimes(3);
    expect(await createMarkovModel({ storage: createMemoryAdvisorStorage(), key: 'none' }).load()).toEqual(ok());
  });

  it('reset forgets everything', () => {
    const model = createMarkovModel({ storage: createMemoryAdvisorStorage(), key: 'k', schedule: () => undefined });
    model.observe('a');
    model.observe('b');
    model.reset();
    expect(model.snapshot()).toEqual({ version: 1, transitions: {}, last: undefined });
  });
});

describe('markov advisor', () => {
  it('needs minimum observations, then answers restricted to the options', async () => {
    const model = createMarkovModel({ storage: createMemoryAdvisorStorage(), key: 'k', schedule: () => undefined });
    const advisor = createMarkovAdvisor(Point, { id: 'next-route', model, from: (q: { route: string }) => q.route, minObservations: 2 });
    const ctx = { signal: new AbortController().signal };
    expect(advisor.tier).toBe('statistical');
    expect(advisor.latency).toBe('sync');
    expect(advisor.supports(Point)).toBe(true);
    expect(advisor.advise(Point, { route: 'home' }, ctx)).toMatchObject({ ok: false, error: { code: 'SF-ADV-003' } });
    model.transition('home', 'studio');
    model.transition('home', 'studio');
    const answer = await advisor.advise(Point, { route: 'home' }, ctx);
    expect(answer).toMatchObject({ ok: true, value: { distribution: { studio: 1 }, confidence: 0.5 } });
  });
});
