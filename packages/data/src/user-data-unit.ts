/** The user-data unit (own module: apps may register it from a lazily loaded chunk). */
import { unit } from '@staticflux/core';
import { createUserData } from './user-data.js';
import { UserDataConfigToken, UserDataToken } from './tokens.js';

export const userDataUnit = unit({
  id: 'data/user-data-unit',
  provides: UserDataToken,
  scope: 'app',
  deps: { required: { config: UserDataConfigToken } },
  create: ({ config }, ctx) => {
    const userData = createUserData({ ...config, telemetry: ctx.telemetry });
    ctx.scope.defer(() => userData.dispose());
    return userData;
  },
  description: 'User-data document: typed slices, offline-first persistence, remote sync, logout policy.',
});
