/**
 * `createDevtools` — the collector plus bound live sources, controls and view
 * builders behind one handle. No DOM; the panel (`@staticflux/devtools/panel`)
 * only renders what this handle returns.
 *
 * Sources are optional and can be bound late (`bind`). With an injector, sources
 * the app has *already* resolved are bound automatically (`bindFromInjector`):
 * devtools never instantiate app units as a side effect.
 */
import {
  type AnyUnit,
  createScope,
  err,
  type Injector,
  type LevelName,
  type MetricDefinition,
  ok,
  type Result,
  type Scope,
  type Subsystem,
  type Telemetry,
  type Token,
} from '@staticflux/core';
import { AccessAction, defineAction, type Decision, type Gate, type GateLevel, GateToken } from '@staticflux/gate';
import { type JourneyTracker, JourneyTrackerToken } from '@staticflux/perf';
import { type AppCommand, type FeatureHost, FeatureHostToken, type Supervisor, SupervisorToken } from '@staticflux/runtime';
import { type CollectorCapacity, createDevtoolsCollector, type DevtoolsCollector } from './collector.js';
import { SourceNotBoundError } from './errors.js';
import { createVerbosityControl, LEVEL_NAMES, type LevelEntry, type SessionStoragePort, type VerbosityControl } from './levels.js';
import { createRingBuffer, type RingBuffer } from './ring.js';
import {
  type BootWaterfall,
  buildBootWaterfall,
  buildDecisions,
  buildDiGraph,
  buildJourneysFromSpans,
  buildJourneysFromTracker,
  buildLifecycles,
  buildMetrics,
  buildViolations,
  type DecisionFilter,
  type DecisionsView,
  declaredMetricsOf,
  type DiGraphView,
  type JourneyView,
  type LifecycleView,
  type MetricsView,
  type StorePatchView,
  type StoreView,
  type ViolationsView,
} from './views.js';

// ---------------------------------------------------------------- store port

/** Minimal patch message shape (structural subset of `@staticflux/data` `PatchMessage`). */
export interface InspectablePatch {
  readonly version: number;
  readonly epoch: number;
  readonly action: string;
  readonly patches: readonly { readonly op: string; readonly path: readonly (string | number)[] }[];
}

/**
 * A store the inspector can show. `@staticflux/data` owner and replica stores
 * satisfy it structurally (`id`, `version`, `epoch`, `getSnapshot`, `onPatches`).
 */
export interface InspectableStore {
  readonly id: string;
  readonly mode?: string;
  readonly version: number;
  readonly epoch: number;
  getSnapshot(): { readonly state: unknown; readonly schemaVersion?: number };
  onPatches?(listener: (message: InspectablePatch) => void): () => void;
}

// ---------------------------------------------------------------- handle

/** Commands devtools may trigger; all go through `supervisor.request()` and its command policy (R4.5). */
export const DEVTOOLS_COMMANDS = ['pause', 'resume', 'refresh'] as const satisfies readonly AppCommand[];
export type DevtoolsCommand = (typeof DEVTOOLS_COMMANDS)[number];

/** Source id used in command requests and telemetry. */
export const DEVTOOLS_SOURCE = 'devtools' as const;
export const DEVTOOLS_SUBSYSTEM = 'devtools/panel' as const satisfies Subsystem;

export interface DevtoolsSources {
  readonly injector?: Injector | undefined;
  readonly supervisor?: Supervisor | undefined;
  readonly featureHost?: FeatureHost | undefined;
  readonly gate?: Gate | undefined;
  readonly journeys?: JourneyTracker | undefined;
  readonly stores?: readonly InspectableStore[] | undefined;
  /** Unit definitions for the declared DI graph (`analyzeGraph`) and declared metrics. */
  readonly units?: readonly AnyUnit[] | undefined;
  /** Extra declared metrics to list even before they are recorded. */
  readonly metrics?: readonly MetricDefinition[] | undefined;
}

export interface DevtoolsOptions extends DevtoolsSources {
  readonly telemetry: Telemetry;
  readonly capacity?: Partial<CollectorCapacity>;
  /** Tab-session storage for `?sf-debug` persistence (default: none). */
  readonly session?: SessionStoragePort | undefined;
  /** Clock for "elapsed" values of open spans/journeys (default `telemetry.now`). */
  readonly now?: () => number;
  /** Coalesces change notifications (default `queueMicrotask`). */
  readonly schedule?: (callback: () => void) => void;
  /** Patches kept per store (default 50). */
  readonly patchHistory?: number;
}

export interface SettingsView {
  readonly subsystems: readonly { readonly subsystem: string; readonly level: LevelName; readonly overridden: boolean }[];
  readonly overrides: readonly LevelEntry[];
  readonly levels: readonly LevelName[];
  readonly commands: readonly { readonly command: DevtoolsCommand; readonly available: boolean }[];
  readonly appState: string | undefined;
  readonly bound: Readonly<Record<keyof DevtoolsSources, boolean>>;
}

export interface ExplanationView {
  readonly level: GateLevel;
  readonly resourceId: string;
  readonly actionId: string;
  readonly subject: 'principal' | 'agent';
  readonly effect: 'allow' | 'deny';
  readonly reason: string | undefined;
  readonly meta: Readonly<Record<string, unknown>>;
  readonly alternatives: readonly string[];
  readonly determining: readonly string[];
  readonly evaluated: readonly string[];
  readonly facts: readonly { readonly fact: string; readonly value: unknown }[];
  readonly source: 'policy' | 'unmatched';
  readonly tableVersion: number;
  readonly cost: { readonly meter: string; readonly amount: number } | undefined;
  readonly requiresConfirmation: boolean;
}

export interface DevtoolsViews {
  boot(): BootWaterfall;
  journeys(): readonly JourneyView[];
  graph(): DiGraphView;
  lifecycles(): LifecycleView;
  decisions(filter?: DecisionFilter): DecisionsView;
  stores(): readonly StoreView[];
  violations(): ViolationsView;
  metrics(): MetricsView;
  settings(): SettingsView;
}

export interface Devtools {
  readonly telemetry: Telemetry;
  readonly collector: DevtoolsCollector;
  readonly verbosity: VerbosityControl;
  readonly views: DevtoolsViews;
  readonly scope: Scope;
  /** Bumped (coalesced) on every change that may affect a view. */
  readonly revision: number;
  bind(sources: DevtoolsSources): void;
  /** Bind sources the app already resolved (never instantiates units). Returns the keys newly bound. */
  bindFromInjector(injector?: Injector): Promise<readonly (keyof DevtoolsSources)[]>;
  sources(): DevtoolsSources;
  /** Fresh, fully attributed gate evaluation ("why?", R6.11). */
  explain(level: GateLevel, resourceId: string, actionId?: string, subject?: 'principal' | 'agent'): Result<ExplanationView>;
  canCommand(command: DevtoolsCommand): boolean;
  /** Ask the supervisor for an app command; its command policy decides. */
  command(command: DevtoolsCommand, reason?: string): Promise<Result<void>>;
  setLevel(subsystem: Subsystem | '*', level: LevelName): void;
  subscribe(listener: () => void): () => void;
  dispose(): Promise<void>;
}

function decisionToRecord(decision: Decision, subject: string, time: number): Parameters<DevtoolsCollector['recordDecision']>[0] {
  const t = decision.trace;
  return {
    time,
    key: `${t.level}:${t.resourceId}:${t.actionId}`,
    level: t.level,
    resourceId: t.resourceId,
    actionId: t.actionId,
    subject,
    effect: decision.effect,
    reason: decision.effect === 'deny' ? decision.reason : undefined,
    determining: [...t.determining],
    facts: t.facts.map((f) => ({ fact: f.fact, value: f.value })),
    alternatives: decision.effect === 'deny' ? decision.alternatives.map((a) => a.reason) : undefined,
    source: 'gate',
  };
}

export function createDevtools(options: DevtoolsOptions): Devtools {
  const { telemetry } = options;
  const scope = createScope('devtools');
  const now = options.now ?? (() => telemetry.now());
  const schedule = options.schedule ?? ((cb: () => void) => queueMicrotask(cb));
  const collector = createDevtoolsCollector(options.capacity === undefined ? {} : { capacity: options.capacity });
  const verbosity = createVerbosityControl({ telemetry, session: options.session });
  const listeners = new Set<() => void>();
  const patchLogs = new Map<string, RingBuffer<StorePatchView>>();
  const patchHistory = options.patchHistory ?? 50;
  let revision = 0;
  let pending = false;
  let disposed = false;
  let sources: DevtoolsSources = {};
  const unbind = new Map<keyof DevtoolsSources, () => void>();

  const notify = (): void => {
    if (pending || disposed) return;
    pending = true;
    schedule(() => {
      pending = false;
      if (disposed) return;
      revision += 1;
      for (const listener of [...listeners]) listener();
    });
  };

  scope.defer(telemetry.addSink(collector));
  scope.defer(collector.onChange(notify));
  scope.defer(verbosity.onChange(notify));
  scope.defer(() => {
    for (const stop of unbind.values()) stop();
    unbind.clear();
  });

  const attach = (key: keyof DevtoolsSources, stop: (() => void) | undefined): void => {
    unbind.get(key)?.();
    unbind.delete(key);
    if (stop !== undefined) unbind.set(key, stop);
  };

  const bind = (next: DevtoolsSources): void => {
    if (disposed) return;
    const merged: Record<string, unknown> = { ...sources };
    for (const [key, value] of Object.entries(next)) if (value !== undefined) merged[key] = value;
    sources = merged as DevtoolsSources;
    if (next.gate !== undefined) {
      const gate = next.gate;
      collector.preferGateDecisions(true);
      attach('gate', gate.onDecisionChange((change) => collector.recordDecision(decisionToRecord(change.after, change.subject, now()))));
    }
    if (next.supervisor !== undefined) attach('supervisor', next.supervisor.onTransition(notify));
    if (next.featureHost !== undefined) attach('featureHost', next.featureHost.onTransition(notify));
    if (next.journeys !== undefined) attach('journeys', next.journeys.onJourney(notify));
    if (next.stores !== undefined) {
      const stops: (() => void)[] = [];
      for (const store of next.stores) {
        let log = patchLogs.get(store.id);
        if (log === undefined) {
          log = createRingBuffer(patchHistory);
          patchLogs.set(store.id, log);
        }
        const target = log;
        const stop = store.onPatches?.((message) => {
          target.push({
            time: now(),
            version: message.version,
            epoch: message.epoch,
            action: message.action,
            ops: message.patches.length,
            paths: message.patches.slice(0, 10).map((p) => `${p.op} /${p.path.join('/')}`),
          });
          notify();
        });
        if (stop !== undefined) stops.push(stop);
      }
      attach('stores', () => {
        for (const stop of stops) stop();
      });
    }
    notify();
  };

  const optionalTokens: readonly [keyof DevtoolsSources, Token<unknown>][] = [
    ['supervisor', SupervisorToken as Token<unknown>],
    ['featureHost', FeatureHostToken as Token<unknown>],
    ['gate', GateToken as Token<unknown>],
    ['journeys', JourneyTrackerToken as Token<unknown>],
  ];

  const bindFromInjector = async (injector = sources.injector): Promise<readonly (keyof DevtoolsSources)[]> => {
    if (injector === undefined || disposed) return [];
    if (sources.injector === undefined) bind({ injector });
    const found: Record<string, unknown> = {};
    for (const [key, tok] of optionalTokens) {
      if (sources[key] !== undefined) continue;
      if (injector.stateOf(tok) !== 'ready') continue;
      const resolved = await injector.get(tok);
      if (resolved.ok) found[key] = resolved.value;
    }
    const keys = Object.keys(found) as (keyof DevtoolsSources)[];
    if (keys.length > 0) bind(found as DevtoolsSources);
    return keys;
  };

  bind({
    injector: options.injector,
    supervisor: options.supervisor,
    featureHost: options.featureHost,
    gate: options.gate,
    journeys: options.journeys,
    stores: options.stores,
    units: options.units,
    metrics: options.metrics,
  });

  const views: DevtoolsViews = {
    boot: () => buildBootWaterfall(collector.bootTrace(), now()),
    journeys: () => (sources.journeys !== undefined ? buildJourneysFromTracker(sources.journeys, now()) : buildJourneysFromSpans(collector.spans())),
    graph: () => buildDiGraph(sources.injector?.inspect() ?? [], sources.units),
    lifecycles: () =>
      buildLifecycles(collector.lifecycles(), {
        app: sources.supervisor === undefined ? undefined : { state: sources.supervisor.state, epoch: sources.supervisor.epoch },
        subsystems: sources.supervisor?.inspect(),
        features: sources.featureHost?.list(),
      }),
    decisions: (filter) => buildDecisions(collector.decisions(), filter),
    stores: () =>
      (sources.stores ?? []).map((store) => {
        const snapshot = store.getSnapshot();
        return {
          id: store.id,
          mode: store.mode ?? 'store',
          version: store.version,
          epoch: store.epoch,
          schemaVersion: snapshot.schemaVersion,
          state: snapshot.state,
          patches: [...(patchLogs.get(store.id)?.toArray() ?? [])].reverse(),
        };
      }),
    violations: () => buildViolations(collector.violations(), collector.violationCount()),
    metrics: () => buildMetrics(collector.metrics(), [...declaredMetricsOf(sources.units ?? []), ...(sources.metrics ?? [])]),
    settings: () => {
      const overrides = verbosity.overrides();
      const overridden = new Set(overrides.map((o) => o.subsystem));
      return {
        subsystems: collector.subsystems().map((subsystem) => ({
          subsystem,
          level: verbosity.levelOf(subsystem as Subsystem),
          overridden: overridden.has(subsystem as Subsystem),
        })),
        overrides,
        levels: LEVEL_NAMES,
        commands: DEVTOOLS_COMMANDS.map((command) => ({ command, available: handle.canCommand(command) })),
        appState: sources.supervisor?.state,
        bound: {
          injector: sources.injector !== undefined,
          supervisor: sources.supervisor !== undefined,
          featureHost: sources.featureHost !== undefined,
          gate: sources.gate !== undefined,
          journeys: sources.journeys !== undefined,
          stores: sources.stores !== undefined,
          units: sources.units !== undefined,
          metrics: sources.metrics !== undefined,
        },
      };
    },
  };

  const handle: Devtools = {
    telemetry,
    collector,
    verbosity,
    views,
    scope,
    get revision() {
      return revision;
    },
    bind,
    bindFromInjector,
    sources: () => sources,
    explain(level, resourceId, actionId, subject = 'principal') {
      const gate = sources.gate;
      if (gate === undefined) return err(SourceNotBoundError({ message: 'No gate bound: decision explanations need `gate`.', details: { source: 'gate' } }));
      const action = actionId === undefined || actionId === '' ? AccessAction : defineAction(actionId as `${string}/${string}`);
      const decision = gate.explain(level, resourceId, action, { subject });
      const t = decision.trace;
      return ok({
        level,
        resourceId,
        actionId: action.id,
        subject,
        effect: decision.effect,
        reason: decision.effect === 'deny' ? decision.reason : undefined,
        meta: decision.effect === 'deny' ? decision.meta : {},
        alternatives: decision.effect === 'deny' ? decision.alternatives.map((a) => a.reason) : [],
        determining: [...t.determining],
        evaluated: [...t.evaluated],
        facts: t.facts.map((f) => ({ fact: f.fact, value: f.value })),
        source: t.source,
        tableVersion: t.tableVersion,
        cost: decision.effect === 'allow' ? decision.cost : undefined,
        requiresConfirmation: decision.effect === 'allow' ? decision.requiresConfirmation : false,
      });
    },
    canCommand(command) {
      return sources.supervisor?.can(command) ?? false;
    },
    async command(command, reason) {
      const supervisor = sources.supervisor;
      if (supervisor === undefined) {
        return err(SourceNotBoundError({ message: `No supervisor bound: cannot request "${command}".`, details: { source: 'supervisor', command } }));
      }
      telemetry.event('devtools.command', { subsystem: DEVTOOLS_SUBSYSTEM, level: 'standard', attrs: { command } });
      const result = await supervisor.request({ command, source: DEVTOOLS_SOURCE, ...(reason === undefined ? {} : { reason }) });
      notify();
      return result;
    },
    setLevel(subsystem, level) {
      verbosity.setLevel(subsystem, level);
      telemetry.event('devtools.level-changed', { subsystem: DEVTOOLS_SUBSYSTEM, level: 'standard', attrs: { target: subsystem, level } });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      await scope.dispose();
    },
  };
  return handle;
}
