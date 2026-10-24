/** DI tokens of @staticflux/messaging (no implementation imports). */
import { token } from '@staticflux/core';
import type { SurfaceManager } from './manager.js';
import type { KeyValuePort } from './ports.js';
import type { RoutableDialogBridge } from './routable.js';
import type { AnySurfaceDef } from './surface.js';

export const SurfaceManagerToken = /* @__PURE__ */ token('messaging/surface-manager').type<SurfaceManager>();
export const RoutableDialogBridgeToken = /* @__PURE__ */ token('messaging/routable-dialogs').type<RoutableDialogBridge>();
/** Multi: routable dialog surfaces (registered with the bridge). */
export const RoutableSurfacesToken = /* @__PURE__ */ token('messaging/routable-surfaces').multi<AnySurfaceDef>();
/** Coach-mark seen-once persistence (async KV). */
export const SeenStoreToken = /* @__PURE__ */ token('messaging/seen-store').type<KeyValuePort<boolean>>();
