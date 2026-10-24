/**
 * The app supervisor (R4.1–R4.6, docs/LIFECYCLES.md §1–§2, I-1).
 *
 * - Owns the app machine; app state is derived from subsystem states
 *   (any `given-up` → `degraded`, all recovered → `running`).
 * - Starts subsystems in dependency order, critical ones before `core-ready`.
 * - Restart policy per subsystem: exponential backoff + max restarts per window → `given-up`.
 * - Commands pause/resume/abort/refresh/reinitialize/shutdown are broadcast in
 *   dependency order (reverse for teardown).
 * - One root AbortController for `abort` (replaced after firing, so later work can run).
 * - `refresh` bumps the injector epoch (`injector.refresh('epoch')`).
 * - Features *request* commands; a pluggable CommandPolicy decides.
 * - Paused-request policy (queue vs reject) is exposed for transports via `whenRunnable`.
 */
import {
  AbortedError,
  backoffDelay,
  box,
  createMachine,
  createNoopTelemetry,
  createScope,
  err,
  type Injector,
  type Machine,
  ok,
  type Result,
  type Scope,
  type SfError,
  type Span,
  type Telemetry,
  TimeoutError,
  type TransitionRecord,
} from '@staticflux/core';
import {
  AppPausedError,
  AppTerminatedError,
  BootFailedError,
  CommandDeniedError,
  CommandNotAllowedError,
  SubsystemGaveUpError,
  SubsystemGraphError,
} from './errors.js';
import { defaultNow, defaultSleep, runHook, type Sleep, withDeadline } from './hooks.js';
import {
  ALLOWED_COMMANDS,
  type AppCommand,
  type AppEvent,
  appMachine,
  type AppState,
  subsystemMachine,
  type SubsystemEvent,
  type SubsystemState,
} from './machines.js';
import {
  type CommandPolicy,
  type CommandRequest,
  defaultCommandPolicy,
  defaultPausedRequestPolicy,
  type PausedRequest,
  type PausedRequestPolicy,
} from './policy.js';
import {
  DEFAULT_RESTART_POLICY,
  type StopReason,
  type Subsystem,
  type SubsystemContext,
  type SubsystemId,
  type SubsystemInfo,
} from './subsystem.js';
import { RUNTIME_SUBSYSTEMS, runtimeMetrics, traceMachine } from './telemetry.js';

const SUB = RUNTIME_SUBSYSTEMS.app;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;

export interface CorePhaseContext {
  readonly reason: 'boot' | 'reinitialize';
  /** Root abort signal. */
  readonly signal: AbortSignal;
  readonly epoch: number;
  readonly span: Span;
}

export interface SupervisorOptions {
  readonly telemetry?: Telemetry;
  /** When given, `refresh`/`reinitialize` bump this injector's epoch. */
  readonly injector?: Injector;
  readonly subsystems?: readonly Subsystem[];
  /** Core phase run before critical subsystems (e.g. `injector.resolveCritical`). */
  readonly core?: (context: CorePhaseContext) => Result<void> | Promise<Result<void>>;
  readonly commandPolicy?: CommandPolicy;
  readonly pausedRequestPolicy?: PausedRequestPolicy;
  /** Parent span for boot spans (e.g. `app.boot`). */
  readonly parentSpan?: Span;
  /** Called once at the end of shutdown (e.g. dispose the injector). */
  readonly onShutdown?: () => void | Promise<void>;
  readonly now?: () => number;
  readonly sleep?: Sleep;
  readonly random?: () => number;
}

export interface Supervisor {
  /** App state. Reactive. */
  readonly state: AppState;
  /** App epoch (injector epoch when an injector is attached). Reactive. */
  readonly epoch: number;
  /** Current root abort signal. Pass (or combine) it into in-flight work so `abort` cancels it. */
  readonly signal: AbortSignal;
  is(...states: readonly AppState[]): boolean;
  onTransition(listener: (record: TransitionRecord<AppState, AppEvent>) => void): () => void;

  register(subsystem: Subsystem): Result<void>;
  stateOf(id: SubsystemId): SubsystemState | undefined;
  inspect(): readonly SubsystemInfo[];
  /** Subsystems currently `failed`, `restarting` or `given-up`. */
  impaired(): readonly SubsystemId[];

  /** Boot: core phase + critical subsystems → core-ready → running. Non-critical subsystems start in the background. */
  start(): Promise<Result<void>>;
  /** Resolves when every subsystem start in flight has settled (running or given-up). */
  settled(): Promise<void>;

  can(command: AppCommand): boolean;
  command(command: AppCommand, options?: { readonly reason?: unknown }): Promise<Result<void>>;
  pause(): Promise<Result<void>>;
  resume(): Promise<Result<void>>;
  abort(reason?: unknown): Promise<Result<void>>;
  refresh(): Promise<Result<void>>;
  reinitialize(): Promise<Result<void>>;
  shutdown(): Promise<Result<void>>;
  /** A feature requests an app-wide command; the command policy decides (R4.5). */
  request(request: CommandRequest): Promise<Result<void>>;

  /** I-1 guard: err(SF-APP-001) while paused, err(SF-APP-007) when shutting down / terminated. */
  assertRunnable(operation?: string): Result<void>;
  /**
   * For transports and schedulers: resolves ok() immediately unless paused. While paused,
   * the paused-request policy decides: `queue` waits for resume, `reject` fails with SF-APP-001.
   */
  whenRunnable(request: PausedRequest, signal?: AbortSignal): Promise<Result<void>>;
  /** Plug policies in after construction (e.g. resolved from the injector during boot). */
  usePolicies(policies: { readonly command?: CommandPolicy; readonly pausedRequest?: PausedRequestPolicy }): void;
}

interface SubsystemRecord {
  readonly subsystem: Subsystem;
  readonly machine: Machine<SubsystemState, SubsystemEvent>;
  scope: Scope | undefined;
  context: SubsystemContext | undefined;
  generation: number;
  failures: number[];
  restarts: number;
  error: SfError | undefined;
  impairedOnce: boolean;
  halted: boolean;
  loop: AbortController;
  startPromise: Promise<SubsystemState> | undefined;
}

export function createSupervisor(options: SupervisorOptions = {}): Supervisor {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const now = options.now ?? defaultNow;
  const sleepFn = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const injector = options.injector;
  let commandPolicy: CommandPolicy = options.commandPolicy ?? defaultCommandPolicy;
  let pausedPolicy: PausedRequestPolicy = options.pausedRequestPolicy ?? defaultPausedRequestPolicy;

  const app = createMachine(appMachine, {
    onInvalid: (state, event) =>
      telemetry.event('lifecycle.app.invalid', { subsystem: SUB, level: 'standard', attrs: { state, event } }),
  });
  traceMachine(app, telemetry, SUB, { criticalStates: ['degraded', 'terminated'] });

  const rootScope = createScope('supervisor');
  const ownEpoch = box(0);
  let controller = new AbortController();
  const records = new Map<SubsystemId, SubsystemRecord>();
  let order: SubsystemRecord[] = [];
  let started = false;
  let resuming = false;
  let shutdownPromise: Promise<Result<void>> | undefined;
  const pausedWaiters = new Set<(resumed: boolean) => void>();

  const epochOf = (): number => injector?.epoch ?? ownEpoch.get();
  const isDown = (): boolean => app.is('shutting-down', 'terminated');

  // ------------------------------------------------------------ graph

  /** Topological order; validates unknown deps, cycles and critical → non-critical edges. */
  const computeOrder = (): Result<SubsystemRecord[]> => {
    for (const record of records.values()) {
      for (const dep of record.subsystem.dependsOn ?? []) {
        const target = records.get(dep);
        if (target === undefined) {
          return err(
            SubsystemGraphError({
              units: [record.subsystem.id, dep],
              message: `Subsystem "${record.subsystem.id}" depends on unknown subsystem "${dep}".`,
            }),
          );
        }
        if (record.subsystem.critical === true && target.subsystem.critical !== true) {
          return err(
            SubsystemGraphError({
              units: [record.subsystem.id, dep],
              message: `Critical subsystem "${record.subsystem.id}" cannot depend on non-critical "${dep}".`,
            }),
          );
        }
      }
    }
    const placed = new Set<SubsystemId>();
    const out: SubsystemRecord[] = [];
    let remaining = [...records.values()];
    while (remaining.length > 0) {
      const wave = remaining.filter((r) => (r.subsystem.dependsOn ?? []).every((d) => placed.has(d)));
      if (wave.length === 0) {
        return err(
          SubsystemGraphError({
            units: remaining.map((r) => r.subsystem.id),
            message: `Subsystem dependency cycle among: ${remaining.map((r) => r.subsystem.id).join(', ')}.`,
          }),
        );
      }
      for (const r of wave) placed.add(r.subsystem.id);
      out.push(...wave);
      remaining = remaining.filter((r) => !placed.has(r.subsystem.id));
    }
    return ok(out);
  };

  // ------------------------------------------------------------ derived app state

  const reconcile = (): void => {
    const anyGivenUp = [...records.values()].some((r) => r.machine.is('given-up'));
    if (app.is('running') && anyGivenUp) app.send('degrade');
    else if (app.is('degraded') && !anyGivenUp) app.send('recover');
  };

  const notifyDependents = (id: SubsystemId, state: SubsystemState): void => {
    for (const other of records.values()) {
      if (!(other.subsystem.dependsOn ?? []).includes(id)) continue;
      const ctx = other.context;
      if (ctx === undefined || other.subsystem.onDependencyState === undefined) continue;
      try {
        other.subsystem.onDependencyState(id, state, ctx);
      } catch {
        telemetry.event('subsystem.dependency-hook-failed', { subsystem: SUB, attrs: { subsystem: other.subsystem.id, dependency: id } });
      }
    }
  };

  // ------------------------------------------------------------ paused gate (I-1)

  const releasePaused = (resumed: boolean): void => {
    for (const waiter of [...pausedWaiters]) waiter(resumed);
    pausedWaiters.clear();
  };

  /** true when the app is (or becomes) not paused; false on shutdown or abort of `signal`. */
  const waitUntilNotPaused = (signal: AbortSignal | undefined): Promise<boolean> => {
    if (isDown()) return Promise.resolve(false);
    if (!app.is('paused')) return Promise.resolve(true);
    return new Promise((resolve) => {
      // Aborted to detach the abort listener once the app resumes or shuts down.
      const detach = new AbortController();
      const onAbort = (): void => {
        pausedWaiters.delete(waiter);
        resolve(false);
      };
      const waiter = (resumed: boolean): void => {
        detach.abort();
        resolve(resumed);
      };
      if (signal?.aborted === true) {
        resolve(false);
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true, signal: detach.signal });
      pausedWaiters.add(waiter);
    });
  };

  // ------------------------------------------------------------ subsystem runs

  const createRecord = (subsystem: Subsystem): SubsystemRecord => {
    const machine = createMachine(subsystemMachine, {
      onInvalid: (state, event) =>
        telemetry.event('lifecycle.subsystem.invalid', { subsystem: SUB, attrs: { subsystem: subsystem.id, state, event } }),
    });
    const record: SubsystemRecord = {
      subsystem,
      machine,
      scope: undefined,
      context: undefined,
      generation: 0,
      failures: [],
      restarts: 0,
      error: undefined,
      impairedOnce: false,
      halted: false,
      loop: new AbortController(),
      startPromise: undefined,
    };
    traceMachine(machine, telemetry, SUB, { attrs: { subsystem: subsystem.id }, criticalStates: ['failed', 'given-up'] });
    machine.onTransition(({ to }) => {
      if (to === 'failed' || to === 'given-up') {
        record.impairedOnce = true;
        notifyDependents(subsystem.id, to);
      } else if (to === 'running' && record.impairedOnce) {
        record.impairedOnce = false;
        notifyDependents(subsystem.id, to);
      }
      reconcile();
    });
    return record;
  };

  const makeContext = (record: SubsystemRecord, generation: number, scope: Scope, span: Span, attempt: number): SubsystemContext => ({
    id: record.subsystem.id,
    scope,
    signal: scope.signal,
    get epoch() {
      return epochOf();
    },
    telemetry,
    span,
    attempt,
    fail(error) {
      if (generation !== record.generation || record.halted || !record.machine.is('running', 'paused')) return;
      record.generation += 1;
      void scope.dispose();
      record.startPromise = runLoop(record, error).then(() => record.machine.state);
    },
  });

  const attemptStart = async (record: SubsystemRecord): Promise<Result<void>> => {
    const { subsystem } = record;
    if (!record.machine.can('start')) return err(AppTerminatedError({ units: [subsystem.id] }));
    record.machine.send('start');
    record.generation += 1;
    const generation = record.generation;
    const scope = rootScope.child(`subsystem:${subsystem.id}`);
    record.scope = scope;
    const attempt = record.failures.length + 1;
    const span = telemetry.span('subsystem.start', {
      subsystem: SUB,
      level: subsystem.critical === true ? 'standard' : 'verbose',
      parent: options.parentSpan,
      attrs: { subsystem: subsystem.id, attempt, critical: subsystem.critical === true },
    });
    const context = makeContext(record, generation, scope, span, attempt);
    record.context = context;
    const work = runHook(() => subsystem.start(context));
    let result: Result<void>;
    if (subsystem.startTimeoutMs === undefined) {
      result = await work;
    } else {
      const raced = await withDeadline(work, subsystem.startTimeoutMs, sleepFn);
      result =
        raced === 'timeout'
          ? err(TimeoutError({ units: [subsystem.id], message: `Subsystem "${subsystem.id}" did not start within ${subsystem.startTimeoutMs} ms.` }))
          : raced;
    }
    if (generation !== record.generation || record.halted) {
      span.end('cancelled');
      return err(AppTerminatedError({ units: [subsystem.id] }));
    }
    if (!result.ok) {
      span.end('error', result.error);
      await scope.dispose();
      return result;
    }
    span.end('ok');
    record.error = undefined;
    record.machine.send('started');
    // Started while the app is paused (e.g. a restart racing pause): freeze it immediately (I-1).
    if (app.is('paused')) {
      record.machine.send('pause');
      await runHook(() => subsystem.pause?.(context));
    }
    return ok();
  };

  /** Apply the restart policy. Returns true when another start attempt should follow. */
  const handleFailure = async (record: SubsystemRecord, error: SfError): Promise<boolean> => {
    const { subsystem } = record;
    record.error = error;
    if (record.machine.can('fail')) record.machine.send('fail');
    const policy = { ...DEFAULT_RESTART_POLICY, ...subsystem.restart };
    const at = now();
    record.failures = record.failures.filter((t) => at - t < policy.windowMs);
    if (policy.mode === 'temporary' || record.failures.length >= policy.maxRestarts) {
      record.error = SubsystemGaveUpError({
        units: [subsystem.id],
        cause: error,
        message: `Subsystem "${subsystem.id}" gave up after ${record.failures.length} restart(s) in ${policy.windowMs} ms: ${error.message}`,
        details: { restarts: record.failures.length, windowMs: policy.windowMs },
      });
      record.machine.send('give-up');
      return false;
    }
    record.failures.push(at);
    record.restarts += 1;
    record.machine.send('restart');
    const delay = backoffDelay(record.failures.length, policy.baseDelayMs, policy.maxDelayMs, policy.jitter, random);
    telemetry.record(runtimeMetrics.subsystemRestarts, 1, { subsystem: subsystem.id, delay });
    const slept = await sleepFn(delay, record.loop.signal);
    return slept.ok && !record.halted;
  };

  const runLoop = async (record: SubsystemRecord, initialError?: SfError): Promise<void> => {
    let pending = initialError;
    while (!record.halted) {
      if (pending === undefined) {
        const runnable = await waitUntilNotPaused(record.loop.signal);
        if (!runnable || record.halted) return;
        const result = await attemptStart(record);
        if (result.ok || record.halted) return;
        pending = result.error;
      }
      const again = await handleFailure(record, pending);
      pending = undefined;
      if (!again) return;
    }
  };

  const ensureStarted = (record: SubsystemRecord): Promise<SubsystemState> => {
    record.startPromise ??= (async () => {
      for (const dep of record.subsystem.dependsOn ?? []) {
        const target = records.get(dep);
        if (target !== undefined) await ensureStarted(target);
      }
      await runLoop(record);
      return record.machine.state;
    })();
    return record.startPromise;
  };

  const stopRecord = async (record: SubsystemRecord, reason: StopReason): Promise<void> => {
    const { subsystem } = record;
    record.halted = true;
    record.loop.abort();
    record.generation += 1;
    const previous = record.machine.state;
    if (!record.machine.can('stop')) return;
    record.machine.send('stop');
    const context = record.context;
    if (context !== undefined && (previous === 'starting' || previous === 'running' || previous === 'paused')) {
      const span = telemetry.span('subsystem.stop', { subsystem: SUB, level: 'verbose', attrs: { subsystem: subsystem.id, reason } });
      const outcome = await withDeadline(
        runHook(() => subsystem.stop?.(reason, context)),
        subsystem.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
        sleepFn,
      );
      if (outcome === 'timeout') {
        telemetry.event('subsystem.stop-timeout', { subsystem: SUB, level: 'critical', attrs: { subsystem: subsystem.id } });
        span.end('error');
      } else if (!outcome.ok) span.end('error', outcome.error);
      else span.end('ok');
    }
    await record.scope?.dispose();
    record.machine.send('stopped');
  };

  const stopAll = async (reason: StopReason): Promise<void> => {
    for (const record of [...order].reverse()) await stopRecord(record, reason);
  };

  const resetForBoot = (): void => {
    for (const record of records.values()) {
      record.halted = false;
      record.loop = new AbortController();
      record.failures = [];
      record.error = undefined;
      record.startPromise = undefined;
    }
  };

  const bumpEpoch = async (): Promise<Result<void>> => {
    if (injector !== undefined) return injector.refresh('epoch');
    ownEpoch.set(ownEpoch.get() + 1);
    return ok();
  };

  // ------------------------------------------------------------ boot phases

  const bootPhases = async (reason: 'boot' | 'reinitialize'): Promise<Result<void>> => {
    const begin = now();
    const span = telemetry.span(reason === 'boot' ? 'supervisor.boot' : 'supervisor.reinitialize', {
      subsystem: SUB,
      level: 'critical',
      parent: options.parentSpan,
      attrs: { subsystems: records.size },
    });
    const fail = async (error: SfError): Promise<Result<void>> => {
      span.end('error', error);
      await doShutdown();
      return err(error);
    };
    const graph = computeOrder();
    if (!graph.ok) return fail(graph.error);
    order = graph.value;

    if (options.core !== undefined) {
      const core = await runHook(() => options.core?.({ reason, signal: controller.signal, epoch: epochOf(), span }));
      if (isDown()) return fail(AppTerminatedError());
      if (!core.ok) return fail(BootFailedError({ cause: core.error, message: `Core phase failed: ${core.error.message}` }));
    }
    const critical = order.filter((r) => r.subsystem.critical === true);
    await Promise.all(critical.map(ensureStarted));
    if (isDown()) return fail(AppTerminatedError());
    const gaveUp = critical.find((r) => r.machine.is('given-up'));
    if (gaveUp !== undefined) {
      return fail(
        BootFailedError({
          units: [gaveUp.subsystem.id],
          cause: gaveUp.error,
          message: `Critical subsystem "${gaveUp.subsystem.id}" could not start.`,
        }),
      );
    }
    app.send('core-ready');
    if (reason === 'boot') telemetry.record(runtimeMetrics.coreReady, now() - begin);
    app.send('run');
    reconcile();
    for (const record of order) if (record.subsystem.critical !== true) void ensureStarted(record);
    span.end('ok');
    return ok();
  };

  // ------------------------------------------------------------ commands

  const doPause = async (): Promise<Result<void>> => {
    app.send('pause');
    for (const record of [...order].reverse()) {
      if (!record.machine.is('running') || record.context === undefined) continue;
      const context = record.context;
      record.machine.send('pause');
      const r = await runHook(() => record.subsystem.pause?.(context));
      if (!r.ok) telemetry.event('subsystem.pause-failed', { subsystem: SUB, attrs: { subsystem: record.subsystem.id } });
    }
    return ok();
  };

  const doResume = async (): Promise<Result<void>> => {
    resuming = true;
    try {
      for (const record of order) {
        if (!record.machine.is('paused') || record.context === undefined) continue;
        const context = record.context;
        const r = await runHook(() => record.subsystem.resume?.(context));
        if (!r.ok) telemetry.event('subsystem.resume-failed', { subsystem: SUB, attrs: { subsystem: record.subsystem.id } });
        if (record.machine.is('paused')) record.machine.send('resume');
      }
      if (isDown()) return err(AppTerminatedError());
      app.send('resume');
      reconcile();
      releasePaused(true);
      return ok();
    } finally {
      resuming = false;
    }
  };

  const doAbort = async (reason: unknown): Promise<Result<void>> => {
    const fired = controller;
    controller = new AbortController();
    fired.abort(reason ?? new DOMException('App abort', 'AbortError'));
    for (const record of order) {
      const context = record.context;
      if (context === undefined || !record.machine.is('running', 'paused', 'starting')) continue;
      try {
        record.subsystem.abort?.(reason, context);
      } catch {
        telemetry.event('subsystem.abort-failed', { subsystem: SUB, attrs: { subsystem: record.subsystem.id } });
      }
    }
    // Aborting during boot cancels the boot: the app shuts down.
    if (app.is('starting')) return doShutdown();
    return ok();
  };

  const doRefresh = async (): Promise<Result<void>> => {
    let failure: SfError | undefined;
    const bumped = await bumpEpoch();
    if (!bumped.ok) failure = bumped.error;
    const epoch = epochOf();
    for (const record of order) {
      const context = record.context;
      if (context === undefined || !record.machine.is('running') || record.subsystem.refresh === undefined) continue;
      const r = await runHook(() => record.subsystem.refresh?.(epoch, context));
      if (!r.ok) {
        failure ??= r.error;
        context.fail(r.error);
      }
    }
    return failure === undefined ? ok() : err(failure);
  };

  const doReinitialize = async (): Promise<Result<void>> => {
    app.send('reinitialize');
    await stopAll('reinitialize');
    resetForBoot();
    const bumped = await bumpEpoch();
    if (!bumped.ok) telemetry.event('app.reinitialize-refresh-failed', { subsystem: SUB, level: 'critical' });
    return bootPhases('reinitialize');
  };

  const doShutdown = (): Promise<Result<void>> => {
    shutdownPromise ??= (async () => {
      app.send('shutdown');
      releasePaused(false);
      await stopAll('shutdown');
      controller.abort(new DOMException('App shutdown', 'AbortError'));
      await rootScope.dispose();
      const hook = await runHook(() => options.onShutdown?.());
      if (!hook.ok) telemetry.event('app.shutdown-hook-failed', { subsystem: SUB, level: 'critical' });
      app.send('terminate');
      return ok();
    })();
    return shutdownPromise;
  };

  const supervisor: Supervisor = {
    get state() {
      return app.state;
    },
    get epoch() {
      return epochOf();
    },
    get signal() {
      return controller.signal;
    },
    is: (...states) => app.is(...states),
    onTransition: (listener) => app.onTransition(listener),

    register(subsystem) {
      if (isDown()) return err(AppTerminatedError({ units: [subsystem.id] }));
      if (records.has(subsystem.id)) {
        return err(SubsystemGraphError({ units: [subsystem.id], message: `Subsystem "${subsystem.id}" is registered twice.` }));
      }
      const record = createRecord(subsystem);
      records.set(subsystem.id, record);
      if (!started) return ok();
      // Late registration: validate and start right away (after its dependencies).
      if (subsystem.critical === true && !app.is('starting')) {
        records.delete(subsystem.id);
        return err(
          SubsystemGraphError({ units: [subsystem.id], message: `Critical subsystem "${subsystem.id}" registered after core-ready.` }),
        );
      }
      const graph = computeOrder();
      if (!graph.ok) {
        records.delete(subsystem.id);
        return graph;
      }
      order = graph.value;
      if (!app.is('starting', 'reinitializing')) void ensureStarted(record);
      return ok();
    },
    stateOf: (id) => records.get(id)?.machine.state,
    inspect: () =>
      [...records.values()].map((r) => ({
        id: r.subsystem.id,
        state: r.machine.state,
        critical: r.subsystem.critical === true,
        dependsOn: r.subsystem.dependsOn ?? [],
        restarts: r.restarts,
        error: r.error?.toJSON(),
      })),
    impaired: () =>
      [...records.values()].filter((r) => r.machine.is('failed', 'restarting', 'given-up')).map((r) => r.subsystem.id),

    async start() {
      if (started || !app.is('starting')) {
        return err(CommandNotAllowedError({ message: 'Supervisor already started.', details: { state: app.state } }));
      }
      started = true;
      return bootPhases('boot');
    },
    async settled() {
      await Promise.all([...records.values()].map((r) => r.startPromise));
    },

    can(command) {
      if (command === 'resume' && resuming) return false;
      return ALLOWED_COMMANDS[app.state].includes(command);
    },
    async command(command, commandOptions = {}) {
      if (!supervisor.can(command)) {
        return err(
          CommandNotAllowedError({
            message: `App command "${command}" is not allowed in state "${app.state}".`,
            details: { command, state: app.state },
          }),
        );
      }
      const span = telemetry.span('app.command', { subsystem: SUB, level: 'standard', attrs: { command, from: app.state } });
      let result: Result<void>;
      switch (command) {
        case 'pause':
          result = await doPause();
          break;
        case 'resume':
          result = await doResume();
          break;
        case 'abort':
          result = await doAbort(commandOptions.reason);
          break;
        case 'refresh':
          result = await doRefresh();
          break;
        case 'reinitialize':
          result = await doReinitialize();
          break;
        case 'shutdown':
          result = await doShutdown();
          break;
      }
      span.set('to', app.state);
      if (result.ok) span.end('ok');
      else span.end('error', result.error);
      return result;
    },
    pause: () => supervisor.command('pause'),
    resume: () => supervisor.command('resume'),
    abort: (reason) => supervisor.command('abort', { reason }),
    refresh: () => supervisor.command('refresh'),
    reinitialize: () => supervisor.command('reinitialize'),
    shutdown: () => supervisor.command('shutdown'),

    async request(request) {
      const decision = await commandPolicy(request, { state: app.state });
      telemetry.event('app.command-request', {
        subsystem: SUB,
        level: 'standard',
        attrs: { command: request.command, source: request.source, allowed: decision.allow },
      });
      if (!decision.allow) {
        return err(
          CommandDeniedError({
            message: `Command "${request.command}" requested by "${request.source}" was denied: ${decision.reason}`,
            details: { command: request.command, source: request.source, reason: decision.reason },
          }),
        );
      }
      return supervisor.command(request.command);
    },

    assertRunnable(operation = 'operation') {
      if (isDown()) return err(AppTerminatedError({ details: { operation } }));
      if (app.is('paused')) {
        return err(AppPausedError({ message: `"${operation}" cannot run while the app is paused (I-1).`, details: { operation } }));
      }
      return ok();
    },
    async whenRunnable(request, signal) {
      if (isDown()) return err(AppTerminatedError());
      if (!app.is('paused')) return ok();
      const decision = pausedPolicy(request);
      telemetry.event('app.paused-request', {
        subsystem: SUB,
        level: 'verbose',
        attrs: { kind: request.kind, idempotent: request.idempotent === true, decision, source: request.source ?? null },
      });
      if (decision === 'reject') {
        return err(AppPausedError({ details: { kind: request.kind, decision, source: request.source ?? null } }));
      }
      const resumed = await waitUntilNotPaused(signal);
      if (resumed) return ok();
      if (signal?.aborted === true) return err(AbortedError({ cause: signal.reason }));
      return err(AppTerminatedError());
    },
    usePolicies(policies) {
      if (policies.command !== undefined) commandPolicy = policies.command;
      if (policies.pausedRequest !== undefined) pausedPolicy = policies.pausedRequest;
    },
  };

  for (const subsystem of options.subsystems ?? []) {
    const registered = supervisor.register(subsystem);
    if (!registered.ok) throw registered.error;
  }
  return supervisor;
}
