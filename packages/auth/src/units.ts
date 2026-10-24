/**
 * DI tokens and units for @staticflux/auth. Apps register a provider unit (variant
 * bindings choose per mode: `bff-cookie` on web, `embed-host` in ChatGPT, `guest`
 * for demos), an environment unit and a transport unit; `sessionUnit` does the rest.
 *
 *   createInjector({ units: [browserAuthEnvironmentUnit, fetchAuthTransportUnit,
 *     bffCookieProviderUnit({ endpoints }), sessionUnit] })
 */
import { ok, token, unit } from '@staticflux/core';
import type { GuestUpgradeHook, IdentityProvider, SessionListener } from './contract.js';
import { type AuthEnvironment, browserAuthEnvironment } from './environment.js';
import { guestProvider } from './guest.js';
import { type BffCookieOptions, bffCookieProvider } from './providers/bff-cookie.js';
import { type AuthHostBridge, embedHostProvider } from './providers/embed-host.js';
import { type OidcPkceOptions, oidcPkceProvider } from './providers/oidc-pkce.js';
import { type PasskeyOptions, browserWebAuthn, passkeyProvider } from './providers/passkey.js';
import { type AuthorizedTransport, createAuthorizedTransport } from './broker.js';
import { AuthMetrics, type SessionStore, type SessionStoreOptions, createSessionStore } from './session.js';
import { type AuthTransport, fetchTransport } from './transport.js';

export const AuthEnvironmentToken = /* @__PURE__ */ token('auth/environment').type<AuthEnvironment>();
export const AuthTransportToken = /* @__PURE__ */ token('auth/transport').type<AuthTransport>();
export const IdentityProviderToken = /* @__PURE__ */ token('auth/identity-provider').type<IdentityProvider>();
/** Multi: things reacting to session changes (the runtime contributes one that calls `refresh('epoch')`). */
export const SessionListenersToken = /* @__PURE__ */ token('auth/session-listeners').multi<SessionListener>();
/** Multi: guest → user handoff hooks (R6.4), e.g. from @staticflux/handoff. */
export const GuestUpgradeHooksToken = /* @__PURE__ */ token('auth/guest-upgrade-hooks').multi<GuestUpgradeHook>();
export const SessionToken = /* @__PURE__ */ token('auth/session').type<SessionStore>();
export const AuthorizedTransportToken = /* @__PURE__ */ token('auth/authorized-transport').type<AuthorizedTransport>();
/** Host bridge port (provided by the platform host-bridge plugin in embedded modes). */
export const AuthHostBridgeToken = /* @__PURE__ */ token('auth/host-bridge').type<AuthHostBridge>();

export const browserAuthEnvironmentUnit = unit({
  id: 'auth/browser-environment-unit',
  provides: AuthEnvironmentToken,
  scope: 'app',
  create: () => browserAuthEnvironment(),
  description: 'Feature-detected browser environment (storage, BroadcastChannel, WebCrypto, Web Locks).',
});

export const fetchAuthTransportUnit = unit({
  id: 'auth/fetch-transport-unit',
  provides: AuthTransportToken,
  scope: 'app',
  create: () => fetchTransport(),
});

export const guestProviderUnit = unit({
  id: 'auth/guest-provider-unit',
  provides: IdentityProviderToken,
  scope: 'app',
  create: () => guestProvider(),
});

export function bffCookieProviderUnit(config: Omit<BffCookieOptions, 'transport'>) {
  return unit({
    id: 'auth/bff-cookie-provider-unit',
    provides: IdentityProviderToken,
    scope: 'app',
    deps: { required: { transport: AuthTransportToken } },
    create: ({ transport }) => bffCookieProvider({ ...config, transport }),
  });
}

export function oidcPkceProviderUnit(config: Omit<OidcPkceOptions, 'transport' | 'env'>) {
  return unit({
    id: 'auth/oidc-pkce-provider-unit',
    provides: IdentityProviderToken,
    scope: 'app',
    deps: { required: { transport: AuthTransportToken, env: AuthEnvironmentToken } },
    create: ({ transport, env }) => oidcPkceProvider({ ...config, transport, env }),
  });
}

export function passkeyProviderUnit(config: Omit<PasskeyOptions, 'transport' | 'webauthn'> & Partial<Pick<PasskeyOptions, 'webauthn'>>) {
  return unit({
    id: 'auth/passkey-provider-unit',
    provides: IdentityProviderToken,
    scope: 'app',
    deps: { required: { transport: AuthTransportToken } },
    create: ({ transport }) => passkeyProvider({ ...config, transport, webauthn: config.webauthn ?? browserWebAuthn() }),
  });
}

export const embedHostProviderUnit = unit({
  id: 'auth/embed-host-provider-unit',
  provides: IdentityProviderToken,
  scope: 'app',
  deps: { required: { bridge: AuthHostBridgeToken } },
  create: ({ bridge }) => embedHostProvider(bridge),
});

export type SessionUnitConfig = Pick<SessionStoreOptions, 'channelName' | 'refreshLeewayMs' | 'exposeRawToken'>;

/** The session store unit (scope app). `init` starts the silent probe but never waits for it (R6.3). */
/* @__NO_SIDE_EFFECTS__ */
export function createSessionUnit(config: SessionUnitConfig = {}) {
  return unit({
    id: 'auth/session-unit',
    provides: SessionToken,
    scope: 'app',
    deps: {
      required: {
        provider: IdentityProviderToken,
        env: AuthEnvironmentToken,
        listeners: SessionListenersToken,
        upgradeHooks: GuestUpgradeHooksToken,
      },
    },
    informs: Object.values(AuthMetrics),
    create: ({ provider, env, listeners, upgradeHooks }, ctx) => {
      const store = createSessionStore({ ...config, provider, env, listeners, upgradeHooks, telemetry: ctx.telemetry });
      ctx.scope.defer(() => store.dispose());
      return store;
    },
    init: (store, ctx) => {
      void store.start(ctx.signal);
      return ok();
    },
    description: 'Reactive session model over the bound IdentityProvider; multi-tab sync; single-flight refresh; token broker.',
  });
}

export const sessionUnit = createSessionUnit();

export const authorizedTransportUnit = unit({
  id: 'auth/authorized-transport-unit',
  provides: AuthorizedTransportToken,
  scope: 'app',
  deps: { required: { session: SessionToken, transport: AuthTransportToken } },
  create: ({ session, transport }) => createAuthorizedTransport(session, transport),
});
