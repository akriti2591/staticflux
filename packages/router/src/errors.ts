/**
 * Error catalog of @staticflux/router. Codes are stable (`SF-NAV-NNN`); agents look them
 * up instead of guessing (docs/LIFECYCLES.md §7, §13).
 */
import { defineError } from '@staticflux/core';

export const RouteNotFoundError = defineError(
  'SF-NAV-001',
  'not-found',
  'No route matches the requested location.',
  'Register a route for this path (RoutesToken contribution), or pass `notFound` to the router config.',
);

export const NavigationBlockedError = defineError(
  'SF-NAV-002',
  'forbidden',
  'A stage plugin or route guard blocked the navigation.',
  'Inspect `details.stage` / `details.step`; guards should pass a specific SfError to `block(error)`.',
);

export const RedirectLoopError = defineError(
  'SF-NAV-003',
  'invariant',
  'Too many redirects in one navigation.',
  'Two guards redirect to each other. Make one of them `continue` for the other route, or raise `maxRedirects` with a reason.',
);

export const StageFailedError = defineError(
  'SF-NAV-004',
  'unknown',
  'A stage step threw or returned an error result.',
  'Inspect `cause`. Stage plugins return `block(error)` for expected denials; `err()` and throws mean "failed".',
);

export const FeatureUnavailableError = defineError(
  'SF-NAV-005',
  'unavailable',
  'No candidate feature of the route capability is available for the current app profile.',
  'Add a feature variant for this mode to the route `feature` selector (R18.5/R18.7), or gate the route for this profile.',
);

export const TransientRouteError = defineError(
  'SF-NAV-006',
  'invariant',
  'A transient route finished its transient stage without redirecting.',
  'Transient routes never commit: give the route a `redirect`, or contribute a `transient` stage plugin that redirects.',
);

export const RouteDefinitionError = defineError(
  'SF-NAV-007',
  'invariant',
  'The route/dialog/stage definitions are invalid (duplicate id or path, unregistered parent, bad key or position).',
  'Read `details`; ids and full paths are unique, parents must be registered, dialog keys are `[a-z0-9-]+`.',
);

export const DialogRouteError = defineError(
  'SF-NAV-008',
  'validation',
  'The dialog cannot be opened here: unknown key, or its owner route is not part of the current route.',
  'Feature-level dialogs open only below their `owner` route (R7.16); app-level dialogs have no owner.',
);

export const NoDialogSurfaceError = defineError(
  'SF-NAV-009',
  'unavailable',
  'A routable dialog was requested but no DialogSurfacePort is bound.',
  'Register the messaging package (it binds DialogSurfacePortToken), or bind your own port.',
);

export const FeatureDriveError = defineError(
  'SF-NAV-010',
  'unavailable',
  'Activating or mounting the route feature failed.',
  'Inspect `cause` (runtime SF-FT-* error); the feature host owns the feature lifecycle.',
);

export const MissingParamError = defineError(
  'SF-NAV-011',
  'validation',
  'A path parameter required by the route pattern is missing or empty.',
  'Pass every `:param` of the route path in `params` (the types require them; this is a runtime guard for untyped callers).',
);

export const RouterDisposedError = defineError(
  'SF-NAV-012',
  'aborted',
  'The router was disposed.',
  'Expected during app shutdown or reinitialize. Do not keep router references beyond the app scope.',
);

export const UnknownStageError = defineError(
  'SF-NAV-013',
  'invariant',
  'A stage plugin attaches to a custom stage that is not registered.',
  'Contribute the stage (CustomStagesToken / `stages` option) created by `defineStage`, or attach the plugin to a built-in stage.',
);
