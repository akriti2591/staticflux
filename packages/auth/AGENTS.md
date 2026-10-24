# @staticflux/auth — AGENTS.md

**Layer:** vertical (depends only on `@staticflux/core`). Must not import `@staticflux/gate`, `runtime` or any other vertical.
**Budget (proposed):** ≤ 4 KB brotli for the boot surface (`sessionUnit` + `bff-cookie` + environment/transport units); the other providers are separate imports and tree-shake away.

## Purpose
Identity providers, the session lifecycle, multi-tab sync, single-flight refresh and a
token broker (R6.1–R6.7, docs/LIFECYCLES.md §9). One session model for every provider.

> **Client-side auth state is UX, not security (R6.7, R6.16).** Decoded claims and
> session JSON are advisory. The backend validates and re-checks every request.

## Public API (by file)
- `contract.ts` — `IdentityProvider`, `Credentials` (no tokens), `ProviderGrant`, `SessionSnapshot` (discriminated union), `SessionChange` (typed event incl. `requiresEpochRefresh`), `SessionListener` port, `GuestUpgradeHook` port, `AccessGrant`.
- `machine.ts` — `sessionMachine`: `guest → authenticating → authenticated ⇄ refreshing → expired | revoked → guest | authenticating`.
- `session.ts` — `createSessionStore({ provider, env, listeners, upgradeHooks, … })` → reactive `snapshot/state/principal/isAuthenticated/embedded`, `start`, `whenSettled`, `login`, `completeLogin`, `refresh` (single-flight, optional Web Lock), `logout`, `reportUnauthorized`, `revoke`, `withAccessToken(task)`, `onChange`. `AuthMetrics`.
- `broker.ts` — `createAuthorizedTransport(session, transport)`: adds grant headers, 401 → one refresh + one retry.
- `session-scope.ts` — `createSessionScope({ injector, session, units })`: one `session`-level child injector per principal; logout/revocation/account switch disposes it (R2.7). `sessionScopeKey`.
- `transport.ts` — `AuthTransport` (minimal fetch-like port), `fetchTransport`, `requestJson`, `statusError`.
- `environment.ts` — `AuthEnvironment` port (clock, timers, WebCrypto, storage, BroadcastChannel, navigation, Web Locks); `browserAuthEnvironment()` (feature-detected), `memoryStorage`, `webStorage`, `broadcastChannelPort`, `createMemoryChannelHub`, `createTestAuthEnvironment`.
- `pkce.ts` — `createPkcePair`, `pkceChallenge` (S256, WebCrypto), base64url helpers, `decodeJwtPayload` (advisory).
- `guest.ts` — `stableGuestId`, `guestProvider`.
- `providers/bff-cookie.ts` — **recommended**: tokens stay in the BFF; client sees only the session endpoint + CSRF header.
- `providers/oidc-pkce.ts` — browser-only code + PKCE; tokens in memory only; verifier/state in sessionStorage for the redirect only; refresh-token rotation; RFC 7009 revocation.
- `providers/passkey.ts` — WebAuthn behind `isPasskeySupported`; `browserWebAuthn()` port (native JSON helpers or manual conversion); `register()`.
- `providers/embed-host.ts` — host bridge (`AuthHostBridge` port); embedded flavour; widget never holds tokens; grant scheme `host`.
- `providers/custom.ts` — `customProvider({...})` with safe defaults.
- `units.ts` — tokens `SessionToken`, `IdentityProviderToken`, `AuthEnvironmentToken`, `AuthTransportToken`, `AuthorizedTransportToken`, `AuthHostBridgeToken`, multi `SessionListenersToken`, `GuestUpgradeHooksToken`; units `sessionUnit` / `createSessionUnit(config)`, `browserAuthEnvironmentUnit`, `fetchAuthTransportUnit`, `authorizedTransportUnit`, provider units (`bffCookieProviderUnit(cfg)`, `oidcPkceProviderUnit(cfg)`, `passkeyProviderUnit(cfg)`, `embedHostProviderUnit`, `guestProviderUnit`).
- `errors.ts` — `SF-AUTH-001…017`.

## Rules
- Boot never waits on auth (R6.3): `sessionUnit.init` starts the silent probe and returns. Route guards await `session.whenSettled()`.
- Raw tokens never leave this package by default. `withAccessToken` hands out headers; `rawToken` only with `exposeRawToken: true` (document why).
- Never put tokens in `localStorage`/`sessionStorage`, on the BroadcastChannel, or in telemetry attributes.
- Embedded mode: the host owns OAuth. Never extract tokens via tool `_meta`. Validate `event.source`/`event.origin` in the bridge implementation.
- App-wide refresh is the runtime's job: contribute a `SessionListener` (SessionListenersToken) that calls `injector.refresh('epoch')` when `change.requiresEpochRefresh`. Auth does not depend on runtime.
- Guest → user handoff goes through `GuestUpgradeHook` (contributed by @staticflux/handoff). `beforeUpgrade` runs before any redirect — persist there.
- Every network call goes through `AuthTransport`; every browser API through `AuthEnvironment` (feature-detected; Safari private mode and sandboxed iframes degrade, never throw).
- Every lifecycle change goes through `sessionMachine`; invalid events are reported, never thrown.
- Multi-token contributions currently need `create: () => value as never` (core typing of multi tokens).

## Test
`npx vitest run packages/auth` · `npx tsc -p packages/auth --noEmit`
