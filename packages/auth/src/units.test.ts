import { describe, expect, it, vi } from 'vitest';
import { composeUnits, createDeferred, createInjector, ok, token, unit, type Result } from '@staticflux/core';
import {
  AuthEnvironmentToken,
  AuthHostBridgeToken,
  AuthTransportToken,
  AuthorizedTransportToken,
  type Credentials,
  GuestUpgradeHooksToken,
  IdentityProviderToken,
  SessionListenersToken,
  SessionToken,
  authorizedTransportUnit,
  bffCookieProviderUnit,
  createSessionScope,
  createSessionStore,
  createSessionUnit,
  createTestAuthEnvironment,
  customProvider,
  embedHostProviderUnit,
  guestProviderUnit,
  oidcPkceProviderUnit,
  passkeyProviderUnit,
  sessionScopeKey,
  sessionUnit,
  type SessionChange,
} from './index.js';

const testEnvUnit = unit({ id: 'test/auth-env', provides: AuthEnvironmentToken, scope: 'app', create: () => createTestAuthEnvironment() });
const testTransportUnit = unit({
  id: 'test/auth-transport',
  provides: AuthTransportToken,
  scope: 'app',
  create: () => async () => ({ status: 200, json: async () => ({ authenticated: true, user: { id: 'bff-user' } }) }),
});

describe('auth units', () => {
  it('compose into a complete app: provider + env + transport + session', async () => {
    const units = composeUnits([testEnvUnit, testTransportUnit, bffCookieProviderUnit({ endpoints: { session: '/s', login: '/l', logout: '/o' } }), sessionUnit, authorizedTransportUnit]);
    const injector = createInjector({ units });
    const session = await injector.get(SessionToken);
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    expect(session.value.provider.kind).toBe('bff-cookie');
    expect((await session.value.whenSettled()).state).toBe('authenticated');
    expect((await injector.get(AuthorizedTransportToken)).ok).toBe(true);
    await injector.dispose();
  });

  it('session readiness never waits on the silent probe (R6.3)', async () => {
    const gate = createDeferred<Result<Credentials | undefined>>();
    const slow = unit({ id: 'test/slow-provider', provides: IdentityProviderToken, scope: 'app', create: () => customProvider({ restore: () => gate.promise, login: async () => ok({ kind: 'redirect', url: '/' }) }) });
    const injector = createInjector({ units: [testEnvUnit, slow, sessionUnit] });
    const session = await injector.get(SessionToken);
    expect(session.ok && session.value.state).toBe('authenticating');
    gate.resolve(ok(undefined));
    await injector.dispose();
  });

  it('feeds contributed listeners and upgrade hooks (multi tokens)', async () => {
    const changes: SessionChange[] = [];
    const listenerUnit = unit({
      id: 'test/epoch-listener',
      provides: SessionListenersToken,
      scope: 'app',
      create: () => ({ id: 'test/epoch' as const, onSessionChange: (c: SessionChange) => changes.push(c) }) as never,
    });
    const hook = { id: 'test/hook' as const, afterUpgrade: vi.fn(() => ok()) };
    const hookUnit = unit({ id: 'test/hook-unit', provides: GuestUpgradeHooksToken, scope: 'app', create: () => hook as never });
    const provider = unit({ id: 'test/p', provides: IdentityProviderToken, scope: 'app', create: () => customProvider({ restore: async () => ok({ principal: { id: 'x' }, expiresAt: undefined, embedded: false }), login: async () => ok({ kind: 'redirect', url: '/' }) }) });
    const injector = createInjector({ units: [testEnvUnit, provider, listenerUnit, hookUnit, createSessionUnit({ refreshLeewayMs: 5 })] });
    const session = await injector.get(SessionToken);
    if (!session.ok) throw session.error;
    await session.value.whenSettled();
    expect(changes.map((c) => c.to.state)).toEqual(['authenticating', 'authenticated']);
    expect(changes[1]?.requiresEpochRefresh).toBe(true);
    expect(hook.afterUpgrade).toHaveBeenCalledTimes(1);
    await injector.dispose();
  });

  it('provider unit factories resolve with their ports', async () => {
    const bridge = unit({
      id: 'test/bridge',
      provides: AuthHostBridgeToken,
      scope: 'app',
      create: () => ({ hostKind: 'test', identity: async () => ok(undefined), requestAuthentication: async () => ok(), onIdentityChange: () => () => undefined }),
    });
    const cases = [
      [guestProviderUnit, 'guest'],
      [embedHostProviderUnit, 'embed-host'],
      [oidcPkceProviderUnit({ clientId: 'c', authorizationEndpoint: 'https://i/a', tokenEndpoint: 'https://i/t', redirectUri: 'https://a/cb' }), 'oidc-pkce'],
      [passkeyProviderUnit({ endpoints: { options: '/o', verify: '/v', session: '/s', logout: '/l' } }), 'passkey'],
    ] as const;
    for (const [providerUnit, kind] of cases) {
      const injector = createInjector({ units: [testEnvUnit, testTransportUnit, bridge, providerUnit] });
      const provider = await injector.get(IdentityProviderToken);
      expect(provider.ok && provider.value.kind).toBe(kind);
      await injector.dispose();
    }
  });
});

describe('session scope helper', () => {
  const SessionCacheToken = token('test/session-cache').type<{ readonly owner: string; disposed: boolean }>();

  it('creates a session injector per principal and disposes it on logout/switch', async () => {
    let restoreAs: string | undefined;
    const env = createTestAuthEnvironment();
    const store = createSessionStore({
      env,
      provider: customProvider({
        restore: async () => ok(restoreAs === undefined ? undefined : { principal: { id: restoreAs }, expiresAt: undefined, embedded: false }),
        login: async () => ok({ kind: 'authenticated', credentials: { principal: { id: 'alice' }, expiresAt: undefined, embedded: false } }),
      }),
    });
    const created: string[] = [];
    const disposed: string[] = [];
    const cacheUnit = unit({
      id: 'test/session-cache-unit',
      provides: SessionCacheToken,
      scope: 'session',
      create: (_deps, ctx) => {
        const cache = { owner: ctx.unitId, disposed: false };
        ctx.scope.defer(() => {
          cache.disposed = true;
        });
        return cache;
      },
    });
    const app = createInjector();
    const host = createSessionScope({
      injector: app,
      session: store,
      units: [cacheUnit],
      onCreated: (child, key) => {
        created.push(key);
        child.scope.defer(() => {
          disposed.push(key);
        });
      },
    });
    await host.settled();
    expect(host.key).toBe(`guest:${store.guestId}`);
    const guestCache = await host.injector?.get(SessionCacheToken);
    expect(guestCache?.ok).toBe(true);

    await store.login();
    await host.settled();
    expect(host.key).toBe('user:alice');
    expect(guestCache?.ok && guestCache.value.disposed).toBe(true);
    const aliceCache = await host.injector?.get(SessionCacheToken);

    await store.logout();
    await host.settled();
    expect(aliceCache?.ok && aliceCache.value.disposed).toBe(true);
    expect(created).toEqual([`guest:${store.guestId}`, 'user:alice', `guest:${store.guestId}`]);
    expect(disposed).toEqual([`guest:${store.guestId}`, 'user:alice']);

    restoreAs = 'bob';
    await host.dispose();
    expect(host.injector).toBeUndefined();
    await app.dispose();
  });

  it('keys: authenticating keeps the previous key, revoked has none, guests optional', () => {
    const base = { guestId: 'g', provider: 'custom' as const };
    expect(sessionScopeKey({ ...base, state: 'guest', principal: undefined }, undefined, true)).toBe('guest:g');
    expect(sessionScopeKey({ ...base, state: 'guest', principal: undefined }, undefined, false)).toBeUndefined();
    expect(sessionScopeKey({ ...base, state: 'authenticating', principal: undefined, silent: true }, 'guest:g', true)).toBe('guest:g');
    expect(sessionScopeKey({ ...base, state: 'expired', principal: { id: 'u' } }, 'user:u', true)).toBe('user:u');
    expect(sessionScopeKey({ ...base, state: 'revoked', principal: { id: 'u' }, reason: 'x' }, 'user:u', true)).toBeUndefined();
  });
});
