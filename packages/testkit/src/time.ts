/**
 * Deterministic time (R16.3): a fake clock with timers, fake animation frames, fake
 * idle callbacks and a fake macrotask queue — bundled by `createFakeTime()` with
 * adapters for every injectable timing port in the framework:
 *
 * - runtime `createFrameScheduler(env)` → `time.schedulerEnv` (raf, now, macrotask, idle, yield)
 * - core `createInjector({ idle })` / `bootApp({ idle, now, sleep })` → `time.injectorIdle`, `clock.now`, `clock.sleep`
 * - urlstate `FrameScheduler` port → `time.urlScheduler`
 * - auth / gate `setTimer(fn, ms) → cancel` ports → `clock.setTimer`
 *
 * Nothing here patches globals. Code that calls global `setTimeout` directly (e.g. core
 * `sleep`) needs Vitest's `vi.useFakeTimers()` instead.
 */
import { AbortedError, err, ok, type Result } from '@staticflux/core';
import type { IdleDeadline, Priority, SchedulerEnvironment } from '@staticflux/runtime';
import type { FrameScheduler as UrlFrameScheduler } from '@staticflux/urlstate';
import { RunawayTimersError } from './errors.js';

/** Let pending promise continuations run (a bounded number of microtask turns). */
export async function flushMicrotasks(turns = 50): Promise<void> {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

// ---------------------------------------------------------------- clock

export type TimerId = number;

export interface FakeClock {
  /** Current fake time in ms. */
  now(): number;
  /** Number of pending timers (timeouts + intervals). */
  readonly pending: number;
  setTimeout(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): TimerId;
  clearTimeout(id: TimerId | undefined): void;
  setInterval(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): TimerId;
  clearInterval(id: TimerId | undefined): void;
  /** `setTimer(fn, ms) → cancel` port (auth, gate). */
  setTimer(callback: () => void, ms: number): () => void;
  /** Abortable sleep with the core/runtime `Sleep` signature. */
  sleep(ms: number, signal?: AbortSignal): Promise<Result<void>>;
  /** Move time forward, firing due timers in order (timers scheduled meanwhile fire too if due). Returns the new time. */
  advance(ms: number): number;
  /** Like `advance`, but lets promise continuations run after each timer (for async code that re-arms timers). */
  advanceAsync(ms: number): Promise<number>;
  /** Fire the next pending timer (jumping time to it). Returns false when none is pending. */
  next(): boolean;
  /** Fire every pending timer, jumping time forward, until none remain. Throws `SF-TEST-004` past `limit`. */
  runAll(limit?: number): number;
  runAllAsync(limit?: number): Promise<number>;
  /** Set the time without firing timers (e.g. simulate a frozen tab waking up late). */
  setNow(time: number): void;
}

interface TimerEntry {
  readonly id: TimerId;
  at: number;
  readonly interval: number | undefined;
  readonly callback: () => void;
}

export interface FakeClockOptions {
  /** Start time in ms (default 1_000_000). */
  readonly start?: number;
}

export function createFakeClock(options: FakeClockOptions = {}): FakeClock {
  let time = options.start ?? 1_000_000;
  let nextId = 1;
  const timers = new Map<TimerId, TimerEntry>();

  const add = (callback: () => void, ms: number | undefined, interval: boolean): TimerId => {
    const delay = Math.max(0, Number.isFinite(ms) ? (ms as number) : 0);
    const id = nextId;
    nextId += 1;
    timers.set(id, { id, at: time + delay, interval: interval ? Math.max(1, delay) : undefined, callback });
    return id;
  };

  /** Earliest timer due at or before `limit` (ties: scheduling order). */
  const due = (limit: number): TimerEntry | undefined => {
    let best: TimerEntry | undefined;
    for (const entry of timers.values()) {
      if (entry.at > limit) continue;
      if (best === undefined || entry.at < best.at || (entry.at === best.at && entry.id < best.id)) best = entry;
    }
    return best;
  };

  const fire = (entry: TimerEntry): void => {
    time = Math.max(time, entry.at);
    if (entry.interval === undefined) timers.delete(entry.id);
    else entry.at = time + entry.interval;
    entry.callback();
  };

  const clock: FakeClock = {
    now: () => time,
    get pending() {
      return timers.size;
    },
    setTimeout: (callback, ms, ...args) => add(() => callback(...args), ms, false),
    clearTimeout: (id) => {
      if (id !== undefined) timers.delete(id);
    },
    setInterval: (callback, ms, ...args) => add(() => callback(...args), ms, true),
    clearInterval: (id) => {
      if (id !== undefined) timers.delete(id);
    },
    setTimer(callback, ms) {
      const id = add(callback, ms, false);
      return () => {
        timers.delete(id);
      };
    },
    sleep(ms, signal) {
      return new Promise((resolve) => {
        if (signal?.aborted === true) {
          resolve(err(AbortedError({ cause: signal.reason })));
          return;
        }
        // Aborted to detach the abort listener once the timer fires.
        const detach = new AbortController();
        const id = add(
          () => {
            detach.abort();
            resolve(ok());
          },
          ms,
          false,
        );
        signal?.addEventListener(
          'abort',
          () => {
            timers.delete(id);
            resolve(err(AbortedError({ cause: signal.reason })));
          },
          { once: true, signal: detach.signal },
        );
      });
    },
    advance(ms) {
      const target = time + Math.max(0, ms);
      for (let entry = due(target); entry !== undefined; entry = due(target)) fire(entry);
      time = target;
      return time;
    },
    async advanceAsync(ms) {
      const target = time + Math.max(0, ms);
      await flushMicrotasks();
      for (let entry = due(target); entry !== undefined; entry = due(target)) {
        fire(entry);
        await flushMicrotasks();
      }
      time = target;
      return time;
    },
    next() {
      const entry = due(Number.POSITIVE_INFINITY);
      if (entry === undefined) return false;
      fire(entry);
      return true;
    },
    runAll(limit = 1_000) {
      let count = 0;
      while (clock.next()) {
        count += 1;
        if (count >= limit) throw RunawayTimersError({ details: { limit } });
      }
      return time;
    },
    async runAllAsync(limit = 1_000) {
      let count = 0;
      await flushMicrotasks();
      while (clock.next()) {
        count += 1;
        if (count >= limit) throw RunawayTimersError({ details: { limit } });
        await flushMicrotasks();
      }
      return time;
    },
    setNow(value) {
      time = value;
    },
  };
  return clock;
}

// ---------------------------------------------------------------- frames

export interface FakeFrames {
  /** requestAnimationFrame-compatible. */
  raf(callback: (time: number) => void): number;
  /** cancelAnimationFrame-compatible. */
  cancelRaf(id: number): void;
  /** Run the callbacks queued before this call (callbacks queued while flushing wait for the next frame). Returns how many ran. */
  flushFrame(): number;
  /** Flush up to `count` frames (stops early when nothing is queued). */
  flushFrames(count: number): number;
  readonly pending: number;
  /** Frames flushed so far. */
  readonly frame: number;
}

export interface FakeFramesOptions {
  /** Timestamps passed to callbacks (default: frame count × `frameMs`). */
  readonly clock?: Pick<FakeClock, 'now' | 'advance'>;
  /** With a clock: advance it by this much before each frame (default 0 = do not move time). */
  readonly frameMs?: number;
}

export function createFakeFrames(options: FakeFramesOptions = {}): FakeFrames {
  let nextId = 1;
  let frame = 0;
  let queue = new Map<number, (time: number) => void>();
  const frameMs = options.frameMs ?? 0;
  const frames: FakeFrames = {
    raf(callback) {
      const id = nextId;
      nextId += 1;
      queue.set(id, callback);
      return id;
    },
    cancelRaf(id) {
      queue.delete(id);
    },
    flushFrame() {
      if (queue.size === 0) return 0;
      const run = queue;
      queue = new Map();
      frame += 1;
      if (options.clock !== undefined && frameMs > 0) options.clock.advance(frameMs);
      const stamp = options.clock?.now() ?? frame * 16;
      for (const callback of run.values()) callback(stamp);
      return run.size;
    },
    flushFrames(count) {
      let ran = 0;
      for (let i = 0; i < count && queue.size > 0; i += 1) ran += frames.flushFrame();
      return ran;
    },
    get pending() {
      return queue.size;
    },
    get frame() {
      return frame;
    },
  };
  return frames;
}

// ---------------------------------------------------------------- idle

export interface FakeIdleOptions {
  /** With a clock, an idle callback's `timeout` fires it with `didTimeout: true` when time passes it. */
  readonly clock?: FakeClock;
  /** Default `timeRemaining()` budget (default 50 ms, like an idle browser). */
  readonly budgetMs?: number;
}

export interface FlushIdleOptions {
  readonly timeRemaining?: number;
  readonly didTimeout?: boolean;
}

export interface FakeIdle {
  /** requestIdleCallback-compatible. */
  requestIdleCallback(callback: (deadline: IdleDeadline) => void, options?: { readonly timeout?: number }): number;
  cancelIdleCallback(id: number): void;
  /** Run the callbacks queued before this call. Returns how many ran. */
  flushIdle(options?: FlushIdleOptions): number;
  readonly pending: number;
}

export function createFakeIdle(options: FakeIdleOptions = {}): FakeIdle {
  let nextId = 1;
  const budget = options.budgetMs ?? 50;
  const queue = new Map<number, { callback: (deadline: IdleDeadline) => void; cancelTimeout: (() => void) | undefined }>();
  const run = (id: number, didTimeout: boolean, remaining: number): boolean => {
    const entry = queue.get(id);
    if (entry === undefined) return false;
    queue.delete(id);
    entry.cancelTimeout?.();
    entry.callback({ didTimeout, timeRemaining: () => remaining });
    return true;
  };
  return {
    requestIdleCallback(callback, requestOptions = {}) {
      const id = nextId;
      nextId += 1;
      const timeout = requestOptions.timeout;
      const cancelTimeout =
        options.clock !== undefined && timeout !== undefined && timeout > 0
          ? options.clock.setTimer(() => void run(id, true, 0), timeout)
          : undefined;
      queue.set(id, { callback, cancelTimeout });
      return id;
    },
    cancelIdleCallback(id) {
      queue.get(id)?.cancelTimeout?.();
      queue.delete(id);
    },
    flushIdle(flushOptions = {}) {
      let ran = 0;
      for (const id of [...queue.keys()]) {
        if (run(id, flushOptions.didTimeout ?? false, flushOptions.timeRemaining ?? budget)) ran += 1;
      }
      return ran;
    },
    get pending() {
      return queue.size;
    },
  };
}

// ---------------------------------------------------------------- bundle

export interface FakeTasks {
  /** Queue a macrotask (runtime scheduler `macrotask` port). */
  post(callback: () => void, priority?: Priority): void;
  /** Run queued macrotasks FIFO, including ones queued while running (bounded). Returns how many ran. */
  flushTasks(limit?: number): number;
  readonly pending: number;
}

function createFakeTasks(): FakeTasks {
  const queue: (() => void)[] = [];
  return {
    post(callback) {
      queue.push(callback);
    },
    flushTasks(limit = 10_000) {
      let ran = 0;
      while (queue.length > 0) {
        if (ran >= limit) throw RunawayTimersError({ message: 'flushTasks exceeded its limit: a task keeps re-posting itself.', details: { limit } });
        queue.shift()?.();
        ran += 1;
      }
      return ran;
    },
    get pending() {
      return queue.length;
    },
  };
}

export interface FakeTime {
  readonly clock: FakeClock;
  readonly frames: FakeFrames;
  readonly idle: FakeIdle;
  readonly tasks: FakeTasks;
  /** Plug into runtime `createFrameScheduler({ ...time.schedulerEnv })`. */
  readonly schedulerEnv: Required<SchedulerEnvironment>;
  /** urlstate `FrameScheduler` port backed by the fake frames. */
  readonly urlScheduler: UrlFrameScheduler;
  /** core injector / `bootApp` idle port backed by the fake idle queue. */
  readonly injectorIdle: (callback: () => void) => void;
  /** Total pending work (timers excluded: they need time to pass). */
  readonly pending: number;
  /** Run microtasks, macrotasks, frames and idle callbacks until quiet (time does not move). */
  flush(): Promise<void>;
  /** `clock.advanceAsync(ms)` then `flush()`. */
  advance(ms: number): Promise<void>;
}

export interface FakeTimeOptions extends FakeClockOptions {
  /** Advance the clock by this much on each frame (default 0). */
  readonly frameMs?: number;
  readonly idleBudgetMs?: number;
}

export function createFakeTime(options: FakeTimeOptions = {}): FakeTime {
  const clock = createFakeClock(options.start === undefined ? {} : { start: options.start });
  const frames = createFakeFrames({ clock, ...(options.frameMs === undefined ? {} : { frameMs: options.frameMs }) });
  const idle = createFakeIdle({ clock, ...(options.idleBudgetMs === undefined ? {} : { budgetMs: options.idleBudgetMs }) });
  const tasks = createFakeTasks();
  const pending = (): number => tasks.pending + frames.pending + idle.pending;
  const time: FakeTime = {
    clock,
    frames,
    idle,
    tasks,
    schedulerEnv: {
      raf: (callback) => frames.raf(callback),
      now: () => clock.now(),
      macrotask: (callback, priority) => tasks.post(callback, priority),
      idle: (callback, timeoutMs) => void idle.requestIdleCallback(callback, { timeout: timeoutMs }),
      yield: () => new Promise<void>((resolve) => tasks.post(resolve)),
    },
    urlScheduler: {
      request(callback) {
        const id = frames.raf(() => callback());
        return () => frames.cancelRaf(id);
      },
    },
    injectorIdle: (callback) => void idle.requestIdleCallback(() => callback()),
    get pending() {
      return pending();
    },
    async flush() {
      for (let round = 0; round < 1_000; round += 1) {
        await flushMicrotasks();
        if (pending() === 0) return;
        // Order mirrors a browser turn: tasks, then a frame, then idle time.
        tasks.flushTasks();
        await flushMicrotasks();
        frames.flushFrame();
        await flushMicrotasks();
        if (tasks.pending === 0 && frames.pending === 0) idle.flushIdle();
      }
      throw RunawayTimersError({ message: 'FakeTime.flush did not settle: work keeps re-scheduling itself.' });
    },
    async advance(ms) {
      await clock.advanceAsync(ms);
      await time.flush();
    },
  };
  return time;
}
