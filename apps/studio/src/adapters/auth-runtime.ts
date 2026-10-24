/**
 * Adapter: @staticflux/auth ⇄ @staticflux/runtime.
 *
 * - Session changes that invalidate cached data (identity change, revocation, login,
 *   or a token rotation that changed the advisory claims) bump the app epoch via
 *   `supervisor.refresh()` (R4.3, R6.5). Auth never imports runtime.
 * - The session scope (R2.7): one `session`-level child injector per principal;
 *   logout / account switch disposes it with every session-scoped unit.
 */
import { contribution, type Registration, token, unit } from '@staticflux/core';
import { createSessionScope, type SessionChange, type SessionScopeHost, SessionListenersToken, SessionToken } from '@staticflux/auth';
import { AppInjectorToken, SupervisorToken } from '@staticflux/runtime';

function claimsKey(change: SessionChange['to']): string {
  return change.principal === undefined ? '' : JSON.stringify(change.principal.claims ?? {});
}

export const epochRefreshListenerUnit = contribution({
  id: 'studio/epoch-refresh-listener-unit',
  provides: SessionListenersToken,
  scope: 'app',
  deps: { lazy: { supervisor: SupervisorToken } },
  create: ({ supervisor }) => ({
    id: 'studio/epoch-refresh',
    onSessionChange(change: SessionChange) {
      const settled = change.to.state === 'authenticated' || change.to.state === 'guest' || change.to.state === 'revoked';
      if (!settled) return;
      // Token rotation with new claims (e.g. plan upgrade): same principal, stale data.
      const claimsChanged = change.to.state === 'authenticated' && change.from.principal !== undefined && claimsKey(change.from) !== claimsKey(change.to);
      if (!change.requiresEpochRefresh && !claimsChanged) return;
      const value = supervisor.value;
      if (value?.can('refresh') === true) void value.refresh();
    },
  }),
  description: 'Session change → app-wide refresh (epoch).',
});

export const SessionScopeToken = token('studio/session-scope').type<SessionScopeHost>();

export function sessionScopeUnit(units: readonly Registration[]) {
  return unit({
    id: 'studio/session-scope-unit',
    provides: SessionScopeToken,
    scope: 'app',
    deps: { required: { session: SessionToken, injector: AppInjectorToken } },
    create: ({ session, injector }, ctx) => {
      const host = createSessionScope({ injector, session, units });
      ctx.scope.defer(() => host.dispose());
      return host;
    },
    description: 'Per-principal session injector (disposed on logout / account switch).',
  });
}
