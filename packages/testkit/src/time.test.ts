import { createInjector, token, unit } from '@staticflux/core';
import { createFrameScheduler } from '@staticflux/runtime';
import { describe, expect, it } from 'vitest';
import { createFakeClock, createFakeFrames, createFakeIdle, createFakeTime, flushMicrotasks } from './index.js';

describe('createFakeClock', () => {
  it('fires timeouts in time order (FIFO on ties) and moves time', () => {
    const clock = createFakeClock({ start: 0 });
    const log: string[] = [];
    clock.setTimeout(() => log.push(`b@${clock.now()}`), 20);
    clock.setTimeout(() => log.push(`a@${clock.now()}`), 10);
    clock.setTimeout(() => log.push(`c@${clock.now()}`), 10);
    clock.setTimeout((x) => log.push(`arg:${String(x)}`), 30, 'x');
    expect(clock.pending).toBe(4);
    expect(clock.advance(15)).toBe(15);
    expect(log).toEqual(['a@10', 'c@10']);
    clock.advance(100);
    expect(log).toEqual(['a@10', 'c@10', 'b@20', 'arg:x']);
    expect(clock.now()).toBe(115);
    expect(clock.pending).toBe(0);
  });

  it('timers scheduled while advancing fire when due inside the window', () => {
    const clock = createFakeClock({ start: 0 });
    const log: number[] = [];
    clock.setTimeout(() => clock.setTimeout(() => log.push(clock.now()), 5), 5);
    clock.advance(10);
    expect(log).toEqual([10]);
  });

  it('clearTimeout, intervals and clearInterval', () => {
    const clock = createFakeClock({ start: 0 });
    const ticks: number[] = [];
    const cancelled = clock.setTimeout(() => ticks.push(-1), 5);
    clock.clearTimeout(cancelled);
    clock.clearTimeout(undefined);
    const id = clock.setInterval(() => ticks.push(clock.now()), 10);
    clock.advance(35);
    expect(ticks).toEqual([10, 20, 30]);
    clock.clearInterval(id);
    clock.clearInterval(undefined);
    clock.advance(100);
    expect(ticks).toEqual([10, 20, 30]);
  });

  it('setTimer returns a cancel function (auth/gate port)', () => {
    const clock = createFakeClock();
    let fired = 0;
    const cancel = clock.setTimer(() => (fired += 1), 10);
    cancel();
    clock.setTimer(() => (fired += 1), 10);
    clock.advance(10);
    expect(fired).toBe(1);
  });

  it('next / runAll jump to pending timers; runAll stops runaway intervals', () => {
    const clock = createFakeClock({ start: 0 });
    expect(clock.next()).toBe(false);
    clock.setTimeout(() => undefined, 1_000);
    expect(clock.runAll()).toBe(1_000);
    clock.setInterval(() => undefined, 1);
    expect(() => clock.runAll(50)).toThrow(expect.objectContaining({ code: 'SF-TEST-004' }));
  });

  it('sleep resolves on advance and aborts cleanly', async () => {
    const clock = createFakeClock({ start: 0 });
    const slept = clock.sleep(100);
    clock.advance(100);
    expect(await slept).toEqual({ ok: true, value: undefined });
    const controller = new AbortController();
    const pending = clock.sleep(100, controller.signal);
    controller.abort();
    expect((await pending).ok).toBe(false);
    expect(clock.pending).toBe(0);
    const pre = await clock.sleep(1, AbortSignal.abort());
    expect(!pre.ok && pre.error.kind).toBe('aborted');
  });

  it('advanceAsync lets async loops re-arm timers', async () => {
    const clock = createFakeClock({ start: 0 });
    const log: number[] = [];
    void (async () => {
      for (let i = 0; i < 3; i += 1) {
        await clock.sleep(10);
        log.push(clock.now());
      }
    })();
    clock.advance(30); // sync advance cannot see re-armed sleeps
    expect(log).toEqual([]);
    await clock.advanceAsync(30);
    expect(log).toEqual([30, 40, 50]);
    await clock.runAllAsync();
    expect(log).toHaveLength(3);
  });

  it('setNow moves time without firing timers', () => {
    const clock = createFakeClock({ start: 0 });
    let fired = false;
    clock.setTimeout(() => (fired = true), 10);
    clock.setNow(500);
    expect(fired).toBe(false);
    clock.advance(0);
    expect(fired).toBe(true);
  });
});

describe('createFakeFrames', () => {
  it('runs queued callbacks per frame; callbacks queued during a frame wait', () => {
    const frames = createFakeFrames();
    const log: string[] = [];
    frames.raf((t) => {
      log.push(`a:${t}`);
      frames.raf(() => log.push('nested'));
    });
    const cancelled = frames.raf(() => log.push('cancelled'));
    frames.cancelRaf(cancelled);
    expect(frames.pending).toBe(1);
    expect(frames.flushFrame()).toBe(1);
    expect(log).toEqual(['a:16']);
    expect(frames.flushFrames(5)).toBe(1);
    expect(log).toEqual(['a:16', 'nested']);
    expect(frames.flushFrame()).toBe(0);
    expect(frames.frame).toBe(2);
  });

  it('can advance a clock per frame', () => {
    const clock = createFakeClock({ start: 0 });
    const frames = createFakeFrames({ clock, frameMs: 16 });
    const stamps: number[] = [];
    frames.raf((t) => stamps.push(t));
    frames.flushFrame();
    expect(stamps).toEqual([16]);
  });
});

describe('createFakeIdle', () => {
  it('flushIdle passes a deadline; cancel works; timeouts fire via the clock', () => {
    const clock = createFakeClock({ start: 0 });
    const idle = createFakeIdle({ clock });
    const log: string[] = [];
    idle.requestIdleCallback((d) => log.push(`a:${d.didTimeout}:${d.timeRemaining()}`));
    const id = idle.requestIdleCallback(() => log.push('cancelled'), { timeout: 5 });
    idle.cancelIdleCallback(id);
    idle.requestIdleCallback((d) => log.push(`t:${d.didTimeout}`), { timeout: 100 });
    expect(idle.pending).toBe(2);
    clock.advance(100);
    expect(log).toEqual(['t:true']);
    expect(idle.flushIdle({ timeRemaining: 3 })).toBe(1);
    expect(log).toEqual(['t:true', 'a:false:3']);
    expect(clock.pending).toBe(0);
  });
});

describe('createFakeTime + runtime frame scheduler', () => {
  it('drives update/measure/mutate frames, prioritized tasks, idle and yield deterministically', async () => {
    const time = createFakeTime({ start: 0 });
    const scheduler = createFrameScheduler({ ...time.schedulerEnv });
    const log: string[] = [];
    const job = (): void => void log.push('update');
    scheduler.schedule(job);
    scheduler.schedule(job); // coalesced
    const write = scheduler.mutate(() => log.push('mutate'));
    const read = scheduler.measure(() => log.push('measure'));
    const idleTask = scheduler.postTask(() => log.push('idle'), { priority: 'idle' });
    const visible = scheduler.postTask(() => log.push('visible'), { priority: 'visible' });
    const urgent = scheduler.postTask(() => log.push('interaction'), { priority: 'interaction' });
    expect(log).toEqual([]);
    expect(time.frames.pending).toBe(1);
    time.frames.flushFrame();
    expect(log).toEqual(['update', 'measure', 'mutate']);
    time.tasks.flushTasks();
    expect(log.slice(3)).toEqual(['interaction', 'visible']);
    time.idle.flushIdle();
    expect(log.slice(5)).toEqual(['idle']);
    await Promise.all([write, read, idleTask, visible, urgent]);

    let yielded = false;
    void scheduler.yieldToMain().then(() => (yielded = true));
    await flushMicrotasks();
    expect(yielded).toBe(false);
    await time.flush();
    expect(yielded).toBe(true);
    expect(time.pending).toBe(0);
    scheduler.dispose();
  });

  it('flush() runs chained work to quiescence; advance() moves time first', async () => {
    const time = createFakeTime({ start: 0 });
    const scheduler = createFrameScheduler({ ...time.schedulerEnv });
    const log: string[] = [];
    void scheduler.postTask(async () => {
      log.push('task');
      await scheduler.measure(() => log.push('measure'));
      await scheduler.postTask(() => log.push('idle'), { priority: 'idle' });
    });
    await time.flush();
    expect(log).toEqual(['task', 'measure', 'idle']);
    time.clock.setTimeout(() => scheduler.schedule(() => void log.push('timer-frame')), 50);
    await time.advance(50);
    expect(log.at(-1)).toBe('timer-frame');
    scheduler.dispose();
  });

  it('flush() reports runaway re-scheduling', async () => {
    const time = createFakeTime();
    const loop = (): void => {
      time.frames.raf(loop);
    };
    loop();
    await expect(time.flush()).rejects.toMatchObject({ code: 'SF-TEST-004' });
  });

  it('urlScheduler is a urlstate FrameScheduler on fake frames', () => {
    const time = createFakeTime();
    const log: string[] = [];
    const cancel = time.urlScheduler.request(() => log.push('cancelled'));
    cancel();
    time.urlScheduler.request(() => log.push('ran'));
    time.frames.flushFrame();
    expect(log).toEqual(['ran']);
  });

  it('injectorIdle drives `idle` init timing of lazy deps', async () => {
    const time = createFakeTime();
    const Lazy = token('it/lazy').type<string>();
    const Host = token('it/host').type<{ readonly state: () => string }>();
    const injector = createInjector({
      idle: time.injectorIdle,
      units: [
        unit({ id: 'it/lazy', provides: Lazy, scope: 'app', create: () => 'lazy' }),
        unit({
          id: 'it/host',
          provides: Host,
          scope: 'app',
          deps: { lazy: { lazy: { token: Lazy, init: 'idle' } } },
          create: ({ lazy }) => ({ state: () => lazy.state }),
        }),
      ],
    });
    const host = await injector.get(Host);
    if (!host.ok) throw host.error;
    await flushMicrotasks();
    expect(host.value.state()).toBe('idle');
    expect(time.idle.pending).toBe(1);
    await time.flush();
    expect(host.value.state()).toBe('ready');
    await injector.dispose();
  });
});
