/**
 * The injector: hierarchical, scope-aware, readiness-aware dependency injection.
 *
 * - Injectors form a tree that mirrors scope levels (app → session → … → component).
 * - A unit's instance lives in the nearest injector whose level equals the unit's scope.
 * - Resolution ("injected") and readiness ("initialized") are distinct states.
 * - `init()` runs once per instance (single-flight); every consumer shares it.
 * - Refresh (`refreshOn` tokens or app epoch) re-initializes without recreating.
 * - Every resolution, init and refresh is traced (`core/di`).
 *
 * See docs/LIFECYCLES.md §4–§5 and invariants I-2, I-3, I-4, I-12.
 */
import { retry, task } from './async.js';
import { createScope, type Scope } from './disposal.js';
import { defineError, type SfError, toSfError } from './errors.js';
import { box, type Box } from './reactivity.js';
import { err, ok, type Result } from './result.js';
import { createNoopTelemetry, type LevelName, type Span, type Telemetry } from './telemetry.js';
import type { AnyToken, Token, TokenId } from './token.js';
import {
  type AnyUnit,
  type DeferredSource,
  type DepHandle,
  dependencyEdges,
  type FunctionalDep,
  type HandleState,
  type HookOptions,
  type InitTiming,
  type ScopeLevel,
  scopeRank,
  type UnitContext,
  type UnitState,
} from './unit.js';

// ---------------------------------------------------------------- errors

export const NoProviderError = defineError(
  'SF-DI-001',
  'invariant',
  'No unit provides the requested token in this injector chain.',
  'Register a unit that `provides` this token, or check that the feature module providing it is loaded.',
);
export const ScopeViolationError = defineError(
  'SF-DI-002',
  'invariant',
  'A longer-lived unit depends on a shorter-lived unit.',
  'Lower the consumer scope, raise the dependency scope, or pass the shorter-lived value as an argument instead.',
);
export const DependencyFailedError = defineError(
  'SF-DI-003',
  'unavailable',
  'A required dependency failed, so this unit cannot become ready.',
  'Fix the failing dependency (see `cause`), or make it a lazy dependency if this unit can work without it.',
);
export const CycleError = defineError(
  'SF-DI-004',
  'invariant',
  'Required dependencies form a cycle.',
  'Break the cycle by making one edge lazy or functional, or extract the shared part into its own unit.',
);
export const CreateFailedError = defineError(
  'SF-DI-005',
  'invariant',
  "A unit's create() threw.",
  'create() must be synchronous and side-effect free; move fallible work to init() and return a Result.',
);
export const NoHostScopeError = defineError(
  'SF-DI-006',
  'invariant',
  "No injector of the unit's scope level exists in the requesting chain.",
  'Resolve from an injector at (or below) the unit scope, e.g. a feature-scoped unit from a feature injector.',
);
export const RegistrationScopeError = defineError(
  'SF-DI-007',
  'invariant',
  'A unit was registered in an injector shorter-lived than its own scope.',
  'Register app/session units at the app/session injector; feature modules may only register feature-or-shorter units.',
);
export const InitFailedError = defineError(
  'SF-DI-008',
  'unavailable',
  "A unit's init() failed.",
  'Inspect `cause`. Add a `retry` policy for transient failures, or surface degraded UI via the failed state.',
);
export const InjectorDisposedError = defineError(
  'SF-DI-010',
  'aborted',
  'The injector (scope) was disposed.',
  'Expected during navigation/logout. Do not retain handles beyond their scope.',
);

// ---------------------------------------------------------------- bindings

export type BindingPrecedence = 'default' | 'app' | 'workspace' | 'experiment';
const PRECEDENCE: Record<BindingPrecedence, number> = { default: 0, app: 1, workspace: 2, experiment: 3 };

export interface Binding {
  readonly kind: 'binding';
  readonly unit: AnyUnit;
  readonly precedence: BindingPrecedence;
  /** Evaluated once per host scope instance when the token is first resolved. */
  readonly when: (() => boolean) | undefined;
  /** Who contributed the override (shown in devtools). */
  readonly source: string | undefined;
}

export interface BindOptions {
  readonly precedence?: BindingPrecedence;
  readonly when?: () => boolean;
  readonly source?: string;
}

export function bind(unitDefinition: AnyUnit, options: BindOptions = {}): Binding {
  return {
    kind: 'binding',
    unit: unitDefinition,
    precedence: options.precedence ?? 'default',
    when: options.when,
    source: options.source,
  };
}

/**
 * An experiment variant: re-binds `of` to `unit` when `when()` is true.
 * Feature code keeps calling inject(of) and never sees the condition.
 */
export function variant<T>(options: {
  readonly of: Token<T>;
  readonly unit: AnyUnit;
  readonly when: () => boolean;
  readonly source?: string;
}): Binding {
  if (options.unit.provides.id !== options.of.id) {
    throw new Error(`variant(): unit "${options.unit.id}" provides "${options.unit.provides.id}", not "${options.of.id}"`);
  }
  return bind(options.unit, { precedence: 'experiment', when: options.when, source: options.source ?? 'experiment' });
}

export type Registration = AnyUnit | Binding;

export interface DeferredUnitsOptions {
  /** Namespaced id of the group, e.g. `studio/capabilities` (telemetry span `di.deferred`, devtools). */
  readonly id: TokenId;
  /** Tokens whose first resolution (get, required/lazy/functional dep) loads the group. */
  readonly provides: readonly AnyToken[];
  /** Scope of the placeholders (default `app`); the loaded units register in that scope's injector. */
  readonly scope?: ScopeLevel;
  /** Import the chunk and return its registrations. Runs at most once per injector (retried after a failure). */
  load(signal: AbortSignal): Promise<readonly Registration[]>;
  readonly description?: string;
}

/**
 * Lazy units (R12.12 "everything lazy by default"): placeholders for `provides` whose code is
 * not in the boot bundle. The first resolution of any of these tokens runs `load()` (typically
 * `() => import('./x.js').then((m) => m.units)`), registers the returned units in the injector
 * of the placeholders' scope and resolves the real provider (span `di.deferred`). Consumers do
 * not change: a required dep, `injector.get` or a lazy/functional handle waits for the chunk
 * (a lazy dep with the default `on-arrival` timing triggers the load right away).
 *
 * Multi tokens: listing one makes its next resolution load the group first. Units of the group
 * that contribute to multi tokens not listed here only join later resolutions (e.g. contribute
 * subsystems with `supervisor.register`, not via `SubsystemsToken`, which resolves at boot).
 */
// Never called: resolving a placeholder resolves the loaded provider instead.
const neverCreated = (): never => {
  throw new Error('deferred');
};

/* @__NO_SIDE_EFFECTS__ */
export function deferredUnits(options: DeferredUnitsOptions): readonly AnyUnit[] {
  const source: DeferredSource = { id: options.id, load: options.load };
  return options.provides.map(
    (provides): AnyUnit => ({
      id: `${options.id}#${provides.id}` as TokenId,
      provides,
      scope: options.scope ?? 'app',
      deferred: source,
      create: neverCreated,
      description: options.description ?? options.id,
    }),
  );
}

function toBinding(entry: Registration): Binding {
  return 'kind' in entry && entry.kind === 'binding' ? entry : bind(entry as AnyUnit);
}

// ---------------------------------------------------------------- public API

export interface InstanceInfo {
  readonly unitId: string;
  readonly tokenId: TokenId;
  readonly scope: ScopeLevel;
  readonly injector: string;
  readonly state: UnitState;
  readonly critical: boolean;
  readonly error: Readonly<Record<string, unknown>> | undefined;
}

export interface Injector {
  readonly name: string;
  readonly level: ScopeLevel;
  readonly parent: Injector | undefined;
  readonly scope: Scope;
  readonly telemetry: Telemetry;
  /** Current app epoch (shared across the tree). */
  readonly epoch: number;
  /** Add units/bindings (e.g. when a feature module loads). */
  register(...entries: readonly Registration[]): Result<void>;
  /** Create a child injector for a shorter-lived scope. */
  child(level: ScopeLevel, name: string, entries?: readonly Registration[]): Injector;
  /** Resolve and wait until ready. */
  get<T>(token: Token<T>, signal?: AbortSignal): Promise<Result<T>>;
  /** Lazy reactive handle (does not resolve until triggered unless timing says so). */
  handle<T>(token: Token<T>, init?: InitTiming): DepHandle<T>;
  /** Functional handle (resolves on first use). */
  functional<T>(token: Token<T>, init?: InitTiming): FunctionalDep<T>;
  /** Readiness state of the instance providing `token` from this injector's perspective. */
  stateOf(token: AnyToken): UnitState;
  /** Resolve every critical unit visible from this injector. `parent` nests the `boot.critical` span. */
  resolveCritical(signal?: AbortSignal, parent?: Span): Promise<Result<void>>;
  /** Refresh units providing `tokens` (and units that `refreshOn` them), or bump the epoch. */
  refresh(target: readonly AnyToken[] | 'epoch'): Promise<Result<void>>;
  /** Snapshot for devtools. Includes descendants. */
  inspect(): readonly InstanceInfo[];
  dispose(): Promise<void>;
}

export interface InjectorOptions {
  readonly name?: string;
  readonly level?: ScopeLevel;
  readonly units?: readonly Registration[];
  readonly telemetry?: Telemetry;
  /** Schedule idle work (default: requestIdleCallback → setTimeout fallback). */
  readonly idle?: (callback: () => void) => void;
}

export function createInjector(options: InjectorOptions = {}): Injector {
  const root = new InjectorImpl(
    options.name ?? 'app',
    options.level ?? 'app',
    undefined,
    {
      telemetry: options.telemetry ?? createNoopTelemetry(),
      idle: options.idle ?? defaultIdle,
      epoch: box(0),
      order: { next: 0 },
    },
  );
  const registered = root.register(...(options.units ?? []));
  if (!registered.ok) throw registered.error;
  return root;
}

function defaultIdle(callback: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
  if (typeof ric === 'function') ric(callback);
  else setTimeout(callback, 1);
}

// ---------------------------------------------------------------- internals

interface Shared {
  readonly telemetry: Telemetry;
  readonly idle: (callback: () => void) => void;
  readonly epoch: Box<number>;
  readonly order: { next: number };
}

const SUBSYSTEM = 'core/di' as const;

class Instance {
  readonly stateBox: Box<UnitState> = box<UnitState>('resolving');
  value: unknown = undefined;
  error: SfError | undefined = undefined;
  ready!: Promise<Result<unknown>>;
  context!: UnitContext;
  readonly listeners = new Set<(state: UnitState) => void>();
  readonly blocking: Promise<Result<void>>[] = [];
  readonly order: number;

  constructor(
    readonly definition: AnyUnit,
    readonly host: InjectorImpl,
    readonly scope: Scope,
  ) {
    this.order = host.shared.order.next++;
  }

  get state(): UnitState {
    return this.stateBox.get();
  }

  setState(state: UnitState): void {
    this.stateBox.set(state);
    for (const listener of [...this.listeners]) listener(state);
  }
}

class InjectorImpl implements Injector {
  readonly scope: Scope;
  readonly bindings = new Map<TokenId, Binding[]>();
  readonly instances = new Map<AnyUnit, Instance>();
  readonly chosen = new Map<TokenId, Binding>();
  readonly children = new Set<InjectorImpl>();
  /** Deferred groups loaded (or loading) into this injector. */
  readonly deferredLoads = new Map<DeferredSource, Promise<Result<void>>>();
  disposed = false;

  constructor(
    readonly name: string,
    readonly level: ScopeLevel,
    readonly parent: InjectorImpl | undefined,
    readonly shared: Shared,
  ) {
    this.scope = parent === undefined ? createScope(`injector:${name}`) : parent.scope.child(`injector:${name}`);
  }

  get telemetry(): Telemetry {
    return this.shared.telemetry;
  }

  get epoch(): number {
    return this.shared.epoch.get();
  }

  register(...entries: readonly Registration[]): Result<void> {
    for (const entry of entries) {
      const binding = toBinding(entry);
      if (scopeRank(binding.unit.scope) < scopeRank(this.level)) {
        return err(
          RegistrationScopeError({
            units: [binding.unit.id],
            scope: this.level,
            message: `Unit "${binding.unit.id}" (scope ${binding.unit.scope}) cannot be registered in injector "${this.name}" (scope ${this.level}).`,
          }),
        );
      }
      const list = this.bindings.get(binding.unit.provides.id) ?? [];
      list.push(binding);
      this.bindings.set(binding.unit.provides.id, list);
    }
    return ok();
  }

  child(level: ScopeLevel, name: string, entries: readonly Registration[] = []): Injector {
    if (scopeRank(level) < scopeRank(this.level)) {
      throw ScopeViolationError({
        message: `Child injector "${name}" (${level}) cannot be longer-lived than parent "${this.name}" (${this.level}).`,
      });
    }
    const child = new InjectorImpl(name, level, this, this.shared);
    this.children.add(child);
    child.scope.defer(() => {
      this.children.delete(child);
    });
    const registered = child.register(...entries);
    if (!registered.ok) throw registered.error;
    return child;
  }

  async get<T>(token: Token<T>, signal?: AbortSignal): Promise<Result<T>> {
    const result = await this.resolve(token, [], undefined, undefined);
    if (signal?.aborted === true) return err(InjectorDisposedError({ cause: signal.reason }));
    return result as Result<T>;
  }

  handle<T>(token: Token<T>, init: InitTiming = 'on-demand'): DepHandle<T> {
    const handle = new Handle<T>(this, token, undefined);
    scheduleTiming(handle, init, this.shared.idle);
    return handle;
  }

  functional<T>(token: Token<T>, init: InitTiming = 'on-demand'): FunctionalDep<T> {
    return functionalFrom(this.handle(token, init));
  }

  stateOf(token: AnyToken): UnitState {
    const binding = this.choose(token.id);
    if (binding === undefined) return 'unresolved';
    const host = this.findHost(binding.unit.scope);
    return host?.instances.get(binding.unit)?.state ?? 'unresolved';
  }

  async resolveCritical(signal?: AbortSignal, parent?: Span): Promise<Result<void>> {
    const span = this.telemetry.span('di.critical', {
      subsystem: SUBSYSTEM,
      level: 'critical',
      parent,
      attrs: { injector: this.name },
    });
    const critical: Binding[] = [];
    const seen = new Set<TokenId>();
    for (let injector: InjectorImpl | undefined = this; injector !== undefined; injector = injector.parent) {
      for (const [tokenId, list] of injector.bindings) {
        if (seen.has(tokenId)) continue;
        seen.add(tokenId);
        for (const binding of list) if (binding.unit.critical === true) critical.push(binding);
      }
    }
    span.set('count', critical.length);
    const results = await Promise.all(
      critical.map((binding) => this.resolve(binding.unit.provides, [], span, undefined)),
    );
    const failure = results.find((r) => !r.ok);
    if (signal?.aborted === true) {
      span.end('cancelled');
      return err(InjectorDisposedError());
    }
    if (failure !== undefined && !failure.ok) {
      span.end('error', failure.error);
      return err(failure.error);
    }
    span.end('ok');
    return ok();
  }

  async refresh(target: readonly AnyToken[] | 'epoch'): Promise<Result<void>> {
    const span = this.telemetry.span('di.refresh', {
      subsystem: SUBSYSTEM,
      level: 'standard',
      attrs: { target: target === 'epoch' ? 'epoch' : target.map((t) => t.id) },
    });
    const live = this.liveInstances();
    let wave: Instance[];
    const refreshed = new Set<TokenId>();
    if (target === 'epoch') {
      this.shared.epoch.set(this.shared.epoch.get() + 1);
      wave = live.filter((i) => i.definition.refreshOn?.includes('epoch') === true);
    } else {
      const ids = new Set(target.map((t) => t.id));
      wave = live.filter((i) => ids.has(i.definition.provides.id));
      for (const id of ids) refreshed.add(id);
    }
    const done = new Set<Instance>();
    let failure: SfError | undefined;
    while (wave.length > 0) {
      const current = wave.filter((i) => !done.has(i));
      for (const instance of current) done.add(instance);
      const results = await Promise.all(current.map((instance) => refreshInstance(instance, span)));
      for (const r of results) if (!r.ok) failure ??= r.error;
      for (const instance of current) refreshed.add(instance.definition.provides.id);
      wave = live.filter(
        (i) =>
          !done.has(i) &&
          i.definition.refreshOn?.some((t: AnyToken | 'epoch') => t !== 'epoch' && refreshed.has(t.id)) === true,
      );
    }
    if (failure !== undefined) {
      span.end('error', failure);
      return err(failure);
    }
    span.end('ok');
    return ok();
  }

  inspect(): readonly InstanceInfo[] {
    const out: InstanceInfo[] = [];
    for (const instance of this.instances.values()) {
      out.push({
        unitId: instance.definition.id,
        tokenId: instance.definition.provides.id,
        scope: instance.definition.scope,
        injector: this.name,
        state: instance.state,
        critical: instance.definition.critical === true,
        error: instance.error?.toJSON(),
      });
    }
    for (const child of this.children) out.push(...child.inspect());
    return out;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const child of [...this.children].reverse()) await child.dispose();
    const ordered = [...this.instances.values()].sort((a, b) => b.order - a.order);
    for (const instance of ordered) {
      await instance.scope.dispose();
      instance.setState('disposed');
    }
    await this.scope.dispose();
  }

  // -------------------------------------------------------------- resolution

  /** Pick the binding for a single token: highest precedence, nearest injector, latest registration. */
  choose(tokenId: TokenId): Binding | undefined {
    const cached = this.chosen.get(tokenId);
    if (cached !== undefined) return cached;
    let best: Binding | undefined;
    let bestScore = -1;
    let depth = 0;
    for (let injector: InjectorImpl | undefined = this; injector !== undefined; injector = injector.parent, depth += 1) {
      const list = injector.bindings.get(tokenId) ?? [];
      for (const binding of list) {
        if (binding.when !== undefined && !binding.when()) continue;
        // precedence dominates; nearer injectors beat farther ones at equal precedence.
        const score = PRECEDENCE[binding.precedence] * 1000 + (1000 - depth);
        if (score >= bestScore) {
          best = binding;
          bestScore = score;
        }
      }
    }
    // A deferred placeholder is not cached: once its group loads, the real provider wins.
    if (best?.unit.deferred === undefined && best !== undefined) this.chosen.set(tokenId, best);
    return best;
  }

  /** All applicable bindings for a multi token, ordered by `order`. */
  chooseAll(tokenId: TokenId): Binding[] {
    const all: Binding[] = [];
    for (let injector: InjectorImpl | undefined = this; injector !== undefined; injector = injector.parent) {
      for (const binding of injector.bindings.get(tokenId) ?? []) {
        if (binding.when === undefined || binding.when()) all.push(binding);
      }
    }
    return all.sort((a, b) => (a.unit.order ?? 0) - (b.unit.order ?? 0));
  }

  findHost(level: ScopeLevel): InjectorImpl | undefined {
    for (let injector: InjectorImpl | undefined = this; injector !== undefined; injector = injector.parent) {
      if (injector.level === level) return injector;
    }
    return undefined;
  }

  liveInstances(): Instance[] {
    const out = [...this.instances.values()].filter((i) => i.state !== 'disposed');
    for (const child of this.children) out.push(...child.liveInstances());
    return out;
  }

  /**
   * Resolve `token` from this injector.
   * @param stack unit ids on the required-dependency path (cycle detection)
   * @param consumer the consuming unit (scope-rule check), if any
   */
  async resolve(
    token: AnyToken,
    stack: readonly string[],
    parentSpan: Span | undefined,
    consumer: AnyUnit | undefined,
  ): Promise<Result<unknown>> {
    if (this.disposed) return err(InjectorDisposedError({ scope: this.name }));
    if (token.multi) {
      let bindings = this.chooseAll(token.id);
      const deferred = bindings.filter((b) => b.unit.deferred !== undefined);
      if (deferred.length > 0) {
        const failed = (await Promise.all(deferred.map((b) => this.loadDeferred(b, parentSpan)))).find((r) => !r.ok);
        if (failed !== undefined) return failed;
        bindings = this.chooseAll(token.id).filter((b) => b.unit.deferred === undefined);
      }
      const results = await Promise.all(
        bindings.map((b) => this.resolveBinding(b, stack, parentSpan, consumer).then((r) => r.result)),
      );
      const values: unknown[] = [];
      for (const r of results) {
        if (!r.ok) return r;
        values.push(r.value);
      }
      return ok(values);
    }
    const binding = this.choose(token.id);
    if (binding === undefined) {
      return err(
        NoProviderError({
          message: `No provider for "${token.id}" in injector "${this.name}".`,
          details: { token: token.id, injector: this.name },
          units: consumer === undefined ? [] : [consumer.id],
        }),
      );
    }
    return (await this.resolveBinding(binding, stack, parentSpan, consumer)).result;
  }

  async resolveBinding(
    binding: Binding,
    stack: readonly string[],
    parentSpan: Span | undefined,
    consumer: AnyUnit | undefined,
  ): Promise<{ result: Result<unknown>; instance: Instance | undefined }> {
    const definition = binding.unit;
    if (definition.deferred !== undefined) {
      // A deferredUnits() placeholder: load its group, then resolve the real provider.
      const loaded = await this.loadDeferred(binding, parentSpan);
      const next = this.choose(definition.provides.id);
      if (!loaded.ok) return { instance: undefined, result: loaded };
      if (next === undefined || next.unit.deferred !== undefined) {
        return { instance: undefined, result: err(NoProviderError({ details: { token: definition.provides.id, injector: this.name } })) };
      }
      return this.resolveBinding(next, stack, parentSpan, consumer);
    }
    if (consumer !== undefined && scopeRank(definition.scope) > scopeRank(consumer.scope)) {
      return {
        instance: undefined,
        result: err(
          ScopeViolationError({
            units: [consumer.id, definition.id],
            message: `"${consumer.id}" (${consumer.scope}) cannot depend on "${definition.id}" (${definition.scope}).`,
          }),
        ),
      };
    }
    if (stack.includes(definition.id)) {
      return {
        instance: undefined,
        result: err(
          CycleError({
            units: [...stack, definition.id],
            message: `Dependency cycle: ${[...stack, definition.id].join(' → ')}`,
          }),
        ),
      };
    }
    const host = this.findHost(definition.scope);
    if (host === undefined) {
      return {
        instance: undefined,
        result: err(
          NoHostScopeError({
            units: [definition.id],
            message: `No "${definition.scope}" injector above "${this.name}" to host "${definition.id}".`,
          }),
        ),
      };
    }
    let instance = host.instances.get(definition);
    if (instance === undefined) {
      instance = new Instance(definition, host, host.scope.child(`unit:${definition.id}`));
      host.instances.set(definition, instance);
      instance.ready = host.build(instance, stack, parentSpan);
    }
    const result = await instance.ready;
    return { instance, result: this.diagnose(result, definition) };
  }

  /** Single-flight load of a placeholder's group into its scope's injector (retried after a failure). */
  loadDeferred(binding: Binding, parentSpan: Span | undefined): Promise<Result<void>> {
    const source = binding.unit.deferred as DeferredSource;
    // The loaded units register at the placeholders' scope level (app, session, …).
    const owner = this.findHost(binding.unit.scope) ?? this;
    let pending = owner.deferredLoads.get(source);
    if (pending === undefined) {
      const span = this.telemetry.span('di.deferred', { subsystem: SUBSYSTEM, parent: parentSpan, attrs: { units: source.id } });
      pending = source
        .load(owner.scope.signal)
        .then(
          (entries) => owner.register(...(entries as readonly Registration[])),
          (error: unknown) => err(InitFailedError({ units: [source.id], cause: error })),
        )
        .then((result) => {
          if (result.ok) span.end();
          else {
            owner.deferredLoads.delete(source);
            span.end('error', result.error);
          }
          return result;
        });
      owner.deferredLoads.set(source, pending);
    }
    return pending;
  }

  /**
   * A longer-lived host cannot see shorter-lived bindings, so a scope violation first
   * surfaces as "no provider". If the requesting chain does provide the token at a
   * shorter-lived scope, report the real cause (I-2).
   */
  diagnose(result: Result<unknown>, definition: AnyUnit): Result<unknown> {
    if (result.ok || result.error.code !== NoProviderError.code) return result;
    const missing = result.error.details['token'];
    if (typeof missing !== 'string') return result;
    const visible = this.choose(missing as TokenId);
    if (visible === undefined || scopeRank(visible.unit.scope) <= scopeRank(definition.scope)) return result;
    return err(
      ScopeViolationError({
        units: [definition.id, visible.unit.id],
        message: `"${definition.id}" (${definition.scope}) cannot depend on "${visible.unit.id}" (${visible.unit.scope}).`,
        cause: result.error,
      }),
    );
  }

  /** Construct and initialize an instance. Runs once per instance. */
  async build(instance: Instance, stack: readonly string[], parentSpan: Span | undefined): Promise<Result<unknown>> {
    const definition = instance.definition;
    const level: LevelName = definition.critical === true ? 'standard' : 'verbose';
    const span = this.telemetry.span('di.resolve', {
      subsystem: SUBSYSTEM,
      level,
      parent: parentSpan,
      attrs: { unit: definition.id, token: definition.provides.id, scope: definition.scope, injector: this.name },
    });
    const fail = (error: SfError): Result<unknown> => {
      instance.error = error;
      instance.setState('failed');
      span.end('error', error);
      return err(error);
    };

    // 1. required dependencies — ready before create (I-3)
    const edges = dependencyEdges(definition);
    const nextStack = [...stack, definition.id];
    const deps: Record<string, unknown> = {};
    const requiredHandles = new Map<string, DepHandle<unknown>>();
    const required = edges.filter((e) => e.kind === 'required');
    const requiredResults = await Promise.all(
      required.map(async (edge) => {
        const binding = edge.token.multi ? undefined : this.choose(edge.token.id);
        if (binding === undefined) {
          // multi tokens, or no provider (resolve() produces the right error)
          return { edge, result: await this.resolve(edge.token, nextStack, span, definition), instance: undefined };
        }
        const resolved = await this.resolveBinding(binding, nextStack, span, definition);
        return { edge, result: resolved.result, instance: resolved.instance };
      }),
    );
    for (const { edge, result, instance: depInstance } of requiredResults) {
      if (!result.ok) {
        const cause = result.error;
        if (cause.code === CycleError.code || cause.code === ScopeViolationError.code || cause.code === NoProviderError.code) {
          return fail(cause);
        }
        return fail(
          DependencyFailedError({
            units: [definition.id, edge.token.id],
            message: `"${definition.id}" cannot become ready: required "${edge.key}" (${edge.token.id}) failed.`,
            cause,
          }),
        );
      }
      deps[edge.key] = result.value;
      requiredHandles.set(edge.key, Handle.forInstance(this, edge.token, depInstance, result.value));
    }

    // 2. lazy + functional handles (cycles through them are allowed)
    for (const edge of edges) {
      if (edge.kind === 'required') continue;
      const handle = new Handle<unknown>(this, edge.token, definition);
      instance.scope.defer(() => handle.dispose());
      deps[edge.key] = edge.kind === 'lazy' ? handle : functionalFrom(handle);
      // Timing is applied after create so hooks registered in create observe the first transition.
      queueMicrotask(() => scheduleTiming(handle, edge.init, this.shared.idle));
    }

    // 3. create — "injected"
    instance.context = makeContext(instance, span, requiredHandles);
    try {
      instance.value = definition.create(deps as never, instance.context);
    } catch (error) {
      return fail(CreateFailedError({ units: [definition.id], cause: error, message: `create() of "${definition.id}" threw: ${toSfError(error).message}` }));
    }
    instance.setState('created');
    span.event('created');

    // 4. init — "ready"
    const initResult = await runInit(instance, definition.init?.bind(definition));
    if (!initResult.ok) return fail(initResult.error);
    const blocking = await Promise.all(instance.blocking);
    const blockingFailure = blocking.find((r) => !r.ok);
    if (blockingFailure !== undefined && !blockingFailure.ok) return fail(blockingFailure.error);

    if (instance.scope.disposed) return fail(InjectorDisposedError({ units: [definition.id] }));
    instance.setState('ready');
    const budget = definition.budget?.initMs;
    if (budget !== undefined && span.recording) span.set('budget.initMs', budget);
    span.end('ok');
    return ok(instance.value);
  }
}

async function runInit(
  instance: Instance,
  init: ((value: unknown, context: UnitContext) => Promise<Result<void>> | Result<void>) | undefined,
): Promise<Result<void>> {
  if (init === undefined) return ok();
  instance.setState('initializing');
  const definition = instance.definition;
  const once = task(async () => {
    const r = await init(instance.value, instance.context);
    if (!r.ok) throw r.error;
  });
  const runner = definition.retry === undefined ? once : retry(once, definition.retry);
  const result = await runner(instance.scope.signal);
  if (result.ok) return ok();
  return err(
    result.error.code === InitFailedError.code
      ? result.error
      : InitFailedError({ units: [definition.id], cause: result.error, message: `init() of "${definition.id}" failed: ${result.error.message}` }),
  );
}

async function refreshInstance(instance: Instance, parentSpan: Span): Promise<Result<void>> {
  if (instance.state !== 'ready') return ok();
  const definition = instance.definition;
  const span = instance.host.telemetry.span('di.refresh-unit', {
    subsystem: SUBSYSTEM,
    level: 'verbose',
    parent: parentSpan,
    attrs: { unit: definition.id },
  });
  instance.setState('refreshing');
  const refresher = definition.refresh?.bind(definition) ?? definition.init?.bind(definition);
  const once = task(async () => {
    if (refresher === undefined) return;
    const r = await refresher(instance.value, instance.context);
    if (!r.ok) throw r.error;
  });
  const result = await once(instance.scope.signal);
  if (!result.ok) {
    instance.error = result.error;
    instance.setState('failed');
    span.end('error', result.error);
    return err(result.error);
  }
  instance.setState('ready');
  span.end('ok');
  return ok();
}

function makeContext(instance: Instance, span: Span, requiredHandles: Map<string, DepHandle<unknown>>): UnitContext {
  const { definition, host, scope } = instance;
  const runHook = <T>(
    handle: DepHandle<T>,
    fn: (value: T, hookScope: Scope) => void | Promise<void>,
  ): ((value: T) => Promise<Result<void>>) => {
    let hookScope: Scope | undefined;
    return async (value: T) => {
      if (hookScope !== undefined) await hookScope.dispose();
      hookScope = scope.child(`hook:${handle.tokenId}`);
      const hookSpan = host.telemetry.span('di.hook', {
        subsystem: SUBSYSTEM,
        level: 'verbose',
        parent: span.context === undefined ? undefined : span,
        attrs: { unit: definition.id, dependency: handle.tokenId },
      });
      try {
        await fn(value, hookScope);
        hookSpan.end('ok');
        return ok();
      } catch (error) {
        const sf = toSfError(error);
        hookSpan.end('error', sf);
        return err(sf);
      }
    };
  };
  const afterRefresh = <T>(handle: DepHandle<T>, run: (value: T) => Promise<Result<void>>): void => {
    let previous: HandleState = handle.state;
    const unsubscribe = handle.subscribe((state) => {
      if (previous === 'refreshing' && state === 'ready' && handle.value !== undefined) void run(handle.value);
      previous = state;
    });
    scope.defer(unsubscribe);
  };
  return {
    unitId: definition.id,
    scope,
    signal: scope.signal,
    telemetry: host.telemetry,
    span,
    get epoch() {
      return host.epoch;
    },
    onReady<T>(handle: DepHandle<T>, fn: (value: T, s: Scope) => void | Promise<void>, options: HookOptions = {}) {
      const run = runHook(handle, fn);
      const first = handle.whenReady(scope.signal).then((r) => (r.ok ? run(r.value) : err(r.error)));
      if (options.blocking === true) instance.blocking.push(first);
      else void first;
      afterRefresh(handle, run);
    },
    onRefresh<T>(handle: DepHandle<T>, fn: (value: T, s: Scope) => void | Promise<void>) {
      afterRefresh(handle, runHook(handle, fn));
    },
    onFailed<T>(handle: DepHandle<T>, fn: (error: SfError) => void) {
      const unsubscribe = handle.subscribe((state) => {
        if (state === 'failed' && handle.error !== undefined) fn(handle.error);
      });
      scope.defer(unsubscribe);
    },
    handleOf(key: string) {
      const handle = requiredHandles.get(key);
      if (handle === undefined) throw new Error(`handleOf("${key}"): "${definition.id}" has no required dependency "${key}".`);
      return handle;
    },
  };
}

// ---------------------------------------------------------------- handles

function mapState(state: UnitState): HandleState {
  switch (state) {
    case 'ready':
      return 'ready';
    case 'refreshing':
      return 'refreshing';
    case 'failed':
      return 'failed';
    case 'disposed':
      return 'disposed';
    default:
      return 'pending';
  }
}

class Handle<T> implements DepHandle<T> {
  private readonly stateBox: Box<HandleState> = box<HandleState>('idle');
  private readonly valueBox: Box<T | undefined> = box<T | undefined>(undefined);
  private errorValue: SfError | undefined;
  private started = false;
  private first: Promise<Result<T>> | undefined;
  private readonly listeners = new Set<(state: HandleState) => void>();
  private detach: (() => void) | undefined;

  constructor(
    private readonly injector: InjectorImpl,
    private readonly token: AnyToken,
    private readonly consumer: AnyUnit | undefined,
  ) {}

  static forInstance<V>(injector: InjectorImpl, token: AnyToken, instance: Instance | undefined, value: V): DepHandle<V> {
    const handle = new Handle<V>(injector, token, undefined);
    handle.started = true;
    handle.first = Promise.resolve(ok(value));
    handle.valueBox.set(value);
    handle.setState('ready');
    if (instance !== undefined) handle.follow(instance);
    return handle;
  }

  get tokenId(): TokenId {
    return this.token.id;
  }

  get state(): HandleState {
    return this.stateBox.get();
  }

  get value(): T | undefined {
    return this.valueBox.get();
  }

  get error(): SfError | undefined {
    // Read state so callers re-evaluate when it changes.
    this.stateBox.get();
    return this.errorValue;
  }

  trigger(): void {
    void this.whenReady();
  }

  whenReady(signal?: AbortSignal): Promise<Result<T>> {
    if (!this.started) {
      this.started = true;
      this.setState('pending');
      this.first = this.start();
    }
    const first = this.first as Promise<Result<T>>;
    if (this.state === 'ready') return Promise.resolve(ok(this.value as T));
    if (signal === undefined) return first;
    return new Promise((resolve) => {
      const onAbort = (): void => resolve(err(InjectorDisposedError({ cause: signal.reason })));
      if (signal.aborted) {
        onAbort();
        return;
      }
      const detach = new AbortController();
      signal.addEventListener('abort', onAbort, { once: true, signal: detach.signal });
      void first.then((r) => {
        detach.abort();
        resolve(r);
      });
    });
  }

  subscribe(listener: (state: HandleState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.detach?.();
    this.setState('disposed');
    this.listeners.clear();
  }

  private async start(): Promise<Result<T>> {
    let result: Result<unknown>;
    if (this.token.multi) {
      result = await this.injector.resolve(this.token, [], undefined, this.consumer);
    } else {
      const binding = this.injector.choose(this.token.id);
      if (binding === undefined) {
        result = await this.injector.resolve(this.token, [], undefined, this.consumer);
      } else {
        const resolved = await this.injector.resolveBinding(binding, [], undefined, this.consumer);
        result = resolved.result;
        if (resolved.instance !== undefined) this.follow(resolved.instance);
      }
    }
    if (result.ok) {
      this.valueBox.set(result.value as T);
      this.setState('ready');
      return ok(result.value as T);
    }
    this.errorValue = result.error;
    this.setState('failed');
    return err(result.error);
  }

  private follow(instance: Instance): void {
    const listener = (state: UnitState): void => {
      if (state === 'ready') this.valueBox.set(instance.value as T);
      if (state === 'failed') this.errorValue = instance.error;
      const mapped = mapState(state);
      if (mapped !== 'pending') this.setState(mapped);
    };
    instance.listeners.add(listener);
    this.detach = () => instance.listeners.delete(listener);
  }

  private setState(state: HandleState): void {
    if (this.stateBox.get() === state) return;
    this.stateBox.set(state);
    for (const listener of [...this.listeners]) listener(state);
  }
}

function scheduleTiming(handle: DepHandle<unknown>, timing: InitTiming, idle: (cb: () => void) => void): void {
  switch (timing) {
    case 'eager':
    case 'on-arrival':
      handle.trigger();
      return;
    case 'idle':
      idle(() => handle.trigger());
      return;
    case 'on-visible':
    case 'on-intent':
    case 'on-demand':
      return; // triggered explicitly by the UI layer or by use
  }
}

function functionalFrom<T>(handle: DepHandle<T>): FunctionalDep<T> {
  return {
    get tokenId() {
      return handle.tokenId;
    },
    get state() {
      return handle.state;
    },
    get: (signal?: AbortSignal) => handle.whenReady(signal),
    prewarm: () => handle.trigger(),
  };
}
