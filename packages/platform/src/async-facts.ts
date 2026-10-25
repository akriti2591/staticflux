/**
 * Async fact lane (SF-Δ26, R18.14): platform facts that need a round trip (a GPU adapter,
 * a codec matrix, a worker probe) are probed **off the boot path**. `start()` schedules the
 * declared facts on idle and returns at once; readers see `idle → probing → settled | failed`
 * reactively and decide for themselves whether to wait (`probe()` single-flights and caches).
 *
 * A fact is a typed definition object (`defineAsyncFact`); the lane is keyed by that object,
 * never by a string. Every probe runs under a timeout and the caller's `AbortSignal`, and a probe
 * that throws or times out settles the fact as `failed` with `SF-PLAT-009`, never an exception.
 *
 * ```ts
 * const lane = createAsyncFactLane({ env, scope, facts: [webGpuAdapterFact, codecSupportFact] });
 * lane.start();                                  // never awaited at boot
 * const adapter = await lane.probe(webGpuAdapterFact); // joins the running probe
 * ```
 */
import {
  AbortedError,
  box,
  type Box,
  createMachine,
  createNoopTelemetry,
  defineMachine,
  err,
  type Machine,
  metric,
  ok,
  type Result,
  type Scope,
  type SfError,
  type Telemetry,
  timeout,
  toSfError,
  untracked,
} from '@staticflux/core';
import { type PlatformEnv, readGlobal } from './env.js';
import { AsyncFactProbeFailedError } from './errors.js';

export const ASYNC_FACTS_SUBSYSTEM = 'platform/async-facts' as const;

/** `<package>/<name>`, e.g. `platform/webgpu-adapter`. */
export type AsyncFactId = `${string}/${string}`;

export interface AsyncFactDefinition<T, Id extends AsyncFactId = AsyncFactId> {
  readonly kind: 'async-fact';
  readonly id: Id;
  /** Per probe. Default 5000 ms. */
  readonly timeoutMs: number;
  /** Must not throw for "absent" (return a value that says so); throwing marks the fact failed. */
  probe(env: PlatformEnv, signal: AbortSignal): Promise<T>;
  readonly description?: string;
}

export const DEFAULT_ASYNC_FACT_TIMEOUT_MS = 5000;

/* @__NO_SIDE_EFFECTS__ */
export function defineAsyncFact<T, const Id extends AsyncFactId = AsyncFactId>(definition: {
  readonly id: Id;
  readonly probe: (env: PlatformEnv, signal: AbortSignal) => Promise<T>;
  readonly timeoutMs?: number;
  readonly description?: string;
}): AsyncFactDefinition<T, Id> {
  return Object.freeze({ timeoutMs: DEFAULT_ASYNC_FACT_TIMEOUT_MS, ...definition, kind: 'async-fact' });
}

export const asyncFactMachine = defineMachine({
  id: 'platform/async-fact',
  initial: 'idle',
  states: ['idle', 'probing', 'settled', 'failed', 'disposed'],
  transitions: {
    idle: { probe: 'probing', dispose: 'disposed' },
    probing: { settle: 'settled', fail: 'failed', cancel: 'idle', dispose: 'disposed' },
    settled: { probe: 'probing', dispose: 'disposed' },
    failed: { probe: 'probing', dispose: 'disposed' },
  },
  terminal: ['disposed'],
});
export type AsyncFactState = (typeof asyncFactMachine.states)[number];
type AsyncFactEvent = 'probe' | 'settle' | 'fail' | 'cancel' | 'dispose';

export interface AsyncFactReading<T> {
  readonly state: AsyncFactState;
  /** Set once `settled` (kept while a refresh is probing). */
  readonly value: T | undefined;
  /** Set when `failed`. */
  readonly error: SfError | undefined;
}

export const asyncFactDuration = /* @__PURE__ */ metric.histogram('platform/async-fact-duration', {
  unit: 'ms',
  description: 'Time to probe one async platform fact (GPU adapter, codec matrix, OPFS sync handles).',
});

export interface AsyncFactProbeOptions {
  readonly signal?: AbortSignal;
  /** Probe again even if the fact is settled or failed. */
  readonly refresh?: boolean;
}

export interface AsyncFactLane {
  /** Current reading. Reactive. Facts not declared at creation are tracked on first use. */
  read<T>(fact: AsyncFactDefinition<T>): AsyncFactReading<T>;
  /** Settled value (cached), or join / start a probe. Never throws. */
  probe<T>(fact: AsyncFactDefinition<T>, options?: AsyncFactProbeOptions): Promise<Result<T>>;
  /** Schedule every declared, still idle fact on idle time. Returns at once. */
  start(): void;
  /** Untracked plain copy keyed by fact id (devtools, worker replication). */
  snapshot(): Readonly<Record<string, AsyncFactReading<unknown>>>;
  /** Declared facts, in order. */
  readonly facts: readonly AsyncFactDefinition<unknown>[];
}

export interface AsyncFactLaneOptions {
  readonly env: PlatformEnv;
  /** Owns the lane; disposing aborts running probes and freezes readings. */
  readonly scope: Scope;
  readonly facts?: readonly AsyncFactDefinition<unknown>[];
  readonly telemetry?: Telemetry;
  /** Runs `start()`'s probes. Default: `requestIdleCallback` (1 s timeout), else `setTimeout(0)`. */
  readonly schedule?: (task: () => void) => void;
}

/** Idle scheduler read through `PlatformEnv` (falls back to a macrotask, then a microtask). */
export function idleSchedule(env: PlatformEnv): (task: () => void) => void {
  const idle = readGlobal(env, 'requestIdleCallback') as ((cb: () => void, options?: { timeout: number }) => unknown) | undefined;
  if (typeof idle === 'function') return (task) => void idle(task, { timeout: 1000 });
  const later = readGlobal(env, 'setTimeout') as ((cb: () => void, ms: number) => unknown) | undefined;
  if (typeof later === 'function') return (task) => void later(task, 0);
  return (task) => queueMicrotask(task);
}

/** One shared probe run; aborted only when every waiting caller aborted (or the lane is disposed). */
interface Flight {
  readonly promise: Promise<Result<unknown>>;
  readonly controller: AbortController;
  waiters: number;
}

interface Entry {
  readonly fact: AsyncFactDefinition<unknown>;
  readonly machine: Machine<AsyncFactState, AsyncFactEvent>;
  readonly reading: Box<AsyncFactReading<unknown>>;
  flight: Flight | undefined;
}

const IDLE_READING: AsyncFactReading<never> = Object.freeze({ state: 'idle', value: undefined, error: undefined });

/** Wait for a flight under the caller's signal; the last caller to abort aborts the flight. */
function join(flight: Flight, signal: AbortSignal): Promise<Result<unknown>> {
  flight.waiters += 1;
  return new Promise((resolve) => {
    const detach = new AbortController();
    const onAbort = (): void => {
      detach.abort();
      flight.waiters -= 1;
      if (flight.waiters === 0) flight.controller.abort(signal.reason);
      resolve(err(AbortedError({ cause: signal.reason })));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true, signal: detach.signal });
    void flight.promise.then((result) => {
      detach.abort();
      resolve(result);
    });
  });
}

export function createAsyncFactLane(options: AsyncFactLaneOptions): AsyncFactLane {
  const { env, scope } = options;
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const schedule = options.schedule ?? idleSchedule(env);
  const declared = [...(options.facts ?? [])];
  const entries = new Map<AsyncFactDefinition<unknown>, Entry>();

  const entryOf = (fact: AsyncFactDefinition<unknown>): Entry => {
    let entry = entries.get(fact);
    if (entry === undefined) {
      entry = { fact, machine: createMachine(asyncFactMachine), reading: box<AsyncFactReading<unknown>>(IDLE_READING), flight: undefined };
      if (scope.disposed) {
        entry.machine.send('dispose');
        entry.reading.set({ ...IDLE_READING, state: 'disposed' });
      }
      entries.set(fact, entry);
    }
    return entry;
  };
  for (const fact of declared) entryOf(fact);

  const transition = (entry: Entry, event: AsyncFactEvent, next: Omit<AsyncFactReading<unknown>, 'state'>): void => {
    if (!entry.machine.can(event)) return;
    entry.machine.send(event);
    entry.reading.set({ state: entry.machine.state, ...next });
  };

  /** Start the shared probe. State transitions follow the flight, never a single caller. */
  const startFlight = (entry: Entry): Flight => {
    const { fact } = entry;
    const previous = untracked(() => entry.reading.get());
    transition(entry, 'probe', { value: previous.value, error: undefined });
    const span = telemetry.span('platform.async-fact', { subsystem: ASYNC_FACTS_SUBSYSTEM, attrs: { fact: fact.id } });
    const started = telemetry.now();
    const controller = new AbortController();
    const task = timeout(async (inner: AbortSignal): Promise<Result<unknown>> => {
      try {
        return ok(await fact.probe(env, inner));
      } catch (error) {
        return err(toSfError(error));
      }
    }, fact.timeoutMs);
    const promise = task(controller.signal).then((result): Result<unknown> => {
      entry.flight = undefined;
      telemetry.record(asyncFactDuration, telemetry.now() - started, { fact: fact.id });
      if (result.ok) {
        transition(entry, 'settle', { value: result.value, error: undefined });
        span.end('ok');
        return result;
      }
      if (controller.signal.aborted) {
        // Every caller gave up (or the lane was disposed): back to idle so the next caller probes again.
        transition(entry, 'cancel', { value: previous.value, error: undefined });
        span.end('cancelled', result.error);
        return err(AbortedError({ cause: controller.signal.reason }));
      }
      const failure = AsyncFactProbeFailedError({ cause: result.error, details: { fact: fact.id, code: result.error.code } });
      transition(entry, 'fail', { value: undefined, error: failure });
      span.end('error', failure);
      return err(failure);
    });
    const flight: Flight = { promise, controller, waiters: 0 };
    entry.flight = flight;
    return flight;
  };

  const lane: AsyncFactLane = {
    facts: declared,
    read<T>(fact: AsyncFactDefinition<T>): AsyncFactReading<T> {
      return entryOf(fact).reading.get() as AsyncFactReading<T>;
    },
    async probe<T>(fact: AsyncFactDefinition<T>, probeOptions: AsyncFactProbeOptions = {}): Promise<Result<T>> {
      const entry = entryOf(fact);
      const signal = probeOptions.signal ?? scope.signal;
      // A cancelled run is still unwinding: let it finish instead of joining it (it would report "aborted").
      if (entry.flight?.controller.signal.aborted === true) await entry.flight.promise;
      const current = untracked(() => entry.reading.get());
      if (current.state === 'disposed' || scope.disposed) {
        return err(AsyncFactProbeFailedError({ message: `Async fact "${fact.id}": lane disposed.`, details: { fact: fact.id } }));
      }
      if (probeOptions.refresh !== true && entry.flight === undefined) {
        if (current.state === 'settled') return ok(current.value as T);
        if (current.state === 'failed' && current.error !== undefined) return err(current.error);
      }
      return (await join(entry.flight ?? startFlight(entry), signal)) as Result<T>;
    },
    start() {
      for (const fact of declared) {
        if (untracked(() => entryOf(fact).reading.get()).state !== 'idle') continue;
        schedule(() => {
          if (scope.disposed || untracked(() => entryOf(fact).reading.get()).state !== 'idle') return;
          void lane.probe(fact);
        });
      }
    },
    snapshot() {
      return untracked(() => Object.fromEntries([...entries.values()].map((entry) => [entry.fact.id, entry.reading.get()])));
    },
  };

  scope.defer(() => {
    for (const entry of entries.values()) {
      const last = untracked(() => entry.reading.get());
      transition(entry, 'dispose', { value: last.value, error: last.error });
      entry.flight?.controller.abort(new DOMException('Async fact lane disposed.', 'AbortError'));
    }
  });
  return lane;
}
