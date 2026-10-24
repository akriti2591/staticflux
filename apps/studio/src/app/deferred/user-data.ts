/**
 * Deferred chunk: user data (typed slices, offline-first persistence, remote sync, logout
 * policy) and its backends over the storage registry. Loaded on first use (settings slices),
 * or by the identity listener to wipe on logout (adapters/auth-data.ts).
 */
import { type Registration, unit } from '@staticflux/core';
import { SessionToken } from '@staticflux/auth';
import { remoteSyncFromStore, sliceBackendFromStore, UserDataConfigToken, userDataUnit } from '@staticflux/data';
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

export const userDataUnits: readonly Registration[] = [userDataConfigUnit, userDataUnit];
