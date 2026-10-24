import { createMachine, createMemorySink, createScope, createTelemetry, defineError, err, ok } from '@staticflux/core';
import { describe, expect, it, vi } from 'vitest';
import {
  type Advisor,
  type AdvisorEnvironment,
  type AdvisorServiceOptions,
  advisorFor,
  consultationMachine,
  createAdvisorService,
  defineDecisionPoint,
} from './index.js';

const options = ['studio', 'chat', 'billing', 'none'] as const;
type Q = { from: string };

const SyncPoint = defineDecisionPoint({
  id: 'loader/next-feature',
  purpose: 'warmup',
  options,
  latency: 'sync',
  heuristic: (q: Q) => (q.from === 'studio' ? 'chat' : 'none'),
});
const BgPoint = defineDecisionPoint({
  id: 'loader/next-feature-bg',
  purpose: 'warmup',
  options,
  latency: 'background',
  budgetMs: 30,
  heuristic: (q: Q) => (q.from === 'studio' ? 'chat' : 'none'),
  constrain: (option) => option !== 'billing' || true,
});
const IdlePoint = defineDecisionPoint({
  id: 'data/prefetch',
  purpose: 'prefetch',
  options,
  latency: 'idle',
  budgetMs: 30,
  heuristic: () => 'none',
});

const answer = (dist: Partial<Record<(typeof options)[number], number>>, confidence?: number) =>
  ok({ distribution: dist, ...(confidence === undefined ? {} : { confidence }) });

function syncAdvisor(dist: Partial<Record<(typeof options)[number], number>>, id = 'stat', confidence?: number): Advisor {
  return advisorFor(SyncPoint, { id, tier: 'statistical', latency: 'sync', advise: () => answer(dist, confidence) });
}

function make(extra: AdvisorServiceOptions = {}) {
  const sink = createMemorySink();
  const telemetry = createTelemetry({ defaultLevel: 'debug' });
  telemetry.addSink(sink);
  let time = 0;
  const service = createAdvisorService({ telemetry, now: () => time, idle: () => Promise.resolve(), ...extra });
  return { service, sink, advance: (ms: number) => (time += ms) };
}

const metricsNamed = (sink: ReturnType<typeof createMemorySink>, id: string) =>
  sink.records.filter((r) => r.type === 'metric' && r.metric === id);

describe('advisor service: sync points', () => {
  it('uses the deterministic default when no advisor exists', () => {
    const { service } = make();
    const advice = service.decide(SyncPoint, { from: 'studio' });
    expect(advice).toMatchObject({
      choice: 'chat',
      defaultChoice: 'chat',
      advisor: 'default',
      tier: 'heuristic',
      source: 'default',
      fallback: 'no-advisor',
      overridden: false,
      confidence: 1,
    });
  });

  it('a statistical advisor overrides the default; the trace records it', () => {
    const { service, sink } = make({ advisors: [syncAdvisor({ studio: 3, chat: 1 })] });
    const advice = service.decide(SyncPoint, { from: 'home' });
    expect(advice).toMatchObject({ choice: 'studio', defaultChoice: 'none', overridden: true, advisor: 'stat', source: 'advisor', confidence: 0.75 });
    expect(advice.distribution).toEqual({ studio: 0.75, chat: 0.25, billing: 0, none: 0 });
    expect(service.traces()).toEqual([
      expect.objectContaining({ id: advice.traceId, advisor: 'stat', overridden: true, defaultChoice: 'none', choice: 'studio' }),
    ]);
    expect(metricsNamed(sink, 'advisors/overrides')).toHaveLength(1);
  });

  it('prefers higher tiers and falls through failures, invalid answers and low confidence', () => {
    const Fail = defineError('SF-TESTADV-010', 'unavailable', 'x', 'y');
    const throwing: Advisor = { ...syncAdvisor({}), id: 'throws', advise: () => { throw new Error('x'); } };
    const failing = advisorFor(SyncPoint, { id: 'fail', tier: 'model', latency: 'sync', advise: () => err(Fail()) });
    const asyncOnly: Advisor = { ...syncAdvisor({ billing: 1 }, 'async'), tier: 'model', advise: () => Promise.resolve(answer({ billing: 1 })) };
    const invalid = syncAdvisor({ none: 0 }, 'invalid');
    const lowConfidence = syncAdvisor({ billing: 1 }, 'low', 0.1);
    const good = syncAdvisor({ chat: 1 }, 'good');
    const point = defineDecisionPoint({ ...SyncPoint, id: 'loader/strict', minConfidence: 0.5 });
    const supportsAll = (a: Advisor): Advisor => ({ ...a, supports: () => true });
    const { service } = make({ advisors: [throwing, invalid, lowConfidence, good, failing, asyncOnly].map(supportsAll) });
    expect(service.decide(point, { from: 'x' })).toMatchObject({ advisor: 'good', choice: 'chat' });
    const onlyBad = make({ advisors: [invalid, lowConfidence].map(supportsAll) }).service;
    expect(onlyBad.decide(point, { from: 'x' })).toMatchObject({ source: 'default', fallback: 'low-confidence', choice: 'none' });
  });

  it('clamps with point and call constraints; clamped-away answers fall back', () => {
    const point = defineDecisionPoint({ ...SyncPoint, id: 'loader/clamped', constrain: (o) => o !== 'billing' });
    const { service } = make({ advisors: [{ ...syncAdvisor({ billing: 0.9, studio: 0.1 }), supports: () => true }] });
    expect(service.decide(point, { from: 'x' })).toMatchObject({ choice: 'studio', advisor: 'stat' });
    const advice = service.decide(point, { from: 'x' }, { constrain: (o) => o === 'billing' || o === 'none' });
    expect(advice).toMatchObject({ fallback: 'clamped', choice: 'none', source: 'default' });
    const nothing = service.decide(point, { from: 'x' }, { constrain: () => false });
    expect(nothing.choice).toBeUndefined();
    expect(nothing.defaultChoice).toBeUndefined();
  });
});

describe('advisor service: background and idle points', () => {
  it('decide() never blocks: default now, cached answer later, cached until the input facts change', async () => {
    const advise = vi.fn(async () => answer({ studio: 1 }, 0.8));
    const model = advisorFor(BgPoint, { id: 'jev', tier: 'model', latency: 'background', advise });
    const { service } = make({ advisors: [model] });
    const first = service.decide(BgPoint, { from: 'home' });
    expect(first).toMatchObject({ source: 'default', fallback: 'pending', choice: 'none' });
    await vi.waitFor(() => expect(service.decide(BgPoint, { from: 'home' }).source).toBe('cache'));
    expect(service.decide(BgPoint, { from: 'home' })).toMatchObject({ choice: 'studio', advisor: 'jev', confidence: 0.8 });
    expect(advise).toHaveBeenCalledTimes(1);
    // new input facts → new consultation
    expect(service.decide(BgPoint, { from: 'studio' }).fallback).toBe('pending');
    await vi.waitFor(() => expect(advise).toHaveBeenCalledTimes(2));
    service.invalidate(BgPoint.id);
    expect(service.decide(BgPoint, { from: 'home' }).fallback).toBe('pending');
  });

  it('ask() single-flights, time-boxes to the default and remembers failures for a while', async () => {
    let resolveSlow: (() => void) | undefined;
    const advise = vi.fn(
      (_q: Q, ctx: { signal: AbortSignal }) =>
        new Promise<ReturnType<typeof answer>>((resolve) => {
          resolveSlow = () => resolve(answer({ studio: 1 }));
          ctx.signal.addEventListener('abort', () => resolve(answer({ billing: 1 })), { once: true });
        }),
    );
    const slow = advisorFor(BgPoint, { id: 'slow', tier: 'remote', latency: 'background', advise });
    const { service, advance, sink } = make({ advisors: [slow], environment: () => ({ lowEndDevice: false, saveData: false, allowRemote: true }), retryAfterMs: 1000 });
    const [a, b] = await Promise.all([service.ask(BgPoint, { from: 'studio' }), service.ask(BgPoint, { from: 'studio' })]);
    expect(advise).toHaveBeenCalledTimes(1);
    expect(a).toMatchObject({ fallback: 'timeout', choice: 'chat', source: 'default' });
    expect(b.fallback).toBe('timeout');
    expect(resolveSlow).toBeDefined();
    // negative cache: no new consultation until retryAfter
    expect((await service.ask(BgPoint, { from: 'studio' })).fallback).toBe('timeout');
    expect(advise).toHaveBeenCalledTimes(1);
    advance(1000);
    void service.ask(BgPoint, { from: 'studio' });
    expect(advise).toHaveBeenCalledTimes(2);
    expect(metricsNamed(sink, 'advisors/fallbacks').length).toBeGreaterThan(0);
    expect(sink.records.some((r) => r.type === 'span' && r.name === 'advisor.consult')).toBe(true);
  });

  it('idle points wait for an idle slot first', async () => {
    const order: string[] = [];
    const idleAdvisor = advisorFor(IdlePoint, {
      id: 'idle-stat',
      tier: 'statistical',
      latency: 'idle',
      advise: async () => {
        order.push('advise');
        return answer({ billing: 1 });
      },
    });
    const { service } = make({
      advisors: [idleAdvisor],
      idle: async () => {
        order.push('idle');
      },
    });
    expect(await service.ask(IdlePoint, { from: 'x' })).toMatchObject({ choice: 'billing', source: 'advisor' });
    expect(order).toEqual(['idle', 'advise']);
    expect(await service.ask(IdlePoint, { from: 'x' })).toMatchObject({ source: 'cache' });
  });

  it('caller abort returns the default without cancelling the shared consultation', async () => {
    let finish: (() => void) | undefined;
    const advisor = advisorFor(BgPoint, {
      id: 'm',
      tier: 'model',
      latency: 'background',
      advise: () => new Promise((resolve) => (finish = () => resolve(answer({ studio: 1 })))),
    });
    const { service } = make({ advisors: [advisor] });
    const controller = new AbortController();
    const pending = service.ask(BgPoint, { from: 'x' }, { signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ fallback: 'cancelled', source: 'default' });
    await vi.waitFor(() => expect(finish).toBeDefined());
    finish?.();
    await vi.waitFor(() => expect(service.decide(BgPoint, { from: 'x' }).source).toBe('cache'));
    const pre = new AbortController();
    pre.abort();
    expect((await service.ask(BgPoint, { from: 'y' }, { signal: pre.signal })).fallback).toBe('cancelled');
  });

  it('ask() on a sync point answers synchronously-computed advice', async () => {
    const { service } = make({ advisors: [syncAdvisor({ billing: 1 })] });
    expect(await service.ask(SyncPoint, { from: 'x' })).toMatchObject({ choice: 'billing', source: 'advisor' });
  });
});

describe('advisor service: environment (downgrade, privacy)', () => {
  const model = advisorFor(SyncPoint, { id: 'model', tier: 'model', latency: 'sync', advise: () => answer({ billing: 1 }) });
  const remote = advisorFor(SyncPoint, { id: 'remote', tier: 'remote', latency: 'sync', advise: () => answer({ studio: 1 }) });
  const stat = syncAdvisor({ chat: 1 });

  it('remote advisors are off unless explicitly allowed', () => {
    let env: AdvisorEnvironment = { lowEndDevice: false, saveData: false };
    const { service } = make({ advisors: [remote, model, stat], environment: () => env });
    expect(service.decide(SyncPoint, { from: 'x' }).advisor).toBe('model');
    env = { ...env, allowRemote: true };
    expect(service.decide(SyncPoint, { from: 'x' }).advisor).toBe('remote');
  });

  it('auto-downgrades to heuristic + statistical on low-end / save-data / battery / slow network', () => {
    for (const env of [
      { lowEndDevice: true, saveData: false },
      { lowEndDevice: false, saveData: true },
      { lowEndDevice: false, saveData: false, batterySaver: true },
      { lowEndDevice: false, saveData: false, slowNetwork: true, allowRemote: true },
    ]) {
      const { service } = make({ advisors: [remote, model, stat], environment: () => env });
      expect(service.decide(SyncPoint, { from: 'x' }).advisor).toBe('stat');
      const onlyModels = make({ advisors: [model, remote], environment: () => env }).service;
      expect(onlyModels.decide(SyncPoint, { from: 'x' })).toMatchObject({ fallback: 'downgraded', advisor: 'default' });
    }
  });
});

describe('advisor service: outcomes, plugins, lifecycle', () => {
  it('tracks hit rate and wasted bytes per point', () => {
    const { service, sink } = make({ advisors: [syncAdvisor({ studio: 1 })] });
    const a = service.decide(SyncPoint, { from: 'x' });
    const b = service.decide(SyncPoint, { from: 'x' });
    service.recordOutcome(a, { hit: true });
    service.recordOutcome(b, { hit: false, wastedBytes: 2048 });
    expect(service.stats(SyncPoint.id)).toEqual({
      decisions: 2,
      advised: 2,
      overridden: 2,
      fallbacks: {},
      hits: 1,
      misses: 1,
      hitRate: 0.5,
      wastedBytes: 2048,
    });
    expect(service.traces()[0]?.outcome).toEqual({ hit: true });
    expect(metricsNamed(sink, 'advisors/wasted-bytes')).toHaveLength(1);
    expect(service.stats('nothing/here').hitRate).toBeUndefined();
  });

  it('bounds the trace buffer', () => {
    const { service } = make({ traceLimit: 3 });
    for (let i = 0; i < 5; i += 1) service.decide(SyncPoint, { from: 'x' });
    expect(service.traces().map((t) => t.id)).toEqual(['adv-3', 'adv-4', 'adv-5']);
    service.recordOutcome(service.decide(SyncPoint, { from: 'x' }), { hit: true });
  });

  it('advisors can be added for a scope', async () => {
    const { service } = make();
    const scope = createScope('feature');
    service.addAdvisor(syncAdvisor({ billing: 1 }), scope);
    expect(service.decide(SyncPoint, { from: 'x' }).advisor).toBe('stat');
    await scope.dispose();
    expect(service.decide(SyncPoint, { from: 'x' }).advisor).toBe('default');
    const remove = service.addAdvisor(syncAdvisor({ billing: 1 }));
    remove();
    remove();
    expect(service.decide(SyncPoint, { from: 'x' }).advisor).toBe('default');
  });

  it('dispose cancels consultations; later asks return defaults', async () => {
    const advisor = advisorFor(BgPoint, { id: 'm', tier: 'model', latency: 'background', advise: () => new Promise(() => undefined) });
    const { service } = make({ advisors: [advisor] });
    const pending = service.ask(BgPoint, { from: 'x' });
    await service.dispose();
    expect((await pending).source).toBe('default');
    expect((await service.ask(BgPoint, { from: 'x' })).source).toBe('default');
  });

  it('consultation machine allows only documented transitions', () => {
    const machine = createMachine(consultationMachine);
    expect(machine.send('answer').ok).toBe(false);
    expect(machine.send('wait').ok).toBe(true);
    expect(machine.send('consult').ok).toBe(true);
    expect(machine.send('fallback')).toEqual(ok('defaulted'));
    expect(machine.can('consult')).toBe(false);
  });
});
