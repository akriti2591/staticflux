/**
 * DI tokens of @staticflux/router. Contracts only: importing this file pulls in no implementation.
 */
import { token } from '@staticflux/core';
import type { DialogSurfacePort, AnyDialog } from './dialogs.js';
import type { ProfilePredicate, RouteFeatureDriver } from './feature-driver.js';
import type { HistoryAdapter } from './history.js';
import type { NavigationHooks, Router } from './router.js';
import type { AnyRoute } from './routes.js';
import type { CustomStage, StagePlugin } from './stages.js';

export const RouterToken = token('router/router').type<Router>();
/** Routes contributed by apps/feature packages (one contribution per route: `routeUnit`). */
export const RoutesToken = token('router/routes').multi<AnyRoute>();
/** Routable dialogs (`dialogUnit`). */
export const DialogsToken = token('router/dialogs').multi<AnyDialog>();
/** Stage plugins contributed by auth, gate, loader, urlstate wiring, … (`stagePluginUnit`). */
export const StagePluginsToken = token('router/stage-plugins').multi<StagePlugin>();
/** Custom stages (`defineStage`, `stageUnit`). */
export const CustomStagesToken = token('router/custom-stages').multi<CustomStage>();
/** Navigation hooks (e.g. urlstate `flush()` before navigating). */
export const NavigationHooksToken = token('router/navigation-hooks').multi<NavigationHooks>();
/** History strategy (per host mode, R18.9). Bind the same instance to urlstate's HistoryPortToken. */
export const HistoryAdapterToken = token('router/history').type<HistoryAdapter>();
/** Feature lifecycle port (default: `featureHostDriverUnit` over the runtime FeatureHost). Optional. */
export const RouteFeatureDriverToken = token('router/feature-driver').type<RouteFeatureDriver>();
/** Availability predicate for per-mode variants (R18.5). Optional; default: everything available. */
export const RouteProfileToken = token('router/profile').type<ProfilePredicate>();
/** Routable dialog surfaces (implemented by @staticflux/messaging). Optional. */
export const DialogSurfacePortToken = token('router/dialog-surface').type<DialogSurfacePort>();
