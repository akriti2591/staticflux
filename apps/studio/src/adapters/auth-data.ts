/**
 * Adapter: @staticflux/auth → @staticflux/data user-data (R9.8–R9.12).
 *
 * - The user-data identity follows the session (guest → user, account switch).
 * - Logout flushes, wipes user/workspace/session slices and continues as guest.
 * - Slices persist through the storage registry (`user` scope; IndexedDB in browsers),
 *   remote sync through a second registry store standing in for the backend.
 */
import { contribution, unit } from '@staticflux/core';
import { SessionListenersToken, SessionToken, type SessionChange } from '@staticflux/auth';
import { remoteSyncFromStore, sliceBackendFromStore, UserDataConfigToken, UserDataToken } from '@staticflux/data';
import { StoreRegistryToken } from '@staticflux/storage';

export const userDataConfigUnit = unit({
  id: 'studio/user-data-config-unit',
  provides: UserDataConfigToken,
  scope: 'app',
  deps: { required: { registry: StoreRegistryToken, session: SessionToken } },
  create: ({ registry, session }) => ({
    identity: { userId: session.principal?.id, deviceId: session.guestId },
    local: sliceBackendFromStore(registry.open('user', 'studio/user-data'), { id: 'studio/user-data' }),
    remote: remoteSyncFromStore(registry.open('device', 'studio/user-data-remote')),
    writeDelayMs: 50,
  }),
  description: 'User-data backends (storage registry) and the initial identity.',
});

export const userDataIdentityListenerUnit = contribution({
  id: 'studio/user-data-identity-unit',
  provides: SessionListenersToken,
  scope: 'app',
  deps: { lazy: { userData: UserDataToken } },
  create: ({ userData }) => ({
    id: 'studio/user-data-identity',
    onSessionChange(change: SessionChange) {
      const data = userData.value;
      if (data === undefined || !change.principalChanged) return;
      if (change.to.state === 'guest') void data.logout();
      else if (change.to.principal !== undefined) void data.setIdentity({ userId: change.to.principal.id, deviceId: change.to.guestId });
    },
  }),
  description: 'User-data identity follows the session; logout wipes per policy.',
});
