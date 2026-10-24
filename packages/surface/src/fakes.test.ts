/**
 * Shared fakes for surface tests (not exported from the package).
 */
import { describe, expect, it } from 'vitest';
import type { FrameScheduler, ResizeObserverFactory, SurfaceEnvironment } from './env.js';

export interface ManualScheduler extends FrameScheduler {
  /** Run pending callbacks at `now` (advances the manual clock). */
  tick(now?: number): void;
  readonly pending: number;
}

export function manualScheduler(clock: { time: number }): ManualScheduler {
  let next = 1;
  const callbacks = new Map<number, (now: number) => void>();
  return {
    kind: 'raf',
    request(callback) {
      const id = next++;
      callbacks.set(id, callback);
      return id;
    },
    cancel(handle) {
      callbacks.delete(handle as number);
    },
    tick(now) {
      if (now !== undefined) clock.time = now;
      const due = [...callbacks.values()];
      callbacks.clear();
      for (const callback of due) callback(clock.time);
    },
    get pending() {
      return callbacks.size;
    },
  };
}

export interface FakeResizeObserver {
  readonly factory: ResizeObserverFactory;
  resize(width: number, height: number): void;
  readonly observed: number;
  readonly disconnected: number;
}

export function fakeResizeObserver(): FakeResizeObserver {
  let callback: ((entries: readonly { contentRect: { width: number; height: number } }[]) => void) | undefined;
  let observed = 0;
  let disconnected = 0;
  return {
    factory: (cb) => {
      callback = cb;
      return {
        observe: () => {
          observed += 1;
        },
        disconnect: () => {
          disconnected += 1;
          callback = undefined;
        },
      };
    },
    resize(width, height) {
      callback?.([{ contentRect: { width, height } }]);
    },
    get observed() {
      return observed;
    },
    get disconnected() {
      return disconnected;
    },
  };
}

export interface TestEnv extends SurfaceEnvironment {
  readonly clock: { time: number };
  readonly frames: ManualScheduler;
  readonly ro: FakeResizeObserver;
  dpr: number;
}

export function testEnv(overrides: { document?: Document | undefined; dpr?: number; timeOrigin?: number } = {}): TestEnv {
  const clock = { time: 0 };
  const frames = manualScheduler(clock);
  const ro = fakeResizeObserver();
  const env = {
    clock,
    frames,
    ro,
    dpr: overrides.dpr ?? 2,
    now: () => clock.time,
    timeOrigin: overrides.timeOrigin ?? 1000,
    devicePixelRatio: () => env.dpr,
    scheduler: frames,
    document: 'document' in overrides ? overrides.document : document,
    resizeObserver: ro.factory,
  };
  return env;
}

export function hostElement(width = 300, height = 150): HTMLElement {
  const host = document.createElement('div');
  host.getBoundingClientRect = () => ({ left: 10, top: 20, width, height, right: 10 + width, bottom: 20 + height, x: 10, y: 20, toJSON: () => ({}) });
  document.body.appendChild(host);
  return host;
}

export const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));


describe('test fakes', () => {
  it('manual scheduler runs and cancels callbacks', () => {
    const clock = { time: 0 };
    const scheduler = manualScheduler(clock);
    const seen: number[] = [];
    scheduler.request((now) => seen.push(now));
    const cancelled = scheduler.request(() => seen.push(-1));
    scheduler.cancel(cancelled);
    expect(scheduler.pending).toBe(1);
    scheduler.tick(16);
    expect(seen).toEqual([16]);
  });
});
