/**
 * Deferred unit groups (R12.12 "everything lazy by default"): placeholders from core
 * `deferredUnits` for verticals the first frame does not need. Each group's code is its own
 * chunk (`./deferred/*.ts`); the first resolution of one of its tokens — a required dep, an
 * `injector.get`, a lazy/functional handle — imports the chunk, registers its units and
 * resolves the real provider. Consumers do not know the difference.
 *
 * | group | loads when |
 * |---|---|
 * | `studio/surfaces` | first surface request (dialog route, toast, banner, palette); post-boot idle |
 * | `studio/keyboard` | `<sf-shell>` asks for the command shortcuts when idle |
 * | `studio/capabilities` | an editor / the assistant / a test invokes a capability |
 * | `studio/resources` | the resource manager is first resolved |
 * | `studio/handoff` | intents held for / restored after the login redirect, a guest draft carried |
 * | `studio/user-data` | first slice use (settings), or a logout that must wipe local slices |
 * | `studio/resource-cache` | per session injector: first `ResourcesToken` resolution (docs list) |
 *
 * Tokens named here must come from token-only modules (`tokens.ts` of each package,
 * `contracts.ts`), so naming them never bundles their implementation.
 */
import { ShortcutRegistryToken } from '@staticflux/a11y';
import { CapabilityRegistryToken } from '@staticflux/capabilities';
import { deferredUnits, type Registration } from '@staticflux/core';
import { ResourcesToken, UserDataConfigToken, UserDataToken } from '@staticflux/data';
import { HandoffStoragesToken, HandoffStoreToken } from '@staticflux/handoff';
import { RoutableDialogBridgeToken, SurfaceManagerToken } from '@staticflux/messaging';
import { DialogSurfacePortToken } from '@staticflux/router';
import { MemoryPressureToken, ResourceManagerToken } from '@staticflux/runtime';
import { CommandRegistryToken, CommandShortcutBindingsToken } from '@staticflux/shell';
import { CapabilityInvokerToken } from './contracts.js';

export const surfacesGroup = deferredUnits({
  id: 'studio/surfaces',
  provides: [SurfaceManagerToken, RoutableDialogBridgeToken, DialogSurfacePortToken],
  load: async () => {
    const chunk = await import('./deferred/surfaces.js');
    chunk.defineSurfaceElements();
    return chunk.surfaceUnits;
  },
  description: 'Messaging surfaces: manager, routable dialogs, <sf-surface-host>.',
});

export const keyboardGroup = deferredUnits({
  id: 'studio/keyboard',
  provides: [CommandShortcutBindingsToken, CommandRegistryToken, ShortcutRegistryToken],
  load: async () => (await import('./deferred/keyboard.js')).keyboardUnits,
  description: 'Shortcut registry, command registry, palette + command bindings.',
});

export const capabilitiesGroup = deferredUnits({
  id: 'studio/capabilities',
  provides: [CapabilityRegistryToken, CapabilityInvokerToken],
  load: async () => (await import('./deferred/capabilities.js')).capabilityUnits,
  description: 'Capability pipeline: registry, ports, implementations, upsell invoker.',
});

export const resourcesGroup = deferredUnits({
  id: 'studio/resources',
  provides: [ResourceManagerToken, MemoryPressureToken],
  load: async () => (await import('./deferred/resources.js')).resourceUnits,
  description: 'Runtime resource manager + memory pressure.',
});

export const userDataGroup = deferredUnits({
  id: 'studio/user-data',
  provides: [UserDataToken, UserDataConfigToken],
  load: async () => (await import('./deferred/user-data.js')).userDataUnits,
  description: 'User-data slices + storage-registry backends.',
});

export const handoffGroup = deferredUnits({
  id: 'studio/handoff',
  provides: [HandoffStoreToken, HandoffStoragesToken],
  load: async () => (await import('./deferred/handoff.js')).handoffUnits,
  description: 'Handoff store (login-redirect carry) + storages.',
});

/** Registered in each session injector (adapters/auth-runtime `sessionScopeUnit`). */
export const resourceCacheGroup = deferredUnits({
  id: 'studio/resource-cache',
  scope: 'session',
  provides: [ResourcesToken],
  load: async () => (await import('./deferred/resource-cache.js')).resourceCacheUnits,
  description: 'Session-scoped resource cache.',
});

export const deferredStudioUnits: readonly Registration[] = [...surfacesGroup, ...keyboardGroup, ...capabilitiesGroup, ...resourcesGroup, ...userDataGroup, ...handoffGroup];
