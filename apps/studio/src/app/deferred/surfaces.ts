/**
 * Deferred chunk: the messaging surface stack — surface manager, seen-once store, the
 * routable-dialog bridge + router port and the app's routable dialogs — and the kit's
 * `<sf-surface-layer>` visual layer (native <dialog>, Popover API; defined when the chunk
 * loads; the tag is in the UI root from the start). Loaded on the first request for a surface (dialog route, toast, banner,
 * command palette) and right after first paint (post-boot), never on the boot path.
 */
import { contribution, ok, type Registration } from '@staticflux/core';
import { defineSurfaces } from '@staticflux/kit/surfaces';
import { defineTextField } from '@staticflux/kit/text-field';
import { routableDialogBridgeUnit, RoutableSurfacesToken, surfaceManagerUnit } from '@staticflux/messaging';
import { FeatureHostToken } from '@staticflux/runtime';
import { routableDialogPortUnit } from '../../adapters/messaging-router.js';
import { seenStoreUnit } from '../../adapters/storage-shell.js';
import { Features } from '../contracts.js';
import { ShareDialog, upgradeDialog } from '../surfaces.js';

export const upgradeDialogUnit = contribution({
  id: 'studio/upgrade-dialog-surface-unit',
  provides: RoutableSurfacesToken,
  scope: 'app',
  deps: { required: { host: FeatureHostToken } },
  create: ({ host }) =>
    upgradeDialog(async (signal) => {
      // Lazy content: activating the billing feature loads its chunk (gated, I-8).
      const activated = await host.activate(Features.billing.id, signal);
      return activated.ok ? ok() : activated;
    }),
});

export const shareDialogUnit = contribution({
  id: 'studio/share-dialog-surface-unit',
  provides: RoutableSurfacesToken,
  scope: 'app',
  create: () => ShareDialog,
});

export const surfaceUnits: readonly Registration[] = [
  seenStoreUnit,
  surfaceManagerUnit,
  routableDialogBridgeUnit,
  upgradeDialogUnit,
  shareDialogUnit,
  routableDialogPortUnit,
];

/** Custom elements of the chunk (no-op without a custom element registry, e.g. headless hosts). */
export function defineSurfaceElements(): void {
  if (typeof customElements !== 'undefined') {
    defineSurfaces();
    defineTextField(); // share dialog body
  }
}
