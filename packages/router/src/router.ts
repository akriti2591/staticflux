/**
 * The router: typed route table + navigation pipeline + history integration (R7.1–R7.9,
 * R7.16–R7.21 router side, R17.5–R17.9, R18.5, R18.9; docs/LIFECYCLES.md §7).
 *
 * Flow of one navigation:
 *   request → (wait for the superseded run to settle) → beforeNavigate hooks → run gate (I-1)
 *   → match → classify (full | view | dialog) → stages (spans) → commit (history + state) → hooks
 *
 * Concurrency (R7.3): the newest navigation cancels older ones through their AbortSignal; an
 * uninterruptible step (e.g. "save before leaving", R7.2) defers that cancellation until it
 * settles, and the newer navigation starts only after the older one settled. `render` and
 * `commit` are the commit point: once reached, the navigation completes.
 *
 * History (R7.4): back/forward and intercepted links arrive through `HistoryAdapter.listen` and run
 * the same pipeline. Already-committed traversals (popstate) that do not commit are reverted with a
 * silent traversal (revert-and-replay). Non-router writes (urlstate view/sticky sync) are adopted
 * without a pipeline when they only change view state.
 */
import {
  batch,
  box,
  createDeferred,
  createMachine,
  createNoopTelemetry,
  createScope,
  type Deferred,
  err,
  ok,
  type Result,
  type Scope,
  type SfError,
  type Span,
  type Telemetry,
  toSfError,
} from '@staticflux/core';
import { type FeatureId, traceMachine } from '@staticflux/runtime';
import type { NavigationContext, NavigationIntent, NavigationTrigger, SelectedFeature } from './context.js';
import { type AnyDialog, type DialogSurfaceHandle, type DialogSurfacePort, dialogPath } from './dialogs.js';
import {
  DialogRouteError,
  FeatureDriveError,
  FeatureUnavailableError,
  NoDialogSurfaceError,
  RedirectLoopError,
  RouteNotFoundError,
  RouterDisposedError,
  TransientRouteError,
  UnknownStageError,
} from './errors.js';
import { allModesAvailable, type ProfilePredicate, type RouteFeatureDriver } from './feature-driver.js';
import { type ExternalNavigation, type HistoryAdapter, type HistoryChange, type HistoryEntry, ROUTER_SOURCE } from './history.js';
import { compilePattern } from './path.js';
import { cancelReason, createRunControl, type PipelineOutcome, type PipelineStep, type RunControl, runStage } from './pipeline.js';
import {
  type AnyRoute,
  createRouteTable,
  type GuardSpec,
  type HrefTarget,
  type NavigationTarget,
  parseLocation,
  requirementsOf,
  type RouteMatch,
  type RouteTable,
  type RouteTarget,
  toGuard,
} from './routes.js';
import {
  block,
  type BuiltinStageId,
  type CustomStage,
  type PipelineKind,
  type PlannedStage,
  planStages,
  proceed,
  redirect,
  type StageName,
  stageName,
  type StagePlugin,
  validateStages,
} from './stages.js';
import { navigationMachine, type NavigationStatus, ROUTER_SUBSYSTEMS, routerMetrics } from './telemetry.js';

const SUB = ROUTER_SUBSYSTEMS.navigation;
const PIPELINE = ROUTER_SUBSYSTEMS.pipeline;

// ---------------------------------------------------------------- options & results

/** A port resolved on first use (e.g. a DI functional dependency). `undefined` = not bound. */
export interface LazyPort<T> {
  readonly kind: 'lazy-port';
  get(): Promise<T | undefined>;
}

export function lazyPort<T>(get: () => Promise<T | undefined>): LazyPort<T> {
  return { kind: 'lazy-port', get };
}

export type PortInput<T> = T | LazyPort<T>;

function isLazy<T>(input: PortInput<T>): input is LazyPort<T> {
  return typeof input === 'object' && input !== null && (input as { kind?: unknown }).kind === 'lazy-port';
}

async function resolvePort<T>(input: PortInput<T> | undefined): Promise<T | undefined> {
  if (input === undefined) return undefined;
  return isLazy(input) ? input.get() : input;
}

/** Cross-cutting hooks around every navigation (e.g. `urlSync.flush()` before navigating). */
export interface NavigationHooks {
  readonly id: `${string}/${string}`;
  /** Before the pipeline of every navigation (router- or history-initiated). Errors are reported, not fatal. */
  beforeNavigate?(intent: NavigationIntent, signal: AbortSignal): void | Promise<void>;
  /** After a navigation settled (redirects followed). */
  afterNavigate?(result: NavigationResult): void;
}

export interface RouterOptions {
  readonly routes: readonly AnyRoute[];
  readonly dialogs?: readonly AnyDialog[];
  readonly plugins?: readonly StagePlugin[];
  readonly stages?: readonly CustomStage[];
  readonly history: HistoryAdapter;
  readonly features?: PortInput<RouteFeatureDriver>;
  readonly profile?: PortInput<ProfilePredicate>;
  readonly dialogSurface?: PortInput<DialogSurfacePort>;
  readonly hooks?: readonly NavigationHooks[];
  readonly telemetry?: Telemetry;
  /** I-1 gate, e.g. `(signal) => supervisor.whenRunnable({ kind: 'task', source: 'router' }, signal)`. */
  readonly runGate?: (signal: AbortSignal) => Promise<Result<void>>;
  /** Rendered (URL kept) when nothing matches; otherwise the navigation is blocked with SF-NAV-001. */
  readonly notFound?: AnyRoute;
  /** Default 8. */
  readonly maxRedirects?: number;
}

export interface NavigateOptions {
  readonly replace?: boolean;
  /** History state for the new entry (read back as `context.intent.state`). */
  readonly state?: unknown;
  /** Run the pipeline even if the location is unchanged. */
  readonly force?: boolean;
  /** Aborting cancels this navigation (like a newer navigation would). */
  readonly signal?: AbortSignal;
}

interface ResultBase {
  readonly id: number;
  /** Hrefs redirected from (oldest first). */
  readonly redirects: readonly string[];
  readonly kind: PipelineKind | undefined;
}

export type NavigationResult =
  | (ResultBase & { readonly outcome: 'committed'; readonly match: RouteMatch; readonly skipped: boolean })
  | (ResultBase & { readonly outcome: 'cancelled'; readonly reason: string })
  | (ResultBase & { readonly outcome: 'blocked'; readonly error: SfError; readonly stage: StageName })
  | (ResultBase & { readonly outcome: 'failed'; readonly error: SfError; readonly stage: StageName | undefined });

export interface PendingNavigation {
  readonly id: number;
  readonly href: string;
  readonly kind: PipelineKind | undefined;
  readonly stage: StageName | undefined;
}

export type ExitGuardTarget = AnyRoute | AnyDialog | undefined;

export interface Router {
  readonly table: RouteTable;
  readonly history: HistoryAdapter;
  /** Committed match. Reactive. */
  readonly current: RouteMatch | undefined;
  /** Navigation machine state. Reactive. */
  readonly status: NavigationStatus;
  /** Stage of the running navigation. Reactive. */
  readonly stage: StageName | undefined;
  /** Running navigation (pending UI). Reactive. */
  readonly pending: PendingNavigation | undefined;
  /** Features the router mounted for the current match. */
  readonly mountedFeatures: readonly FeatureId[];
  /** Currently open routable dialog. */
  readonly openDialog: AnyDialog | undefined;
  /** Run the first navigation for the current history location and start listening to history. */
  start(): Promise<NavigationResult>;
  navigate<R extends AnyRoute>(target: RouteTarget<R> | HrefTarget, options?: NavigateOptions): Promise<NavigationResult>;
  href<R extends AnyRoute>(target: RouteTarget<R>): Result<string>;
  match(href: string): RouteMatch | undefined;
  back(): Promise<NavigationResult>;
  forward(): Promise<NavigationResult>;
  go(delta: number): Promise<NavigationResult>;
  /** Re-run a serialized intent (e.g. after login). */
  retry(intent: NavigationIntent): Promise<NavigationResult>;
  /** Re-run the full pipeline for the current location (mode change → variant swap, R18.6). */
  refresh(): Promise<NavigationResult>;
  /** Open a routable dialog over the current location (`…/d/<key>`). */
  openDialogRoute(dialog: AnyDialog, options?: { readonly state?: unknown }): Promise<NavigationResult>;
  /** Dismiss the routable dialog: back if opened in-app, replace to the parent if deep-linked (R7.18). */
  dismissDialog(): Promise<NavigationResult>;
  /**
   * Register an exit guard at runtime (unsaved state, R7.2/R7.19): runs when `target` (route or dialog)
   * is left; `undefined` = every full navigation away from the current location. Removed on `scope` dispose.
   */
  guardExit(target: ExitGuardTarget, guard: GuardSpec, scope?: Scope): () => void;
  /** Scope of a route segment in the current match (disposed when the segment is left, R7.21). */
  scopeOf(route: AnyRoute): Scope | undefined;
  /** Scope of the open routable dialog. */
  readonly dialogScope: Scope | undefined;
  onNavigation(listener: (result: NavigationResult) => void): () => void;
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------- internals

interface NavRequest {
  readonly href: string;
  readonly mode: 'push' | 'replace';
  readonly trigger: NavigationTrigger;
  readonly state: unknown;
  readonly external: ExternalNavigation | undefined;
  readonly redirects: readonly string[];
  readonly force: boolean;
  readonly signal: AbortSignal | undefined;
}

interface Run {
  readonly id: number;
  readonly request: NavRequest;
  readonly control: RunControl;
  readonly done: Deferred<void>;
  finished: boolean;
}

type RunResult =
  | { readonly kind: 'committed'; readonly match: RouteMatch; readonly pipeline: PipelineKind | undefined; readonly skipped: boolean; readonly followUp: PipelineOutcome | undefined }
  | { readonly kind: 'redirect'; readonly outcome: Extract<PipelineOutcome, { kind: 'redirect' }>; readonly pipeline: PipelineKind | undefined }
  | { readonly kind: 'cancelled'; readonly reason: string; readonly pipeline: PipelineKind | undefined }
  | { readonly kind: 'blocked'; readonly error: SfError; readonly stage: StageName; readonly pipeline: PipelineKind | undefined }
  | { readonly kind: 'failed'; readonly error: SfError; readonly stage: StageName | undefined; readonly pipeline: PipelineKind | undefined };

/** What the router stores in history entry state. */
interface RouterEntryState {
  readonly __router: { readonly dialogInApp: boolean };
  readonly user: unknown;
}

function isRouterState(value: unknown): value is RouterEntryState {
  return typeof value === 'object' && value !== null && '__router' in value;
}

function userState(value: unknown): unknown {
  return isRouterState(value) ? value.user : value;
}

interface OpenDialogRecord {
  readonly dialog: AnyDialog;
  readonly baseHref: string;
  readonly handle: DialogSurfaceHandle;
  readonly scope: Scope;
}

interface DynamicGuard {
  readonly target: ExitGuardTarget;
  readonly spec: GuardSpec;
}

const paramNamesCache = new WeakMap<AnyRoute, readonly string[]>();
function paramNamesOf(route: AnyRoute): readonly string[] {
  let names = paramNamesCache.get(route);
  if (names === undefined) {
    names = compilePattern(route.path).paramNames;
    paramNamesCache.set(route, names);
  }
  return names;
}

function sameSegment(route: AnyRoute, a: RouteMatch, b: RouteMatch): boolean {
  const pa = a.params as Readonly<Record<string, string>>;
  const pb = b.params as Readonly<Record<string, string>>;
  return paramNamesOf(route).every((n) => pa[n] === pb[n]);
}

/** Entering (outer → inner) and leaving (inner → outer) segments. */
export function diffChains(from: RouteMatch | undefined, to: RouteMatch): { entering: readonly AnyRoute[]; leaving: readonly AnyRoute[] } {
  if (from === undefined) return { entering: to.chain, leaving: [] };
  let i = 0;
  while (i < from.chain.length && i < to.chain.length && from.chain[i] === to.chain[i] && sameSegment(from.chain[i] as AnyRoute, from, to)) {
    i += 1;
  }
  return { entering: to.chain.slice(i), leaving: from.chain.slice(i).reverse() };
}

/**
 * Pipeline kind for `from → to` (R7.7, R7.17):
 * - `dialog` — only the routable dialog differs;
 * - `view`   — every entered/left segment is a `view` route and no `route`-kind search param changed
 *   (view search params, undeclared keys and the hash may change);
 * - `full`   — anything else.
 */
export function classifyNavigation(from: RouteMatch | undefined, to: RouteMatch): PipelineKind {
  if (from === undefined) return 'full';
  if (from.dialog !== to.dialog) {
    return from.route === to.route && from.baseHref === to.baseHref && sameSegment(to.route, from, to) ? 'dialog' : 'full';
  }
  if (from.dialog !== undefined && from.baseHref !== to.baseHref) return 'full';
  const { entering, leaving } = diffChains(from, to);
  if (!entering.every((r) => r.view) || !leaving.every((r) => r.view)) return 'full';
  const fromSearch = new URLSearchParams(from.location.search);
  const toSearch = new URLSearchParams(to.location.search);
  for (const route of new Set([...from.chain, ...to.chain])) {
    for (const [key, param] of Object.entries(route.ownSearch)) {
      if (param.urlKind === 'route' && fromSearch.get(key) !== toSearch.get(key)) return 'full';
    }
  }
  return 'view';
}

// ---------------------------------------------------------------- router

export function createRouter(options: RouterOptions): Result<Router> {
  const tableResult = createRouteTable(
    options.notFound !== undefined && !options.routes.includes(options.notFound) ? [...options.routes, options.notFound] : options.routes,
    options.dialogs ?? [],
  );
  if (!tableResult.ok) return tableResult;
  const customStages = options.stages ?? [];
  const stagesValid = validateStages(customStages);
  if (!stagesValid.ok) return stagesValid;
  const plugins = options.plugins ?? [];
  for (const plugin of plugins) {
    if (typeof plugin.stage !== 'string' && !customStages.includes(plugin.stage)) {
      return err(UnknownStageError({ details: { plugin: plugin.id, stage: plugin.stage.id } }));
    }
  }
  const table = tableResult.value;
  const history = options.history;
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const maxRedirects = options.maxRedirects ?? 8;
  const hooks = options.hooks ?? [];

  const rootScope = createScope('router');
  const hard = new AbortController();
  const machine = createMachine(navigationMachine);
  rootScope.defer(traceMachine(machine, telemetry, SUB, { criticalStates: ['failed'] }));
  const currentBox = box<RouteMatch | undefined>(undefined);
  const stageBox = box<StageName | undefined>(undefined);
  const pendingBox = box<PendingNavigation | undefined>(undefined);
  const listeners = new Set<(result: NavigationResult) => void>();
  const dynamicGuards = new Set<DynamicGuard>();
  const segmentScopes = new Map<AnyRoute, Scope>();
  let mounted = new Map<FeatureId, SelectedFeature>();
  let openDialog: OpenDialogRecord | undefined;
  let committedEntry: HistoryEntry | undefined;
  let active: Run | undefined;
  let sequence = 0;
  let committedCount = 0;
  let started = false;
  let disposed = false;
  let latestExternal: Promise<NavigationResult> | undefined;
  let releaseSubscribed = false;

  const pluginsFor = (name: StageName): StagePlugin[] => plugins.filter((p) => stageName(p.stage) === name);

  const plans: { [K in PipelineKind]: readonly PlannedStage[] } = {
    full: planStages('full', customStages),
    view: planStages('view', customStages),
    dialog: planStages('dialog', customStages),
  };

  const featureDriver = async (): Promise<RouteFeatureDriver | undefined> => {
    const driver = await resolvePort(options.features);
    if (driver !== undefined && !releaseSubscribed && driver.onReleased !== undefined) {
      releaseSubscribed = true;
      rootScope.defer(driver.onReleased((id) => mounted.delete(id)));
    }
    return driver;
  };

  // ------------------------------------------------------------ results

  const toResult = (run: Run, result: RunResult): NavigationResult => {
    const base = { id: run.id, redirects: run.request.redirects, kind: result.pipeline };
    switch (result.kind) {
      case 'committed':
        return { ...base, outcome: 'committed', match: result.match, skipped: result.skipped };
      case 'cancelled':
        return { ...base, outcome: 'cancelled', reason: result.reason };
      case 'blocked':
        return { ...base, outcome: 'blocked', error: result.error, stage: result.stage };
      case 'failed':
        return { ...base, outcome: 'failed', error: result.error, stage: result.stage };
      case 'redirect':
        // Never surfaces (redirects are followed); kept total for the type checker.
        return { ...base, outcome: 'cancelled', reason: 'redirected' };
    }
  };

  const immediateFailure = (error: SfError, redirects: readonly string[] = []): NavigationResult => {
    sequence += 1;
    return { id: sequence, redirects, kind: undefined, outcome: 'failed', error, stage: undefined };
  };

  const skippedResult = (): NavigationResult => {
    const match = currentBox.get();
    sequence += 1;
    if (match === undefined) return { id: sequence, redirects: [], kind: undefined, outcome: 'cancelled', reason: 'nothing-to-do' };
    return { id: sequence, redirects: [], kind: undefined, outcome: 'committed', match, skipped: true };
  };

  // ------------------------------------------------------------ history alignment

  /** Bring the browser back to the committed entry (revert-and-replay). */
  const alignHistory = async (): Promise<void> => {
    if (committedEntry === undefined) return;
    const now = history.current;
    if (now.index !== committedEntry.index) {
      await history.go(committedEntry.index - now.index, { silent: true });
    } else if (now.url !== committedEntry.url) {
      history.replace(committedEntry.url, { state: committedEntry.state, source: ROUTER_SOURCE });
      committedEntry = history.current;
    }
  };

  // ------------------------------------------------------------ dialogs

  const closeDialog = async (reason: 'navigation' | 'replaced' | 'dismissed' | 'disposed'): Promise<void> => {
    const record = openDialog;
    if (record === undefined) return;
    openDialog = undefined;
    try {
      await record.handle.close(reason);
    } catch (error) {
      telemetry.event('nav.dialog-close-error', { subsystem: SUB, level: 'critical', attrs: { dialog: record.dialog.id, error: toSfError(error).code } });
    }
    await record.scope.dispose();
  };

  const transitionDialog = async (ctx: NavigationContext, signal: AbortSignal): Promise<Result<void>> => {
    const target = ctx.to.dialog;
    const changed = openDialog?.dialog !== target || (openDialog !== undefined && openDialog.baseHref !== ctx.to.baseHref);
    if (!changed) return ok();
    if (openDialog !== undefined) await closeDialog(target === undefined ? 'navigation' : 'replaced');
    if (target === undefined) return ok();
    const surface = await resolvePort(options.dialogSurface);
    if (surface === undefined) return err(NoDialogSurfaceError({ details: { dialog: target.id } }));
    const scope = rootScope.child(`dialog:${target.id}`);
    const opened = await surface.open(
      { dialog: target, match: ctx.to, navigation: ctx, scope, dismiss: () => void router.dismissDialog() },
      signal,
    );
    if (!opened.ok) {
      await scope.dispose();
      return opened;
    }
    openDialog = { dialog: target, baseHref: ctx.to.baseHref, handle: opened.value, scope };
    return ok();
  };

  // ------------------------------------------------------------ steps

  const builtinStep = (
    id: string,
    run: PipelineStep['run'],
    extra: Partial<Pick<PipelineStep, 'concurrency' | 'uninterruptible' | 'order'>> = {},
  ): PipelineStep => ({
    id: `router/${id}`,
    source: 'builtin',
    order: extra.order ?? -1000,
    concurrency: extra.concurrency ?? 'serial',
    uninterruptible: extra.uninterruptible ?? false,
    run,
  });

  const guardSteps = (specs: readonly GuardSpec[] | undefined, owner: string, source: PipelineStep['source'], order: number): PipelineStep[] =>
    (specs ?? []).map((spec, i) => {
      const g = toGuard(spec);
      return {
        id: `${owner}#${g.name ?? i}`,
        source,
        order: order + i,
        concurrency: g.concurrency ?? 'serial',
        uninterruptible: g.uninterruptible ?? false,
        run: g.run,
      };
    });

  const builtinSteps = (stage: BuiltinStageId, ctx: InternalContext): PipelineStep[] => {
    const steps: PipelineStep[] = [];
    const kind = ctx.kind;
    const dialogEntering = ctx.dialog.to !== undefined && ctx.dialog.to !== ctx.dialog.from;
    if (stage === 'availability' && kind === 'full') {
      steps.push(
        builtinStep('select-features', async () => {
          const predicate = (await resolvePort(options.profile)) ?? allModesAvailable;
          const driver = await featureDriver();
          const selected: SelectedFeature[] = [];
          for (const route of ctx.to.chain) {
            const selector = route.feature;
            if (selector === undefined) continue;
            const candidate = selector.candidates.find(
              (c) => (driver === undefined || driver.has(c.feature.id)) && predicate(c.modes ?? driver?.modesOf(c.feature.id), c.feature),
            );
            if (candidate === undefined) {
              return block(
                FeatureUnavailableError({
                  message: `No feature serves capability "${selector.capability}" for route "${route.id}" in this profile.`,
                  details: { capability: selector.capability, route: route.id },
                }),
              );
            }
            selected.push({ route, capability: selector.capability, feature: candidate.feature.id, leave: selector.leave });
          }
          ctx.setFeatures(selected);
          return proceed();
        }),
      );
    }
    if (stage === 'transient' && kind === 'full') {
      const route = ctx.to.route;
      if (route.redirect !== undefined) {
        const target = route.redirect;
        steps.push(builtinStep('route-redirect', (c) => redirect(target(c))));
      }
      if (route.transient) {
        steps.push(
          builtinStep('transient-check', () => block(TransientRouteError({ details: { route: route.id } })), { order: 100_000 }),
        );
      }
    }
    if (stage === 'load') {
      if (kind === 'full') {
        for (const selected of ctx.features) {
          steps.push(
            builtinStep(
              `activate:${selected.feature}`,
              async (_c, signal) => {
                const driver = await featureDriver();
                if (driver === undefined) return proceed();
                const activated = await driver.activate(selected.feature, signal);
                if (!activated.ok) {
                  if (signal.aborted) return proceed();
                  return err(FeatureDriveError({ cause: activated.error, details: { feature: selected.feature, op: 'activate' } }));
                }
                ctx.span.set(`activation.${selected.feature}`, activated.value);
                return proceed();
              },
              { concurrency: 'parallel' },
            ),
          );
        }
      }
      const dialog = ctx.dialog.to;
      if ((kind === 'full' || kind === 'dialog') && dialogEntering && dialog?.load !== undefined) {
        const load = dialog.load;
        steps.push(builtinStep(`dialog-load:${dialog.id}`, async (_c, signal) => {
          const loaded = await load(signal);
          return loaded.ok ? proceed() : loaded;
        }, { concurrency: 'parallel' }));
      }
    }
    if (stage === 'render' && kind === 'full') {
      steps.push(
        builtinStep(
          'render-features',
          async (_c, signal) => {
            const driver = await featureDriver();
            if (driver !== undefined) {
              for (const selected of ctx.features) {
                const result = await driver.mount(selected.feature, { route: selected.route, signal });
                if (!result.ok) return err(FeatureDriveError({ cause: result.error, details: { feature: selected.feature, op: 'mount' } }));
              }
              const keep = new Set(ctx.features.map((f) => f.feature));
              for (const [id, previous] of mounted) {
                if (keep.has(id)) continue;
                const released = await driver.release(id, previous.leave);
                if (!released.ok) {
                  telemetry.event('nav.release-failed', { subsystem: SUB, level: 'critical', attrs: { feature: id, error: released.error.code } });
                }
              }
            }
            mounted = new Map(ctx.features.map((f) => [f.feature, f]));
            const dialog = await transitionDialog(ctx, signal);
            return dialog.ok ? proceed() : dialog;
          },
          { uninterruptible: true },
        ),
      );
    }
    if (stage === 'enter' && kind === 'dialog') {
      steps.push(
        builtinStep(
          'dialog-transition',
          async (c, signal) => {
            const result = await transitionDialog(c, signal);
            return result.ok ? proceed() : result;
          },
          { uninterruptible: true },
        ),
      );
    }
    return steps;
  };

  const routeSteps = (stage: BuiltinStageId, ctx: InternalContext): PipelineStep[] => {
    const steps: PipelineStep[] = [];
    let order = 1000;
    const dialogFrom = ctx.dialog.from;
    const dialogTo = ctx.dialog.to;
    if (stage === 'exit') {
      if (dialogFrom !== undefined && (dialogFrom !== dialogTo || ctx.from?.baseHref !== ctx.to.baseHref)) {
        steps.push(...guardSteps(dialogFrom.guards.exit, dialogFrom.id, 'dialog', order));
        order += 100;
        for (const g of dynamicGuards) {
          if (g.target === dialogFrom) steps.push(...guardSteps([g.spec], `${dialogFrom.id}:dynamic`, 'dynamic', order++));
        }
      }
      for (const route of ctx.leaving) {
        steps.push(...guardSteps(route.guards.exit, route.id, 'route', order));
        order += 100;
        for (const g of dynamicGuards) {
          if (g.target === route) steps.push(...guardSteps([g.spec], `${route.id}:dynamic`, 'dynamic', order++));
        }
      }
      if (ctx.kind === 'full' && ctx.from !== undefined) {
        for (const g of dynamicGuards) {
          if (g.target === undefined) steps.push(...guardSteps([g.spec], 'router/global-exit', 'dynamic', order++));
        }
      }
      return steps;
    }
    for (const route of ctx.entering) {
      steps.push(...guardSteps(route.guards[stage], route.id, 'route', order));
      order += 100;
      if (stage === 'load') {
        steps.push(...route.loaders.map((loader, i) => ({
          id: `${route.id}#loader-${i}`,
          source: 'route' as const,
          order: order + i,
          concurrency: 'parallel' as const,
          uninterruptible: false,
          run: loader,
        })));
        order += 100;
      }
    }
    if (dialogTo !== undefined && dialogTo !== dialogFrom && (stage === 'availability' || stage === 'authorize' || stage === 'load' || stage === 'enter')) {
      steps.push(...guardSteps(dialogTo.guards[stage], dialogTo.id, 'dialog', order));
    }
    return steps;
  };

  const stepsFor = (planned: PlannedStage, ctx: InternalContext): PipelineStep[] => {
    const steps: PipelineStep[] = [];
    if (planned.builtin !== undefined) steps.push(...builtinSteps(planned.builtin, ctx));
    for (const plugin of pluginsFor(planned.name)) {
      if (!(plugin.pipelines ?? ['full']).includes(ctx.kind)) continue;
      if (plugin.applies !== undefined && !plugin.applies(ctx)) continue;
      steps.push({
        id: plugin.id,
        source: 'plugin',
        order: plugin.order ?? 0,
        concurrency: plugin.concurrency ?? 'serial',
        uninterruptible: plugin.uninterruptible ?? false,
        run: (c, s) => plugin.run(c, s),
      });
    }
    if (planned.builtin !== undefined) steps.push(...routeSteps(planned.builtin, ctx));
    // Stable sort by order.
    return steps.map((s, i) => ({ s, i })).sort((a, b) => a.s.order - b.s.order || a.i - b.i).map((x) => x.s);
  };

  // ------------------------------------------------------------ context

  interface InternalContext extends NavigationContext {
    setFeatures(features: readonly SelectedFeature[]): void;
    setStage(stage: StageName): void;
  }

  const createContext = (run: Run, kind: PipelineKind, match: RouteMatch, from: RouteMatch | undefined, span: Span): InternalContext => {
    const { entering, leaving } = diffChains(from, match);
    const slots = new Map<string, unknown>();
    let features: readonly SelectedFeature[] = kind === 'full' ? [] : [...mounted.values()];
    let stage: StageName = 'resolve';
    const intent: NavigationIntent = { href: match.location.href, mode: run.request.mode, state: run.request.state };
    return {
      id: run.id,
      kind,
      trigger: run.request.trigger,
      intent,
      from,
      to: match,
      entering,
      leaving,
      dialog: { from: from?.dialog, to: match.dialog },
      requires: requirementsOf(match.chain, match.dialog),
      get features() {
        return features;
      },
      get stage() {
        return stage;
      },
      signal: run.control.signal,
      span,
      redirects: run.request.redirects,
      external: run.request.external !== undefined,
      get: <T>(slot: { readonly id: string }) => slots.get(slot.id) as T | undefined,
      set: (slot, value) => {
        slots.set(slot.id, value);
      },
      setFeatures(next) {
        features = next;
      },
      setStage(next) {
        stage = next;
      },
    };
  };

  // ------------------------------------------------------------ commit

  const commit = async (run: Run, ctx: InternalContext): Promise<void> => {
    const { request } = run;
    const external = request.external;
    const href = ctx.to.location.href;
    const fromDialog = ctx.from?.dialog;
    const previousState = committedEntry?.state;
    const dialogInApp =
      ctx.to.dialog === undefined
        ? false
        : fromDialog === undefined
          ? request.mode === 'push' && ctx.kind === 'dialog'
          : isRouterState(previousState) && previousState.__router.dialogInApp;
    const state: RouterEntryState = { __router: { dialogInApp }, user: request.state ?? null };
    if (external !== undefined && external.committed) {
      // URL already changed (popstate / adopted write): nothing to write.
    } else if (external !== undefined && external.type === 'traverse') {
      await history.go(external.delta, { silent: true });
    } else {
      if (request.mode === 'push' && committedEntry !== undefined && history.current.index !== committedEntry.index) {
        await history.go(committedEntry.index - history.current.index, { silent: true });
      }
      if (request.trigger === 'initial') {
        if (history.url !== href || !isRouterState(history.current.state)) {
          history.replace(href, { state: { ...state, user: request.state ?? userState(history.current.state) ?? null }, source: ROUTER_SOURCE });
        }
      } else if (request.mode === 'push') {
        history.push(href, { state, source: ROUTER_SOURCE });
      } else {
        history.replace(href, { state, source: ROUTER_SOURCE });
      }
    }
    committedEntry = history.current;
    batch(() => currentBox.set(ctx.to));
    // Segment scopes (R7.19, R7.21): left segments are disposed, entered segments get a fresh scope.
    for (const route of ctx.leaving) {
      const scope = segmentScopes.get(route);
      segmentScopes.delete(route);
      if (scope !== undefined) void scope.dispose();
    }
    for (const route of ctx.to.chain) {
      if (!segmentScopes.has(route)) segmentScopes.set(route, rootScope.child(`route:${route.id}`));
    }
    committedCount += 1;
    telemetry.record(routerMetrics.navCommit, telemetry.now(), { kind: ctx.kind, route: ctx.to.route.id, start: committedCount === 1 ? 'cold' : 'soft' }, ctx.span);
  };

  // ------------------------------------------------------------ execute one run

  const execute = async (run: Run): Promise<RunResult> => {
    const { request, control } = run;
    pendingBox.set({ id: run.id, href: request.href, kind: undefined, stage: undefined });
    for (const hook of hooks) {
      if (hook.beforeNavigate === undefined) continue;
      try {
        await hook.beforeNavigate({ href: request.href, mode: request.mode, state: request.state }, control.signal);
      } catch (error) {
        telemetry.event('nav.hook-error', { subsystem: SUB, level: 'critical', attrs: { hook: hook.id, error: toSfError(error).code } });
      }
    }
    if (control.signal.aborted) return { kind: 'cancelled', reason: cancelReason(control.signal), pipeline: undefined };
    if (options.runGate !== undefined) {
      const gate = await options.runGate(control.signal);
      if (control.signal.aborted) return { kind: 'cancelled', reason: cancelReason(control.signal), pipeline: undefined };
      if (!gate.ok) return { kind: 'blocked', error: gate.error, stage: 'resolve', pipeline: undefined };
    }
    const match = table.match(request.href) ?? (options.notFound === undefined ? undefined : table.matchAs(request.href, options.notFound));
    if (match === undefined) {
      return { kind: 'blocked', error: RouteNotFoundError({ details: { href: request.href } }), stage: 'resolve', pipeline: undefined };
    }
    if (match.invalidSearch.length > 0) {
      telemetry.event('nav.search-invalid', { subsystem: SUB, level: 'standard', attrs: { route: match.route.id, keys: match.invalidSearch } });
    }
    const from = currentBox.get();
    if (!request.force && from !== undefined && from.location.href === match.location.href && request.trigger !== 'traverse' && request.trigger !== 'external') {
      return { kind: 'committed', match: from, pipeline: undefined, skipped: true, followUp: undefined };
    }
    const sameLocation = from !== undefined && from.location.href === match.location.href;
    const kind: PipelineKind = request.trigger === 'refresh' || (request.force && sameLocation) ? 'full' : classifyNavigation(from, match);
    pendingBox.set({ id: run.id, href: request.href, kind, stage: undefined });
    machine.send('start');
    const startedAt = telemetry.now();
    const startKind = committedCount === 0 ? 'cold' : 'soft';
    const span = telemetry.span(kind === 'full' ? 'nav.pipeline' : kind === 'view' ? 'nav.view' : 'nav.dialog', {
      subsystem: SUB,
      level: kind === 'full' ? 'critical' : 'standard',
      attrs: { kind, trigger: request.trigger, route: match.route.id, from: from?.route.id ?? null, start: startKind, redirects: request.redirects.length },
    });
    telemetry.record(routerMetrics.navStart, startedAt, { kind, trigger: request.trigger, start: startKind }, span);
    const ctx = createContext(run, kind, match, from, span);
    let commitHold: (() => void) | undefined;
    let followUp: PipelineOutcome | undefined;
    let result: RunResult | undefined;
    try {
      for (const planned of plans[kind]) {
        if (!planned.commitPoint && control.signal.aborted) {
          result = { kind: 'cancelled', reason: cancelReason(control.signal), pipeline: kind };
          break;
        }
        if (planned.commitPoint && commitHold === undefined) commitHold = control.hold();
        ctx.setStage(planned.name);
        stageBox.set(planned.name);
        pendingBox.set({ id: run.id, href: request.href, kind, stage: planned.name });
        const steps = stepsFor(planned, ctx);
        const stageSpan = telemetry.span('nav.stage', { subsystem: PIPELINE, parent: span, attrs: { stage: planned.name, kind, steps: steps.length } });
        const stageStart = telemetry.now();
        let outcome: PipelineOutcome;
        try {
          if (planned.builtin === 'commit') await commit(run, ctx);
          outcome = await runStage(steps, ctx, control, { stage: planned.name, telemetry, span: stageSpan, uninterruptible: planned.uninterruptible });
        } catch (error) {
          outcome = { kind: 'fail', error: toSfError(error) };
        }
        telemetry.record(routerMetrics.stageDuration, telemetry.now() - stageStart, { stage: planned.name, kind });
        stageSpan.set('outcome', outcome.kind);
        stageSpan.end(
          outcome.kind === 'fail' || outcome.kind === 'block' ? 'error' : outcome.kind === 'cancel' ? 'cancelled' : 'ok',
          outcome.kind === 'fail' || outcome.kind === 'block' ? outcome.error : undefined,
        );
        if (planned.postCommit) {
          if (outcome.kind === 'redirect') followUp ??= outcome;
          else if (outcome.kind !== 'continue') {
            telemetry.event('nav.post-commit-outcome-ignored', { subsystem: SUB, level: 'standard', attrs: { stage: planned.name, outcome: outcome.kind } });
          }
          continue;
        }
        if (outcome.kind === 'continue') continue;
        if (outcome.kind === 'redirect') result = { kind: 'redirect', outcome, pipeline: kind };
        else if (outcome.kind === 'block') result = { kind: 'blocked', error: outcome.error, stage: planned.name, pipeline: kind };
        else if (outcome.kind === 'cancel') result = { kind: 'cancelled', reason: outcome.reason, pipeline: kind };
        else result = { kind: 'failed', error: outcome.error, stage: planned.name, pipeline: kind };
        break;
      }
    } finally {
      control.finish();
      commitHold?.();
    }
    result ??= { kind: 'committed', match, pipeline: kind, skipped: false, followUp };
    const duration = telemetry.now() - startedAt;
    const outcomeName = result.kind === 'redirect' ? 'redirected' : result.kind;
    telemetry.record(routerMetrics.navDuration, duration, { kind, outcome: outcomeName });
    telemetry.record(routerMetrics.navigations, 1, { kind, outcome: outcomeName });
    if (kind === 'view' && result.kind === 'committed') telemetry.record(routerMetrics.viewTransition, duration, { route: match.route.id });
    span.set('outcome', outcomeName);
    span.end(
      result.kind === 'failed' ? 'error' : result.kind === 'cancelled' ? 'cancelled' : 'ok',
      result.kind === 'failed' || result.kind === 'blocked' ? result.error : undefined,
    );
    machine.send(result.kind === 'committed' ? 'commit' : result.kind === 'redirect' ? 'redirect' : result.kind === 'blocked' ? 'block' : result.kind === 'failed' ? 'fail' : 'cancel');
    return result;
  };

  // ------------------------------------------------------------ start a navigation

  const targetHref = (target: NavigationTarget): Result<string> => ('href' in target ? ok(parseLocation(target.href).href) : table.build(target));

  const startNavigation = async (request: NavRequest): Promise<NavigationResult> => {
    if (disposed) return immediateFailure(RouterDisposedError(), request.redirects);
    sequence += 1;
    const run: Run = { id: sequence, request, control: createRunControl(hard.signal), done: createDeferred<void>(), finished: false };
    // Aborted once the run is done, so a long-lived caller signal does not keep one listener per navigation.
    const detachCaller = new AbortController();
    if (request.signal !== undefined) {
      if (request.signal.aborted) run.control.requestCancel('aborted');
      else request.signal.addEventListener('abort', () => run.control.requestCancel('aborted'), { once: true, signal: detachCaller.signal });
    }
    const previous = active;
    active = run;
    if (previous !== undefined && !previous.finished) {
      previous.control.requestCancel('superseded');
      await previous.done.promise;
    }
    let result: RunResult;
    if (active !== run || run.control.signal.aborted) {
      result = { kind: 'cancelled', reason: run.control.signal.aborted ? cancelReason(run.control.signal) : 'superseded', pipeline: undefined };
      run.control.finish();
    } else {
      try {
        result = await execute(run);
      } catch (error) {
        result = { kind: 'failed', error: toSfError(error), stage: stageBox.get(), pipeline: undefined };
      }
    }
    run.finished = true;
    detachCaller.abort();
    run.done.resolve();
    const latest = active === run;

    if (result.kind === 'redirect' && latest && !disposed) {
      return followRedirect(request, result.outcome);
    }
    if (result.kind === 'committed' && result.followUp?.kind === 'redirect' && latest && !disposed) {
      return followRedirect({ ...request, mode: 'replace' }, result.followUp);
    }
    if (latest) {
      if (result.kind === 'blocked' || result.kind === 'failed' || (result.kind === 'cancelled' && result.reason !== 'superseded')) {
        await alignHistory();
      }
      batch(() => {
        stageBox.set(undefined);
        pendingBox.set(undefined);
      });
      if (machine.can('settle')) machine.send('settle');
    }
    const final = toResult(run, result);
    for (const hook of hooks) hook.afterNavigate?.(final);
    for (const listener of [...listeners]) listener(final);
    return final;
  };

  const followRedirect = (request: NavRequest, outcome: Extract<PipelineOutcome, { kind: 'redirect' }>): Promise<NavigationResult> => {
    const redirects = [...request.redirects, request.href];
    if (redirects.length > maxRedirects) {
      const error = RedirectLoopError({ details: { redirects } });
      telemetry.event('nav.redirect-loop', { subsystem: SUB, level: 'critical', attrs: { count: redirects.length } });
      return alignHistory().then(() => {
        batch(() => {
          stageBox.set(undefined);
          pendingBox.set(undefined);
        });
        if (machine.can('settle')) machine.send('settle');
        return immediateFailure(error, redirects);
      });
    }
    const href = targetHref(outcome.target);
    if (!href.ok) return Promise.resolve(immediateFailure(href.error, redirects));
    const inherit = request.mode === 'replace' || request.trigger === 'initial' || request.trigger === 'traverse';
    const mode = outcome.replace === true || inherit ? 'replace' : 'push';
    return startNavigation({
      href: href.value,
      mode,
      trigger: 'redirect',
      state: outcome.state ?? null,
      // A deferred (uncommitted) external navigation never touched history; a committed one is replaced.
      external: undefined,
      redirects,
      force: false,
      signal: request.signal,
    });
  };

  // ------------------------------------------------------------ history listeners

  const onExternal = (navigation: ExternalNavigation): void => {
    latestExternal = startNavigation({
      href: navigation.url,
      mode: navigation.type === 'push' ? 'push' : 'replace',
      trigger: navigation.type === 'traverse' ? 'traverse' : 'external',
      state: userState(navigation.state),
      external: navigation,
      redirects: [],
      force: false,
      signal: undefined,
    });
  };

  const onChange = (change: HistoryChange): void => {
    if (change.source === ROUTER_SOURCE || change.cause === 'pop') return;
    // A write by someone else (urlstate view/sticky sync, urlstate dialog URLs, third-party code).
    const match = table.match(change.url);
    const current = currentBox.get();
    const idle = active === undefined || active.finished;
    if (match !== undefined && current !== undefined && idle && classifyNavigation(current, match) === 'view' && match.dialog === current.dialog) {
      // View state only: adopt without a pipeline (R7.11 — the router is not invoked for view changes).
      committedEntry = history.current;
      batch(() => currentBox.set(match));
      telemetry.event('nav.adopted-write', { subsystem: SUB, level: 'verbose', attrs: { source: change.source, route: match.route.id } });
      return;
    }
    latestExternal = startNavigation({
      href: change.url,
      mode: change.cause === 'push' ? 'push' : 'replace',
      trigger: 'external',
      state: userState(history.current.state),
      external: { url: change.url, type: change.cause, delta: 0, committed: true, state: history.current.state, userInitiated: false },
      redirects: [],
      force: true,
      signal: undefined,
    });
  };

  // ------------------------------------------------------------ public API

  const traverse = async (delta: number): Promise<NavigationResult> => {
    if (disposed) return immediateFailure(RouterDisposedError());
    if (!history.canGo(delta)) return skippedResult();
    latestExternal = undefined;
    await history.go(delta);
    const pending = latestExternal as Promise<NavigationResult> | undefined;
    return pending ?? skippedResult();
  };

  const router: Router = {
    table,
    history,
    get current() {
      return currentBox.get();
    },
    get status() {
      return machine.state;
    },
    get stage() {
      return stageBox.get();
    },
    get pending() {
      return pendingBox.get();
    },
    get mountedFeatures() {
      return [...mounted.keys()];
    },
    get openDialog() {
      return openDialog?.dialog;
    },
    get dialogScope() {
      return openDialog?.scope;
    },
    start() {
      if (started) return Promise.resolve(skippedResult());
      started = true;
      rootScope.defer(history.listen(onExternal));
      rootScope.defer(history.subscribe(onChange));
      return startNavigation({
        href: history.url,
        mode: 'replace',
        trigger: 'initial',
        state: userState(history.current.state),
        external: undefined,
        redirects: [],
        force: true,
        signal: undefined,
      });
    },
    navigate(target, navigateOptions = {}) {
      if (disposed) return Promise.resolve(immediateFailure(RouterDisposedError()));
      const href = targetHref(target as NavigationTarget);
      if (!href.ok) return Promise.resolve(immediateFailure(href.error));
      return startNavigation({
        href: href.value,
        mode: navigateOptions.replace === true ? 'replace' : 'push',
        trigger: navigateOptions.replace === true ? 'replace' : 'push',
        state: navigateOptions.state ?? null,
        external: undefined,
        redirects: [],
        force: navigateOptions.force ?? false,
        signal: navigateOptions.signal,
      });
    },
    href: (target) => table.build(target as RouteTarget),
    match: (href) => table.match(href),
    back: () => traverse(-1),
    forward: () => traverse(1),
    go: (delta) => traverse(delta),
    retry(intent) {
      return router.navigate({ href: intent.href }, { replace: intent.mode === 'replace', state: intent.state, force: true });
    },
    refresh() {
      const current = currentBox.get();
      if (current === undefined) return router.start();
      return startNavigation({
        href: current.location.href,
        mode: 'replace',
        trigger: 'refresh',
        state: userState(history.current.state),
        external: undefined,
        redirects: [],
        force: true,
        signal: undefined,
      });
    },
    openDialogRoute(dialog, dialogOptions = {}) {
      const current = currentBox.get();
      if (current === undefined || (dialog.owner !== undefined && !current.chain.includes(dialog.owner))) {
        return Promise.resolve(immediateFailure(DialogRouteError({ details: { dialog: dialog.id, route: current?.route.id ?? null } })));
      }
      const base = parseLocation(current.baseHref);
      const href = `${dialogPath(base.pathname, dialog.key)}${base.search}${base.hash}`;
      return router.navigate({ href }, { replace: current.dialog !== undefined, state: dialogOptions.state });
    },
    async dismissDialog() {
      const current = currentBox.get();
      if (current?.dialog === undefined) return skippedResult();
      const state = history.current.state;
      if (isRouterState(state) && state.__router.dialogInApp && history.canGoBack) return traverse(-1);
      return router.navigate({ href: current.baseHref }, { replace: true });
    },
    guardExit(target, spec, scope) {
      const entry: DynamicGuard = { target, spec };
      dynamicGuards.add(entry);
      const remove = (): void => {
        dynamicGuards.delete(entry);
      };
      scope?.defer(remove);
      return remove;
    },
    scopeOf: (route) => segmentScopes.get(route),
    onNavigation(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      hard.abort(new DOMException('router disposed', 'AbortError'));
      await closeDialog('disposed');
      for (const scope of segmentScopes.values()) await scope.dispose();
      segmentScopes.clear();
      listeners.clear();
      await rootScope.dispose();
    },
  };
  return ok(router);
}
