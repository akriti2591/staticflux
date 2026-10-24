/**
 * Units are the granular building blocks of a StaticFlux app: services, stores,
 * clients, utilities and components all are units. A unit declares exactly
 * what it requires and what it provides; the injector does the rest.
 *
 * Dependency kinds (docs/LIFECYCLES.md §5):
 * - `required`   — must be ready before this unit is created. Receives `T`.
 * - `lazy`       — arrives any time; receives a reactive `DepHandle<T>`.
 * - `functional` — resolved and initialized on first use; receives `FunctionalDep<T>`.
 */
import type { RetryPolicy } from './async.js';
import type { Scope } from './disposal.js';
import type { SfError } from './errors.js';
import type { Result } from './result.js';
import type { MetricDefinition, Span, Telemetry } from './telemetry.js';
import type { AnyToken, MultiToken, Token, TokenId, TokenValue } from './token.js';

/** Scope levels from longest- to shortest-lived. */
export const SCOPE_LEVELS = ['app', 'session', 'workspace', 'route', 'feature', 'view', 'component'] as const;
export type ScopeLevel = (typeof SCOPE_LEVELS)[number];

export function scopeRank(level: ScopeLevel): number {
  return SCOPE_LEVELS.indexOf(level);
}

/** When a dependency initializes (docs/LIFECYCLES.md §5.1). */
export type InitTiming = 'eager' | 'on-arrival' | 'idle' | 'on-visible' | 'on-intent' | 'on-demand';

export interface DepOptions<K extends AnyToken = AnyToken> {
  readonly token: K;
  readonly init?: InitTiming;
}

export type DepSpec = AnyToken | DepOptions;

export interface DepsDeclaration {
  readonly required?: Readonly<Record<string, DepSpec>>;
  readonly lazy?: Readonly<Record<string, DepSpec>>;
  readonly functional?: Readonly<Record<string, DepSpec>>;
}

export type SpecToken<S> = S extends DepOptions<infer K> ? K : S extends AnyToken ? S : never;
export type SpecValue<S> = TokenValue<SpecToken<S>>;

/** Readiness states of a unit instance (docs/LIFECYCLES.md §4). */
export type UnitState =
  | 'unresolved'
  | 'resolving'
  | 'created'
  | 'initializing'
  | 'ready'
  | 'refreshing'
  | 'failed'
  | 'disposed';

export type HandleState = 'idle' | 'pending' | 'ready' | 'refreshing' | 'failed' | 'disposed';

/** Reactive handle for a lazy dependency. Reading `state`/`value` is tracked. */
export interface DepHandle<T> {
  readonly tokenId: TokenId;
  readonly state: HandleState;
  readonly value: T | undefined;
  readonly error: SfError | undefined;
  /** Start resolution now (used by `on-visible` / `on-intent` timing). Idempotent. */
  trigger(): void;
  /** Resolve (if needed) and wait for readiness. */
  whenReady(signal?: AbortSignal): Promise<Result<T>>;
  /** Listen to state changes; returns unsubscribe. */
  subscribe(listener: (state: HandleState) => void): () => void;
  /** Detach from the instance and drop listeners (the instance itself is owned by its scope). */
  dispose(): void;
}

/** Handle for a functional dependency: nothing happens until it is used (or pre-warmed). */
export interface FunctionalDep<T> {
  readonly tokenId: TokenId;
  readonly state: HandleState;
  /** Resolve + initialize (single-flight) and return the instance. */
  get(signal?: AbortSignal): Promise<Result<T>>;
  /** Start resolving in the background (e.g. on hover/focus of the trigger). */
  prewarm(): void;
}

type KeysOf<T> = T extends Readonly<Record<string, unknown>> ? keyof T : never;

type RequiredValues<D extends DepsDeclaration> = D['required'] extends Readonly<Record<string, DepSpec>>
  ? { readonly [K in keyof D['required']]: SpecValue<D['required'][K]> }
  : unknown;
type LazyValues<D extends DepsDeclaration> = D['lazy'] extends Readonly<Record<string, DepSpec>>
  ? { readonly [K in keyof D['lazy']]: DepHandle<SpecValue<D['lazy'][K]>> }
  : unknown;
type FunctionalValues<D extends DepsDeclaration> = D['functional'] extends Readonly<Record<string, DepSpec>>
  ? { readonly [K in keyof D['functional']]: FunctionalDep<SpecValue<D['functional'][K]>> }
  : unknown;

/** Keys must be unique across the three dependency kinds. */
export type DuplicateDepKeys<D extends DepsDeclaration> =
  | (KeysOf<D['required']> & KeysOf<D['lazy']>)
  | (KeysOf<D['required']> & KeysOf<D['functional']>)
  | (KeysOf<D['lazy']> & KeysOf<D['functional']>);

/** The flat, typed deps object a unit (or component) receives. */
export type ResolvedDeps<D extends DepsDeclaration> = RequiredValues<D> & LazyValues<D> & FunctionalValues<D>;

export interface HookOptions {
  /** Count the hook's async work toward the consumer's readiness. */
  readonly blocking?: boolean;
}

/** Context passed to `create`, `init` and `refresh`. */
export interface UnitContext {
  readonly unitId: string;
  /** Scope of this unit instance; disposed when the instance is disposed. */
  readonly scope: Scope;
  readonly signal: AbortSignal;
  readonly telemetry: Telemetry;
  /** Span of this unit's resolution; parent for child spans. */
  readonly span: Span;
  /** App epoch at creation; bumped by app-wide refresh. */
  readonly epoch: number;
  /** Run `fn` with the dependency when it becomes ready (re-runs after its refresh, in a fresh child scope). */
  onReady<T>(handle: DepHandle<T>, fn: (value: T, scope: Scope) => void | Promise<void>, options?: HookOptions): void;
  /** Run `fn` after each refresh of the dependency. */
  onRefresh<T>(handle: DepHandle<T>, fn: (value: T, scope: Scope) => void | Promise<void>): void;
  onFailed<T>(handle: DepHandle<T>, fn: (error: SfError) => void): void;
  /** Handle view of a required dependency (for onRefresh hooks on required deps). */
  handleOf(key: string): DepHandle<unknown>;
}

export interface UnitDefinition<T, D extends DepsDeclaration = DepsDeclaration, P extends TokenId = TokenId> {
  /** Namespaced unit id, e.g. `auth/session-unit`. */
  readonly id: TokenId;
  readonly provides: Token<T, P>;
  /** Lifetime. A unit may only require units with an equal or longer lifetime (I-2). */
  readonly scope: ScopeLevel;
  readonly deps?: D;
  /** Critical units are resolved during boot; the app is `core-ready` only when they are ready. */
  readonly critical?: boolean;
  /** For multi tokens: position in the contributed list (ascending). */
  readonly order?: number;
  /** Synchronous construction — the instance exists ("injected") afterwards. */
  create(deps: ResolvedDeps<D>, context: UnitContext): T;
  /** Asynchronous initialization — the instance is "ready" afterwards. Runs once per instance (single-flight). */
  init?(instance: T, context: UnitContext): Promise<Result<void>> | Result<void>;
  /** Tokens whose refresh refreshes this unit; `'epoch'` = app-wide refresh. */
  readonly refreshOn?: readonly (AnyToken | 'epoch')[];
  /** Custom refresh; defaults to re-running `init`. */
  refresh?(instance: T, context: UnitContext): Promise<Result<void>> | Result<void>;
  readonly retry?: RetryPolicy;
  /** Metrics this unit produces / consumes (checked by the graph tool). */
  readonly informs?: readonly MetricDefinition[];
  readonly reads?: readonly MetricDefinition[];
  /** Budgets checked in dev/CI. */
  readonly budget?: { readonly initMs?: number };
  /** Free-form documentation for agents and devtools. */
  readonly description?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyUnit = UnitDefinition<any, any, TokenId>;

/**
 * Declare a unit. Purely a typed identity function: the declaration is data.
 * Compile error if a dependency key appears in more than one kind.
 */
export function unit<T, const D extends DepsDeclaration = Record<never, never>, const P extends TokenId = TokenId>(
  definition: UnitDefinition<T, D, P> &
    ([DuplicateDepKeys<D>] extends [never] ? unknown : { __duplicateDepKeys: DuplicateDepKeys<D> }),
): UnitDefinition<T, D, P> {
  return definition;
}

/** Normalize a dependency spec. */
export function specToken(spec: DepSpec): AnyToken {
  return 'kind' in spec && spec.kind === 'token' ? spec : (spec as DepOptions).token;
}

export function specTiming(spec: DepSpec, fallback: InitTiming): InitTiming {
  return 'kind' in spec && spec.kind === 'token' ? fallback : ((spec as DepOptions).init ?? fallback);
}

export interface DependencyEdge {
  readonly key: string;
  readonly kind: 'required' | 'lazy' | 'functional';
  readonly token: AnyToken;
  readonly init: InitTiming;
}

/** All declared dependency edges of a unit. */
export function dependencyEdges(definition: AnyUnit): readonly DependencyEdge[] {
  const deps = (definition.deps ?? {}) as DepsDeclaration;
  const edges: DependencyEdge[] = [];
  const add = (kind: DependencyEdge['kind'], group: DepsDeclaration[keyof DepsDeclaration], fallback: InitTiming): void => {
    for (const [key, spec] of Object.entries(group ?? {})) {
      edges.push({ key, kind, token: specToken(spec), init: specTiming(spec, fallback) });
    }
  };
  add('required', deps.required, 'eager');
  add('lazy', deps.lazy, 'on-arrival');
  add('functional', deps.functional, 'on-demand');
  return edges;
}

/**
 * Declare a unit that contributes ONE item to a multi token (menu items, routes,
 * telemetry sinks, …). `create` returns the item; the token's value is the ordered list.
 *
 * @example
 * export const helpItem = contribution({ id: 'help/menu-item', provides: MenuItems, scope: 'app', order: 90,
 *   create: () => ({ label: 'Help' }) });
 */
export function contribution<E, const D extends DepsDeclaration = Record<never, never>, const P extends TokenId = TokenId>(
  definition: Omit<UnitDefinition<E, D, P>, 'provides'> & { readonly provides: MultiToken<E, P> } &
    ([DuplicateDepKeys<D>] extends [never] ? unknown : { __duplicateDepKeys: DuplicateDepKeys<D> }),
): UnitDefinition<readonly E[], D, P> {
  return definition as unknown as UnitDefinition<readonly E[], D, P>;
}
