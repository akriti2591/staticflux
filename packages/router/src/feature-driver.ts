/**
 * The router's port to the feature lifecycle (runtime feature host). The built-in `load`
 * stage activates the selected features (loads code + logic — only after auth/authorize, R7.8),
 * `render` mounts them and releases (unmounts/hides) features of left routes. Logic stays warm;
 * the resource manager owns demotion. Tests fake this port; apps use `featureHostDriver(host)`.
 *
 * Also the availability predicate: `ProfilePredicate` decides whether a candidate feature
 * serves the current app profile (host mode × form factor, R18.4/R18.5). The platform package
 * (or the app) binds it; the router never reads platform facts itself.
 */
import { ok, type Result } from '@staticflux/core';
import type { ActivationKind, FeatureHost, FeatureId, FeatureModeId, FeatureRef } from '@staticflux/runtime';
import type { AnyRoute } from './routes.js';

export interface MountRequest {
  readonly route: AnyRoute;
  readonly signal: AbortSignal;
}

export interface RouteFeatureDriver {
  has(id: FeatureId): boolean;
  /** Modes declared by the feature manifest (undefined = all modes). */
  modesOf(id: FeatureId): readonly FeatureModeId[] | undefined;
  /** Load (if needed) and activate the feature logic. Reports how it started (journey classification, R17.8). */
  activate(id: FeatureId, signal: AbortSignal): Promise<Result<ActivationKind>>;
  /** Mount (or un-hide) the feature UI. Idempotent. */
  mount(id: FeatureId, request: MountRequest): Promise<Result<void>>;
  /** Leave the feature: unmount (logic warm) or hide (DOM kept, effects stopped). */
  release(id: FeatureId, how: 'unmount' | 'hide'): Promise<Result<void>>;
  isMounted(id: FeatureId): boolean;
  /** Called when a feature leaves `mounted|hidden` for any reason (e.g. failure); returns unsubscribe. */
  onReleased?(listener: (id: FeatureId) => void): () => void;
}

/** Availability predicate (R18.5). `modes` = candidate modes, or the manifest's. */
export type ProfilePredicate = (modes: readonly FeatureModeId[] | undefined, feature: FeatureRef) => boolean;

/** Default predicate: every feature is available (single-mode apps, tests). */
export const allModesAvailable: ProfilePredicate = () => true;

/**
 * Predicate from the profile's active modes (e.g. `() => [profile.hostMode, profile.formFactor]`):
 * a feature is available when it declares no modes or shares one with the profile.
 */
export function modesPredicate(activeModes: () => readonly FeatureModeId[]): ProfilePredicate {
  return (modes) => {
    if (modes === undefined || modes.length === 0) return true;
    const active = activeModes();
    return modes.some((m) => active.includes(m));
  };
}

export interface FeatureHostDriverOptions {
  /** The UI target passed to `host.mount()` (outlet element / slot) for a route's feature. */
  readonly targetFor?: (route: AnyRoute, feature: FeatureId) => unknown;
}

/** Adapter from the runtime `FeatureHost` to the router port. */
export function featureHostDriver(host: FeatureHost, options: FeatureHostDriverOptions = {}): RouteFeatureDriver {
  return {
    has: (id) => host.has(id),
    modesOf: (id) => host.handle(id)?.manifest.modes,
    async activate(id, signal) {
      const before = host.stateOf(id);
      const kind: ActivationKind =
        before === 'archived' ? 'archived' : before === 'activated' || before === 'mounted' || before === 'hidden' ? 'warm' : 'fresh';
      const result = await host.activate(id, signal);
      return result.ok ? ok(kind) : result;
    },
    async mount(id, request) {
      const state = host.stateOf(id);
      if (state === 'mounted') return ok();
      if (state === 'hidden') return host.show(id);
      return host.mount(id, { target: options.targetFor?.(request.route, id), signal: request.signal });
    },
    async release(id, how) {
      const state = host.stateOf(id);
      if (state !== 'mounted' && state !== 'hidden') return ok();
      if (how === 'hide') return state === 'hidden' ? ok() : host.hide(id);
      return host.unmount(id);
    },
    isMounted(id) {
      const state = host.stateOf(id);
      return state === 'mounted' || state === 'hidden';
    },
    onReleased(listener) {
      return host.onTransition((t) => {
        const wasUi = t.from === 'mounted' || t.from === 'hidden' || t.from === 'mounting';
        const isUi = t.to === 'mounted' || t.to === 'hidden';
        if (wasUi && !isUi) listener(t.id);
      });
    },
  };
}
