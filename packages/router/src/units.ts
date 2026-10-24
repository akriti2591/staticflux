/**
 * DI units of @staticflux/router. Apps register `routerUnits` (or pick), contribute routes,
 * dialogs, stage plugins and custom stages, and choose a history strategy per host mode.
 */
import { contribution, type FunctionalDep, ok, unit } from '@staticflux/core';
import { FeatureHostToken, type FeatureId, type Subsystem, SubsystemsToken, SupervisorToken, defineSubsystem } from '@staticflux/runtime';
import { createBrowserHistory, type BrowserWindowLike } from './browser-history.js';
import type { AnyDialog } from './dialogs.js';
import { allModesAvailable, featureHostDriver, type ProfilePredicate } from './feature-driver.js';
import { createMemoryHistory, type HistoryAdapter, type MemoryHistoryOptions } from './history.js';
import { createRouter, lazyPort, type LazyPort, type Router } from './router.js';
import type { AnyRoute } from './routes.js';
import type { CustomStage, StagePlugin } from './stages.js';
import {
  CustomStagesToken,
  DialogsToken,
  DialogSurfacePortToken,
  HistoryAdapterToken,
  NavigationHooksToken,
  RouteFeatureDriverToken,
  RouteProfileToken,
  RouterToken,
  RoutesToken,
  StagePluginsToken,
} from './tokens.js';

function optional<T>(dep: FunctionalDep<T>): LazyPort<T> {
  return lazyPort(async () => {
    const resolved = await dep.get();
    return resolved.ok ? resolved.value : undefined;
  });
}

export interface RouterUnitOptions {
  readonly notFound?: AnyRoute;
  readonly maxRedirects?: number;
}

/** The router unit with app config (not-found route, redirect limit). */
/* @__NO_SIDE_EFFECTS__ */
export function routerUnitWith(config: RouterUnitOptions = {}) {
  return unit({
    id: 'router/router-unit',
    provides: RouterToken,
    scope: 'app',
    deps: {
      required: {
        routes: RoutesToken,
        dialogs: DialogsToken,
        plugins: StagePluginsToken,
        stages: CustomStagesToken,
        hooks: NavigationHooksToken,
        history: HistoryAdapterToken,
      },
      lazy: { supervisor: SupervisorToken },
      functional: { features: RouteFeatureDriverToken, profile: RouteProfileToken, dialogSurface: DialogSurfacePortToken },
    },
    create: ({ routes, dialogs, plugins, stages, hooks, history, supervisor, features, profile, dialogSurface }, ctx): Router => {
      const created = createRouter({
        routes,
        dialogs,
        plugins,
        stages,
        hooks,
        history,
        telemetry: ctx.telemetry,
        features: optional(features),
        profile: optional(profile),
        dialogSurface: optional(dialogSurface),
        runGate: (signal) => supervisor.value?.whenRunnable({ kind: 'task', source: 'router/navigation' }, signal) ?? Promise.resolve(ok()),
        ...(config.notFound === undefined ? {} : { notFound: config.notFound }),
        ...(config.maxRedirects === undefined ? {} : { maxRedirects: config.maxRedirects }),
      });
      if (!created.ok) throw created.error; // invalid route/stage definitions: fail fast (SF-DI-005, cause SF-NAV-007/013)
      ctx.scope.defer(() => created.value.dispose());
      return created.value;
    },
    description: 'Navigation pipeline, typed route table, history integration, routable dialogs.',
  });
}

export const routerUnit = routerUnitWith();

/** Runs the first navigation when the supervisor starts subsystems (boot step 5). */
export function routerSubsystem(router: Router): Subsystem {
  return defineSubsystem({
    id: 'router/navigation',
    critical: false,
    start: async () => {
      // A blocked/not-found first navigation is a navigation outcome, not a subsystem failure.
      await router.start();
    },
    description: 'Starts the router (first navigation + history listening).',
  });
}

export const routerSubsystemUnit = contribution({
  id: 'router/subsystem-unit',
  provides: SubsystemsToken,
  scope: 'app',
  deps: { required: { router: RouterToken } },
  create: ({ router }) => routerSubsystem(router),
});

/* @__NO_SIDE_EFFECTS__ */
export function memoryHistoryUnitWith(options: MemoryHistoryOptions = {}) {
  return unit({
    id: 'router/memory-history-unit',
    provides: HistoryAdapterToken,
    scope: 'app',
    create: (_deps, ctx): HistoryAdapter => {
      const history = createMemoryHistory(options);
      ctx.scope.defer(() => history.dispose());
      return history;
    },
    description: 'In-memory history (embedded hosts synchronized via host bridge, tests).',
  });
}

export const memoryHistoryUnit = memoryHistoryUnitWith();

/** Navigation API with History API fallback; memory history when there is no window. */
export const browserHistoryUnit = unit({
  id: 'router/browser-history-unit',
  provides: HistoryAdapterToken,
  scope: 'app',
  create: (_deps, ctx): HistoryAdapter => {
    const win = (typeof window === 'undefined' ? undefined : window) as unknown as BrowserWindowLike | undefined;
    const history = win?.history === undefined ? createMemoryHistory() : createBrowserHistory({ window: win });
    ctx.scope.defer(() => history.dispose());
    return history;
  },
  description: 'Browser history: Navigation API (feature-detected) or History API fallback.',
});

/* @__NO_SIDE_EFFECTS__ */
export function featureHostDriverUnitWith(options: { readonly targetFor?: (route: AnyRoute, feature: FeatureId) => unknown } = {}) {
  return unit({
    id: 'router/feature-host-driver-unit',
    provides: RouteFeatureDriverToken,
    scope: 'app',
    deps: { required: { host: FeatureHostToken } },
    create: ({ host }) => featureHostDriver(host, options),
    description: 'Drives route features through the runtime feature host.',
  });
}

export const featureHostDriverUnit = featureHostDriverUnitWith();

/* @__NO_SIDE_EFFECTS__ */
export function profileUnit(predicate: ProfilePredicate) {
  return unit({ id: 'router/profile-unit', provides: RouteProfileToken, scope: 'app', create: () => predicate });
}

export const allModesProfileUnit = profileUnit(allModesAvailable);

/** Contribute one route. */
/* @__NO_SIDE_EFFECTS__ */
export function routeUnit(route: AnyRoute) {
  return contribution({ id: `${route.id}-route`, provides: RoutesToken, scope: 'app', create: () => route });
}

/** Contribute one routable dialog. */
/* @__NO_SIDE_EFFECTS__ */
export function dialogUnit(dialog: AnyDialog) {
  return contribution({ id: `${dialog.id}-dialog`, provides: DialogsToken, scope: 'app', create: () => dialog });
}

/** Contribute a stage plugin with no dependencies (use `contribution()` directly when it needs deps). */
export function stagePluginUnit(plugin: StagePlugin) {
  return contribution({ id: `${plugin.id}-plugin`, provides: StagePluginsToken, scope: 'app', create: () => plugin });
}

export function stageUnit(stage: CustomStage) {
  return contribution({ id: `${stage.id}-stage`, provides: CustomStagesToken, scope: 'app', create: () => stage });
}

/** Router + feature-host driver + default profile + subsystem. Add a history unit per host mode. */
export const routerUnits = [routerUnit, featureHostDriverUnit, allModesProfileUnit, routerSubsystemUnit] as const;
