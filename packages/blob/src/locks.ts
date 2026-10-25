/**
 * Web Locks port. Head CAS takes an exclusive lock per head (S6: without the
 * lock 16 of 16 racing writers "won"; with it exactly 1); the leader holds an
 * exclusive lock for the workspace while it lives.
 *
 * `createMemoryLocks()` is a multi-tab fake for tests: each `forTab(id)` is a
 * tab's `navigator.locks`; `crashTab(id)` releases that tab's locks without
 * running its code further, like a renderer crash.
 */
import { err, ok, type Result } from '@staticflux/core';
import { BlobAbortedError } from './errors.js';

export interface LockManagerLike {
  request(
    name: string,
    options: { readonly mode?: 'exclusive' | 'shared'; readonly signal?: AbortSignal; readonly ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<unknown>,
  ): Promise<unknown>;
}

/** `navigator.locks` when available (windows and workers). */
export function detectLocks(): LockManagerLike | undefined {
  const locks = (globalThis as { navigator?: { locks?: LockManagerLike | null } }).navigator?.locks;
  return locks !== undefined && locks !== null && typeof locks.request === 'function' ? locks : undefined;
}

/**
 * An in-process lock manager (one JS realm only). The fallback where Web Locks
 * are missing: correct within one context, NOT across tabs or workers.
 */
export function createLocalLocks(): LockManagerLike {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request(name, options, callback) {
      if (options.signal?.aborted === true) return Promise.reject(new DOMException('aborted', 'AbortError'));
      const previous = tails.get(name) ?? Promise.resolve();
      const run = previous.then(
        () => callback({ name }),
        () => callback({ name }),
      );
      const tail = run.catch(() => undefined);
      tails.set(name, tail);
      void tail.then(() => {
        if (tails.get(name) === tail) tails.delete(name);
      });
      return run;
    },
  };
}

/**
 * Run `fn` while holding the exclusive lock `name`. An abort while waiting
 * returns `SF-BLOB-006` and never runs `fn`.
 */
export async function withExclusiveLock<T>(
  locks: LockManagerLike,
  name: string,
  fn: () => Promise<Result<T>>,
  signal?: AbortSignal,
): Promise<Result<T>> {
  if (signal?.aborted === true) return err(BlobAbortedError({ cause: signal.reason }));
  try {
    return (await locks.request(name, signal === undefined ? { mode: 'exclusive' } : { mode: 'exclusive', signal }, () => fn())) as Result<T>;
  } catch (cause) {
    return err(BlobAbortedError({ cause, message: `Waiting for lock ${name} was aborted.` }));
  }
}

interface LockRequest {
  readonly tab: string;
  readonly name: string;
  readonly mode: 'exclusive' | 'shared';
  readonly callback: (lock: unknown) => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  done: boolean;
}

export interface MemoryLocks {
  forTab(tab: string): LockManagerLike;
  /** Tabs holding `name`. */
  holders(name: string): readonly string[];
  /** Tabs waiting for `name`, in order. */
  queue(name: string): readonly string[];
  /** The tab died: its held locks are released and its queued requests dropped. Its callbacks never settle. */
  crashTab(tab: string): void;
}

export function createMemoryLocks(): MemoryLocks {
  const held = new Map<string, LockRequest[]>();
  const waiting = new Map<string, LockRequest[]>();
  const crashed = new Set<string>();

  const release = (request: LockRequest): void => {
    const list = (held.get(request.name) ?? []).filter((r) => r !== request);
    if (list.length === 0) held.delete(request.name);
    else held.set(request.name, list);
    grant(request.name);
  };

  const grant = (name: string): void => {
    const queue = waiting.get(name) ?? [];
    for (;;) {
      const next = queue[0];
      if (next === undefined) break;
      const holding = held.get(name) ?? [];
      const compatible = holding.length === 0 || (next.mode === 'shared' && holding.every((r) => r.mode === 'shared'));
      if (!compatible) break;
      queue.shift();
      held.set(name, [...holding, next]);
      void Promise.resolve()
        .then(() => next.callback({ name }))
        .then(
          (value) => finish(next, () => next.resolve(value)),
          (error: unknown) => finish(next, () => next.reject(error)),
        );
    }
    if (queue.length === 0) waiting.delete(name);
  };

  const finish = (request: LockRequest, settle: () => void): void => {
    if (request.done || crashed.has(request.tab)) return;
    request.done = true;
    settle();
    release(request);
  };

  return {
    forTab(tab) {
      return {
        request(name, options, callback) {
          return new Promise<unknown>((resolve, reject) => {
            if (crashed.has(tab)) return;
            if (options.signal?.aborted === true) {
              reject(new DOMException('aborted', 'AbortError'));
              return;
            }
            if (options.ifAvailable === true && (held.get(name)?.length ?? 0) > 0) {
              Promise.resolve()
                .then(() => callback(null))
                .then(resolve, reject);
              return;
            }
            // Aborted once the request leaves the queue (granted or aborted), detaching the abort listener.
            const detach = new AbortController();
            const request: LockRequest = {
              tab,
              name,
              mode: options.mode ?? 'exclusive',
              callback: (lock) => {
                detach.abort();
                return callback(lock);
              },
              resolve,
              reject,
              done: false,
            };
            const queue = waiting.get(name) ?? [];
            queue.push(request);
            waiting.set(name, queue);
            options.signal?.addEventListener(
              'abort',
              () => {
                const list = waiting.get(name);
                if (list === undefined || !list.includes(request)) return;
                waiting.set(
                  name,
                  list.filter((r) => r !== request),
                );
                request.done = true;
                detach.abort();
                reject(new DOMException('aborted', 'AbortError'));
              },
              { once: true, signal: detach.signal },
            );
            grant(name);
          });
        },
      };
    },
    holders(name) {
      return (held.get(name) ?? []).map((r) => r.tab);
    },
    queue(name) {
      return (waiting.get(name) ?? []).map((r) => r.tab);
    },
    crashTab(tab) {
      crashed.add(tab);
      for (const [name, list] of [...waiting]) waiting.set(
        name,
        list.filter((r) => r.tab !== tab),
      );
      for (const list of [...held.values()]) {
        for (const request of list) {
          if (request.tab !== tab) continue;
          request.done = true;
          const remaining = (held.get(request.name) ?? []).filter((r) => r !== request);
          if (remaining.length === 0) held.delete(request.name);
          else held.set(request.name, remaining);
          grant(request.name);
        }
      }
    },
  };
}

/** `ok(true)` when the lock manager reports `name` free right now (best effort, for diagnostics). */
export async function isLockFree(locks: LockManagerLike, name: string): Promise<Result<boolean>> {
  try {
    const free = await locks.request(name, { mode: 'exclusive', ifAvailable: true }, (lock) => Promise.resolve(lock !== null));
    return ok(free === true);
  } catch (cause) {
    return err(BlobAbortedError({ cause }));
  }
}
