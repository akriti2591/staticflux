/**
 * Adapter: @staticflux/storage registry → shell/messaging preference ports.
 * Workspace preferences and coach-mark "seen" flags persist in user-scoped stores
 * (IndexedDB in browsers, memory fallback reported by the registry); the appearance
 * preference lives in `storage-ui.ts`. The registry's `AsyncStore` satisfies the async
 * `KeyValuePort` structurally (R9.0a).
 */
import { unit } from '@staticflux/core';
import { type KeyValuePort, SeenStoreToken } from '@staticflux/messaging';
import { WorkspacePreferenceStoreToken } from '@staticflux/shell';
import { StoreRegistryToken } from '@staticflux/storage';

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
