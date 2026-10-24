import { createMemorySink, createTelemetry, ok } from '@staticflux/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFrameScheduler, defaultIdle, defaultMacrotask, type IdleDeadline, type Priority, yieldToMain } from './index.js';

/** Deterministic environment: frames, macrotasks and idle callbacks run only when the test says so. */
function fakeEnv() {
  const frames: ((t: number) => void)[] = [];
  const tasks: { cb: () => void; priority: Priority }[] = [];
  const idles: ((d: IdleDeadline) => void)[] = [];
  let time = 0;
  return {
    frames,
    tasks,
    idles,
    advance(ms: number) {
      time += ms;
    },
    env: {
      raf: (cb: (t: number) => void) => frames.push(cb),
      now: () => time,
      macrotask: (cb: () => void, priority: Priority) => tasks.push({ cb, priority }),
      idle: (cb: (d: IdleDeadline) => void) => idles.push(cb),
      yield: () => Promise.resolve(),
    },
    runFrame() {
      const frame = frames.shift();
      frame?.(time);
    },
    runTasks() {
      while (tasks.length > 0) tasks.shift()?.cb();
    },
    runIdle(remaining = 50) {
      const idle = idles.shift();
      idle?.({ didTimeout: false, timeRemaining: () => remaining });
    },
  };
}

const flushPromises = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('frame scheduler: frames', () => {
  it('coalesces update jobs to one run per frame, then measures, then mutates', async () => {
    const fake = fakeEnv();
    const scheduler = createFrameScheduler(fake.env);
    const order: string[] = [];
    const job = (): void => {
      order.push('update');
    };
    scheduler.schedule(job);
    scheduler.schedule(job);
    scheduler.schedule(job);
    const write = scheduler.mutate(() => order.push('write'));
    const read = scheduler.measure(() => {
      order.push('read');
      return 42;
    });
    expect(fake.frames).toHaveLength(1); // one coalesced flush requested
    expect(scheduler.pending).toBe(3);
    fake.runFrame();
    expect(order).toEqual(['update', 'read', 'write']);
    expect(await read).toEqual(ok(42));
    expect((await write).ok).toBe(true);
    expect(fake.frames).toHaveLength(0);
    expect(scheduler.phase).toBe('idle');
  });

  it('reads requested from a write run in the next frame (no layout thrashing); writes from reads run this frame', async () => {
    const fake = fakeEnv();
    const scheduler = createFrameScheduler(fake.env);
    const order: string[] = [];
    void scheduler.measure(() => {
      order.push(`read1:${scheduler.phase}`);
      void scheduler.mutate(() => {
        order.push(`write-from-read:${scheduler.phase}`);
        void scheduler.measure(() => order.push(`read-from-write:${scheduler.phase}`));
      });
    });
    fake.runFrame();
    expect(order).toEqual(['read1:measure', 'write-from-read:mutate']);
    expect(fake.frames).toHaveLength(1);
    fake.runFrame();
    expect(order).toEqual(['read1:measure', 'write-from-read:mutate', 'read-from-write:measure']);
  });

  it('captures job errors as Results and keeps flushing', async () => {
    const fake = fakeEnv();
    const scheduler = createFrameScheduler(fake.env);
    const bad = scheduler.mutate(() => {
      throw new Error('boom');
    });
    const good = scheduler.mutate(() => 'ok');
    scheduler.schedule(() => {
      throw new Error('update boom');
    });
    fake.runFrame();
    const badResult = await bad;
    expect(badResult.ok).toBe(false);
    expect(await good).toEqual(ok('ok'));
  });

  it('honours abort signals for frame jobs', async () => {
    const fake = fakeEnv();
    const scheduler = createFrameScheduler(fake.env);
    const controller = new AbortController();
    const fn = vi.fn();
    const read = scheduler.measure(fn, controller.signal);
    const job = vi.fn();
    scheduler.schedule(job, controller.signal);
    controller.abort();
    fake.runFrame();
    expect((await read).ok).toBe(false);
    expect(fn).not.toHaveBeenCalled();
    expect(job).not.toHaveBeenCalled();
    const pre = await scheduler.mutate(fn, controller.signal);
    expect(pre.ok).toBe(false);
  });

  it('pause stops frames; resume flushes the pending work', async () => {
    const fake = fakeEnv();
    const scheduler = createFrameScheduler(fake.env);
    scheduler.pause();
    expect(scheduler.paused).toBe(true);
    const write = scheduler.mutate(() => 1);
    expect(fake.frames).toHaveLength(0);
    scheduler.resume();
    expect(fake.frames).toHaveLength(1);
    fake.runFrame();
    expect(await write).toEqual(ok(1));
  });

  it('flush() runs a frame synchronously and reports long frames', () => {
    const fake = fakeEnv();
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'debug', now: fake.env.now });
    telemetry.addSink(sink);
    const scheduler = createFrameScheduler({ ...fake.env, telemetry, longFrameMs: 10 });
    scheduler.schedule(() => fake.advance(20));
    scheduler.flush();
    expect(sink.records.some((r) => r.type === 'event' && r.name === 'frame.long')).toBe(true);
    expect(sink.records.some((r) => r.type === 'metric' && r.metric === 'runtime/frame-flush')).toBe(true);
  });

  it('dispose rejects pending and future work', async () => {
    const fake = fakeEnv();
    const scheduler = createFrameScheduler(fake.env);
    const pending = scheduler.measure(() => 1);
    const task = scheduler.postTask(() => 1);
    scheduler.dispose();
    const results = await Promise.all([pending, task, scheduler.mutate(() => 1), scheduler.postTask(() => 2), scheduler.yieldToMain()]);
    for (const r of results) expect(!r.ok && r.error.code).toBe('SF-SCHED-001');
  });
});

describe('frame scheduler: tasks', () => {
  it('runs tasks by priority: interaction → critical → visible, idle only when idle', async () => {
    const fake = fakeEnv();
    const scheduler = createFrameScheduler(fake.env);
    const order: string[] = [];
    const all = [
      scheduler.postTask(() => order.push('idle'), { priority: 'idle' }),
      scheduler.postTask(() => order.push('visible'), { priority: 'visible' }),
      scheduler.postTask(() => order.push('critical'), { priority: 'critical' }),
      scheduler.postTask(() => order.push('interaction'), { priority: 'interaction' }),
    ];
    expect(fake.tasks[0]?.priority).toBe('visible');
    fake.runTasks();
    expect(order).toEqual(['interaction', 'critical', 'visible']);
    fake.runIdle();
    expect(order).toEqual(['interaction', 'critical', 'visible', 'idle']);
    for (const r of await Promise.all(all)) expect(r.ok).toBe(true);
  });

  it('yields after a time slice', () => {
    const fake = fakeEnv();
    const scheduler = createFrameScheduler({ ...fake.env, sliceMs: 5 });
    const ran: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      void scheduler.postTask(() => {
        ran.push(i);
        fake.advance(3);
      });
    }
    fake.tasks.shift()?.cb();
    expect(ran).toEqual([0, 1]);
    expect(fake.tasks).toHaveLength(1);
    fake.runTasks();
    expect(ran).toEqual([0, 1, 2, 3]);
  });

  it('resolves async task values, captures errors, and drops aborted tasks', async () => {
    const fake = fakeEnv();
    const scheduler = createFrameScheduler(fake.env);
    const value = scheduler.postTask(async () => 'v');
    const failing = scheduler.postTask(() => {
      throw new Error('x');
    });
    const rejecting = scheduler.postTask(async () => {
      throw new Error('y');
    });
    const controller = new AbortController();
    const skipped = vi.fn();
    const aborted = scheduler.postTask(skipped, { signal: controller.signal });
    controller.abort();
    fake.runTasks();
    expect(await value).toEqual(ok('v'));
    expect((await failing).ok).toBe(false);
    expect((await rejecting).ok).toBe(false);
    expect((await aborted).ok).toBe(false);
    expect(skipped).not.toHaveBeenCalled();
    expect((await scheduler.postTask(() => 1, { signal: controller.signal })).ok).toBe(false);
  });

  it('pause holds the task queue until resume (I-1)', async () => {
    const fake = fakeEnv();
    const scheduler = createFrameScheduler(fake.env);
    scheduler.pause();
    const task = scheduler.postTask(() => 'later');
    fake.runTasks();
    expect(fake.tasks).toHaveLength(0);
    scheduler.resume();
    fake.runTasks();
    expect(await task).toEqual(ok('later'));
  });

  it('yieldToMain waits for resume while paused and honours abort', async () => {
    const fake = fakeEnv();
    const scheduler = createFrameScheduler(fake.env);
    expect(await scheduler.yieldToMain()).toEqual(ok());
    scheduler.pause();
    let done = false;
    const waiting = scheduler.yieldToMain().then((r) => {
      done = true;
      return r;
    });
    await flushPromises();
    expect(done).toBe(false);
    scheduler.resume();
    expect(await waiting).toEqual(ok());
    scheduler.pause();
    const controller = new AbortController();
    const cancelled = scheduler.yieldToMain(controller.signal);
    await flushPromises();
    controller.abort();
    expect((await cancelled).ok).toBe(false);
    const pre = await scheduler.yieldToMain(controller.signal);
    expect(pre.ok).toBe(false);
  });

  it('idleUntilUrgent computes on idle, or synchronously on first get()', () => {
    const fake = fakeEnv();
    const scheduler = createFrameScheduler(fake.env);
    const lazy = vi.fn(() => ({ formatter: true }));
    const idle = scheduler.idleUntilUrgent(lazy);
    expect(idle.done).toBe(false);
    fake.runIdle();
    expect(idle.done).toBe(true);
    expect(idle.get()).toEqual({ formatter: true });
    expect(lazy).toHaveBeenCalledOnce();

    const urgent = vi.fn(() => 7);
    const handle = scheduler.idleUntilUrgent(urgent);
    expect(handle.get()).toBe(7);
    fake.runIdle();
    expect(urgent).toHaveBeenCalledOnce();

    const cancelled = vi.fn(() => 1);
    const c = scheduler.idleUntilUrgent(cancelled);
    c.cancel();
    fake.runIdle();
    expect(cancelled).not.toHaveBeenCalled();
    expect(c.get()).toBe(1);
  });

  it('idle work yields to urgent work', () => {
    const fake = fakeEnv();
    const scheduler = createFrameScheduler(fake.env);
    const order: string[] = [];
    void scheduler.postTask(
      () => {
        order.push('idle-1');
        void scheduler.postTask(() => order.push('urgent'), { priority: 'interaction' });
      },
      { priority: 'idle' },
    );
    void scheduler.postTask(() => order.push('idle-2'), { priority: 'idle' });
    fake.runIdle();
    expect(order).toEqual(['idle-1']);
    fake.runTasks();
    expect(order).toEqual(['idle-1', 'urgent']);
    fake.runIdle();
    expect(order).toEqual(['idle-1', 'urgent', 'idle-2']);
  });
});

describe('environment fallbacks', () => {
  const g = globalThis as { scheduler?: unknown; requestIdleCallback?: unknown };
  const original = { scheduler: g.scheduler, ric: g.requestIdleCallback };
  afterEach(() => {
    g.scheduler = original.scheduler;
    g.requestIdleCallback = original.ric;
  });

  it('yieldToMain prefers scheduler.yield, then postTask, then MessageChannel/setTimeout', async () => {
    const yieldSpy = vi.fn(() => Promise.resolve());
    g.scheduler = { yield: yieldSpy };
    await yieldToMain();
    expect(yieldSpy).toHaveBeenCalledOnce();
    const postTask = vi.fn((cb: () => void) => {
      cb();
      return Promise.resolve();
    });
    g.scheduler = { postTask };
    await yieldToMain();
    expect(postTask).toHaveBeenCalledWith(expect.any(Function), { priority: 'user-visible' });
    g.scheduler = undefined; // Safari: neither API
    await expect(yieldToMain()).resolves.toBeUndefined();
  });

  it('defaultMacrotask maps priorities to postTask and falls back without it', async () => {
    const postTask = vi.fn((cb: () => void) => {
      cb();
      return Promise.resolve();
    });
    g.scheduler = { postTask };
    const ran = vi.fn();
    defaultMacrotask(ran, 'interaction');
    expect(postTask).toHaveBeenCalledWith(ran, { priority: 'user-blocking' });
    defaultMacrotask(ran, 'idle');
    expect(postTask).toHaveBeenLastCalledWith(ran, { priority: 'background' });
    g.scheduler = undefined;
    await new Promise<void>((resolve) => defaultMacrotask(resolve, 'visible'));
  });

  it('defaultIdle uses requestIdleCallback when present, setTimeout otherwise', async () => {
    const ric = vi.fn((cb: (d: IdleDeadline) => void) => {
      cb({ didTimeout: false, timeRemaining: () => 10 });
      return 1;
    });
    g.requestIdleCallback = ric;
    const cb = vi.fn();
    defaultIdle(cb, 100);
    expect(ric).toHaveBeenCalledWith(cb, { timeout: 100 });
    g.requestIdleCallback = undefined;
    const deadline = await new Promise<IdleDeadline>((resolve) => defaultIdle(resolve, 100));
    expect(deadline.timeRemaining()).toBeGreaterThanOrEqual(0);
  });

  it('a scheduler with default environment flushes on a real frame', async () => {
    const scheduler = createFrameScheduler();
    const result = await scheduler.mutate(() => 'painted');
    expect(result).toEqual(ok('painted'));
    expect(await scheduler.postTask(() => 'task')).toEqual(ok('task'));
    scheduler.dispose();
  });
});
