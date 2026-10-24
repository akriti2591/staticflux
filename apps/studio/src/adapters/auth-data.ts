/**
 * Adapter: @staticflux/auth → @staticflux/data user-data (R9.8–R9.12).
 *
 * - The user-data identity follows the session (guest → user, account switch).
 * - Logout flushes, wipes user/workspace/session slices and continues as guest.
 * - Slices persist through the storage registry (`user` scope; IndexedDB in browsers),
 *   remote sync through a second registry store standing in for the backend — wired in the
 *   deferred user-data chunk (`app/deferred/user-data.ts`), loaded on first use (settings).
 * - A logout before user data ever loaded still wipes: the chunk loads, adopts the departing
 *   identity and runs the logout policy.
 */
import { contribution } from '@staticflux/core';
import { SessionListenersToken, type SessionChange } from '@staticflux/auth';
import { type UserData, UserDataToken } from '@staticflux/data';

export const userDataIdentityListenerUnit = contribution({
  id: 'studio/user-data-identity-unit',
  provides: SessionListenersToken,
  scope: 'app',
  // on-demand: never loads the user-data chunk by itself (except to wipe on logout, below).
  deps: { lazy: { userData: { token: UserDataToken, init: 'on-demand' } } },
  create: ({ userData }) => ({
    id: 'studio/user-data-identity',
    onSessionChange(change: SessionChange) {
      if (!change.principalChanged) return;
      const apply = (data: UserData): void => {
        if (change.to.state === 'guest') void data.logout();
        else if (change.to.principal !== undefined) void data.setIdentity({ userId: change.to.principal.id, deviceId: change.to.guestId });
      };
      const data = userData.value;
      if (data !== undefined) return apply(data);
      // Not loaded: a sign-in needs nothing (the chunk reads the session when it loads); a
      // sign-out loads it to wipe the departing user's local slices (logout policy).
      if (change.to.state !== 'guest' || change.from.principal === undefined) return;
      const departing = { userId: change.from.principal.id, deviceId: change.from.guestId };
      void userData.whenReady().then(async (ready) => {
        if (!ready.ok) return;
        await ready.value.setIdentity(departing);
        await ready.value.logout();
      });
    },
  }),
  description: 'User-data identity follows the session; logout wipes per policy.',
});
