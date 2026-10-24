/**
 * Islands hydration (R12.4 part 1) over static/prerendered HTML.
 *
 *   const hydrator = createIslandHydrator({ loader });     // loader: createChunkLoader(...) or any { load, check?, preload? }
 *   hydrator.start(document.body, { injector: app });      // scan + schedule every island
 *
 * Per island (machine `hydrate/island`, see AGENTS.md):
 *   idle ──trigger──▶ loading ──loaded──▶ hydrating ──succeed──▶ hydrated
 *                       │ deny → skipped      │ fail → failed        (skipped|failed ──retry──▶ loading)
 * - Triggers (R12.12 lazy by default): `visible` (IntersectionObserver), `idle` (idle callback),
 *   `interaction` (first pointerdown/touchstart/focusin/keydown/click/input; pointerover/focusin
 *   preloads the chunk = speculative tier, R12.3), `eager` (microtask; requires a reason), `never`.
 * - Before any fetch: the island gate, then `loader.check(chunk)` (chunk gate + profile, I-8).
 * - The chunk is loaded through the loader (deduped, retried, deps preloaded) and its island
 *   module's `hydrate(element, { props, signal, scope, island, injector })` attaches behaviour to
 *   the existing DOM. Queued pre-hydration events are replayed afterwards (`replay.ts`).
 * - Telemetry: one `island.hydrate` span per island (events: gate, loaded, hydrated, replayed),
 *   marks `hydrate/island-static` (scan) and `hydrate/island-interactive`, forwarded to optional
 *   `IslandMarksPort`s (structurally compatible with perf `FeatureMarks`, R17.7).
 * - Size-stable check (R12.19): declared `size` vs prerendered box, and box before vs after
 *   hydration (next frame) → `SF-HYD-007` + `hydrate/layout-shift-risk` + `marks.layoutShift`.
 */
import {
  AbortedError,
  createMachine,
  createNoopTelemetry,
  createScope,
  defineMachine,
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
import type { ChunkGateDecision, ChunkLoader } from '@staticflux/loader';
import { browserIslandEnv, type IslandEnv } from './env.js';
import {
  IslandDeniedError,
  IslandHydrateFailedError,
  IslandLayoutShiftRiskError,
  IslandLoadFailedError,
  IslandMarkerInvalidError,
  IslandModuleInvalidError,
  IslandPropsInvalidError,
} from './errors.js';
import { type IslandModule, resolveIslandModule } from './island.js';
import {
  type HydrateStrategy,
  type IslandChunkId,
  type IslandDescriptor,
  type IslandSize,
  islandElements,
  ISLAND_STATE_ATTR,
  parseIslandProps,
  readIslandMarker,
  scanIslands,
  type ScanResult,
} from './marker.js';
import { createEventReplay, type EventReplay, INTERACTION_EVENTS, type ReplayOptions, WARM_EVENTS } from './replay.js';
import { HYDRATE_SUBSYSTEMS, hydrateMetrics } from './telemetry.js';

export const islandMachine = defineMachine({
  id: 'hydrate/island',
  initial: 'idle',
  states: ['idle', 'loading', 'hydrating', 'hydrated', 'failed', 'skipped', 'disposed'],
  transitions: {
    idle: { trigger: 'loading', skip: 'skipped', dispose: 'disposed' },
    loading: { loaded: 'hydrating', fail: 'failed', deny: 'skipped', dispose: 'disposed' },
    hydrating: { succeed: 'hydrated', fail: 'failed', dispose: 'disposed' },
    hydrated: { dispose: 'disposed' },
    failed: { retry: 'loading', dispose: 'disposed' },
    skipped: { retry: 'loading', dispose: 'disposed' },
  },
  terminal: ['disposed'],
});

export type IslandState = (typeof islandMachine.states)[number];
type IslandEvent = 'trigger' | 'skip' | 'loaded' | 'fail' | 'deny' | 'succeed' | 'retry' | 'dispose';

/** The part of the loader's `ChunkLoader` the hydrator uses (`createChunkLoader(...)` fits). */
export type IslandChunkLoader = Pick<ChunkLoader, 'load'> & Partial<Pick<ChunkLoader, 'check' | 'preload'>>;

/** UX gate consulted before an island's chunk is fetched (client gating is UX, not security). */
export type IslandGate = (island: IslandDescriptor) => ChunkGateDecision;
export const allowAllIslands: IslandGate = () => true;

/** Feature-mark sink; perf's `FeatureMarks` satisfies it structurally (R17.7). */
export interface IslandMarksPort {
  start(feature: string): void;
  renderCommitted(feature: string, element?: Element): void;
  renderDepsResolved(feature: string): void;
  layoutShift(feature: string): void;
}

export type LayoutShiftPhase = 'declared' | 'hydration';

export interface LayoutShiftViolation {
  readonly island: string;
  readonly chunk: IslandChunkId;
  readonly phase: LayoutShiftPhase;
  readonly expected: IslandSize;
  readonly actual: IslandSize;
}

export interface IslandHydratorOptions {
  readonly loader: IslandChunkLoader;
  readonly gate?: IslandGate;
  /** Browser seams; missing ones use `browserIslandEnv()`. */
  readonly env?: Partial<IslandEnv>;
  readonly telemetry?: Telemetry;
  readonly marks?: readonly IslandMarksPort[];
  readonly replay?: ReplayOptions;
  /** Allowed size delta in CSS px before a layout-shift risk is reported. Default 1. */
  readonly sizeTolerancePx?: number;
  /** Every reported issue (malformed markers, denials, failures, violations). */
  readonly onIssue?: (error: SfError) => void;
  /** Parent of the hydrator's lifetime (default: own root scope). */
  readonly scope?: Scope;
}

export interface StartOptions {
  /** Each island gets a `feature`-level child injector (for ui `provideScope`). */
  readonly injector?: Injector;
  /** Parent span for island spans (e.g. the boot span). */
  readonly parent?: Span;
}

export interface IslandHandle {
  readonly id: string;
  readonly chunk: IslandChunkId;
  readonly strategy: HydrateStrategy;
  readonly element: Element;
  readonly descriptor: IslandDescriptor;
  /** Reactive. */
  readonly state: IslandState;
  readonly error: SfError | undefined;
  /** Events captured before hydration and not yet replayed. */
  readonly queuedEvents: number;
  /** Hydrate now (ignores the trigger). Single-flight; `hydrated` → ok. */
  hydrate(): Promise<Result<void>>;
  /** Hydrate again after `failed`/`skipped` (e.g. the gate decision changed). */
  retry(): Promise<Result<void>>;
  /** Resolves when hydrated (ok) or failed/skipped/disposed (err). Does not trigger. */
  whenHydrated(signal?: AbortSignal): Promise<Result<void>>;
  dispose(): Promise<void>;
}

export interface IslandHydrator {
  /** Scan `root` and register every new island (an element is registered once). */
  start(root: ParentNode, options?: StartOptions): readonly IslandHandle[];
  /** Scan only (no registration). */
  scan(root: ParentNode): ScanResult;
  islands(): readonly IslandHandle[];
  get(id: string): IslandHandle | undefined;
  /** Hydrate one island now by id. */
  hydrate(id: string): Promise<Result<void>>;
  issues(): readonly SfError[];
  violations(): readonly LayoutShiftViolation[];
  dispose(): Promise<void>;
}

function decisionReason(decision: ChunkGateDecision): string | undefined {
  if (decision === true) return undefined;
  if (decision === false) return 'denied';
  return decision.allow ? undefined : decision.reason;
}

const NOT_LAID_OUT = (size: IslandSize): boolean => size.width === 0 && size.height === 0;

export function createIslandHydrator(options: IslandHydratorOptions): IslandHydrator {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const env: IslandEnv = { ...browserIslandEnv(), ...options.env };
  const gate = options.gate ?? allowAllIslands;
  const marks = options.marks ?? [];
  const tolerance = options.sizeTolerancePx ?? 1;
  const root = options.scope?.child('hydrate/islands') ?? createScope('hydrate/islands');
  const handles = new Map<string, IslandHandle>();
  const byElement = new WeakMap<Element, IslandHandle>();
  const rejected = new WeakSet<Element>();
  const issues: SfError[] = [];
  const violations: LayoutShiftViolation[] = [];
  const idCounters = new Map<string, number>();

  const report = (error: SfError): void => {
    issues.push(error);
    telemetry.event('island.issue', { subsystem: HYDRATE_SUBSYSTEMS.island, level: 'verbose', attrs: { code: error.code } });
    options.onIssue?.(error);
  };
  const eachMark = (fn: (port: IslandMarksPort) => void): void => {
    for (const port of marks) {
      try {
        fn(port);
      } catch (error) {
        report(toSfError(error));
      }
    }
  };
  const nextId = (chunk: IslandChunkId): string => {
    const n = idCounters.get(chunk) ?? 0;
    idCounters.set(chunk, n + 1);
    return `${chunk}#${n}`;
  };
  const exceeds = (a: IslandSize, b: IslandSize): boolean =>
    Math.abs(a.width - b.width) > tolerance || Math.abs(a.height - b.height) > tolerance;

  const violation = (v: LayoutShiftViolation, parent: Span | undefined): void => {
    violations.push(v);
    telemetry.record(hydrateMetrics.layoutShiftRisk, 1, { chunk: v.chunk, phase: v.phase }, parent);
    eachMark((port) => port.layoutShift(v.island));
    report(IslandLayoutShiftRiskError({
      message: `Island "${v.island}" ${v.phase === 'declared' ? 'does not match its declared size' : 'changed size during hydration'}: expected ${v.expected.width}×${v.expected.height}, got ${v.actual.width}×${v.actual.height}.`,
      details: { island: v.island, chunk: v.chunk, phase: v.phase, expected: v.expected, actual: v.actual },
    }));
  };

  const register = (descriptor: IslandDescriptor, start: StartOptions): IslandHandle => {
    const { element, chunk, strategy } = descriptor;
    const id = descriptor.id;
    const scope = root.child(`island:${id}`);
    const machine: Machine<IslandState, IslandEvent> = createMachine(islandMachine);
    const terminalWaiters = new Set<() => void>();
    let error: SfError | undefined;
    let replay: EventReplay | undefined;
    let running: Promise<Result<void>> | undefined;
    let hydrationScope: Scope | undefined;

    const reflect = (): void => {
      element.setAttribute(ISLAND_STATE_ATTR, machine.state);
    };
    machine.onTransition(() => {
      reflect();
      for (const waiter of [...terminalWaiters]) waiter();
    });
    reflect();
    const send = (event: IslandEvent): void => {
      machine.send(event);
    };
    const capture = (): void => {
      replay ??= createEventReplay(element, options.replay ?? {});
    };
    const dropQueued = (parent: Span | undefined): void => {
      const dropped = replay?.discard() ?? 0;
      replay = undefined;
      if (dropped > 0) telemetry.record(hydrateMetrics.eventsDropped, dropped, { chunk }, parent);
    };

    const fail = (span: Span, failure: SfError, event: 'fail' | 'deny'): Result<void> => {
      error = failure;
      dropQueued(span);
      const scopeToDispose = hydrationScope;
      hydrationScope = undefined;
      void scopeToDispose?.dispose();
      span.set('outcome', event === 'deny' ? 'skipped' : 'failed');
      span.end(event === 'deny' ? 'cancelled' : 'error', failure);
      if (!machine.is('disposed')) send(event);
      report(failure);
      return err(failure);
    };

    const run = async (): Promise<Result<void>> => {
      const started = env.now();
      const span = telemetry.span('island.hydrate', {
        subsystem: HYDRATE_SUBSYSTEMS.island,
        parent: start.parent,
        attrs: { island: id, chunk, strategy },
      });
      error = undefined;
      capture();
      const signal = scope.signal;
      const aborted = (): Result<void> => {
        const e = AbortedError({ details: { island: id } });
        span.end('cancelled', e);
        dropQueued(span);
        return err(e);
      };

      // 1. Gates — never fetch a denied chunk (I-8).
      const reason = decisionReason(gate(descriptor));
      if (reason !== undefined) {
        span.event('gate', { allow: false, reason });
        return fail(span, IslandDeniedError({ details: { island: id, chunk, reason } }), 'deny');
      }
      if (options.loader.check !== undefined) {
        const checked = options.loader.check(chunk);
        if (!checked.ok) {
          const wrapped = checked.error.kind === 'forbidden'
            ? IslandDeniedError({ details: { island: id, chunk, reason: checked.error.code }, cause: checked.error })
            : IslandLoadFailedError({ details: { island: id, chunk }, cause: checked.error });
          return fail(span, wrapped, wrapped.kind === 'forbidden' ? 'deny' : 'fail');
        }
      }
      span.event('gate', { allow: true });

      // 2. Size before hydration (+ declared size check).
      const before = env.measure(element);
      if (descriptor.declaredSize !== undefined && !NOT_LAID_OUT(before) && exceeds(descriptor.declaredSize, before)) {
        violation({ island: id, chunk, phase: 'declared', expected: descriptor.declaredSize, actual: before }, span);
      }

      // 3. Load the chunk.
      const loaded = await options.loader.load<unknown>(chunk, { signal, origin: strategy === 'eager' ? 'boot' : 'demand', parent: span });
      if (signal.aborted) return aborted();
      if (!loaded.ok) return fail(span, IslandLoadFailedError({ details: { island: id, chunk }, cause: loaded.error }), 'fail');
      span.event('loaded');
      const module: IslandModule | undefined = resolveIslandModule(loaded.value, descriptor.exportName);
      if (module === undefined) {
        return fail(span, IslandModuleInvalidError({ details: { island: id, chunk, exportName: descriptor.exportName ?? null } }), 'fail');
      }

      // 4. Props.
      const raw = parseIslandProps(descriptor);
      if (!raw.ok) return fail(span, raw.error, 'fail');
      let props: unknown = raw.value;
      if (module.props !== undefined) {
        const validated = module.props.validate(raw.value);
        if (!validated.ok) {
          return fail(span, IslandPropsInvalidError({ details: { island: id, chunk }, cause: validated.error }), 'fail');
        }
        props = validated.value;
      }
      send('loaded');

      // 5. Hydrate in a fresh scope (disposed on failure / island disposal).
      const local = scope.child('hydration');
      hydrationScope = local;
      let injector: Injector | undefined;
      if (start.injector !== undefined) {
        injector = start.injector.child('feature', `island:${id}`);
        const owned = injector;
        local.defer(() => owned.dispose());
      }
      let outcome: Result<void>;
      try {
        const returned = await module.hydrate(element, { props, signal: local.signal, scope: local, island: { id, chunk, strategy }, injector });
        outcome = returned === undefined ? ok() : returned;
      } catch (thrown) {
        outcome = err(toSfError(thrown));
      }
      if (signal.aborted) return aborted();
      if (!outcome.ok) return fail(span, IslandHydrateFailedError({ details: { island: id, chunk }, cause: outcome.error }), 'fail');

      // 6. Interactive: replay, marks, size check after the next frame.
      send('succeed');
      const replayed = replay?.replay() ?? { replayed: [], dropped: 0 };
      replay = undefined;
      for (const type of replayed.replayed) telemetry.record(hydrateMetrics.eventsReplayed, 1, { chunk, type }, span);
      if (replayed.dropped > 0) telemetry.record(hydrateMetrics.eventsDropped, replayed.dropped, { chunk }, span);
      span.event('replayed', { count: replayed.replayed.length, dropped: replayed.dropped });
      const duration = env.now() - started;
      telemetry.record(hydrateMetrics.islandInteractive, env.now(), { feature: id, chunk, strategy, method: 'island-hydrate' }, span);
      telemetry.record(hydrateMetrics.islandDuration, duration, { chunk, strategy, outcome: 'hydrated' }, span);
      eachMark((port) => port.renderDepsResolved(id));
      span.set('outcome', 'hydrated');
      span.set('replayed', replayed.replayed.length);
      span.end('ok');
      if (!NOT_LAID_OUT(before)) {
        env.afterFrame(() => {
          const after = env.measure(element);
          if (exceeds(before, after)) violation({ island: id, chunk, phase: 'hydration', expected: before, actual: after }, undefined);
        }, local.signal);
      }
      return ok();
    };

    const hydrate = (): Promise<Result<void>> => {
      if (machine.is('hydrated')) return Promise.resolve(ok());
      if (machine.is('disposed')) return Promise.resolve(err(AbortedError({ details: { island: id } })));
      if (strategy === 'never') {
        return Promise.resolve(err(IslandDeniedError({ message: `Island "${id}" is hydrate="never".`, details: { island: id, chunk, reason: 'never' } })));
      }
      if (running !== undefined) return running;
      if (machine.is('idle')) send('trigger');
      else if (machine.is('failed', 'skipped')) send('retry');
      running = run().finally(() => {
        running = undefined;
      });
      return running;
    };

    const handle: IslandHandle = {
      id,
      chunk,
      strategy,
      element,
      descriptor,
      get state() {
        return machine.state;
      },
      get error() {
        return error;
      },
      get queuedEvents() {
        return replay?.queued ?? 0;
      },
      hydrate,
      retry: hydrate,
      whenHydrated(signal) {
        return new Promise((resolve) => {
          const check = (): boolean => {
            if (machine.is('hydrated')) resolve(ok());
            else if (machine.is('failed', 'skipped')) resolve(err(error ?? IslandDeniedError({ details: { island: id, chunk, reason: machine.state } })));
            else if (machine.is('disposed')) resolve(err(AbortedError({ details: { island: id } })));
            else if (signal?.aborted === true) resolve(err(AbortedError({ cause: signal.reason })));
            else return false;
            return true;
          };
          if (check()) return;
          const waiter = (): void => {
            if (check()) cleanup();
          };
          const onAbort = (): void => waiter();
          const cleanup = (): void => {
            terminalWaiters.delete(waiter);
            signal?.removeEventListener('abort', onAbort);
          };
          terminalWaiters.add(waiter);
          // Removed by the waiter when the island settles (paired removeEventListener above).
          // sf-lint-disable-next-line no-bare-listener
          signal?.addEventListener('abort', onAbort, { once: true });
        });
      },
      async dispose() {
        if (machine.is('disposed')) return;
        dropQueued(undefined);
        send('dispose');
        handles.delete(id);
        byElement.delete(element);
        await scope.dispose();
      },
    };

    // Static markup is present: prerendered first render.
    eachMark((port) => {
      port.start(id);
      port.renderCommitted(id, element);
    });
    telemetry.record(hydrateMetrics.islandStatic, env.now(), { feature: id, chunk, method: 'prerendered' }, start.parent);

    // Schedule the trigger.
    const trigger = (): void => {
      if (machine.is('idle')) void hydrate();
    };
    switch (strategy) {
      case 'never':
        send('skip');
        break;
      case 'eager':
        capture();
        queueMicrotask(trigger);
        break;
      case 'idle':
        capture();
        env.idle(trigger, scope.signal);
        break;
      case 'visible':
        capture();
        if (env.whenVisible === undefined) queueMicrotask(trigger);
        else env.whenVisible(element, trigger, scope.signal);
        break;
      case 'interaction': {
        capture();
        const once = new AbortController();
        scope.defer(() => once.abort());
        const fire = (): void => {
          once.abort();
          trigger();
        };
        for (const type of INTERACTION_EVENTS) element.addEventListener(type, fire, { capture: true, signal: once.signal });
        if (options.loader.preload !== undefined) {
          const preload = options.loader.preload.bind(options.loader);
          const warmOnce = new AbortController();
          scope.defer(() => warmOnce.abort());
          const warm = (): void => {
            warmOnce.abort();
            const allowed = decisionReason(gate(descriptor)) === undefined;
            if (allowed && machine.is('idle')) preload(chunk, { origin: 'speculative' });
          };
          for (const type of WARM_EVENTS) element.addEventListener(type, warm, { capture: true, signal: warmOnce.signal });
        }
        break;
      }
    }
    return handle;
  };

  const hydrator: IslandHydrator = {
    scan: (target) => scanIslands(target),
    start(target, startOptions = {}) {
      if (root.disposed) return [];
      // Only unregistered elements are read, so repeated starts neither consume ids nor re-report.
      const added: IslandHandle[] = [];
      for (const element of islandElements(target)) {
        if (byElement.has(element) || rejected.has(element)) continue;
        const read = readIslandMarker(element, nextId);
        if (!read.ok) {
          rejected.add(element);
          report(read.error);
          continue;
        }
        for (const issue of read.value.issues) report(issue);
        const descriptor = read.value.descriptor;
        let unique = descriptor;
        if (handles.has(descriptor.id)) {
          let n = 1;
          while (handles.has(`${descriptor.id}~${n}`)) n += 1;
          unique = { ...descriptor, id: `${descriptor.id}~${n}` };
          report(IslandMarkerInvalidError({ message: `Duplicate island id "${descriptor.id}"; registered as "${unique.id}".`, details: { island: descriptor.id, chunk: descriptor.chunk } }));
        }
        const handle = register(unique, startOptions);
        handles.set(handle.id, handle);
        byElement.set(handle.element, handle);
        added.push(handle);
      }
      return added;
    },
    islands: () => [...handles.values()],
    get: (id) => handles.get(id),
    hydrate(id) {
      const handle = handles.get(id);
      if (handle === undefined) {
        return Promise.resolve(err(IslandMarkerInvalidError({ message: `No island "${id}" is registered.`, details: { island: id } })));
      }
      return handle.hydrate();
    },
    issues: () => [...issues],
    violations: () => [...violations],
    async dispose() {
      for (const handle of [...handles.values()]) await handle.dispose();
      await root.dispose();
    },
  };
  return hydrator;
}
