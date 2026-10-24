/**
 * Adapter: @staticflux/storage registry → shell/messaging preference ports.
 * Theme + workspace preferences and coach-mark "seen" flags persist in device-scoped
 * stores (IndexedDB in browsers, memory fallback reported by the registry). The
 * registry's `AsyncStore` satisfies the async `KeyValuePort` structurally (R9.0a).
 */
import { unit } from '@staticflux/core';
import { type KeyValuePort, SeenStoreToken } from '@staticflux/messaging';
import { ThemePreferenceStoreToken, WorkspacePreferenceStoreToken } from '@staticflux/shell';
import { StoreRegistryToken } from '@staticflux/storage';

export const themePreferenceStoreUnit = unit({
  id: 'studio/theme-preference-store-unit',
  provides: ThemePreferenceStoreToken,
  scope: 'app',
  deps: { required: { registry: StoreRegistryToken } },
  create: ({ registry }): KeyValuePort<string> => registry.open<string>('device', 'shell/theme'),
});

export const workspacePreferenceStoreUnit = unit({
  id: 'studio/workspace-preference-store-unit',
  provides: WorkspacePreferenceStoreToken,
  scope: 'app',
  deps: { required: { registry: StoreRegistryToken } },
  create: ({ registry }): KeyValuePort<string> => registry.open<string>('user', 'shell/workspace'),
});

export const seenStoreUnit = unit({
  id: 'studio/seen-store-unit',
  provides: SeenStoreToken,
  scope: 'app',
  deps: { required: { registry: StoreRegistryToken } },
  create: ({ registry }): KeyValuePort<boolean> => registry.open<boolean>('user', 'messaging/seen'),
});
