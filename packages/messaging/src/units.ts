/**
 * DI tokens and units of @staticflux/messaging.
 *
 * Apps register `messagingUnits` (with `uiUnits`), contribute routable dialogs via
 * `routableSurface(def)`, and bind `SeenStoreToken` to a per-user store
 * (an `@staticflux/storage` AsyncStore fits structurally).
 */
import { contribution, token, unit } from '@staticflux/core';
import { DecideToken, VisibilityObserverToken } from '@staticflux/ui';
import { createSurfaceManager, type SurfaceManager } from './manager.js';
import { createMemoryKeyValue, type KeyValuePort } from './ports.js';
import { createRoutableDialogBridge, type RoutableDialogBridge } from './routable.js';
import type { AnySurfaceDef } from './surface.js';

export const SurfaceManagerToken = token('messaging/surface-manager').type<SurfaceManager>();
export const RoutableDialogBridgeToken = token('messaging/routable-dialogs').type<RoutableDialogBridge>();
/** Multi: routable dialog surfaces (registered with the bridge). */
export const RoutableSurfacesToken = token('messaging/routable-surfaces').multi<AnySurfaceDef>();
/** Coach-mark seen-once persistence (async KV). */
export const SeenStoreToken = token('messaging/seen-store').type<KeyValuePort<boolean>>();

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
