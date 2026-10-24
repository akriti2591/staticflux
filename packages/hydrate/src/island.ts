/**
 * The island module contract. An island chunk's entry exports:
 *
 *   export const hydrate = (element, { props, signal, scope }) => { … attach behaviour to the EXISTING DOM … };
 *   // or, with typed + validated props:
 *   export default defineIsland({ props: s.object({ sku: s.string() }), hydrate(element, { props, scope }) { … } });
 *
 * Rules: keep the prerendered DOM (no re-render from scratch → no flash, no layout shift);
 * register every listener/timer in `scope` (disposed when the island is disposed); stop async
 * work on `signal`. Events the user fired before hydration are replayed AFTER `hydrate` resolves
 * (`isReplayedEvent(event)` tells them apart). Return/resolve `err(...)` or throw to fail.
 * To host Lit components with self-injected deps, call ui's `provideScope(element, { injector })`
 * with `context.injector` (a per-island `feature`-level child injector, when the app passed one).
 */
import type { Injector, Result, Scope, SfError } from '@staticflux/core';
import type { HydrateStrategy, IslandChunkId } from './marker.js';

export interface IslandContext<P> {
  readonly props: P;
  /** Aborted when the island is disposed. */
  readonly signal: AbortSignal;
  /** The island's lifetime scope. */
  readonly scope: Scope;
  readonly island: { readonly id: string; readonly chunk: IslandChunkId; readonly strategy: HydrateStrategy };
  /** Per-island child injector (`feature` level), when the hydrator was started with one. */
  readonly injector: Injector | undefined;
}

export type HydrateOutcome = void | Result<void, SfError> | Promise<void | Result<void, SfError>>;

export type IslandHydrateFn<P> = (element: Element, context: IslandContext<P>) => HydrateOutcome;

/** Anything with a `validate(value) → Result<P>` (e.g. a `@staticflux/data` `s.*` schema). */
export interface PropsValidator<P> {
  validate(value: unknown): Result<P, SfError>;
}

export interface IslandModule<P = unknown> {
  readonly kind?: 'island';
  readonly props?: PropsValidator<P>;
  readonly hydrate: IslandHydrateFn<P>;
}

/** Typed identity: declares an island module (props inferred from the validator). */
export function defineIsland<P = unknown>(module: { readonly props?: PropsValidator<P>; readonly hydrate: IslandHydrateFn<P> }): IslandModule<P> {
  return { kind: 'island', ...module };
}

function asIslandModule(value: unknown): IslandModule | undefined {
  if (typeof value === 'function') return { hydrate: value as IslandHydrateFn<unknown> };
  if (typeof value === 'object' && value !== null && typeof (value as { hydrate?: unknown }).hydrate === 'function') {
    return value as IslandModule;
  }
  return undefined;
}

/**
 * Find the island module in a loaded chunk module. With `exportName`, `module[exportName]`
 * (an island module or a hydrate function). Otherwise: the module itself when it exports
 * `hydrate` (named export), else `module.default`.
 */
export function resolveIslandModule(module: unknown, exportName?: string): IslandModule | undefined {
  if (typeof module !== 'object' && typeof module !== 'function') return undefined;
  if (module === null) return undefined;
  const record = module as Record<string, unknown>;
  if (exportName !== undefined) return asIslandModule(record[exportName]);
  if (typeof record['hydrate'] === 'function') {
    const props = record['props'] as PropsValidator<unknown> | undefined;
    const hydrate = record['hydrate'] as IslandHydrateFn<unknown>;
    return props !== undefined && typeof props.validate === 'function' ? { props, hydrate } : { hydrate };
  }
  return asIslandModule(record['default']);
}

const replayed = new WeakSet<Event>();

/** True for events re-dispatched by the hydrator after hydration (event replay). */
export function isReplayedEvent(event: Event): boolean {
  return replayed.has(event);
}

/** @internal Mark a re-dispatched event. */
export function markReplayed(event: Event): void {
  replayed.add(event);
}
