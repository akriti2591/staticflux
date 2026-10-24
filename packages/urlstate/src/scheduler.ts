/**
 * Frame scheduler port: URL writes coalesce to at most one per frame (R12.13).
 * The runtime's scheduler can provide this token; the built-in uses
 * `requestAnimationFrame` (falling back to a 16 ms timeout, e.g. in background
 * tabs or workers). Tests use the manual scheduler.
 */

export interface FrameScheduler {
  /** Run `callback` before the next frame. Returns cancel. */
  request(callback: () => void): () => void;
}

export function createRafScheduler(global: typeof globalThis = globalThis): FrameScheduler {
  const raf = typeof global.requestAnimationFrame === 'function' ? global.requestAnimationFrame.bind(global) : undefined;
  const caf = typeof global.cancelAnimationFrame === 'function' ? global.cancelAnimationFrame.bind(global) : undefined;
  return {
    request(callback) {
      if (raf !== undefined && caf !== undefined) {
        const id = raf(() => callback());
        return () => caf(id);
      }
      const timer = setTimeout(callback, 16);
      return () => clearTimeout(timer);
    },
  };
}

export interface ManualScheduler extends FrameScheduler {
  /** Run every queued callback. */
  flush(): void;
  readonly pending: number;
}

export function createManualScheduler(): ManualScheduler {
  const queue = new Set<() => void>();
  return {
    request(callback) {
      const entry = (): void => callback();
      queue.add(entry);
      return () => {
        queue.delete(entry);
      };
    },
    flush() {
      const run = [...queue];
      queue.clear();
      for (const callback of run) callback();
    },
    get pending() {
      return queue.size;
    },
  };
}
