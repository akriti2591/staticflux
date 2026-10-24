/**
 * Session lifecycle (docs/LIFECYCLES.md §9):
 *
 *   guest → authenticating → authenticated ⇄ refreshing
 *   authenticated|refreshing → expired | revoked → guest | authenticating
 *   authenticated(embedded) — host-bridged flavour (same states, `embedded: true`)
 */
import { defineMachine } from '@staticflux/core';

export const sessionMachine = defineMachine({
  id: 'auth/session',
  initial: 'guest',
  states: ['guest', 'authenticating', 'authenticated', 'refreshing', 'expired', 'revoked'],
  transitions: {
    guest: { restore: 'authenticating', login: 'authenticating' },
    authenticating: { succeed: 'authenticated', fail: 'guest', logout: 'guest' },
    authenticated: { refresh: 'refreshing', expire: 'expired', revoke: 'revoked', logout: 'guest' },
    refreshing: { refreshed: 'authenticated', expire: 'expired', revoke: 'revoked', logout: 'guest' },
    expired: { login: 'authenticating', restore: 'authenticating', logout: 'guest' },
    revoked: { login: 'authenticating', logout: 'guest' },
  },
});

export type SessionEvent = 'restore' | 'login' | 'succeed' | 'fail' | 'refresh' | 'refreshed' | 'expire' | 'revoke' | 'logout';
