/**
 * Leader election via Web Locks (R11.9), feature-detected. Exactly one tab
 * holds the named exclusive lock and is leader (e.g. owns a store or the
 * SharedWorker-less coordinator). When the leader closes, the browser
 * releases the lock and the next waiting tab becomes leader.
 *
 * Fallback without Web Locks: single-tab mode — this tab is leader.
 */
import { AbortedError, box, createDeferred, createNoopTelemetry, err, ok, type Result, type Telemetry } from '@staticflux/core';

export interface LockManagerLike {
  request(
    name: string,
    options: { readonly mode?: 'exclusive' | 'shared'; readonly signal?: AbortSignal },
    callback: (lock: unknown) => Promise<unknown>,
  ): Promise<unknown>;
}

/** `navigator.locks` when available. */
export function detectLocks(): LockManagerLike | undefined {
  const nav = (globalThis as { navigator?: { locks?: LockManagerLike | null } }).navigator;
  const locks = nav?.locks;
  return locks !== undefined && locks !== null && typeof locks.request === 'function' ? locks : undefined;
}

export type LeaderMode = 'web-locks' | 'single-tab';

export interface LeaderElection {
  readonly name: string;
  readonly mode: LeaderMode;
  /** Reactive. */
  readonly isLeader: boolean;
  whenLeader(signal?: AbortSignal): Promise<Result<void>>;
  onChange(listener: (isLeader: boolean) => void): () => void;
  /** Give up leadership (or stop waiting); does not re-enter the queue. */
  resign(): void;
}

export interface LeaderElectionOptions {
  readonly name: `${string}/${string}`;
  /** Lock manager; `null` forces single-tab mode. Default: `detectLocks()`. */
  readonly locks?: LockManagerLike | null;
  readonly signal?: AbortSignal;
  readonly telemetry?: Telemetry;
}

export function createLeaderElection(options: LeaderElectionOptions): LeaderElection {
  const locks = options.locks === null ? undefined : (options.locks ?? detectLocks());
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const mode: LeaderMode = locks === undefined ? 'single-tab' : 'web-locks';
  const leader = box(false);
  const listeners = new Set<(isLeader: boolean) => void>();
  let waiters: { resolve(result: Result<void>): void }[] = [];
  const controller = new AbortController();
  const release = createDeferred<void>();
  let resigned = false;

  const set = (value: boolean): void => {
    if (leader.get() === value) return;
    leader.set(value);
    telemetry.event(value ? 'leader.acquired' : 'leader.released', {
      subsystem: 'worker/leader',
      level: 'standard',
      attrs: { name: options.name, mode },
    });
    for (const listener of [...listeners]) listener(value);
    if (value) {
      const pending = waiters;
      waiters = [];
      for (const waiter of pending) waiter.resolve(ok());
    }
  };

  const resign = (): void => {
    if (resigned) return;
    resigned = true;
    controller.abort(new DOMException('resigned', 'AbortError'));
    release.resolve();
    set(false);
    const pending = waiters;
    waiters = [];
    for (const waiter of pending) waiter.resolve(err(AbortedError()));
  };

  // resign() aborts `controller`, after which the caller's abort has nothing left to do.
  options.signal?.addEventListener('abort', resign, { once: true, signal: controller.signal });

  if (locks === undefined) {
    set(true);
  } else {
    void locks
      .request(options.name, { mode: 'exclusive', signal: controller.signal }, async () => {
        if (resigned) return;
        set(true);
        await release.promise;
      })
      .catch(() => undefined);
  }

  return {
    name: options.name,
    mode,
    get isLeader() {
      return leader.get();
    },
    whenLeader(signal) {
      if (leader.get()) return Promise.resolve(ok());
      if (resigned) return Promise.resolve(err(AbortedError()));
      const deferred = createDeferred<Result<void>>();
      // Aborted to detach the abort listener once the waiter is resolved.
      const detach = new AbortController();
      const waiter = {
        resolve: (r: Result<void>) => {
          detach.abort();
          deferred.resolve(r);
        },
      };
      waiters.push(waiter);
      signal?.addEventListener(
        'abort',
        () => {
          waiters = waiters.filter((w) => w !== waiter);
          deferred.resolve(err(AbortedError({ cause: signal.reason })));
        },
        { once: true, signal: detach.signal },
      );
      return deferred.promise;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    resign,
  };
}
