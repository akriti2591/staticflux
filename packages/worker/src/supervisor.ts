/**
 * Supervised workers (R11.5, R11.11, docs/LIFECYCLES.md §3).
 *
 *   idle → spawning → handshaking → ready ⇄ busy
 *   ready|busy → unresponsive (missed heartbeat) → crashed      (→ ready if a heartbeat recovers)
 *   error event → crashed → respawning → spawning
 *   crashed (intensity exceeded) → failed                         (declared fallback activated)
 *   ready|busy|… → draining → terminated
 *
 * A supervised worker is `Subsystem`-shaped (id, dependsOn, start, pause,
 * resume, refresh, stop) so the runtime supervisor can drive it. Lifecycle
 * commands propagate to the worker over `sf/control`. On every (re)spawn the
 * handshake carries the core contexts and a rehydration payload; replicas
 * re-handshake; idempotent in-flight requests are retried, others fail with
 * SF-WK-004.
 */
import {
  AbortedError,
  backoffDelay,
  createDeferred,
  createMachine,
  createNoopTelemetry,
  createScope,
  defineMachine,
  err,
  type Machine,
  metric,
  ok,
  type Result,
  type Scope,
  type SfError,
  type Span,
  type SpanContext,
  type Telemetry,
  type TransitionRecord,
} from '@staticflux/core';
import type { TokenBroker } from './broker.js';
import { type Clock, systemClock } from './clock.js';
import type { ContextHub } from './context.js';
import type { HelloMessage, ReadyMessage } from './control.js';
import { Channels } from './envelope.js';
import {
  HandshakeTimeoutError,
  ProtocolMismatchError,
  WorkerCrashedError,
  WorkerFailedError,
  WorkerNotRunningError,
  WorkerUnresponsiveError,
} from './errors.js';
import { createLink, type Link, type MessageContext } from './link.js';
import {
  type AnyProtocol,
  type ArgsOf,
  type EventName,
  type EventPayload,
  isProtocolMessage,
  type ProtocolEventPayload,
  type RequestName,
  type ResultOf,
} from './protocol.js';
import type { Publisher } from './replication.js';
import { createProtocolClient, type ProtocolClient } from './rpc.js';
import type { Spawner } from './spawn.js';
import { type ForwardTarget, receiveForwardedTelemetry } from './telemetry-forward.js';

// ---------------------------------------------------------------- machine

export const WorkerLifecycle = defineMachine({
  id: 'worker',
  initial: 'idle',
  states: [
    'idle',
    'spawning',
    'handshaking',
    'ready',
    'busy',
    'unresponsive',
    'crashed',
    'respawning',
    'failed',
    'draining',
    'terminated',
  ],
  transitions: {
    idle: { spawn: 'spawning', terminate: 'terminated' },
    spawning: { spawned: 'handshaking', crash: 'crashed', drain: 'draining' },
    handshaking: { 'handshake-ok': 'ready', crash: 'crashed', drain: 'draining' },
    ready: { work: 'busy', 'heartbeat-missed': 'unresponsive', crash: 'crashed', drain: 'draining' },
    busy: { idle: 'ready', 'heartbeat-missed': 'unresponsive', crash: 'crashed', drain: 'draining' },
    unresponsive: { 'heartbeat-ok': 'ready', crash: 'crashed', drain: 'draining' },
    crashed: { respawn: 'respawning', 'give-up': 'failed', drain: 'draining' },
    respawning: { spawn: 'spawning', drain: 'draining' },
    failed: { spawn: 'spawning', terminate: 'terminated' },
    draining: { drained: 'terminated' },
  },
  terminal: ['terminated'],
});

export type WorkerState = (typeof WorkerLifecycle.states)[number];
export type WorkerLifecycleEvent =
  | 'spawn'
  | 'spawned'
  | 'handshake-ok'
  | 'work'
  | 'idle'
  | 'heartbeat-missed'
  | 'heartbeat-ok'
  | 'crash'
  | 'respawn'
  | 'give-up'
  | 'drain'
  | 'drained'
  | 'terminate';

export const WorkerMetrics = {
  restarts: metric.counter('worker/restarts', { description: 'Worker respawns after a crash.' }),
  handshakeMs: metric.histogram('worker/handshake-ms', { unit: 'ms', description: 'Spawn → ready, incl. replica sync.' }),
  missedHeartbeats: metric.counter('worker/missed-heartbeats'),
} as const;

// ---------------------------------------------------------------- spec

export interface WorkerFallback {
  /** What the app does without this worker (shown in devtools; R4.4). */
  readonly description: string;
  activate?(error: SfError): void;
  deactivate?(): void;
}

export interface RestartPolicy {
  /** Max restarts within `periodMs` before giving up (OTP intensity). Default 3. */
  readonly intensity?: number;
  readonly periodMs?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly jitter?: 'full' | 'none';
  readonly random?: () => number;
}

export interface HeartbeatPolicy {
  readonly intervalMs?: number;
  /** A ping not answered within this is a missed heartbeat. */
  readonly timeoutMs?: number;
  /** Consecutive misses before the worker is treated as crashed. Default 3. */
  readonly maxMissed?: number;
}

/** Anything that re-handshakes on a new link (e.g. `createReplica()`). */
export interface AttachableReplica {
  attach(link: Link, scope?: Scope): Promise<Result<void>>;
}

export interface WorkerSpec<P extends AnyProtocol> {
  /** Subsystem id, e.g. `studio/document-worker`. */
  readonly id: `${string}/${string}`;
  readonly dependsOn?: readonly string[];
  readonly protocol: P;
  readonly spawn: Spawner;
  /** Declared fallback for give-up (required: every worker declares one). */
  readonly fallback: WorkerFallback;
  /** Core contexts replicated in the handshake and kept in sync. */
  readonly contexts?: ContextHub;
  /** Main-owned stores replicated into the worker. Attached before the handshake. */
  readonly publishers?: readonly Publisher[];
  /** Worker-owned stores replicated to the main thread. Synced before `ready`. */
  readonly replicas?: readonly AttachableReplica[];
  readonly broker?: TokenBroker;
  /** Where worker telemetry goes (R11.6). */
  readonly telemetryTarget?: ForwardTarget;
  /** Rehydration payload for the handshake (e.g. last document archive). */
  readonly rehydrate?: () => unknown;
  /** Extra wiring per spawn, after the handshake and before `ready`. */
  readonly connect?: (link: Link, scope: Scope) => void | Result<void> | Promise<Result<void>>;
  readonly heartbeat?: HeartbeatPolicy | false;
  readonly restart?: RestartPolicy;
  readonly handshakeTimeoutMs?: number;
  readonly drainTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly validate?: boolean;
  readonly telemetry?: Telemetry;
  readonly clock?: Clock;
}

// ---------------------------------------------------------------- subsystem shape

export interface SubsystemStartContext {
  readonly signal?: AbortSignal;
  readonly epoch?: number;
}

/** Structural mirror of the runtime's `Subsystem` contract (ARCHITECTURE §4.2). */
export interface SubsystemLike {
  readonly id: string;
  readonly dependsOn: readonly string[];
  start(context?: SubsystemStartContext): Promise<Result<void>>;
  pause(): void;
  resume(): void;
  refresh(epoch: number): Promise<Result<void>>;
  stop(reason?: unknown): Promise<Result<void>>;
}

export interface SupervisedRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly parent?: Span | SpanContext;
}

export interface WorkerInspection {
  readonly id: string;
  readonly state: WorkerState;
  readonly attempt: number;
  readonly restarts: number;
  readonly paused: boolean;
  readonly epoch: number;
  readonly queued: number;
  readonly inFlight: number;
  readonly lastError: string | undefined;
  readonly fallback: { readonly description: string; readonly active: boolean };
}

export interface SupervisedWorker<P extends AnyProtocol> extends SubsystemLike {
  readonly machine: Machine<WorkerState, WorkerLifecycleEvent>;
  /** Reactive. */
  readonly state: WorkerState;
  readonly paused: boolean;
  readonly epoch: number;
  readonly lastError: SfError | undefined;
  /** Current link (undefined between spawns). */
  readonly link: Link | undefined;
  request<K extends RequestName<P>>(
    name: K,
    args: ArgsOf<P, K>,
    options?: SupervisedRequestOptions,
  ): Promise<Result<ResultOf<P, K>>>;
  /** Protocol events from the worker; survives respawns. */
  on<K extends EventName<P>>(name: K, listener: (payload: EventPayload<P, K>, context: MessageContext) => void): () => void;
  whenReady(signal?: AbortSignal): Promise<Result<void>>;
  /** Manual restart from `failed` (resets the intensity window). */
  restart(): Promise<Result<void>>;
  onStateChange(listener: (record: TransitionRecord<WorkerState, WorkerLifecycleEvent>) => void): () => void;
  inspect(): WorkerInspection;
}

// ---------------------------------------------------------------- implementation

interface Attempt {
  readonly gen: number;
  readonly scope: Scope;
  link: Link | undefined;
  client: ProtocolClient<AnyProtocol> | undefined;
  handshaken: boolean;
}

interface Entry {
  readonly name: string;
  readonly args: unknown;
  readonly options: SupervisedRequestOptions;
  readonly idempotent: boolean;
  token: number;
  settled: boolean;
  resolve(result: Result<unknown>): void;
}

const SUBSYSTEM = 'worker/supervisor';

export function createSupervisedWorker<P extends AnyProtocol>(spec: WorkerSpec<P>): SupervisedWorker<P> {
  const telemetry = spec.telemetry ?? createNoopTelemetry();
  const clock = spec.clock ?? systemClock;
  const heartbeat =
    spec.heartbeat === false ? undefined : { intervalMs: 5_000, timeoutMs: 2_000, maxMissed: 3, ...spec.heartbeat };
  const policy = {
    intensity: spec.restart?.intensity ?? 3,
    periodMs: spec.restart?.periodMs ?? 60_000,
    baseDelayMs: spec.restart?.baseDelayMs ?? 100,
    maxDelayMs: spec.restart?.maxDelayMs ?? 5_000,
    jitter: spec.restart?.jitter ?? 'full',
    random: spec.restart?.random ?? Math.random,
  };
  const handshakeTimeoutMs = spec.handshakeTimeoutMs ?? 10_000;
  const drainTimeoutMs = spec.drainTimeoutMs ?? 5_000;
  const validate = spec.validate ?? true;
  const root = createScope(`worker:${spec.id}`);

  const machine = createMachine(WorkerLifecycle, {
    onInvalid: (state, event) => {
      telemetry.event('lifecycle.worker.invalid', { subsystem: SUBSYSTEM, level: 'debug', attrs: { worker: spec.id, state, event } });
    },
  });
  machine.onTransition(({ from, to, event }) => {
    telemetry.event(`lifecycle.worker.${from}→${to}`, {
      subsystem: SUBSYSTEM,
      level: to === 'crashed' || to === 'failed' ? 'critical' : 'verbose',
      attrs: { worker: spec.id, event },
    });
  });
  const go = (event: WorkerLifecycleEvent): boolean => machine.send(event).ok;

  let epoch = 0;
  let paused = false;
  let attempt = 0;
  let generation = 0;
  let restarts = 0;
  let restartTimes: number[] = [];
  let respawnTimer: unknown;
  let heartbeatTimer: unknown;
  let lastError: SfError | undefined;
  let fallbackActive = false;
  let current: Attempt | undefined;
  const queue: Entry[] = [];
  const inFlight = new Set<Entry>();
  let readyWaiters: ((result: Result<void>) => void)[] = [];
  const eventListeners = new Map<string, Set<(payload: unknown, context: MessageContext) => void>>();

  const settleWaiters = (result: Result<void>): void => {
    const waiters = readyWaiters;
    readyWaiters = [];
    for (const waiter of waiters) waiter(result);
  };

  const updateBusy = (): void => {
    if (inFlight.size > 0 && machine.is('ready')) go('work');
    else if (inFlight.size === 0 && machine.is('busy')) go('idle');
  };

  const send = (entry: Entry, client: ProtocolClient<AnyProtocol>): void => {
    entry.token += 1;
    const token = entry.token;
    inFlight.add(entry);
    void client
      .request(entry.name, entry.args, {
        signal: entry.options.signal,
        timeoutMs: entry.options.timeoutMs,
        parent: entry.options.parent,
      })
      .then((result) => {
        if (entry.token !== token || entry.settled) return;
        inFlight.delete(entry);
        entry.resolve(result);
        updateBusy();
      });
  };

  const dispatch = (): void => {
    const client = current?.client;
    if (client === undefined || paused || !machine.is('ready', 'busy')) return;
    while (queue.length > 0) send(queue.shift() as Entry, client);
    updateBusy();
  };

  const failQueued = (error: SfError): void => {
    for (const entry of queue.splice(0)) entry.resolve(err(error));
    for (const entry of [...inFlight]) {
      inFlight.delete(entry);
      entry.resolve(err(error));
    }
  };

  const stopHeartbeat = (): void => {
    clock.clearTimeout(heartbeatTimer);
    heartbeatTimer = undefined;
  };

  const startHeartbeat = (attemptRef: Attempt, link: Link): void => {
    if (heartbeat === undefined) return;
    let missed = 0;
    let expectedAt = 0;
    const schedule = (): void => {
      expectedAt = clock.now() + heartbeat.intervalMs;
      heartbeatTimer = clock.setTimeout(() => void tick(), heartbeat.intervalMs);
    };
    const tick = async (): Promise<void> => {
      if (attemptRef.gen !== generation) return;
      const lateBy = clock.now() - expectedAt;
      // Paused: nothing runs (I-1). Fired very late: our own thread was frozen or
      // throttled (background tab) — do not blame the worker for that interval (R11.4).
      if (paused || lateBy > heartbeat.intervalMs * 2) {
        schedule();
        return;
      }
      const pong = await link.request(Channels.control, { type: 'ping' }, { timeoutMs: heartbeat.timeoutMs });
      if (attemptRef.gen !== generation) return;
      if (pong.ok) {
        missed = 0;
        if (machine.is('unresponsive')) {
          go('heartbeat-ok');
          dispatch();
          updateBusy();
        }
      } else if (pong.error.kind === 'timeout') {
        missed += 1;
        telemetry.record(WorkerMetrics.missedHeartbeats, 1, { worker: spec.id });
        if (machine.is('ready', 'busy')) go('heartbeat-missed');
        if (missed >= heartbeat.maxMissed) {
          crash(attemptRef.gen, WorkerUnresponsiveError({ details: { worker: spec.id, missed } }));
          return;
        }
      } else {
        return; // link closed — crash/stop handles it
      }
      schedule();
    };
    schedule();
  };

  const giveUp = (cause: SfError): void => {
    go('give-up');
    const failure = WorkerFailedError({ cause, units: [spec.id], details: { worker: spec.id, restarts, fallback: spec.fallback.description } });
    lastError = failure;
    fallbackActive = true;
    telemetry.event('worker.failed', {
      subsystem: SUBSYSTEM,
      level: 'critical',
      attrs: { worker: spec.id, cause: cause.code, fallback: spec.fallback.description },
    });
    spec.fallback.activate?.(failure);
    failQueued(failure);
    settleWaiters(err(failure));
  };

  const crash = (gen: number, error: SfError): void => {
    if (current === undefined || current.gen !== gen || gen !== generation) return;
    if (!go('crash')) return;
    lastError = error;
    telemetry.event('worker.crashed', {
      subsystem: SUBSYSTEM,
      level: 'critical',
      attrs: { worker: spec.id, code: error.code, message: error.message, attempt },
    });
    const dead = current;
    current = undefined;
    generation += 1;
    stopHeartbeat();
    // In-flight: idempotent requests go back to the queue, others fail (LIFECYCLES §3).
    for (const entry of [...inFlight].reverse()) {
      inFlight.delete(entry);
      entry.token += 1;
      if (entry.idempotent && entry.options.signal?.aborted !== true) queue.unshift(entry);
      else entry.resolve(err(WorkerCrashedError({ cause: error, details: { worker: spec.id, request: entry.name } })));
    }
    void dead.scope.dispose();
    const now = clock.now();
    restartTimes = restartTimes.filter((t) => now - t < policy.periodMs);
    if (restartTimes.length >= policy.intensity) {
      giveUp(error);
      return;
    }
    restartTimes.push(now);
    restarts += 1;
    telemetry.record(WorkerMetrics.restarts, 1, { worker: spec.id });
    go('respawn');
    const delay = backoffDelay(restartTimes.length, policy.baseDelayMs, policy.maxDelayMs, policy.jitter, policy.random);
    respawnTimer = clock.setTimeout(() => {
      respawnTimer = undefined;
      void spawnOnce();
    }, delay);
  };

  const spawnOnce = async (): Promise<void> => {
    if (!go('spawn')) return;
    generation += 1;
    attempt += 1;
    const gen = generation;
    const scope = root.child(`spawn-${attempt}`);
    const self: Attempt = { gen, scope, link: undefined, client: undefined, handshaken: false };
    current = self;
    const started = clock.now();
    const span = telemetry.span('worker.spawn', { subsystem: SUBSYSTEM, level: 'standard', attrs: { worker: spec.id, attempt } });
    const live = (): boolean => gen === generation && current === self;
    const fail = (error: SfError): void => {
      span.end('error', error);
      crash(gen, error);
    };

    const spawned = await spec.spawn({ signal: scope.signal, attempt });
    if (!live()) {
      if (spawned.ok) spawned.value.terminate();
      span.end('cancelled');
      return;
    }
    if (!spawned.ok) {
      fail(spawned.error);
      return;
    }
    const { port, terminate } = spawned.value;
    scope.defer(terminate);
    const link = createLink({
      port,
      name: `${spec.id}#${attempt}`,
      epoch,
      telemetry,
      clock,
      ...(spec.requestTimeoutMs === undefined ? {} : { defaultTimeoutMs: spec.requestTimeoutMs }),
    });
    self.link = link;
    scope.defer(() => link.close());
    scope.defer(port.onError((error) => crash(gen, error)));
    go('spawned');

    // Owner-side services first, so the worker can use them during its setup.
    if (spec.telemetryTarget !== undefined) scope.defer(receiveForwardedTelemetry(link, spec.telemetryTarget, spec.id));
    spec.broker?.attach(link, scope);
    spec.contexts?.attach(link, scope);
    for (const publisher of spec.publishers ?? []) publisher.attach(link, scope);
    scope.defer(
      link.on(spec.protocol.id, (raw, context) => {
        if (!isProtocolMessage(raw, 'payload')) return;
        const message = raw as unknown as ProtocolEventPayload;
        const set = eventListeners.get(message.name);
        if (set === undefined) return;
        const definition = spec.protocol.events[message.name];
        if (validate && definition !== undefined && !definition.payload.check(message.payload).ok) return;
        for (const listener of [...set]) listener(message.payload, context);
      }),
    );

    const hello: HelloMessage = {
      type: 'hello',
      workerId: spec.id,
      attempt,
      epoch,
      paused,
      protocol: { id: spec.protocol.id, version: spec.protocol.version },
      contexts: spec.contexts?.snapshot() ?? {},
      rehydrate: spec.rehydrate?.(),
    };
    const handshake = await link.request(Channels.control, hello, { timeoutMs: handshakeTimeoutMs, parent: span });
    if (!live()) return;
    if (!handshake.ok) {
      fail(
        handshake.error.kind === 'timeout'
          ? HandshakeTimeoutError({ cause: handshake.error, details: { worker: spec.id, timeoutMs: handshakeTimeoutMs } })
          : handshake.error,
      );
      return;
    }
    const ready = handshake.value as ReadyMessage;
    if (ready?.protocol?.id !== spec.protocol.id || ready.protocol.version !== spec.protocol.version) {
      fail(ProtocolMismatchError({ details: { expected: `${spec.protocol.id}@${spec.protocol.version}`, received: `${ready?.protocol?.id}@${ready?.protocol?.version}` } }));
      return;
    }
    self.handshaken = true;
    self.client = createProtocolClient(link, spec.protocol, { validate });

    for (const replica of spec.replicas ?? []) {
      const synced = await replica.attach(link, scope);
      if (!live()) return;
      if (!synced.ok) {
        fail(synced.error);
        return;
      }
    }
    if (spec.connect !== undefined) {
      const connected = await spec.connect(link, scope);
      if (!live()) return;
      if (connected !== undefined && !connected.ok) {
        fail(connected.error);
        return;
      }
    }
    if (!go('handshake-ok')) return;
    span.end('ok');
    telemetry.record(WorkerMetrics.handshakeMs, clock.now() - started, { worker: spec.id, attempt });
    settleWaiters(ok());
    startHeartbeat(self, link);
    dispatch();
  };

  const control = (message: { type: 'pause' | 'resume' }): void => {
    const link = current?.link;
    if (link === undefined || current?.handshaken !== true) return;
    void link.request(Channels.control, message);
  };

  const whenReady = (signal?: AbortSignal): Promise<Result<void>> => {
    if (machine.is('ready', 'busy')) return Promise.resolve(ok());
    if (machine.is('failed')) return Promise.resolve(err(lastError ?? WorkerFailedError()));
    if (machine.is('draining', 'terminated')) return Promise.resolve(err(WorkerNotRunningError({ details: { worker: spec.id } })));
    if (signal?.aborted === true) return Promise.resolve(err(AbortedError({ cause: signal.reason })));
    const deferred = createDeferred<Result<void>>();
    // Aborted to detach the abort listener once the waiter is resolved.
    const detach = new AbortController();
    const waiter = (result: Result<void>): void => {
      detach.abort();
      deferred.resolve(result);
    };
    readyWaiters.push(waiter);
    signal?.addEventListener(
      'abort',
      () => {
        readyWaiters = readyWaiters.filter((w) => w !== waiter);
        deferred.resolve(err(AbortedError({ cause: signal.reason })));
      },
      { once: true, signal: detach.signal },
    );
    return deferred.promise;
  };

  const worker: SupervisedWorker<P> = {
    id: spec.id,
    dependsOn: spec.dependsOn ?? [],
    machine,
    get state() {
      return machine.state;
    },
    get paused() {
      return paused;
    },
    get epoch() {
      return epoch;
    },
    get lastError() {
      return lastError;
    },
    get link() {
      return current?.link;
    },
    start(context = {}) {
      if (context.epoch !== undefined) epoch = context.epoch;
      if (machine.is('idle')) void spawnOnce();
      return whenReady(context.signal);
    },
    pause() {
      if (paused) return;
      paused = true;
      control({ type: 'pause' });
    },
    resume() {
      if (!paused) return;
      paused = false;
      control({ type: 'resume' });
      dispatch();
    },
    async refresh(nextEpoch) {
      epoch = nextEpoch;
      const link = current?.link;
      link?.setEpoch(nextEpoch);
      if (link === undefined || current?.handshaken !== true) return ok();
      const result = await link.request(Channels.control, { type: 'refresh', epoch: nextEpoch });
      return result.ok ? ok() : result;
    },
    async stop(reason) {
      clock.clearTimeout(respawnTimer);
      respawnTimer = undefined;
      if (machine.is('terminated')) return ok();
      const notRunning = WorkerNotRunningError({ details: { worker: spec.id, reason: String(reason ?? 'stop') } });
      if (machine.is('idle', 'failed')) {
        go('terminate');
        failQueued(notRunning);
        settleWaiters(err(notRunning));
        await root.dispose();
        return ok();
      }
      go('drain');
      stopHeartbeat();
      const live = current;
      current = undefined;
      generation += 1;
      for (const entry of queue.splice(0)) entry.resolve(err(notRunning));
      settleWaiters(err(notRunning));
      if (live?.link !== undefined && live.handshaken && !live.link.closed) {
        await live.link.request(Channels.control, { type: 'drain' }, { timeoutMs: drainTimeoutMs });
      }
      failQueued(notRunning);
      await live?.scope.dispose();
      go('drained');
      await root.dispose();
      return ok();
    },
    async restart() {
      if (!machine.is('failed')) return whenReady();
      restartTimes = [];
      if (fallbackActive) {
        fallbackActive = false;
        spec.fallback.deactivate?.();
      }
      void spawnOnce();
      return whenReady();
    },
    request(name, args, options = {}) {
      if (machine.is('failed')) return Promise.resolve(err(lastError ?? WorkerFailedError()));
      if (machine.is('draining', 'terminated')) {
        return Promise.resolve(err(WorkerNotRunningError({ details: { worker: spec.id, request: name } })));
      }
      const signal = options.signal;
      if (signal?.aborted === true) return Promise.resolve(err(AbortedError({ cause: signal.reason })));
      const deferred = createDeferred<Result<unknown>>();
      // Aborted to detach the abort listener once the request settles.
      const detach = new AbortController();
      const onAbort = (): void => {
        const index = queue.indexOf(entry);
        if (index >= 0) {
          queue.splice(index, 1);
          entry.resolve(err(AbortedError({ cause: signal?.reason })));
        }
      };
      const entry: Entry = {
        name,
        args,
        options,
        idempotent: spec.protocol.requests[name]?.idempotent === true,
        token: 0,
        settled: false,
        resolve(result) {
          if (entry.settled) return;
          entry.settled = true;
          detach.abort();
          deferred.resolve(result);
        },
      };
      signal?.addEventListener('abort', onAbort, { once: true, signal: detach.signal });
      queue.push(entry);
      dispatch();
      return deferred.promise as Promise<Result<ResultOf<P, typeof name>>>;
    },
    on(name, listener) {
      let set = eventListeners.get(name);
      if (set === undefined) {
        set = new Set();
        eventListeners.set(name, set);
      }
      const typed = listener as (payload: unknown, context: MessageContext) => void;
      set.add(typed);
      return () => {
        set.delete(typed);
      };
    },
    whenReady,
    onStateChange(listener) {
      return machine.onTransition(listener);
    },
    inspect() {
      return {
        id: spec.id,
        state: machine.state,
        attempt,
        restarts,
        paused,
        epoch,
        queued: queue.length,
        inFlight: inFlight.size,
        lastError: lastError?.code,
        fallback: { description: spec.fallback.description, active: fallbackActive },
      };
    },
  };
  return worker;
}
