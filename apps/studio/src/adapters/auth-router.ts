/**
 * Adapter: @staticflux/auth → @staticflux/router `auth-boundary` stage (R6.3, R7.8).
 *
 * Routes declaring `requires.auth = 'required'` wait for the session to settle (boot
 * never waits on auth; only this navigation does), then redirect guests to the login
 * route with the deep-link intent as `returnTo`. What survives the full-page BFF
 * redirect (URL intents, guest draft) is prepared through the `LoginReturnPort`
 * (urlstate + handoff wiring), so this file stays auth ⇄ router only.
 */
import { contribution, token } from '@staticflux/core';
import { SessionToken } from '@staticflux/auth';
import { proceed, redirect, stagePlugin, StagePluginsToken } from '@staticflux/router';
import { LoginRoute } from '../app/routes.js';

/** Persists what must survive the login redirect; returns the `returnTo` path. */
export interface LoginReturnPort {
  prepare(href: string, signal: AbortSignal): Promise<string>;
}
export const LoginReturnPortToken = /* @__PURE__ */ token('studio/login-return-port').type<LoginReturnPort>();

export const authBoundaryPluginUnit = contribution({
  id: 'studio/auth-boundary-plugin-unit',
  provides: StagePluginsToken,
  scope: 'app',
  deps: { required: { session: SessionToken, returns: LoginReturnPortToken } },
  create: ({ session, returns }) =>
    stagePlugin({
      id: 'studio/auth-boundary',
      stage: 'auth-boundary',
      pipelines: ['full', 'dialog'],
      applies: (context) => context.requires.auth === 'required',
      run: async (context, signal) => {
        const snapshot = await session.whenSettled(signal);
        if (snapshot.state === 'authenticated' || snapshot.state === 'refreshing') return proceed();
        const returnTo = await returns.prepare(context.intent.href, signal);
        return redirect({ to: LoginRoute, search: { returnTo } }, { reason: 'login-required', state: { returnTo } });
      },
      description: 'Guests are redirected to /login with the deep-link intent preserved.',
    }),
});
