/**
 * Adapter: @staticflux/storage registry → @staticflux/ui appearance preference port.
 * The appearance (color scheme, contrast, density, motion) is remembered per device
 * (UX §3: "density remembered per device"); the registry's `AsyncStore` satisfies the
 * async `AppearanceStore` structurally (R9.0a).
 */
import { unit } from '@staticflux/core';
import { StoreRegistryToken } from '@staticflux/storage';
import { type AppearanceStore, AppearanceStoreToken } from '@staticflux/ui/theme';

export const appearanceStoreUnit = unit({
  id: 'studio/appearance-store-unit',
  provides: AppearanceStoreToken,
  scope: 'app',
  deps: { required: { registry: StoreRegistryToken } },
  create: ({ registry }): AppearanceStore => registry.open<string>('device', 'ui/appearance'),
});
