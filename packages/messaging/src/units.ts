/**
 * DI units of @staticflux/messaging (tokens: `tokens.ts`, so boot code can name them while the
 * surface stack loads later).
 *
 * Apps register `messagingUnits` (with `uiUnits`), contribute routable dialogs via
 * `routableSurface(def)`, and bind `SeenStoreToken` to a per-user store
 * (an `@staticflux/storage` AsyncStore fits structurally).
 */
import { contribution, unit } from '@staticflux/core';
import { DecideToken, VisibilityObserverToken } from '@staticflux/ui';
import { createSurfaceManager, strictSurfacePolicy } from './manager.js';
import { createMemoryKeyValue } from './ports.js';
import { createRoutableDialogBridge } from './routable.js';
import type { AnySurfaceDef } from './surface.js';
import { RoutableDialogBridgeToken, RoutableSurfacesToken, SeenStoreToken, SurfaceManagerToken } from './tokens.js';

export const memorySeenStoreUnit = unit({
  id: 'messaging/memory-seen-store-unit',
  provides: SeenStoreToken,
  scope: 'app',
  create: () => createMemoryKeyValue<boolean>(),
  description: 'In-memory seen-once store. Bind a per-user (remote + local cache) store in apps.',
});

export const surfaceManagerUnit = unit({
  id: 'messaging/surface-manager-unit',
  provides: SurfaceManagerToken,
  scope: 'app',
  deps: { required: { decide: DecideToken, seen: SeenStoreToken, visibility: VisibilityObserverToken } },
  create: ({ decide, seen, visibility }, ctx) => {
    const reducedMotion = (): boolean =>
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const manager = createSurfaceManager({ telemetry: ctx.telemetry, decide, seen, visibility, reducedMotion });
    ctx.scope.defer(() => manager.dispose());
    return manager;
  },
  description: 'The single surface manager: arbitration, scope-bound lifetimes, gating, metrics.',
});

/**
 * The surface manager under `strictSurfacePolicy` (OVERLAYS-FEEDBACK §1): one modal at a time (a second is refused,
 * SF-MSG-008; a blocking error replaces with `replace: true`), one popover at a time, Escape reaches the newest toast.
 * Register this instead of `surfaceManagerUnit`; both provide `SurfaceManagerToken`.
 */
export const strictSurfaceManagerUnit = unit({
  id: 'messaging/strict-surface-manager-unit',
  provides: SurfaceManagerToken,
  scope: 'app',
  deps: { required: { decide: DecideToken, seen: SeenStoreToken, visibility: VisibilityObserverToken } },
  create: ({ decide, seen, visibility }, ctx) => {
    const reducedMotion = (): boolean =>
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const manager = createSurfaceManager({ telemetry: ctx.telemetry, decide, seen, visibility, reducedMotion, policy: strictSurfacePolicy });
    ctx.scope.defer(() => manager.dispose());
    return manager;
  },
  description: 'The surface manager under the strict overlay policy (one modal, one popover, Escape reaches toasts).',
});

export const routableDialogBridgeUnit = unit({
  id: 'messaging/routable-dialog-bridge-unit',
  provides: RoutableDialogBridgeToken,
  scope: 'app',
  deps: { required: { manager: SurfaceManagerToken, surfaces: RoutableSurfacesToken, decide: DecideToken } },
  create: ({ manager, surfaces, decide }, ctx) =>
    createRoutableDialogBridge({ manager, surfaces, decide, telemetry: ctx.telemetry, owner: { scope: ctx.scope } }),
  description: 'Port the router calls to open/close routable dialogs; emits back/replace dismiss intents.',
});

let routableCounter = 0;

/** Contribute a routable dialog surface to the bridge. */
export function routableSurface(def: AnySurfaceDef) {
  routableCounter += 1;
  return contribution({
    id: `messaging/routable-${def.routable?.key ?? `surface-${routableCounter}`}`,
    provides: RoutableSurfacesToken,
    scope: 'app',
    create: () => def,
  });
}

export const messagingUnits = [memorySeenStoreUnit, surfaceManagerUnit, routableDialogBridgeUnit] as const;

/** `messagingUnits` with the strict overlay policy (Instaflow, OVERLAYS-FEEDBACK §1). */
export const strictMessagingUnits = [memorySeenStoreUnit, strictSurfaceManagerUnit, routableDialogBridgeUnit] as const;
