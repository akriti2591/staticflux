/**
 * Typed route definitions (R7.5, R7.9, R18.5).
 *
 * - `defineRoute({ id, path, parent, search, feature, requires, guards, loaders, redirect, transient })`.
 *   The full path is `parent.path + path` at the type level, so params are typed through nesting.
 * - Routes bind to a **capability selector**, never a hardcoded feature: `bindCapability()` lists
 *   candidate features (per-mode variants); the availability stage picks the one matching the
 *   injected profile predicate (R18.5).
 * - `requires` is open metadata (declaration merging on `RouteRequirements`) that stage plugins
 *   read — e.g. auth merges `{ auth?: 'required' | 'optional' }`. The router does not interpret it.
 * - Guards attach per segment to named stages; `loaders` run in parallel in the `load` stage.
 */
import { err, ok, type Result } from '@staticflux/core';
import type { FeatureModeId, FeatureRef } from '@staticflux/runtime';
import type { NavigationContext } from './context.js';
import { type AnyDialog, DIALOG_SEGMENT, dialogPath } from './dialogs.js';
import { DialogRouteError, RouteDefinitionError } from './errors.js';
import {
  buildPath,
  type CompiledPattern,
  compilePattern,
  joinPaths,
  type JoinPaths,
  matchPattern,
  type ParamNames,
  type PathParams,
  splitPath,
} from './path.js';
import { parseSearch, type SearchInput, type SearchSchema, type SearchValues, serializeSearch } from './search.js';
import type { BuiltinStageId, StageReturn } from './stages.js';

export type RouteId = `${string}/${string}`;
export type CapabilityId = `${string}/${string}`;

/**
 * Route metadata read by stage plugins. Open set, extended via declaration merging:
 * `declare module '@staticflux/router' { interface RouteRequirements { auth?: 'required' | 'optional' } }`
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface RouteRequirements {}

// ---------------------------------------------------------------- capability binding

export interface FeatureCandidate {
  readonly feature: FeatureRef;
  /** Modes this candidate serves; default: the feature manifest's `modes` (via the feature driver). */
  readonly modes?: readonly FeatureModeId[];
}

export interface FeatureSelector {
  readonly kind: 'feature-selector';
  readonly capability: CapabilityId;
  /** In preference order: the first candidate available for the profile wins. */
  readonly candidates: readonly FeatureCandidate[];
  /** What happens to the feature when the route is left: unmount (default; logic stays warm) or hide. */
  readonly leave: 'unmount' | 'hide';
}

/** Bind a route to a capability served by one of several (per-mode) features. */
export function bindCapability<const C extends CapabilityId>(
  capability: C,
  candidates: readonly FeatureCandidate[],
  options: { readonly leave?: 'unmount' | 'hide' } = {},
): FeatureSelector {
  return Object.freeze({ kind: 'feature-selector', capability, candidates, leave: options.leave ?? 'unmount' });
}

// ---------------------------------------------------------------- guards

export type GuardFn = (context: NavigationContext, signal: AbortSignal) => StageReturn;

export interface RouteGuard {
  readonly kind: 'guard';
  readonly run: GuardFn;
  /** Defer cancellation by a newer navigation until this guard settles (e.g. "save before leaving", R7.2). */
  readonly uninterruptible?: boolean;
  readonly concurrency?: 'serial' | 'parallel';
  /** Shown in spans / errors. */
  readonly name?: string;
}

export function guard(run: GuardFn, options: Omit<RouteGuard, 'kind' | 'run'> = {}): RouteGuard {
  return Object.freeze({ ...options, kind: 'guard' as const, run });
}

export type GuardSpec = GuardFn | RouteGuard;
export type RouteGuards = { readonly [S in BuiltinStageId]?: readonly GuardSpec[] };

export function toGuard(spec: GuardSpec): RouteGuard {
  return typeof spec === 'function' ? guard(spec) : spec;
}

// ---------------------------------------------------------------- routes

export interface RouteDef<Id extends RouteId = RouteId, Path extends string = string, S extends SearchSchema = SearchSchema> {
  readonly kind: 'route';
  readonly id: Id;
  /** Full normalized path pattern (`/studio/doc/:id`). */
  readonly path: Path;
  /** Own segment pattern relative to the parent. */
  readonly segment: string;
  readonly parent: AnyRoute | undefined;
  /** Merged search schema (parent's + own). */
  readonly search: S;
  readonly ownSearch: SearchSchema;
  readonly feature: FeatureSelector | undefined;
  readonly requires: RouteRequirements;
  readonly guards: RouteGuards;
  readonly loaders: readonly GuardFn[];
  /** Redirect-only route: the transient stage redirects to this target (with the navigation's mode). */
  readonly redirect: ((context: NavigationContext) => NavigationTarget) | undefined;
  /** Never committed: a transient-stage plugin (or `redirect`) must redirect. */
  readonly transient: boolean;
  /** Layout-only parent: never matched by itself. */
  readonly abstract: boolean;
  /**
   * View sub-route (tabs, wizard steps) of its parent's feature: entering/leaving it runs the light
   * view pipeline (exit → enter → commit, R7.7). May only have `exit`/`enter` guards — no feature, no loaders.
   */
  readonly view: boolean;
  readonly description: string | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRoute = RouteDef<RouteId, string, any>;

type ParentPath<P> = P extends RouteDef<RouteId, infer PP, SearchSchema> ? PP : '';
type ParentSearch<P> = P extends RouteDef<RouteId, string, infer PS> ? PS : Record<never, never>;

export interface RouteConfig<Id extends RouteId, Seg extends string, S extends SearchSchema, P extends AnyRoute | undefined> {
  readonly id: Id;
  /** Segment pattern relative to the parent (`doc/:id`); `''` or `'/'` for an index/root route. */
  readonly path: Seg;
  readonly parent?: P;
  readonly search?: S;
  readonly feature?: FeatureSelector;
  readonly requires?: RouteRequirements;
  readonly guards?: RouteGuards;
  readonly loaders?: readonly GuardFn[];
  readonly redirect?: (context: NavigationContext) => NavigationTarget;
  readonly transient?: boolean;
  readonly abstract?: boolean;
  readonly view?: boolean;
  readonly description?: string;
}

/** Declare a route. Params and search are typed from the (joined) path and the merged schema. */
/* @__NO_SIDE_EFFECTS__ */
export function defineRoute<
  const Id extends RouteId,
  const Seg extends string,
  const S extends SearchSchema = Record<never, never>,
  P extends AnyRoute | undefined = undefined,
>(config: RouteConfig<Id, Seg, S, P>): RouteDef<Id, JoinPaths<ParentPath<P>, Seg>, S & ParentSearch<P>> {
  const parent = config.parent;
  const ownSearch: SearchSchema = config.search ?? {};
  return Object.freeze({
    kind: 'route' as const,
    id: config.id,
    path: joinPaths(parent?.path ?? '', config.path) as JoinPaths<ParentPath<P>, Seg>,
    segment: config.path,
    parent,
    search: { ...(parent?.search ?? {}), ...ownSearch } as S & ParentSearch<P>,
    ownSearch,
    feature: config.feature,
    requires: config.requires ?? {},
    guards: config.guards ?? {},
    loaders: config.loaders ?? [],
    redirect: config.redirect,
    transient: config.transient ?? false,
    abstract: config.abstract ?? false,
    view: config.view ?? false,
    description: config.description,
  });
}

// ---------------------------------------------------------------- targets & matches

export type SearchOf<R extends AnyRoute> = R['search'];

/** Typed params of a route (any string-keyed record for untyped routes). */
export type RouteParams<R extends AnyRoute> = string extends R['path'] ? Readonly<Record<string, string>> : PathParams<R['path']>;

type ParamsArg<P extends string> = string extends P
  ? { readonly params?: Readonly<Record<string, string>> }
  : [ParamNames<P>] extends [never]
    ? { readonly params?: Readonly<Record<string, never>> }
    : { readonly params: PathParams<P> };

/** Typed navigation target: route + typed params + typed search (+ optional routable dialog). */
export type RouteTarget<R extends AnyRoute = AnyRoute> = {
  readonly to: R;
  readonly search?: SearchInput<SearchOf<R>>;
  readonly hash?: string;
  readonly dialog?: AnyDialog;
} & ParamsArg<R['path']>;

/** Untyped target (history replays, external links, serialized intents). */
export interface HrefTarget {
  readonly href: string;
}

export type NavigationTarget = RouteTarget | HrefTarget;

export interface RouterLocation {
  readonly pathname: string;
  /** `''` or `?a=b`. */
  readonly search: string;
  /** `''` or `#x`. */
  readonly hash: string;
  /** pathname + search + hash. */
  readonly href: string;
}

const BASE = 'http://sf.invalid';

export function parseLocation(href: string): RouterLocation {
  const url = new URL(href, BASE);
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  return { pathname, search: url.search, hash: url.hash, href: `${pathname}${url.search}${url.hash}` };
}

export interface RouteMatch<R extends AnyRoute = AnyRoute> {
  readonly route: R;
  /** Root → leaf. */
  readonly chain: readonly AnyRoute[];
  readonly params: RouteParams<R>;
  readonly search: SearchValues<SearchOf<R>>;
  readonly location: RouterLocation;
  /** The routable dialog in the URL (at most one, R7.20). */
  readonly dialog: AnyDialog | undefined;
  /** Location without the dialog segment (the dialog's parent location). */
  readonly baseHref: string;
  /** Search keys whose values failed to parse (fallbacks were used). */
  readonly invalidSearch: readonly string[];
  /** Matched through the router's `notFound` fallback. */
  readonly notFound: boolean;
}

/** Narrow a match to a route for typed `params` / `search`. */
export function isMatchOf<R extends AnyRoute>(match: RouteMatch | undefined, route: R): match is RouteMatch<R> {
  return match?.route === route;
}

/** Merged requirements: outer → inner (inner wins per key), then the dialog's. */
export function requirementsOf(chain: readonly AnyRoute[], dialog: AnyDialog | undefined): RouteRequirements {
  const merged: Record<string, unknown> = {};
  for (const route of chain) Object.assign(merged, route.requires);
  if (dialog !== undefined) Object.assign(merged, dialog.requires);
  return merged as RouteRequirements;
}

// ---------------------------------------------------------------- table

export interface RouteTable {
  readonly routes: readonly AnyRoute[];
  readonly dialogs: readonly AnyDialog[];
  match(href: string): RouteMatch | undefined;
  /** Match `href` as `route` (not-found fallback keeps the URL). */
  matchAs(href: string, route: AnyRoute): RouteMatch;
  build(target: RouteTarget): Result<string>;
  chainOf(route: AnyRoute): readonly AnyRoute[];
}

function chainFor(route: AnyRoute): AnyRoute[] {
  const chain: AnyRoute[] = [];
  for (let r: AnyRoute | undefined = route; r !== undefined; r = r.parent) chain.unshift(r);
  return chain;
}

const DIALOG_KEY = /^[a-z0-9][a-z0-9-]*$/;

export function createRouteTable(routes: readonly AnyRoute[], dialogs: readonly AnyDialog[] = []): Result<RouteTable> {
  const byId = new Map<string, AnyRoute>();
  const compiled = new Map<AnyRoute, CompiledPattern>();
  const paths = new Map<string, string>();
  for (const route of routes) {
    if (byId.has(route.id)) {
      return err(RouteDefinitionError({ message: `Route id "${route.id}" is registered twice.`, details: { route: route.id } }));
    }
    byId.set(route.id, route);
  }
  for (const route of routes) {
    if (route.parent !== undefined && byId.get(route.parent.id) !== route.parent) {
      return err(
        RouteDefinitionError({
          message: `Route "${route.id}" has parent "${route.parent.id}", which is not registered.`,
          details: { route: route.id, parent: route.parent.id },
        }),
      );
    }
    if (route.view) {
      const extraGuards = Object.keys(route.guards).filter((stage) => stage !== 'exit' && stage !== 'enter');
      if (route.feature !== undefined || route.loaders.length > 0 || extraGuards.length > 0 || route.redirect !== undefined || route.transient) {
        return err(
          RouteDefinitionError({
            message: `View route "${route.id}" may only have exit/enter guards (no feature, loaders, redirect or other stage guards).`,
            details: { route: route.id },
          }),
        );
      }
    }
    const pattern = compilePattern(route.path);
    compiled.set(route, pattern);
    if (route.abstract) continue;
    const shape = pattern.segments.map((s) => (s.type === 'static' ? s.value : ':')).join('/');
    const clash = paths.get(shape);
    if (clash !== undefined) {
      return err(
        RouteDefinitionError({
          message: `Routes "${clash}" and "${route.id}" have the same path shape "${route.path}".`,
          details: { route: route.id, other: clash },
        }),
      );
    }
    paths.set(shape, route.id);
  }
  const dialogKeys = new Set<string>();
  for (const dialog of dialogs) {
    if (!DIALOG_KEY.test(dialog.key)) {
      return err(RouteDefinitionError({ message: `Dialog key "${dialog.key}" is not a valid URL segment.`, details: { dialog: dialog.id } }));
    }
    if (dialog.owner !== undefined && byId.get(dialog.owner.id) !== dialog.owner) {
      return err(RouteDefinitionError({ message: `Dialog "${dialog.id}" owner "${dialog.owner.id}" is not registered.`, details: { dialog: dialog.id } }));
    }
    const scoped = `${dialog.owner?.id ?? '<app>'}:${dialog.key}`;
    if (dialogKeys.has(scoped)) {
      return err(RouteDefinitionError({ message: `Dialog key "${dialog.key}" is registered twice for one owner.`, details: { dialog: dialog.id } }));
    }
    dialogKeys.add(scoped);
  }
  const matchable = routes
    .filter((r) => !r.abstract)
    .sort((a, b) => (compiled.get(b)?.score ?? 0) - (compiled.get(a)?.score ?? 0));

  const matchSegments = (segments: readonly string[]): { route: AnyRoute; params: Record<string, string> } | undefined => {
    for (const route of matchable) {
      const params = matchPattern(compiled.get(route) as CompiledPattern, segments);
      if (params !== undefined) return { route, params };
    }
    return undefined;
  };

  const finish = (
    route: AnyRoute,
    params: Record<string, string>,
    location: RouterLocation,
    dialog: AnyDialog | undefined,
    baseHref: string,
    notFound: boolean,
  ): RouteMatch => {
    const parsed = parseSearch(route.search as SearchSchema, new URLSearchParams(location.search));
    return {
      route,
      chain: chainFor(route),
      params,
      search: parsed.values,
      location,
      dialog,
      baseHref,
      invalidSearch: parsed.invalid,
      notFound,
    };
  };

  return ok({
    routes,
    dialogs,
    chainOf: chainFor,
    match(href) {
      const location = parseLocation(href);
      const segments = splitPath(location.pathname);
      const direct = matchSegments(segments);
      if (direct !== undefined) return finish(direct.route, direct.params, location, undefined, location.href, false);
      // Routable dialog: `<base>/d/<key>` (R7.16).
      if (segments.length < 2 || segments[segments.length - 2] !== DIALOG_SEGMENT) return undefined;
      const key = segments[segments.length - 1] as string;
      const baseSegments = segments.slice(0, -2);
      const base = matchSegments(baseSegments);
      if (base === undefined) return undefined;
      const chain = chainFor(base.route);
      const owned = dialogs
        .filter((d) => d.key === key && d.owner !== undefined && chain.includes(d.owner))
        .sort((a, b) => chain.indexOf(b.owner as AnyRoute) - chain.indexOf(a.owner as AnyRoute));
      const dialog = owned[0] ?? dialogs.find((d) => d.key === key && d.owner === undefined);
      if (dialog === undefined) return undefined;
      const basePath = baseSegments.length === 0 ? '/' : `/${baseSegments.join('/')}`;
      return finish(base.route, base.params, location, dialog, `${basePath}${location.search}${location.hash}`, false);
    },
    matchAs(href, route) {
      const location = parseLocation(href);
      return finish(route, {}, location, undefined, location.href, true);
    },
    build(target) {
      const route = target.to;
      const pattern = compiled.get(route) ?? compilePattern(route.path);
      const path = buildPath(pattern, (target.params ?? {}) as Readonly<Record<string, string>>);
      if (!path.ok) return path;
      let pathname = path.value;
      if (target.dialog !== undefined) {
        const owner = target.dialog.owner;
        if (owner !== undefined && !chainFor(route).includes(owner)) {
          return err(DialogRouteError({ details: { dialog: target.dialog.id, route: route.id } }));
        }
        pathname = dialogPath(pathname, target.dialog.key);
      }
      const search = serializeSearch(route.search as SearchSchema, target.search as Readonly<Record<string, unknown>> | undefined);
      const hash = target.hash === undefined || target.hash.length === 0 ? '' : target.hash.startsWith('#') ? target.hash : `#${target.hash}`;
      return ok(`${pathname}${search}${hash}`);
    },
  });
}
