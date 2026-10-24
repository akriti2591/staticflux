# @staticflux/router — AGENTS.md

**Layer:** vertical (depends on `@staticflux/core`, `@staticflux/runtime`). Never imports auth, gate, urlstate,
loader or messaging — they plug in through stage plugins and ports defined here.
**Budget:** boot path (R12.7, counts toward the 45 KB framework runtime). Measured ≈ 24.7 KB gzip of unminified
tsc output for the whole package (comments included); `browser-history`, `integrations`, `units` tree-shake per app.
No size-limit entry yet.

## Purpose
Async, cancellable navigation pipeline with fixed named stages, typed routes (path + search params), nested
routes with per-segment guards, capability-bound routes (per-mode variants), light pipelines for view state and
routable dialogs, history strategies (Navigation API / History API / memory), feature host integration and
navigation telemetry. Implements REQUIREMENTS R7.1–R7.9, R7.16–R7.21 (router side), R17.5–R17.9 (navigation
spans/marks), R18.5, R18.9; docs/LIFECYCLES.md §7.

## Pipeline
`resolve → exit → availability → transient → pre-auth → auth-boundary → post-auth → authorize → load → prefetch → enter → render → commit`
- `full` runs all; `view` (only `view: true` sub-routes entered/left, or only view/undeclared search params or hash
  changed) runs `exit → enter → commit`; `dialog` (only the `/d/<key>` part changed) runs
  `exit → availability → authorize → load → enter → commit`.
- Steps return `Result<StageOutcome>` via `proceed() | redirect(target, opts) | block(error) | cancel(reason)`;
  `err()`/throw = failed. Serial steps in order; consecutive `parallel` steps run together (first non-continue wins,
  siblings aborted).
- Built-ins: availability = capability → feature selection (profile predicate); transient = route `redirect`,
  transient routes must redirect; load = feature activation (parallel) + dialog `load`; render = mount selected
  features, release left ones, close/open dialogs; commit = history write + state + segment scopes. Plugins run at
  order 0 (built-ins -1000, route/dialog guards from 1000).
- Concurrency: newest cancels older (AbortSignal). Uninterruptible steps (and custom stages) hold cancellation
  until they settle; the newer navigation waits. `render`/`commit` are the commit point (always complete).
- History-initiated navigations run the same pipeline. `committed: true` (popstate) navigations that do not commit
  are reverted with a silent `go()` (revert-and-replay); superseded ones are left to the newest navigation.
- Non-router history writes (`source !== 'router'`, e.g. urlstate) that only change view state are adopted without
  a pipeline; other writes run a pipeline and are reverted if blocked.

## Public API (by file)
- `stages.ts` — `STAGES`, `PIPELINE_STAGES`, `PipelineKind`, `defineStage({ id, position: 'before:x'|'after:x', pipelines, uninterruptible })`,
  `StagePlugin` (`id, stage, order, concurrency, uninterruptible, pipelines, applies, run`), `stagePlugin`, outcomes
  `proceed/redirect/block/cancel`, `planStages`, `validateStages`.
- `routes.ts` — `defineRoute({ id, path, parent, search, feature, requires, guards, loaders, redirect, transient, abstract, view })`,
  `bindCapability(capability, candidates, { leave })`, `guard(fn, { uninterruptible, concurrency, name })`,
  `RouteRequirements` (open, declaration merging — auth/gate add keys), `RouteTarget<R>` (typed params/search/dialog),
  `HrefTarget`, `RouteMatch`, `isMatchOf`, `createRouteTable`, `parseLocation`, `requirementsOf`.
- `path.ts` — `JoinPaths`, `ParamNames`, `PathParams` (template literal types), `compilePattern/matchPattern/buildPath`.
- `search.ts` — `searchParam.string|number|boolean|enum|custom({ default, kind: 'route'|'view' })`, `SearchValues`, `SearchInput`.
- `dialogs.ts` — `defineDialog({ id, key, owner, requires, guards, load })`, `DialogSurfacePort` (messaging implements:
  `open(request, signal) → handle.close(reason)`), `DialogOpenRequest` (`scope`, `dismiss()`), `dialogPath`.
- `context.ts` — `NavigationContext` (kind, trigger, intent, from/to, entering/leaving, dialog, requires, features,
  stage, signal, span, typed slots `get/set(token)`), `NavigationIntent` (serializable; `router.retry`).
- `history.ts` — `HistoryAdapter` (structural superset of urlstate `HistoryPort`), `ExternalNavigation`, `ROUTER_SOURCE`,
  `createMemoryHistory({ initial, traversal: 'committed'|'deferred' })` (+ `navigateExternal` for host bridges).
- `browser-history.ts` — `createBrowserHistory({ window, preferHistoryApi, interceptLinks })`, `supportsNavigationApi`.
- `feature-driver.ts` — `RouteFeatureDriver` port, `featureHostDriver(host, { targetFor })`, `ProfilePredicate`,
  `modesPredicate(() => modes)`, `allModesAvailable`.
- `router.ts` — `createRouter(options) → Result<Router>`: `start`, `navigate`, `href`, `match`, `back/forward/go`, `retry`,
  `refresh` (mode change → variant swap), `openDialogRoute`, `dismissDialog`, `guardExit(target, guard, scope)`,
  `scopeOf(route)`, `dialogScope`, reactive `current/status/stage/pending`, `onNavigation`, `dispose`;
  `NavigationHooks` (`beforeNavigate`/`afterNavigate`), `lazyPort`, `classifyNavigation`, `diffChains`.
- `pipeline.ts` — `runStage`, `createRunControl`, `cancelReason` (internal runner, exported for tests).
- `integrations.ts` — `intentCapturePlugin` (resolve), `intentAuthorizePlugin` (end of authorize), `urlSyncFlushHook`.
- `telemetry.ts` — `ROUTER_SUBSYSTEMS` (`router/navigation|pipeline|history`), `routerMetrics` (`nav-start`, `nav-commit`
  marks; durations; counts; view transition), `navigationMachine` (`router/navigation`).
- `tokens.ts` — `RouterToken`, multi `RoutesToken`, `DialogsToken`, `StagePluginsToken`, `CustomStagesToken`,
  `NavigationHooksToken`; `HistoryAdapterToken`; optional `RouteFeatureDriverToken`, `RouteProfileToken`, `DialogSurfacePortToken`.
- `units.ts` — `routerUnitWith({ notFound, maxRedirects })`/`routerUnit`, `routerSubsystemUnit` (first navigation on
  start), `memoryHistoryUnitWith`/`memoryHistoryUnit`, `browserHistoryUnit`, `featureHostDriverUnitWith`/`featureHostDriverUnit`,
  `profileUnit`, `allModesProfileUnit`, `routeUnit`, `dialogUnit`, `stagePluginUnit`, `stageUnit`, `routerUnits`.
- `errors.ts` — `SF-NAV-001` not found · `002` blocked · `003` redirect loop · `004` step failed · `005` feature
  unavailable for profile · `006` transient did not redirect · `007` invalid definitions · `008` dialog not here ·
  `009` no dialog surface · `010` feature activate/mount failed · `011` missing param · `012` disposed · `013` unknown stage.

## Wiring sibling packages (ports, no imports)
- **urlstate:** bind ONE history instance to `HistoryAdapterToken` and urlstate's `HistoryPortToken`; contribute
  `intentCapturePlugin(intents)`, `intentAuthorizePlugin(intents)` and `urlSyncFlushHook(urlSync)` (NavigationHooksToken).
- **auth / gate / loader:** contribute `StagePluginsToken` with `contribution()`; read `ctx.requires` (merge
  `RouteRequirements`), redirect with `redirect(target, { state: { returnTo: ctx.intent } })` and `router.retry(intent)`.
- **messaging:** bind `DialogSurfacePortToken`; call `request.dismiss()` on user dismissal; stack non-routable surfaces in `request.scope`.
- **platform:** bind `RouteProfileToken` (`modesPredicate(() => [hostMode, formFactor])`); call `router.refresh()` on mode change.

## Rules
- Client-side guards are UX, not security (R6.16): the server re-checks everything.
- No magic strings: routes, dialogs, stages and capabilities are typed values; navigate with `{ to: route, params }`.
- The router never interprets `requires`; plugins do. The router never renders: features mount via the driver,
  dialogs via the surface port.
- View routes (`view: true`) may only have exit/enter guards; data-dependent sub-routes are normal routes.
- Keep the navigation machine in sync with docs/LIFECYCLES.md §7.

## Test
`npx vitest run packages/router` · `npx tsc -p packages/router --noEmit`

<!-- sf:generated:start -->
<!-- Generated by `sf agents` from package.json and .size-limit.json. Do not edit between these markers. -->

## Budgets

| Check | Limit | Measures |
|---|---|---|
| @staticflux/router (full) | 13.5 KB | packages/router/dist/index.js |

Budgets ratchet (R12.8): `sf budgets` proposes tightening; raising one needs a reviewed reason.

## Allowed dependencies

**Layer:** vertical

- Internal: `@staticflux/core`, `@staticflux/runtime`

Anything else is a boundary violation (`pnpm lint:boundaries`). Adding a dependency needs a reviewed reason.
<!-- sf:generated:end -->
