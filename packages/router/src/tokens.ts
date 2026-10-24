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

export const RouterToken = /* @__PURE__ */ token('router/router').type<Router>();
/** Routes contributed by apps/feature packages (one contribution per route: `routeUnit`). */
export const RoutesToken = /* @__PURE__ */ token('router/routes').multi<AnyRoute>();
/** Routable dialogs (`dialogUnit`). */
export const DialogsToken = /* @__PURE__ */ token('router/dialogs').multi<AnyDialog>();
/** Stage plugins contributed by auth, gate, loader, urlstate wiring, … (`stagePluginUnit`). */
export const StagePluginsToken = /* @__PURE__ */ token('router/stage-plugins').multi<StagePlugin>();
/** Custom stages (`defineStage`, `stageUnit`). */
export const CustomStagesToken = /* @__PURE__ */ token('router/custom-stages').multi<CustomStage>();
/** Navigation hooks (e.g. urlstate `flush()` before navigating). */
export const NavigationHooksToken = /* @__PURE__ */ token('router/navigation-hooks').multi<NavigationHooks>();
/** History strategy (per host mode, R18.9). Bind the same instance to urlstate's HistoryPortToken. */
export const HistoryAdapterToken = /* @__PURE__ */ token('router/history').type<HistoryAdapter>();
/** Feature lifecycle port (default: `featureHostDriverUnit` over the runtime FeatureHost). Optional. */
export const RouteFeatureDriverToken = /* @__PURE__ */ token('router/feature-driver').type<RouteFeatureDriver>();
/** Availability predicate for per-mode variants (R18.5). Optional; default: everything available. */
export const RouteProfileToken = /* @__PURE__ */ token('router/profile').type<ProfilePredicate>();
/** Routable dialog surfaces (implemented by @staticflux/messaging). Optional. */
export const DialogSurfacePortToken = /* @__PURE__ */ token('router/dialog-surface').type<DialogSurfacePort>();
