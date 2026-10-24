/**
 * Async primitives. A `Task<T>` is a function of an AbortSignal that resolves
 * to a Result — it never throws for expected failures and always stops when
 * its signal aborts. All combinators take and return Tasks so they compose:
 *
 *   const load = retry(timeout(fetchDoc, 5_000), { attempts: 3 });
 *   const result = await load(scope.signal);
 */
import { AbortedError, defineError, type SfError, toSfError } from './errors.js';
import { err, ok, type Result } from './result.js';

export type Task<T> = (signal: AbortSignal) => Promise<Result<T>>;

/** Lift a throwing async function into a Task. */
export function task<T>(fn: (signal: AbortSignal) => Promise<T>): Task<T> {
  return async (signal) => {
    if (signal.aborted) return err(AbortedError({ cause: signal.reason }));
    try {
      return ok(await fn(signal));
    } catch (error) {
      if (signal.aborted) return err(AbortedError({ cause: signal.reason }));
      return err(toSfError(error));
    }
  };
}

/** Combine signals; aborts when any input aborts. Uses AbortSignal.any when available. */
export function anySignal(...signals: readonly (AbortSignal | undefined)[]): AbortSignal {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  const native = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof native === 'function') return native.call(AbortSignal, present);
  const controller = new AbortController();
  for (const signal of present) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true, signal: controller.signal });
  }
  return controller.signal;
}

/** Abortable sleep. Resolves ok() after `ms`, or err(aborted) when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<Result<void>> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve(err(AbortedError({ cause: signal.reason })));
      return;
    }
    // Aborted to detach the abort listener once the timer wins.
    const detach = new AbortController();
    const timer = setTimeout(() => {
      detach.abort();
      resolve(ok());
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(err(AbortedError({ cause: signal?.reason })));
    };
    signal?.addEventListener('abort', onAbort, { once: true, signal: detach.signal });
  });
}

export const TaskTimeoutError = defineError(
  'SF-ASYNC-001',
  'timeout',
  'A task exceeded its timeout.',
  'Make the task cheaper, stream partial results, or raise the timeout with a documented reason.',
);

/** Fail with a timeout error if `inner` does not settle within `ms`. The inner task is aborted on timeout. */
export function timeout<T>(inner: Task<T>, ms: number): Task<T> {
  return async (signal) => {
    const controller = new AbortController();
    const combined = anySignal(signal, controller.signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<Result<T>>((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new DOMException('timeout', 'TimeoutError'));
        resolve(err(TaskTimeoutError({ details: { ms } })));
      }, ms);
    });
    try {
      return await Promise.race([inner(combined), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  };
}

export interface RetryPolicy {
  /** Total attempts including the first. */
  readonly attempts: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** `full` = AWS full jitter (random in [0, backoff]). Default `full`. */
  readonly jitter?: 'full' | 'none';
  /** Decide whether an error is retryable. Default: network | timeout | unavailable | rate. */
  readonly retryIf?: (error: SfError, attempt: number) => boolean;
  /** Injectable randomness for deterministic tests. */
  readonly random?: () => number;
  readonly onRetry?: (error: SfError, attempt: number, delayMs: number) => void;
}

const RETRYABLE_KINDS = new Set(['network', 'timeout', 'unavailable', 'rate']);

export function defaultRetryIf(error: SfError): boolean {
  return RETRYABLE_KINDS.has(error.kind);
}

/** Exponential backoff delay for a 1-based retry number. */
export function backoffDelay(
  retryNumber: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitter: 'full' | 'none',
  random: () => number = Math.random,
): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (retryNumber - 1));
  return jitter === 'full' ? Math.floor(random() * exponential) : exponential;
}

/** Retry a task with exponential backoff and (default) full jitter. Never retries aborts. */
export function retry<T>(inner: Task<T>, policy: RetryPolicy): Task<T> {
  const base = policy.baseDelayMs ?? 100;
  const max = policy.maxDelayMs ?? 10_000;
  const jitter = policy.jitter ?? 'full';
  const retryIf = policy.retryIf ?? defaultRetryIf;
  return async (signal) => {
    let last: Result<T> = err(AbortedError());
    for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
      last = await inner(signal);
      if (last.ok) return last;
      const error = last.error;
      if (error.kind === 'aborted' || signal.aborted) return last;
      if (attempt === policy.attempts || !retryIf(error, attempt)) return last;
      const delay = backoffDelay(attempt, base, max, jitter, policy.random);
      policy.onRetry?.(error, attempt, delay);
      const slept = await sleep(delay, signal);
      if (!slept.ok) return err(slept.error);
    }
    return last;
  };
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
  readonly settled: boolean;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  let settled = false;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    promise,
    resolve(value) {
      settled = true;
      resolve(value);
    },
    reject(reason) {
      settled = true;
      reject(reason);
    },
    get settled() {
      return settled;
    },
  };
}

export interface SingleFlight<K, T> {
  /** Run the task for `key`, or join the in-flight run for the same key. */
  run(key: K, inner: Task<T>, signal: AbortSignal): Promise<Result<T>>;
  inFlight(key: K): boolean;
}

/**
 * Coalesce concurrent calls per key (e.g. ten 401s → one token refresh).
 * The shared run is aborted only when every joined caller has aborted.
 */
export function createSingleFlight<K, T>(): SingleFlight<K, T> {
  interface Flight {
    promise: Promise<Result<T>>;
    controller: AbortController;
    waiters: number;
  }
  const flights = new Map<K, Flight>();
  return {
    run(key, inner, signal) {
      let flight = flights.get(key);
      if (flight === undefined) {
        const controller = new AbortController();
        const created: Flight = { controller, waiters: 0, promise: Promise.resolve(err(AbortedError())) };
        created.promise = inner(controller.signal).finally(() => {
          if (flights.get(key) === created) flights.delete(key);
        });
        flights.set(key, created);
        flight = created;
      }
      const current = flight;
      current.waiters += 1;
      return new Promise<Result<T>>((resolve) => {
        const onAbort = (): void => {
          current.waiters -= 1;
          if (current.waiters === 0) current.controller.abort(signal.reason);
          resolve(err(AbortedError({ cause: signal.reason })));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        const detach = new AbortController();
        signal.addEventListener('abort', onAbort, { once: true, signal: detach.signal });
        void current.promise.then((result) => {
          detach.abort();
          resolve(result);
        });
      });
    },
    inFlight(key) {
      return flights.has(key);
    },
  };
}

/** Run tasks concurrently and collect every result (never short-circuits). */
export async function settleAll<T>(tasks: readonly Task<T>[], signal: AbortSignal): Promise<readonly Result<T>[]> {
  return Promise.all(tasks.map((t) => t(signal)));
}

export interface Limiter {
  run<T>(inner: Task<T>, signal: AbortSignal): Promise<Result<T>>;
  readonly active: number;
  readonly queued: number;
}

/** Limit concurrency. Queued tasks whose signal aborts are dropped without running. */
export function createLimiter(concurrency: number): Limiter {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = (): void => {
    if (active >= concurrency) return;
    const start = queue.shift();
    start?.();
  };
  return {
    get active() {
      return active;
    },
    get queued() {
      return queue.length;
    },
    run<T>(inner: Task<T>, signal: AbortSignal): Promise<Result<T>> {
      return new Promise((resolve) => {
        // Aborted to detach the abort listener once the task leaves the queue.
        const detach = new AbortController();
        const start = (): void => {
          detach.abort();
          if (signal.aborted) {
            resolve(err(AbortedError({ cause: signal.reason })));
            next();
            return;
          }
          active += 1;
          void inner(signal).then((result) => {
            active -= 1;
            resolve(result);
            next();
          });
        };
        const onAbort = (): void => {
          const index = queue.indexOf(start);
          if (index >= 0) queue.splice(index, 1);
          resolve(err(AbortedError({ cause: signal.reason })));
        };
        signal.addEventListener('abort', onAbort, { once: true, signal: detach.signal });
        queue.push(start);
        next();
      });
    },
  };
}

export const CircuitOpenError = defineError(
  'SF-ASYNC-002',
  'unavailable',
  'The circuit breaker is open; the call was not attempted.',
  'The dependency is failing repeatedly. Show degraded UI and let the breaker half-open after its reset window.',
);

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  readonly failureThreshold: number;
  readonly resetAfterMs: number;
  readonly now?: () => number;
  /** Which errors count as failures. Default: network | timeout | unavailable. */
  readonly isFailure?: (error: SfError) => boolean;
  readonly onStateChange?: (state: CircuitState) => void;
}

export interface CircuitBreaker {
  readonly state: CircuitState;
  run<T>(inner: Task<T>, signal: AbortSignal): Promise<Result<T>>;
  reset(): void;
}

export function createCircuitBreaker(options: CircuitBreakerOptions): CircuitBreaker {
  const now = options.now ?? Date.now;
  const isFailure = options.isFailure ?? ((e: SfError) => e.kind === 'network' || e.kind === 'timeout' || e.kind === 'unavailable');
  let state: CircuitState = 'closed';
  let failures = 0;
  let openedAt = 0;
  const setState = (next: CircuitState): void => {
    if (state === next) return;
    state = next;
    options.onStateChange?.(next);
  };
  return {
    get state() {
      if (state === 'open' && now() - openedAt >= options.resetAfterMs) setState('half-open');
      return state;
    },
    async run<T>(inner: Task<T>, signal: AbortSignal): Promise<Result<T>> {
      if (this.state === 'open') return err(CircuitOpenError());
      const result = await inner(signal);
      if (result.ok) {
        failures = 0;
        setState('closed');
      } else if (isFailure(result.error)) {
        failures += 1;
        if (state === 'half-open' || failures >= options.failureThreshold) {
          openedAt = now();
          setState('open');
        }
      }
      return result;
    },
    reset() {
      failures = 0;
      setState('closed');
    },
  };
}
