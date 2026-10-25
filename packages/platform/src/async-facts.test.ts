import { createScope, TaskTimeoutError, watch } from '@staticflux/core';
import { describe, expect, it, vi } from 'vitest';
import {
  type AsyncFactState,
  asyncFactMachine,
  createAsyncFactLane,
  createFakePlatformEnv,
  DEFAULT_ASYNC_FACT_TIMEOUT_MS,
  defineAsyncFact,
  idleSchedule,
} from './index.js';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const env = createFakePlatformEnv();
/** Collects scheduled tasks so tests decide when "idle" happens. */
function manualSchedule(): { schedule: (task: () => void) => void; flush: () => void; readonly size: number } {
  const tasks: (() => void)[] = [];
  return {
    schedule: (task) => {
      tasks.push(task);
    },
    flush: () => {
      for (const task of tasks.splice(0)) task();
    },
    get size() {
      return tasks.length;
    },
  };
}

describe('defineAsyncFact', () => {
  it('freezes the definition with a default timeout', () => {
    const fact = defineAsyncFact({ id: 'test/answer', probe: async () => 42 });
    expect(fact).toMatchObject({ kind: 'async-fact', id: 'test/answer', timeoutMs: DEFAULT_ASYNC_FACT_TIMEOUT_MS });
    expect(Object.isFrozen(fact)).toBe(true);
    expect(defineAsyncFact({ id: 'test/fast', timeoutMs: 10, probe: async () => 1 }).timeoutMs).toBe(10);
  });

  it('machine allows cancel back to idle and refresh from settled/failed', () => {
    expect(asyncFactMachine.transitions.probing).toMatchObject({ cancel: 'idle', settle: 'settled', fail: 'failed' });
    expect(asyncFactMachine.transitions.settled).toMatchObject({ probe: 'probing' });
  });
});

describe('async fact lane', () => {
  it('probes once, caches the settled value and refreshes on demand', async () => {
    let calls = 0;
    const fact = defineAsyncFact({ id: 'test/count', probe: async () => ++calls });
    const lane = createAsyncFactLane({ env, scope: createScope('test'), facts: [fact] });
    expect(lane.read(fact)).toEqual({ state: 'idle', value: undefined, error: undefined });
    expect(await lane.probe(fact)).toEqual({ ok: true, value: 1 });
    expect(await lane.probe(fact)).toEqual({ ok: true, value: 1 });
    expect(calls).toBe(1);
    expect(lane.read(fact)).toEqual({ state: 'settled', value: 1, error: undefined });
    expect(await lane.probe(fact, { refresh: true })).toEqual({ ok: true, value: 2 });
    expect(lane.snapshot()).toEqual({ 'test/count': { state: 'settled', value: 2, error: undefined } });
  });

  it('single-flights concurrent probes', async () => {
    const gate = deferred<string>();
    const probe = vi.fn(() => gate.promise);
    const fact = defineAsyncFact({ id: 'test/slow', probe });
    const lane = createAsyncFactLane({ env, scope: createScope('test') });
    const a = lane.probe(fact);
    const b = lane.probe(fact);
    expect(lane.read(fact).state).toBe('probing');
    gate.resolve('done');
    expect(await Promise.all([a, b])).toEqual([
      { ok: true, value: 'done' },
      { ok: true, value: 'done' },
    ]);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('a throwing probe fails the fact with SF-PLAT-009 (cached until refresh)', async () => {
    const fact = defineAsyncFact({
      id: 'test/throws',
      probe: async () => {
        throw new Error('driver crashed');
      },
    });
    const lane = createAsyncFactLane({ env, scope: createScope('test') });
    const result = await lane.probe(fact);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SF-PLAT-009');
      expect(result.error.details).toMatchObject({ fact: 'test/throws' });
    }
    expect(lane.read(fact).state).toBe('failed');
    expect(lane.read(fact).error?.code).toBe('SF-PLAT-009');
    const again = await lane.probe(fact);
    expect(again.ok).toBe(false);
  });

  it('a probe that never answers times out as failed', async () => {
    const fact = defineAsyncFact({ id: 'test/hangs', timeoutMs: 5, probe: () => new Promise<never>(() => {}) });
    const lane = createAsyncFactLane({ env, scope: createScope('test') });
    const result = await lane.probe(fact);
    expect(result.ok).toBe(false);
    expect(lane.read(fact).state).toBe('failed');
    expect(lane.read(fact).error?.details).toMatchObject({ code: TaskTimeoutError.code });
  });

  it('one aborting caller does not cancel the probe for the others', async () => {
    const gate = deferred<number>();
    const fact = defineAsyncFact({ id: 'test/shared', probe: () => gate.promise });
    const lane = createAsyncFactLane({ env, scope: createScope('test') });
    const controller = new AbortController();
    const quitter = lane.probe(fact, { signal: controller.signal });
    const stayer = lane.probe(fact);
    controller.abort();
    expect((await quitter).ok).toBe(false);
    expect(lane.read(fact).state).toBe('probing');
    gate.resolve(7);
    expect(await stayer).toEqual({ ok: true, value: 7 });
    expect(lane.read(fact).state).toBe('settled');
  });

  it('when every caller aborts the probe is cancelled back to idle and can run again', async () => {
    let calls = 0;
    const fact = defineAsyncFact({
      id: 'test/abortable',
      probe: (_env, signal) =>
        new Promise<number>((resolve, reject) => {
          calls += 1;
          if (calls > 1) resolve(calls);
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    });
    const lane = createAsyncFactLane({ env, scope: createScope('test') });
    const controller = new AbortController();
    const first = lane.probe(fact, { signal: controller.signal });
    controller.abort();
    const aborted = await first;
    expect(aborted.ok).toBe(false);
    if (!aborted.ok) expect(aborted.error.kind).toBe('aborted');
    await vi.waitFor(() => expect(lane.read(fact).state).toBe('idle'));
    expect(await lane.probe(fact)).toEqual({ ok: true, value: 2 });
  });

  it('a new caller right after everyone aborted gets a fresh probe, not the dying one', async () => {
    let calls = 0;
    const fact = defineAsyncFact({
      id: 'test/unwinding',
      probe: async (_env, signal) => {
        calls += 1;
        await Promise.resolve();
        if (signal.aborted) throw signal.reason;
        return calls;
      },
    });
    const lane = createAsyncFactLane({ env, scope: createScope('test') });
    const controller = new AbortController();
    const first = lane.probe(fact, { signal: controller.signal });
    controller.abort();
    const second = lane.probe(fact);
    expect((await first).ok).toBe(false);
    expect(await second).toEqual({ ok: true, value: 2 });
    expect(lane.read(fact).state).toBe('settled');
  });

  it('an already aborted signal returns at once', async () => {
    const fact = defineAsyncFact({ id: 'test/pre-aborted', probe: async () => 1 });
    const lane = createAsyncFactLane({ env, scope: createScope('test') });
    const result = await lane.probe(fact, { signal: AbortSignal.abort() });
    expect(result.ok).toBe(false);
  });

  it('start() schedules declared idle facts and returns before any probe runs', async () => {
    const probe = vi.fn(async () => 'ok');
    const fact = defineAsyncFact({ id: 'test/scheduled', probe });
    const settledFact = defineAsyncFact({ id: 'test/already', probe: async () => 'x' });
    const idle = manualSchedule();
    const lane = createAsyncFactLane({ env, scope: createScope('test'), facts: [fact, settledFact], schedule: idle.schedule });
    await lane.probe(settledFact);
    lane.start();
    expect(idle.size).toBe(1);
    expect(probe).not.toHaveBeenCalled();
    expect(lane.read(fact).state).toBe('idle');
    idle.flush();
    expect(lane.read(fact).state).toBe('probing');
    await vi.waitFor(() => expect(lane.read(fact).state).toBe('settled'));
    lane.start();
    expect(idle.size).toBe(0);
    expect(lane.facts).toEqual([fact, settledFact]);
  });

  it('readings are reactive', async () => {
    const fact = defineAsyncFact({ id: 'test/reactive', probe: async () => true });
    const scope = createScope('test');
    const lane = createAsyncFactLane({ env, scope });
    const seen: AsyncFactState[] = [];
    watch(
      () => lane.read(fact).state,
      (state) => seen.push(state),
      { scope },
    );
    await lane.probe(fact);
    expect(seen).toEqual(['probing', 'settled']);
  });

  it('disposing the scope aborts running probes, freezes readings and refuses new probes', async () => {
    const fact = defineAsyncFact({
      id: 'test/dispose',
      probe: (_env, signal) => new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    });
    const late = defineAsyncFact({ id: 'test/late', probe: async () => 1 });
    const scheduled = defineAsyncFact({ id: 'test/scheduled-late', probe: vi.fn(async () => 1) });
    const idle = manualSchedule();
    const scope = createScope('test');
    const lane = createAsyncFactLane({ env, scope, facts: [scheduled], schedule: idle.schedule });
    lane.start();
    const running = lane.probe(fact);
    await scope.dispose();
    expect((await running).ok).toBe(false);
    expect(lane.read(fact).state).toBe('disposed');
    expect(lane.read(late).state).toBe('disposed');
    const refused = await lane.probe(late);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('SF-PLAT-009');
    idle.flush();
    expect(scheduled.probe).not.toHaveBeenCalled();
  });
});

describe('idleSchedule', () => {
  it('prefers requestIdleCallback with a timeout', () => {
    const requestIdleCallback = vi.fn((cb: () => void) => cb());
    const task = vi.fn();
    idleSchedule(createFakePlatformEnv({ globals: { requestIdleCallback } }))(task);
    expect(requestIdleCallback).toHaveBeenCalledWith(task, { timeout: 1000 });
    expect(task).toHaveBeenCalled();
  });

  it('falls back to setTimeout, then a microtask', async () => {
    const setTimeout = vi.fn((cb: () => void) => cb());
    const task = vi.fn();
    idleSchedule(createFakePlatformEnv({ globals: { setTimeout } }))(task);
    expect(setTimeout).toHaveBeenCalledWith(task, 0);
    const micro = vi.fn();
    idleSchedule(createFakePlatformEnv())(micro);
    expect(micro).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(micro).toHaveBeenCalled();
  });
});
