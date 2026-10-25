import { createInjector, createMemorySink, createTelemetry, unwrap } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import {
  createLongTaskDetector,
  createWorkerScheduler,
  type Priority,
  WorkerSchedulerDisposedError,
  WorkerSchedulerMetrics,
  WorkerSchedulerToken,
  workerSchedulerUnit,
} from './worker.js';

/** Deterministic worker environment: macrotasks run only when the test says so; time moves by hand. */
function fakeEnv() {
  let time = 0;
  const tasks: { cb: () => void; priority: Priority }[] = [];
  let yields = 0;
  return {
    tasks,
    get yields() {
      return yields;
    },
    advance(ms: number) {
      time += ms;
    },
    env: {
      now: () => time,
      macrotask: (cb: () => void, priority: Priority) => void tasks.push({ cb, priority }),
      yield: () => {
        yields += 1;
        return Promise.resolve();
      },
    },
    runTasks() {
      while (tasks.length > 0) tasks.shift()?.cb();
    },
  };
}

const flushPromises = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('worker scheduler: priorities and slices', () => {
  it('runs interaction → critical → visible → idle regardless of posting order', async () => {
    const fake = fakeEnv();
    const scheduler = createWorkerScheduler(fake.env);
    const order: string[] = [];
    const posted = (['idle', 'visible', 'critical', 'interaction'] as const).map((priority) =>
      scheduler.postTask(() => order.push(priority), { priority }),
    );
    expect(scheduler.pending).toBe(4);
    expect(fake.tasks.map((t) => t.priority)).toEqual(['idle']); // one loop scheduled, at the top priority when posted
    fake.runTasks();
    await Promise.all(posted);
    expect(order).toEqual(['interaction', 'critical', 'visible', 'idle']);
    expect(scheduler.pending).toBe(0);
  });

  it('yields to the event loop when a slice is used up', () => {
    const fake = fakeEnv();
    const scheduler = createWorkerScheduler({ ...fake.env, sliceMs: 5 });
    const ran: number[] = [];
    for (let i = 0; i < 4; i++) {
      void scheduler.postTask(() => {
        ran.push(i);
        fake.advance(3);
      });
    }
    fake.tasks.shift()?.cb();
    expect(ran).toEqual([0, 1]); // 6 ms ≥ 5 ms slice: the rest waits for the next macrotask
    expect(fake.tasks).toHaveLength(1);
    fake.runTasks();
    expect(ran).toEqual([0, 1, 2, 3]);
  });

  it('shouldYield: slice used up, or interaction work waiting behind other work', async () => {
    const fake = fakeEnv();
    const scheduler = createWorkerScheduler({ ...fake.env, sliceMs: 5 });
    const seen: boolean[] = [];
    void scheduler.postTask(
      () => {
        seen.push(scheduler.shouldYield());
        void scheduler.postTask(() => undefined, { priority: 'interaction' });
        seen.push(scheduler.shouldYield());
        expect(scheduler.running).toBe('idle');
      },
      { priority: 'idle' },
    );
    fake.runTasks();
    expect(seen).toEqual([false, true]);
    fake.advance(6);
    expect(scheduler.shouldYield()).toBe(true);
    const result = await scheduler.yield();
    expect(result.ok && fake.yields).toBe(1);
    expect(scheduler.shouldYield()).toBe(false); // a yield starts a new slice
  });

  it('resolves values, async values and errors as Results', async () => {
    const fake = fakeEnv();
    const scheduler = createWorkerScheduler(fake.env);
    const sync = scheduler.postTask(() => 21 * 2);
    const async = scheduler.postTask(async () => 'later');
    const thrown = scheduler.postTask(() => {
      throw new Error('bad');
    });
    const rejected = scheduler.postTask(() => Promise.reject(new Error('worse')));
    fake.runTasks();
    expect(await sync).toEqual({ ok: true, value: 42 });
    expect(await async).toEqual({ ok: true, value: 'later' });
    const t = await thrown;
    expect(!t.ok && t.error.message).toBe('bad');
    const r = await rejected;
    expect(!r.ok && r.error.message).toBe('worse');
  });
});

describe('worker scheduler: cancellation, pause and dispose', () => {
  it('aborts queued tasks and refuses pre-aborted ones', async () => {
    const fake = fakeEnv();
    const scheduler = createWorkerScheduler(fake.env);
    const controller = new AbortController();
    const queued = scheduler.postTask(() => 'never', { signal: controller.signal });
    controller.abort();
    const result = await queued;
    expect(!result.ok && result.error.kind).toBe('aborted');
    expect(scheduler.pending).toBe(0);
    const pre = await scheduler.postTask(() => 1, { signal: controller.signal });
    expect(!pre.ok && pre.error.kind).toBe('aborted');
    const yielded = await scheduler.yield(controller.signal);
    expect(!yielded.ok && yielded.error.kind).toBe('aborted');
  });

  it('nothing runs while paused (I-1); yield waits for resume', async () => {
    const fake = fakeEnv();
    const scheduler = createWorkerScheduler(fake.env);
    scheduler.pause();
    expect(scheduler.paused).toBe(true);
    const ran: string[] = [];
    void scheduler.postTask(() => ran.push('task'));
    expect(fake.tasks).toHaveLength(0);
    let resumed = false;
    void scheduler.yield().then(() => {
      resumed = true;
    });
    await flushPromises();
    expect(resumed).toBe(false);
    expect(scheduler.shouldYield()).toBe(true);
    scheduler.resume();
    await flushPromises();
    expect(resumed).toBe(true);
    fake.runTasks();
    expect(ran).toEqual(['task']);
    scheduler.pause();
    const controller = new AbortController();
    const waiting = scheduler.yield(controller.signal);
    await flushPromises();
    controller.abort();
    expect((await waiting).ok).toBe(false);
  });

  it('dispose cancels queued tasks with SF-SCHED-002 and refuses new work', async () => {
    const fake = fakeEnv();
    const scheduler = createWorkerScheduler(fake.env);
    const queued = scheduler.postTask(() => 1);
    scheduler.pause();
    const waiting = scheduler.yield();
    scheduler.dispose();
    scheduler.dispose();
    expect(scheduler.disposed).toBe(true);
    const cancelled = await queued;
    expect(!cancelled.ok && cancelled.error.code).toBe(WorkerSchedulerDisposedError.code);
    const woken = await waiting;
    expect(!woken.ok && woken.error.code).toBe(WorkerSchedulerDisposedError.code);
    const late = await scheduler.postTask(() => 2);
    expect(!late.ok && late.error.code).toBe(WorkerSchedulerDisposedError.code);
    const yielded = await scheduler.yield();
    expect(!yielded.ok && yielded.error.code).toBe(WorkerSchedulerDisposedError.code);
    scheduler.resume(); // no-op after dispose
  });

  it('runs on the default MessageChannel fallback (no scheduler.postTask in Node)', async () => {
    const scheduler = createWorkerScheduler();
    expect(await scheduler.postTask(() => 'via macrotask', { priority: 'critical' })).toEqual({ ok: true, value: 'via macrotask' });
    expect((await scheduler.yield()).ok).toBe(true);
    scheduler.dispose();
  });
});

describe('long-task detector', () => {
  it('reports scheduled tasks over the threshold with their name (metric, event, listener)', () => {
    const fake = fakeEnv();
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'debug', now: fake.env.now });
    telemetry.addSink(sink);
    const scheduler = createWorkerScheduler({ ...fake.env, telemetry });
    const seen: string[] = [];
    scheduler.longTasks.onLongTask((task) => seen.push(`${task.name}:${task.duration}:${task.source}`));
    void scheduler.postTask(() => fake.advance(80), { name: 'crdt-merge', priority: 'idle' });
    void scheduler.postTask(() => fake.advance(10));
    fake.runTasks();
    expect(seen).toEqual(['crdt-merge:80:task']);
    expect(scheduler.longTasks.stats).toEqual({ count: 1, longestMs: 80, totalMs: 80 });
    const metrics = sink.records.filter((r) => r.type === 'metric' && r.metric === WorkerSchedulerMetrics.longTask.id);
    expect(metrics).toHaveLength(1);
    expect(sink.records.some((r) => r.type === 'event' && r.name === 'worker.long-task')).toBe(true);
  });

  it('measures and records work outside the scheduler; keeps the recent ones', () => {
    let time = 0;
    const detector = createLongTaskDetector({ now: () => time, thresholdMs: 10, keep: 2 });
    expect(detector.measure('short', () => ((time += 5), 'value'))).toBe('value');
    expect(() =>
      detector.measure('throws', () => {
        time += 20;
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(detector.record('wasm:raster', 100, 140)).toMatchObject({ name: 'wasm:raster', duration: 40 });
    expect(detector.record('fast', 0, 1)).toBeUndefined();
    detector.record('third', 0, 12);
    expect(detector.recent.map((t) => t.name)).toEqual(['wasm:raster', 'third']);
    expect(detector.stats.count).toBe(3);
    expect(detector.thresholdMs).toBe(10);
  });

  it('the lag probe catches a blocked event loop', () => {
    let time = 0;
    const timers: { fn: () => void; due: number }[] = [];
    const detector = createLongTaskDetector({
      now: () => time,
      probeIntervalMs: 100,
      setTimer: (fn, ms) => {
        const timer = { fn, due: time + ms };
        timers.push(timer);
        return () => timers.splice(timers.indexOf(timer), 1);
      },
    });
    const fire = (at: number): void => {
      time = at;
      timers.shift()?.fn();
    };
    detector.start();
    detector.start(); // idempotent
    expect(detector.probing).toBe(true);
    fire(105); // 5 ms late: fine
    fire(205 + 300); // 300 ms late: the loop was blocked
    expect(detector.recent).toEqual([{ name: 'event-loop', start: 205, duration: 300, source: 'lag' }]);
    detector.stop();
    expect(detector.probing).toBe(false);
    expect(timers).toHaveLength(0);
  });
});

describe('workerSchedulerUnit', () => {
  it('provides the scheduler through DI and disposes it with the scope', async () => {
    const injector = createInjector({ units: [workerSchedulerUnit({ probe: true, longTasks: { probeIntervalMs: 1_000 } })] });
    const scheduler = unwrap(await injector.get(WorkerSchedulerToken));
    expect(scheduler.longTasks.probing).toBe(true);
    await injector.dispose();
    expect(scheduler.disposed).toBe(true);
    expect(scheduler.longTasks.probing).toBe(false);
  });
});
