import { describe, expect, it, vi } from 'vitest';
import { createDeferred, err, ok, type Result } from '@staticflux/core';
import {
  type GateClock,
  type MeterBackend,
  QuotaExceededError,
  createMeterRegistry,
  defineMeter,
  meterFact,
  reservationMachine,
} from './index.js';
import { createMachine } from '@staticflux/core';

function manualClock(start = 0): GateClock & { advance(ms: number): void } {
  let time = start;
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => time,
    setTimer(fn, ms) {
      id += 1;
      const key = id;
      timers.set(key, { at: time + ms, fn });
      return () => timers.delete(key);
    },
    advance(ms) {
      const target = time + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        time = due[1].at;
        due[1].fn();
      }
      time = target;
    },
  };
}

const Credits = defineMeter('billing/credits', { unit: 'credits', lowThreshold: 10, reservationTtlMs: 1_000 });
const Requests = defineMeter('agent/requests', { unit: 'requests', mode: 'rate', window: { ms: 60_000 }, limit: 3 });

function registry(backend?: MeterBackend) {
  const clock = manualClock();
  const reg = createMeterRegistry({ definitions: [Credits, Requests], clock, ...(backend === undefined ? {} : { backend }) });
  const credits = reg.get(Credits);
  const requests = reg.get(Requests);
  if (!credits.ok || !requests.ok) throw new Error('meters missing');
  return { reg, clock, credits: credits.value, requests: requests.value };
}

describe('meters: optimistic view over a server-authoritative balance', () => {
  it('reserve → commit(actual) settles the optimistic balance', async () => {
    const { credits } = registry();
    expect(credits.status).toBe('unknown');
    credits.setServerState({ balance: 100 });
    const r = await credits.reserve(30);
    if (!r.ok) throw r.error;
    expect(r.value.state).toBe('reserved');
    expect(credits.held).toBe(30);
    expect(credits.available).toBe(70);
    expect((await r.value.commit(12)).ok).toBe(true);
    expect(r.value.state).toBe('committed');
    expect(credits.held).toBe(0);
    expect(credits.balance).toBe(88);
    const again = await r.value.commit(1);
    expect(!again.ok && again.error.code).toBe('SF-GATE-020');
  });

  it('release() returns the hold; expiry returns it automatically', async () => {
    const { credits, clock } = registry();
    credits.setServerState({ balance: 50 });
    const a = await credits.reserve(20);
    const b = await credits.reserve(20);
    if (!a.ok || !b.ok) throw new Error('reserve failed');
    expect(credits.available).toBe(10);
    expect(credits.status).toBe('low');
    expect((await a.value.release()).ok).toBe(true);
    expect(a.value.state).toBe('released');
    expect(credits.available).toBe(30);
    clock.advance(1_000);
    expect(b.value.state).toBe('expired');
    expect(credits.available).toBe(50);
    expect(credits.reservations).toEqual([]);
    expect((await b.value.release()).ok).toBe(false);
  });

  it('denies optimistically (quota) without calling the server', async () => {
    const backend: MeterBackend = { reserve: vi.fn(), commit: vi.fn(), release: vi.fn() } as unknown as MeterBackend;
    const { credits } = registry(backend);
    credits.setServerState({ balance: 5 });
    const r = await credits.reserve(6);
    expect(!r.ok && r.error.code).toBe('SF-GATE-003');
    expect(!r.ok && r.error.kind).toBe('quota');
    expect(backend.reserve).not.toHaveBeenCalled();
  });

  it('server denials and failures are surfaced; holds are undone', async () => {
    let answer: Result<{ reservationId: string; balance?: number }> = err(QuotaExceededError());
    const backend: MeterBackend = {
      reserve: async () => answer,
      commit: async () => ok({ balance: 1 }),
      release: async () => ok({}),
    };
    const { credits } = registry(backend);
    const denied = await credits.reserve(5);
    expect(!denied.ok && denied.error.kind).toBe('quota');
    expect(credits.held).toBe(0);
    answer = ok({ reservationId: 'srv-1', balance: 40 });
    const r = await credits.reserve(5);
    if (!r.ok) throw r.error;
    expect(r.value.id).toBe('srv-1');
    expect(credits.balance).toBe(40);
    expect(credits.available).toBe(35);
    await r.value.commit(3);
    expect(credits.balance).toBe(1); // server-authoritative balance wins over optimistic math
  });

  it('holds optimistically while estimating, and cancels on abort', async () => {
    const pending = createDeferred<Result<{ reservationId: string }>>();
    const backend: MeterBackend = { reserve: () => pending.promise, commit: async () => ok({}), release: vi.fn(async () => ok({})) };
    const { credits } = registry(backend);
    credits.setServerState({ balance: 10 });
    const controller = new AbortController();
    const reserving = credits.reserve(4, { signal: controller.signal });
    expect(credits.held).toBe(4);
    controller.abort();
    pending.resolve(ok({ reservationId: 'late' }));
    const r = await reserving;
    expect(r.ok).toBe(false);
    expect(credits.held).toBe(0);
    expect(backend.release).toHaveBeenCalled();
  });

  it('a failed commit keeps the reservation so it can be retried or released', async () => {
    let fail = true;
    const backend: MeterBackend = {
      reserve: async () => ok({ reservationId: 'r' }),
      commit: async () => (fail ? err(QuotaExceededError()) : ok({})),
      release: async () => ok({}),
    };
    const { credits } = registry(backend);
    credits.setServerState({ balance: 10 });
    const r = await credits.reserve(2);
    if (!r.ok) throw r.error;
    expect((await r.value.commit(2)).ok).toBe(false);
    expect(r.value.state).toBe('reserved');
    fail = false;
    expect((await r.value.commit(2)).ok).toBe(true);
    expect(credits.balance).toBe(8);
  });
});

describe('meters: rate windows, status and facts', () => {
  it('rate meters deny with `rate` and refill at the window boundary', async () => {
    const { requests, clock } = registry();
    requests.setServerState({ balance: 1 });
    expect(requests.resetAt).toBe(60_000);
    const first = await requests.reserve(1);
    if (!first.ok) throw first.error;
    await first.value.commit(1);
    const second = await requests.reserve(1);
    expect(!second.ok && second.error.kind).toBe('rate');
    expect(!second.ok && second.error.details['retryAt']).toBe(60_000);
    clock.advance(60_000);
    expect(requests.available).toBe(3);
    expect(requests.resetAt).toBe(120_000);
    expect((await requests.reserve(1)).ok).toBe(true);
  });

  it('status changes notify (low-balance / exhaustion surfaces)', async () => {
    const { credits } = registry();
    const statuses: string[] = [];
    const stop = credits.onStatusChange((s) => statuses.push(s));
    credits.setServerState({ balance: 100 });
    credits.setServerState({ balance: 8 });
    credits.setServerState({ balance: 0 });
    stop();
    credits.setServerState({ balance: 50 });
    expect(statuses).toEqual(['ok', 'low', 'exhausted']);
  });

  it('publishes available balances as facts', async () => {
    const { reg, credits } = registry();
    const seen: unknown[] = [];
    const disconnect = reg.connect({ set: (f, v) => seen.push([f.id, v]), batch: (fn) => fn() });
    credits.setServerState({ balance: 7 });
    expect(seen).toEqual([
      ['meter:billing/credits', undefined],
      ['meter:agent/requests', undefined],
      ['meter:billing/credits', 7],
    ]);
    disconnect();
    expect(meterFact(Credits).id).toBe('meter:billing/credits');
    expect(reg.modes.get('agent/requests')).toBe('rate');
    expect(reg.facts).toHaveLength(2);
    const unknown = reg.get(defineMeter('x/y', { unit: 'u' }));
    expect(!unknown.ok && unknown.error.code).toBe('SF-GATE-021');
    reg.dispose();
  });

  it('reservation machine follows LIFECYCLES §11', () => {
    const m = createMachine(reservationMachine);
    expect(m.state).toBe('estimating');
    expect(m.can('commit')).toBe(false);
    expect(m.send('reserve').ok).toBe(true);
    expect(m.send('expire').ok).toBe(true);
    expect(m.send('commit').ok).toBe(false);
    const d = createMachine(reservationMachine);
    expect(d.send('deny').ok).toBe(true);
    expect(d.state).toBe('denied');
  });
});
