/**
 * Feature host: drives every feature through its lifecycle (R5, docs/LIFECYCLES.md §6, I-5, I-6).
 *
 *   declared → loading → loaded → activating → activated → mounting → mounted ⇄ hidden
 *   mounted|hidden → unmounting → activated → deactivating → loaded → archived | evicted
 *
 * - Logic and UI have independent lifetimes: a feature-scoped child injector + logic
 *   scope live while activated; a UI scope (child of the logic scope, so I-5 holds
 *   structurally) lives while mounted; a visible scope lives while not hidden.
 * - Ref-counting (I-6): activating a feature activates its `requires.features` first;
 *   a feature cannot deactivate while a dependent feature is mounted. Dependents that
 *   are only activated are deactivated first (cascade).
 * - Heavy features archive: `snapshot()` at deactivation → ArchiveStore → `restore()` on reactivation.
 * - Operations on one feature are serialized; every operation returns a Result.
 * - The ui/router packages drive mount/hide/show/unmount; the resource manager drives demotion.
 */
import {
  type Box,
  box,
  createMachine,
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
  toSfError,
} from '@staticflux/core';
import { type ArchiveStore, createMemoryArchiveStore, SNAPSHOT_FORMAT, type SnapshotEnvelope } from './archive.js';
import {
  ArchiveFailedError,
  FeatureActivationFailedError,
  FeatureDependencyError,
  FeatureGraphError,
  FeatureInUseError,
  FeatureLoadFailedError,
  FeatureMountFailedError,
  MountWithoutLogicError,
  UnknownFeatureError,
} from './errors.js';
import type {
  ActivationKind,
  FeatureId,
  FeatureLogicContext,
  FeatureManifest,
  FeatureModule,
  FeatureRef,
  FeatureUiContext,
  FeatureWeight,
  ReadinessMark,
  RetentionPolicy,
} from './feature.js';
import { defaultNow, runHook } from './hooks.js';
import {
  type FeatureEvent,
  featureMachine,
  type FeatureState,
  LOGIC_ALIVE_STATES,
  UI_MOUNTED_STATES,
} from './machines.js';
import { RUNTIME_SUBSYSTEMS, runtimeMetrics, traceMachine } from './telemetry.js';

const SUB = RUNTIME_SUBSYSTEMS.feature;

export type FeatureLoader = (manifest: FeatureManifest, signal: AbortSignal) => Promise<Result<FeatureModule>>;

export interface FeatureHostOptions {
  /** Parent of every feature injector (usually the app or session injector). */
  readonly injector: Injector;
  readonly telemetry?: Telemetry;
  readonly archive?: ArchiveStore;
  readonly features?: readonly FeatureManifest[];
  /** I-1 gate, e.g. `(op) => supervisor.assertRunnable(op)`. */
  readonly gate?: (operation: string) => Result<void>;
  /** Override module loading (loader package: chunk ids, gating — I-8). Default: `manifest.load(signal)`. */
  readonly load?: FeatureLoader;
  readonly now?: () => number;
}

export interface FeatureInfo {
  readonly id: FeatureId;
  readonly state: FeatureState;
  readonly weight: FeatureWeight;
  readonly retention: RetentionPolicy;
  readonly headless: boolean;
  /** Activated/mounted by a host caller (not only as another feature's dependency). */
  readonly explicit: boolean;
  /** Dependents whose logic is alive (ref-count). */
  readonly refCount: number;
  /** Dependents whose UI is mounted (I-6 blockers). */
  readonly mountedDependents: readonly FeatureId[];
  /** Last activate/mount/show/touch time (LRU). */
  readonly lastUsed: number;
  /** An activate/mount operation is in flight (never a demotion candidate). */
  readonly busy: boolean;
  readonly error: SfError | undefined;
}

export interface FeatureHandle {
  readonly id: FeatureId;
  readonly manifest: FeatureManifest;
  /** Reactive. */
  readonly state: FeatureState;
  /** Reactive. */
  readonly hidden: boolean;
  readonly error: SfError | undefined;
  /** Feature injector while the logic is activated. */
  readonly injector: Injector | undefined;
  is(...states: readonly FeatureState[]): boolean;
}

export interface FeatureTransition {
  readonly id: FeatureId;
  readonly from: FeatureState;
  readonly to: FeatureState;
  readonly event: FeatureEvent;
}

export interface MountOptions {
  /** Passed to the module's mount() as `context.target`. */
  readonly target?: unknown;
  /** Mount directly into `hidden` (pre-render a likely-next feature). */
  readonly hidden?: boolean;
  readonly signal?: AbortSignal;
}

export interface FeatureHost {
  register(...manifests: readonly FeatureManifest[]): Result<void>;
  has(id: FeatureId): boolean;
  handle(id: FeatureId): FeatureHandle | undefined;
  stateOf(id: FeatureId): FeatureState | undefined;
  info(id: FeatureId): FeatureInfo | undefined;
  list(): readonly FeatureInfo[];
  refCount(id: FeatureId): number;
  load(id: FeatureId, signal?: AbortSignal): Promise<Result<void>>;
  /** Load (if needed) and activate logic, after the features it requires. */
  activate(id: FeatureId, signal?: AbortSignal): Promise<Result<Injector>>;
  /** Activate (if needed) then mount the UI. */
  mount(id: FeatureId, options?: MountOptions): Promise<Result<void>>;
  hide(id: FeatureId): Promise<Result<void>>;
  show(id: FeatureId): Promise<Result<void>>;
  /** Unmount the UI; logic stays warm. */
  unmount(id: FeatureId): Promise<Result<void>>;
  /** Unmount (if needed) and dispose logic. Fails with SF-FT-002 while a dependent is mounted. */
  deactivate(id: FeatureId): Promise<Result<void>>;
  /** Snapshot → persist → drop module (heavy features). */
  archive(id: FeatureId): Promise<Result<void>>;
  /** Drop everything (module, snapshot); the feature reloads on next use. */
  evict(id: FeatureId): Promise<Result<void>>;
  /** Mark as used now (LRU). */
  touch(id: FeatureId): void;
  /** Report a readiness mark (R17.7/R17.20); recorded once per mount. */
  mark(id: FeatureId, mark: ReadinessMark): void;
  onTransition(listener: (transition: FeatureTransition) => void): () => void;
  /** Called when the last in-flight activate/mount of a feature settles (it is no longer `busy`). */
  onSettled(listener: (id: FeatureId) => void): () => void;
  /** Tear everything down (dependents first). Bypasses the I-1 gate. */
  dispose(): Promise<void>;
}

interface FeatureRecord {
  readonly manifest: FeatureManifest;
  readonly machine: Machine<FeatureState, FeatureEvent>;
  readonly hiddenBox: Box<boolean>;
  module: FeatureModule | undefined;
  injector: Injector | undefined;
  logicScope: Scope | undefined;
  uiScope: Scope | undefined;
  visibleScope: Scope | undefined;
  logicContext: FeatureLogicContext | undefined;
  uiContext: FeatureUiContext | undefined;
  snapshot: SnapshotEnvelope | undefined;
  error: SfError | undefined;
  explicit: boolean;
  lastUsed: number;
  activationStart: number;
  marks: Set<ReadinessMark>;
  queue: Promise<unknown>;
  /** In-flight activate/mount operations (protects against demotion between steps). */
  claims: number;
}

const defaultLoader: FeatureLoader = async (manifest, signal) => {
  try {
    return ok(await manifest.load(signal));
  } catch (error) {
    return err(toSfError(error));
  }
};

export function createFeatureHost(options: FeatureHostOptions): FeatureHost {
  const parent = options.injector;
  const telemetry = options.telemetry ?? parent.telemetry;
  const archive = options.archive ?? createMemoryArchiveStore();
  const loader = options.load ?? defaultLoader;
  const now = options.now ?? defaultNow;
  const gate = options.gate ?? (() => ok());
  const hostScope = createScope('feature-host');
  const records = new Map<FeatureId, FeatureRecord>();
  const listeners = new Set<(transition: FeatureTransition) => void>();
  const settledListeners = new Set<(id: FeatureId) => void>();

  const release = (record: FeatureRecord): void => {
    record.claims -= 1;
    if (record.claims === 0) for (const listener of [...settledListeners]) listener(record.manifest.id);
  };
  let disposed = false;

  const unknown = (id: FeatureId): SfError => UnknownFeatureError({ units: [id], message: `Unknown feature "${id}".` });

  const dependentsOf = (id: FeatureId): FeatureRecord[] =>
    [...records.values()].filter((r) => (r.manifest.requires?.features ?? []).some((ref) => ref.id === id));

  const refCount = (id: FeatureId): number => dependentsOf(id).filter((r) => r.machine.is(...LOGIC_ALIVE_STATES, 'activating')).length;

  const mountedDependents = (id: FeatureId): FeatureId[] =>
    dependentsOf(id)
      .filter((r) => r.machine.is(...UI_MOUNTED_STATES))
      .map((r) => r.manifest.id);

  const enqueue = <T>(record: FeatureRecord, op: () => Promise<T>): Promise<T> => {
    const run = record.queue.then(op);
    record.queue = run.catch(() => undefined);
    return run;
  };

  const send = (record: FeatureRecord, event: FeatureEvent): Result<FeatureState> => record.machine.send(event);

  // ------------------------------------------------------------ graph

  const findCycle = (): FeatureId[] | undefined => {
    const visiting = new Set<FeatureId>();
    const done = new Set<FeatureId>();
    const visit = (id: FeatureId, path: FeatureId[]): FeatureId[] | undefined => {
      if (done.has(id)) return undefined;
      if (visiting.has(id)) return [...path, id];
      visiting.add(id);
      for (const ref of records.get(id)?.manifest.requires?.features ?? []) {
        if (!records.has(ref.id)) continue;
        const cycle = visit(ref.id, [...path, id]);
        if (cycle !== undefined) return cycle;
      }
      visiting.delete(id);
      done.add(id);
      return undefined;
    };
    for (const id of records.keys()) {
      const cycle = visit(id, []);
      if (cycle !== undefined) return cycle;
    }
    return undefined;
  };

  // ------------------------------------------------------------ contexts

  const makeLogicContext = (record: FeatureRecord, injector: Injector, scope: Scope, kind: ActivationKind): FeatureLogicContext => {
    const span = telemetry.span('feature.logic', {
      subsystem: SUB,
      level: 'verbose',
      attrs: { feature: record.manifest.id, activation: kind },
    });
    scope.defer(() => span.end('ok'));
    return {
      id: record.manifest.id,
      manifest: record.manifest,
      injector,
      scope,
      signal: scope.signal,
      telemetry,
      span,
      get epoch() {
        return injector.epoch;
      },
      activation: kind,
      dependency(ref: FeatureRef) {
        const allowed = (record.manifest.requires?.features ?? []).some((r) => r.id === ref.id);
        const target = records.get(ref.id);
        if (!allowed || target?.injector === undefined) {
          return err(
            FeatureDependencyError({
              units: [record.manifest.id, ref.id],
              message: allowed
                ? `Required feature "${ref.id}" is not activated.`
                : `"${record.manifest.id}" does not declare "${ref.id}" in requires.features.`,
            }),
          );
        }
        return ok(target.injector);
      },
    };
  };

  const makeUiContext = (record: FeatureRecord, logic: FeatureLogicContext, uiScope: Scope, target: unknown): FeatureUiContext => ({
    ...logic,
    get epoch() {
      return logic.epoch;
    },
    uiScope,
    target,
    get hidden() {
      return record.hiddenBox.get();
    },
  });

  // ------------------------------------------------------------ single-feature steps (run inside the record queue)

  const loadModule = async (record: FeatureRecord, signal: AbortSignal): Promise<Result<FeatureModule>> => {
    const { manifest } = record;
    const start = now();
    const span = telemetry.span('feature.load', { subsystem: SUB, level: 'standard', attrs: { feature: manifest.id } });
    const result = await loader(manifest, signal);
    telemetry.record(runtimeMetrics.featureLoad, now() - start, { feature: manifest.id, ok: result.ok });
    if (!result.ok) {
      const error = FeatureLoadFailedError({
        units: [manifest.id],
        cause: result.error,
        message: `Feature "${manifest.id}" failed to load: ${result.error.message}`,
      });
      span.end('error', error);
      return err(error);
    }
    span.end('ok');
    return ok(result.value);
  };

  const doLoad = async (record: FeatureRecord, signal: AbortSignal): Promise<Result<void>> => {
    if (record.module !== undefined && !record.machine.is('declared', 'evicted', 'archived', 'failed')) return ok();
    if (record.machine.is('archived')) return ok(); // archived activates straight from the snapshot
    if (record.machine.is('failed')) {
      if (record.module !== undefined) return ok();
      send(record, 'retry-load');
    } else {
      const sent = send(record, 'load');
      if (!sent.ok) return err(sent.error);
    }
    const loaded = await loadModule(record, signal);
    if (!loaded.ok) {
      record.error = loaded.error;
      send(record, 'fail');
      return err(loaded.error);
    }
    record.module = loaded.value;
    record.error = undefined;
    send(record, 'loaded');
    return ok();
  };

  const failActivation = async (record: FeatureRecord, cause: SfError, span: Span): Promise<Result<Injector>> => {
    const error =
      cause.code === FeatureLoadFailedError.code || cause.code === FeatureDependencyError.code
        ? cause
        : FeatureActivationFailedError({
            units: [record.manifest.id],
            cause,
            message: `Feature "${record.manifest.id}" failed to activate: ${cause.message}`,
          });
    await record.logicScope?.dispose();
    record.logicScope = undefined;
    record.injector = undefined;
    record.logicContext = undefined;
    record.error = error;
    span.end('error', error);
    send(record, 'fail');
    return err(error);
  };

  const doActivate = async (record: FeatureRecord, signal: AbortSignal): Promise<Result<Injector>> => {
    const { manifest } = record;
    if (record.machine.is(...LOGIC_ALIVE_STATES) && record.injector !== undefined) return ok(record.injector);
    let kind: ActivationKind = record.module === undefined ? 'fresh' : 'warm';
    if (record.machine.is('archived')) kind = 'archived';
    else if (record.machine.is('declared', 'evicted') || (record.machine.is('failed') && record.module === undefined)) {
      const loaded = await doLoad(record, signal);
      if (!loaded.ok) return err(loaded.error);
    }
    const sent = send(record, record.machine.is('failed') ? 'retry-activate' : 'activate');
    if (!sent.ok) return err(sent.error);

    record.activationStart = now();
    const span = telemetry.span('feature.activate', {
      subsystem: SUB,
      level: 'standard',
      attrs: { feature: manifest.id, weight: manifest.weight, activation: kind },
    });

    for (const ref of manifest.requires?.features ?? []) {
      const dep = records.get(ref.id);
      if (dep === undefined || !dep.machine.is(...LOGIC_ALIVE_STATES)) {
        return failActivation(
          record,
          FeatureDependencyError({ units: [manifest.id, ref.id], message: `Required feature "${ref.id}" is not activated.` }),
          span,
        );
      }
    }
    if (record.module === undefined) {
      const loaded = await loadModule(record, signal);
      if (!loaded.ok) return failActivation(record, loaded.error, span);
      record.module = loaded.value;
    }
    const module = record.module;

    let injector: Injector;
    try {
      injector = parent.child('feature', manifest.id, [...(manifest.units ?? []), ...(module.units ?? [])]);
    } catch (error) {
      return failActivation(record, toSfError(error), span);
    }
    const logicScope = hostScope.child(`feature:${manifest.id}`);
    // Registered first → disposed last: the injector outlives everything else in the logic scope.
    logicScope.defer(() => injector.dispose());
    record.logicScope = logicScope;
    record.injector = injector;
    const context = makeLogicContext(record, injector, logicScope, kind);
    record.logicContext = context;

    const activated = await runHook(() => module.activate?.(context));
    if (!activated.ok) return failActivation(record, activated.error, span);

    if (kind === 'archived') {
      const stored = await archive.get(manifest.id, signal);
      if (!stored.ok) {
        telemetry.event('feature.archive-read-failed', { subsystem: SUB, level: 'critical', attrs: { feature: manifest.id } });
      } else if (stored.value !== undefined) {
        const snapshot = stored.value;
        const restored = await runHook(() => module.restore?.(snapshot.data, snapshot.version, context));
        if (!restored.ok) return failActivation(record, restored.error, span);
        await archive.delete(manifest.id);
      }
    }
    if (signal.aborted) return failActivation(record, toSfError(signal.reason), span);

    record.error = undefined;
    const duration = now() - record.activationStart;
    telemetry.record(runtimeMetrics.featureActivation, duration, { feature: manifest.id, activation: kind });
    const budget = manifest.budget?.activationMs;
    if (budget !== undefined && duration > budget) {
      telemetry.event('feature.budget-exceeded', {
        subsystem: SUB,
        level: 'standard',
        attrs: { feature: manifest.id, budget: 'activationMs', limit: budget, actual: duration },
      });
    }
    span.end('ok');
    record.lastUsed = now();
    send(record, 'activated');
    return ok(injector);
  };

  const openVisible = async (record: FeatureRecord): Promise<void> => {
    const ui = record.uiContext;
    if (ui === undefined || record.uiScope === undefined) return;
    const scope = record.uiScope.child('visible');
    record.visibleScope = scope;
    const r = await runHook(() => record.module?.visible?.(ui, scope));
    if (!r.ok) {
      telemetry.event('feature.visible-failed', { subsystem: SUB, level: 'standard', attrs: { feature: record.manifest.id, message: r.error.message } });
    }
  };

  const closeVisible = async (record: FeatureRecord): Promise<void> => {
    const scope = record.visibleScope;
    record.visibleScope = undefined;
    await scope?.dispose();
  };

  const doMount = async (record: FeatureRecord, mountOptions: MountOptions): Promise<Result<void>> => {
    const { manifest } = record;
    if (record.machine.is('mounted', 'hidden')) return ok();
    const logic = record.logicContext;
    if (!record.machine.is('activated') || logic === undefined || record.logicScope === undefined) {
      return err(
        MountWithoutLogicError({ units: [manifest.id], message: `Feature "${manifest.id}" is "${record.machine.state}", not activated (I-5).` }),
      );
    }
    if (manifest.headless === true) {
      return err(FeatureMountFailedError({ units: [manifest.id], message: `Feature "${manifest.id}" is headless and has no UI.` }));
    }
    send(record, 'mount');
    const span = telemetry.span('feature.mount', { subsystem: SUB, level: 'standard', attrs: { feature: manifest.id } });
    const uiScope = record.logicScope.child('ui');
    record.uiScope = uiScope;
    record.hiddenBox.set(mountOptions.hidden === true);
    const ui = makeUiContext(record, logic, uiScope, mountOptions.target);
    record.uiContext = ui;
    record.marks.clear();
    const mounted = await runHook(() => record.module?.mount?.(ui));
    if (!mounted.ok) {
      await uiScope.dispose();
      record.uiScope = undefined;
      record.uiContext = undefined;
      const error = FeatureMountFailedError({ units: [manifest.id], cause: mounted.error, message: `mount() of "${manifest.id}" failed: ${mounted.error.message}` });
      span.end('error', error);
      send(record, 'mount-failed');
      return err(error);
    }
    record.lastUsed = now();
    send(record, 'mounted');
    if (mountOptions.hidden === true) {
      send(record, 'hide');
      record.module?.hide?.(ui);
    } else {
      await openVisible(record);
    }
    span.end('ok');
    return ok();
  };

  const doHide = async (record: FeatureRecord): Promise<Result<void>> => {
    if (record.machine.is('hidden')) return ok();
    const sent = send(record, 'hide');
    if (!sent.ok) return err(sent.error);
    record.hiddenBox.set(true);
    await closeVisible(record);
    const ui = record.uiContext;
    if (ui !== undefined) record.module?.hide?.(ui);
    return ok();
  };

  const doShow = async (record: FeatureRecord): Promise<Result<void>> => {
    if (record.machine.is('mounted')) return ok();
    const sent = send(record, 'show');
    if (!sent.ok) return err(sent.error);
    record.hiddenBox.set(false);
    record.lastUsed = now();
    await openVisible(record);
    return ok();
  };

  const doUnmount = async (record: FeatureRecord): Promise<Result<void>> => {
    if (!record.machine.is('mounted', 'hidden')) return ok();
    send(record, 'unmount');
    const span = telemetry.span('feature.unmount', { subsystem: SUB, level: 'verbose', attrs: { feature: record.manifest.id } });
    await closeVisible(record);
    const ui = record.uiContext;
    if (ui !== undefined) {
      const r = await runHook(() => record.module?.unmount?.(ui));
      if (!r.ok) telemetry.event('feature.unmount-failed', { subsystem: SUB, level: 'standard', attrs: { feature: record.manifest.id } });
    }
    await record.uiScope?.dispose();
    record.uiScope = undefined;
    record.uiContext = undefined;
    record.hiddenBox.set(false);
    span.end('ok');
    send(record, 'unmounted');
    return ok();
  };

  const doDeactivate = async (record: FeatureRecord, capture: boolean): Promise<Result<void>> => {
    const { manifest } = record;
    if (!record.machine.is(...LOGIC_ALIVE_STATES)) return ok();
    const blockers = mountedDependents(manifest.id);
    if (blockers.length > 0) {
      return err(
        FeatureInUseError({
          units: [manifest.id, ...blockers],
          message: `Feature "${manifest.id}" cannot deactivate: mounted dependents ${blockers.join(', ')} (I-6).`,
          details: { dependents: blockers },
        }),
      );
    }
    await doUnmount(record);
    send(record, 'deactivate');
    const span = telemetry.span('feature.deactivate', { subsystem: SUB, level: 'standard', attrs: { feature: manifest.id, snapshot: capture } });
    const context = record.logicContext;
    if (capture && context !== undefined && record.module?.snapshot !== undefined) {
      const module = record.module;
      try {
        const data: unknown = await module.snapshot?.(context);
        record.snapshot = {
          format: SNAPSHOT_FORMAT,
          id: manifest.id,
          version: manifest.snapshotVersion ?? 1,
          createdAt: Date.now(),
          epoch: context.epoch,
          data,
        };
      } catch (error) {
        telemetry.event('feature.snapshot-failed', { subsystem: SUB, level: 'critical', attrs: { feature: manifest.id, message: toSfError(error).message } });
      }
    }
    if (context !== undefined) {
      const r = await runHook(() => record.module?.deactivate?.(context));
      if (!r.ok) telemetry.event('feature.deactivate-failed', { subsystem: SUB, level: 'standard', attrs: { feature: manifest.id } });
    }
    await record.logicScope?.dispose();
    record.logicScope = undefined;
    record.injector = undefined;
    record.logicContext = undefined;
    record.explicit = false;
    span.end('ok');
    send(record, 'deactivated');
    return ok();
  };

  const doArchive = async (record: FeatureRecord): Promise<Result<void>> => {
    const { manifest } = record;
    if (record.machine.is('archived')) return ok();
    if (!record.machine.can('archive')) {
      const sent = send(record, 'archive');
      return sent.ok ? ok() : err(sent.error);
    }
    const span = telemetry.span('feature.archive', { subsystem: SUB, level: 'standard', attrs: { feature: manifest.id } });
    if (record.snapshot !== undefined) {
      const stored = await archive.put(record.snapshot);
      if (!stored.ok) {
        const error = ArchiveFailedError({ units: [manifest.id], cause: stored.error });
        span.end('error', error);
        return err(error);
      }
    }
    record.snapshot = undefined;
    record.module = undefined;
    span.end('ok');
    send(record, 'archive');
    return ok();
  };

  const doEvict = async (record: FeatureRecord): Promise<Result<void>> => {
    if (record.machine.is('evicted', 'declared')) return ok();
    const wasArchived = record.machine.is('archived');
    const sent = send(record, 'evict');
    if (!sent.ok) return err(sent.error);
    record.module = undefined;
    record.snapshot = undefined;
    if (wasArchived) await archive.delete(record.manifest.id);
    return ok();
  };

  // ------------------------------------------------------------ public composition (no queue held while waiting on another)

  const lookup = (id: FeatureId, operation: string): Result<FeatureRecord> => {
    if (disposed) return err(unknown(id));
    const allowed = gate(`feature.${operation}`);
    if (!allowed.ok) return err(allowed.error);
    const record = records.get(id);
    return record === undefined ? err(unknown(id)) : ok(record);
  };

  const activateInternal = async (id: FeatureId, signal: AbortSignal, explicit: boolean): Promise<Result<Injector>> => {
    const found = lookup(id, 'activate');
    if (!found.ok) return err(found.error);
    const record = found.value;
    record.claims += 1;
    try {
      for (const ref of record.manifest.requires?.features ?? []) {
        if (!records.has(ref.id)) {
          return err(
            FeatureDependencyError({ units: [id, ref.id], message: `Feature "${id}" requires unregistered feature "${ref.id}".` }),
          );
        }
        const dep = await activateInternal(ref.id, signal, false);
        if (!dep.ok) {
          return err(
            FeatureDependencyError({ units: [id, ref.id], cause: dep.error, message: `Required feature "${ref.id}" could not activate.` }),
          );
        }
      }
      const result = await enqueue(record, () => doActivate(record, signal));
      if (result.ok && explicit) record.explicit = true;
      return result;
    } finally {
      release(record);
    }
  };

  /** Deactivate alive-but-unmounted dependents first (cascade); fail if any dependent is mounted. */
  const releaseDependents = async (id: FeatureId): Promise<Result<void>> => {
    const blockers = mountedDependents(id);
    if (blockers.length > 0) {
      return err(
        FeatureInUseError({
          units: [id, ...blockers],
          message: `Feature "${id}" cannot deactivate: mounted dependents ${blockers.join(', ')} (I-6).`,
          details: { dependents: blockers },
        }),
      );
    }
    for (const dependent of dependentsOf(id)) {
      if (!dependent.machine.is(...LOGIC_ALIVE_STATES)) continue;
      const released = await deactivateInternal(dependent, false);
      if (!released.ok) return released;
    }
    return ok();
  };

  const deactivateInternal = async (record: FeatureRecord, capture: boolean): Promise<Result<void>> => {
    const released = await releaseDependents(record.manifest.id);
    if (!released.ok) return released;
    return enqueue(record, () => doDeactivate(record, capture));
  };

  const host: FeatureHost = {
    register(...manifests) {
      for (const manifest of manifests) {
        if (records.has(manifest.id)) {
          return err(FeatureGraphError({ units: [manifest.id], message: `Feature "${manifest.id}" is registered twice.` }));
        }
        const machine = createMachine(featureMachine, {
          onInvalid: (state, event) =>
            telemetry.event('lifecycle.feature.invalid', { subsystem: SUB, attrs: { feature: manifest.id, state, event } }),
        });
        const record: FeatureRecord = {
          manifest,
          machine,
          hiddenBox: box(false),
          module: undefined,
          injector: undefined,
          logicScope: undefined,
          uiScope: undefined,
          visibleScope: undefined,
          logicContext: undefined,
          uiContext: undefined,
          snapshot: undefined,
          error: undefined,
          explicit: false,
          lastUsed: 0,
          activationStart: 0,
          marks: new Set(),
          queue: Promise.resolve(),
          claims: 0,
        };
        traceMachine(machine, telemetry, SUB, { attrs: { feature: manifest.id }, criticalStates: ['failed'] });
        machine.onTransition(({ from, to, event }) => {
          for (const listener of [...listeners]) listener({ id: manifest.id, from, to, event });
          if (from === 'activating' || from === 'deactivating') {
            const alive = [...records.values()].filter((r) => r.machine.is(...LOGIC_ALIVE_STATES)).length;
            telemetry.record(runtimeMetrics.activeFeatures, alive);
          }
        });
        records.set(manifest.id, record);
        const cycle = findCycle();
        if (cycle !== undefined) {
          records.delete(manifest.id);
          return err(FeatureGraphError({ units: cycle, message: `Feature dependency cycle: ${cycle.join(' → ')}.` }));
        }
      }
      return ok();
    },
    has: (id) => records.has(id),
    handle(id) {
      const record = records.get(id);
      if (record === undefined) return undefined;
      return {
        id,
        manifest: record.manifest,
        get state() {
          return record.machine.state;
        },
        get hidden() {
          return record.hiddenBox.get();
        },
        get error() {
          return record.error;
        },
        get injector() {
          return record.injector;
        },
        is: (...states) => record.machine.is(...states),
      };
    },
    stateOf: (id) => records.get(id)?.machine.state,
    info(id) {
      const record = records.get(id);
      if (record === undefined) return undefined;
      const { manifest } = record;
      return {
        id,
        state: record.machine.state,
        weight: manifest.weight,
        retention: manifest.retention ?? {},
        headless: manifest.headless === true,
        explicit: record.explicit,
        refCount: refCount(id),
        mountedDependents: mountedDependents(id),
        lastUsed: record.lastUsed,
        busy: record.claims > 0,
        error: record.error,
      };
    },
    list: () => [...records.keys()].map((id) => host.info(id) as FeatureInfo),
    refCount,

    async load(id, signal = hostScope.signal) {
      const found = lookup(id, 'load');
      if (!found.ok) return err(found.error);
      const record = found.value;
      return enqueue(record, () => doLoad(record, signal));
    },
    activate: (id, signal = hostScope.signal) => activateInternal(id, signal, true),
    async mount(id, mountOptions = {}) {
      const record = records.get(id);
      if (record !== undefined) record.claims += 1;
      try {
        const activated = await activateInternal(id, mountOptions.signal ?? hostScope.signal, true);
        if (!activated.ok || record === undefined) return activated.ok ? ok() : err(activated.error);
        return await enqueue(record, () => doMount(record, mountOptions));
      } finally {
        if (record !== undefined) release(record);
      }
    },
    async hide(id) {
      const found = lookup(id, 'hide');
      if (!found.ok) return err(found.error);
      const record = found.value;
      return enqueue(record, () => doHide(record));
    },
    async show(id) {
      const found = lookup(id, 'show');
      if (!found.ok) return err(found.error);
      const record = found.value;
      return enqueue(record, () => doShow(record));
    },
    async unmount(id) {
      const found = lookup(id, 'unmount');
      if (!found.ok) return err(found.error);
      const record = found.value;
      return enqueue(record, () => doUnmount(record));
    },
    async deactivate(id) {
      const found = lookup(id, 'deactivate');
      if (!found.ok) return err(found.error);
      return deactivateInternal(found.value, false);
    },
    async archive(id) {
      const found = lookup(id, 'archive');
      if (!found.ok) return err(found.error);
      const record = found.value;
      if (record.machine.is(...LOGIC_ALIVE_STATES)) {
        const deactivated = await deactivateInternal(record, true);
        if (!deactivated.ok) return deactivated;
      }
      return enqueue(record, () => doArchive(record));
    },
    async evict(id) {
      const found = lookup(id, 'evict');
      if (!found.ok) return err(found.error);
      const record = found.value;
      if (record.machine.is(...LOGIC_ALIVE_STATES)) {
        const deactivated = await deactivateInternal(record, false);
        if (!deactivated.ok) return deactivated;
      }
      return enqueue(record, () => doEvict(record));
    },
    touch(id) {
      const record = records.get(id);
      if (record !== undefined) record.lastUsed = now();
    },
    mark(id, mark) {
      const record = records.get(id);
      if (record === undefined || record.marks.has(mark) || !record.machine.is('mounted', 'hidden')) return;
      record.marks.add(mark);
      telemetry.record(runtimeMetrics.featureReadiness, now() - record.activationStart, { feature: id, mark });
      record.logicContext?.span.event(`feature.${mark}`, { feature: id });
    },
    onTransition(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onSettled(listener) {
      settledListeners.add(listener);
      return () => {
        settledListeners.delete(listener);
      };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      // Dependents first: repeatedly tear down features nobody alive depends on.
      let alive = [...records.values()].filter((r) => r.machine.is(...LOGIC_ALIVE_STATES));
      for (let round = 0; alive.length > 0 && round <= records.size; round += 1) {
        const leaves = alive.filter((r) => refCount(r.manifest.id) === 0);
        const batch = leaves.length > 0 ? leaves : alive;
        for (const record of batch) await enqueue(record, () => doDeactivateForced(record));
        alive = [...records.values()].filter((r) => r.machine.is(...LOGIC_ALIVE_STATES));
      }
      await hostScope.dispose();
      listeners.clear();
      settledListeners.clear();
    },
  };

  /** Shutdown path: unmount + deactivate ignoring I-6 (everything is going away). */
  const doDeactivateForced = async (record: FeatureRecord): Promise<void> => {
    for (const dependent of dependentsOf(record.manifest.id)) await doUnmount(dependent);
    await doUnmount(record);
    if (record.machine.is(...LOGIC_ALIVE_STATES)) {
      const blockers = mountedDependents(record.manifest.id);
      if (blockers.length === 0) await doDeactivate(record, false);
    }
  };

  const registered = host.register(...(options.features ?? []));
  if (!registered.ok) throw registered.error;
  return host;
}
