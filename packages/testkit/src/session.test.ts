import { contribution } from '@staticflux/core';
import {
  AuthEnvironmentToken,
  createMemoryChannelHub,
  GuestUpgradeHooksToken,
  IdentityProviderToken,
  NotAuthenticatedError,
  type SessionChange,
  SessionListenersToken,
  SessionToken,
} from '@staticflux/auth';
import { describe, expect, it } from 'vitest';
import { createFakeClock, createFakeIdentityProvider, createFakeSession, createTestInjector, flushMicrotasks, toPrincipal } from './index.js';

describe('toPrincipal', () => {
  it('builds principals from ids, principals and specs', () => {
    expect(toPrincipal('ada')).toEqual({ id: 'ada', displayName: 'ada' });
    expect(toPrincipal({ id: 'p', email: 'p@x' })).toEqual({ id: 'p', email: 'p@x' });
    expect(toPrincipal({ user: 'ada', roles: ['editor'], plan: 'pro', entitlements: ['ai'] })).toEqual({
      id: 'ada',
      displayName: 'ada',
      roles: ['editor'],
      claims: { plan: 'pro', entitlements: ['ai'] },
    });
  });
});

describe('createFakeIdentityProvider', () => {
  it('restores, logs in, grants, refreshes and records calls', async () => {
    const provider = createFakeIdentityProvider({ now: () => 100, expiresInMs: 50 });
    const signal = new AbortController().signal;
    expect(await provider.restore(signal)).toEqual({ ok: true, value: undefined });
    expect((await provider.login({}, signal)).ok).toBe(false);
    provider.setIdentity({ id: 'ada' });
    const login = await provider.login({}, signal);
    expect(login.ok && login.value).toEqual({ kind: 'authenticated', credentials: { principal: { id: 'ada' }, expiresAt: 150, embedded: false } });
    const creds = { principal: { id: 'ada' }, expiresAt: 150, embedded: false };
    expect(await provider.grant(creds, signal)).toEqual({ ok: true, value: { scheme: 'bearer', headers: { authorization: 'Bearer fake-ada' } } });
    expect((await provider.refresh?.(creds, signal))?.ok).toBe(true);
    provider.failNext('grant', NotAuthenticatedError());
    expect((await provider.grant(creds, signal)).ok).toBe(false);
    expect((await provider.grant(creds, signal)).ok).toBe(true);
    expect((await provider.logout(creds, signal)).ok).toBe(true);
    expect(provider.identity).toBeUndefined();
    expect(provider.calls).toEqual(['restore', 'login', 'login', 'grant', 'refresh', 'grant', 'grant', 'logout']);
  });

  it('can be built without refresh capability', () => {
    const provider = createFakeIdentityProvider({ refresh: false });
    expect(provider.capabilities.refresh).toBe(false);
    expect(provider.refresh).toBeUndefined();
  });
});

describe('createFakeSession', () => {
  it('starts as guest by default', async () => {
    const session = createFakeSession();
    const snapshot = await session.ready();
    expect(snapshot.state).toBe('guest');
    expect(session.store.isAuthenticated).toBe(false);
  });

  it('restores the initial user with roles / plan / entitlements', async () => {
    const session = createFakeSession({ initial: { user: 'ada', roles: ['editor'], plan: 'pro', entitlements: ['ai'] } });
    const snapshot = await session.ready();
    expect(snapshot.state).toBe('authenticated');
    expect(session.store.principal).toEqual({ id: 'ada', displayName: 'ada', roles: ['editor'], claims: { plan: 'pro', entitlements: ['ai'] } });
  });

  it('login / logout / expire / revoke drive the real session machine', async () => {
    const session = createFakeSession();
    const changes: SessionChange[] = [];
    session.store.onChange((c) => changes.push(c));
    await session.ready();
    expect((await session.login('ada')).state).toBe('authenticated');
    expect(session.store.principal?.id).toBe('ada');
    expect(changes.at(-1)).toMatchObject({ reason: 'login', principalChanged: true, requiresEpochRefresh: true });
    expect((await session.login('ada')).state).toBe('authenticated'); // idempotent
    expect((await session.expire()).state).toBe('expired');
    expect((await session.login('ada')).state).toBe('authenticated');
    expect(session.revoke('server').state).toBe('revoked');
    expect((await session.logout()).state).toBe('guest');
    expect(session.provider.identity).toBeUndefined();
    expect(await session.expire()).toMatchObject({ state: 'guest' });
  });

  it('expire works without refresh capability', async () => {
    const session = createFakeSession({ initial: 'ada', refresh: false });
    await session.ready();
    expect((await session.expire()).state).toBe('expired');
  });

  it('switchAccount resyncs in place with principalChanged; login(other) switches too', async () => {
    const session = createFakeSession({ initial: 'ada' });
    await session.ready();
    const changes: SessionChange[] = [];
    session.store.onChange((c) => changes.push(c));
    const snapshot = await session.switchAccount({ user: 'bob', roles: ['viewer'] });
    expect(snapshot).toMatchObject({ state: 'authenticated', principal: { id: 'bob', roles: ['viewer'] } });
    expect(changes.at(-1)).toMatchObject({ reason: 'host', principalChanged: true, requiresEpochRefresh: true });
    expect((await session.switchAccount('bob')).principal?.id).toBe('bob'); // no-op
    expect((await session.login('cy')).principal?.id).toBe('cy');
    await session.logout();
    expect((await session.switchAccount('dee')).principal?.id).toBe('dee'); // from guest = login
  });

  it('login failures surface as thrown SfErrors', async () => {
    const session = createFakeSession();
    session.provider.failNext('login', NotAuthenticatedError({ message: 'denied' }));
    await expect(session.login('ada')).rejects.toMatchObject({ code: 'SF-AUTH-001' });
    expect(session.snapshot.state).toBe('guest');
  });

  it('expiresInMs + a fake clock expire the session when time passes', async () => {
    const clock = createFakeClock();
    const session = createFakeSession({ initial: 'ada', clock, expiresInMs: 60_000, refresh: false });
    await session.ready();
    expect(session.snapshot).toMatchObject({ state: 'authenticated', expiresAt: clock.now() + 60_000 });
    clock.advance(59_999);
    expect(session.snapshot.state).toBe('authenticated');
    clock.advance(1);
    expect(session.snapshot.state).toBe('expired');
  });

  it('shared channel hub simulates tabs: logout in one tab signs out the other', async () => {
    const hub = createMemoryChannelHub();
    const tabA = createFakeSession({ initial: 'ada', channels: hub });
    const tabB = createFakeSession({ initial: 'ada', channels: hub });
    await Promise.all([tabA.ready(), tabB.ready()]);
    await tabA.logout();
    await flushMicrotasks();
    expect(tabB.snapshot.state).toBe('guest');
  });

  it('units override the auth tokens and collect contributed listeners / upgrade hooks', async () => {
    const session = createFakeSession();
    const seen: string[] = [];
    const t = createTestInjector({
      units: [
        contribution({
          id: 'it/listener',
          provides: SessionListenersToken,
          scope: 'app',
          create: () => ({ id: 'it/listener', onSessionChange: (c: SessionChange) => void seen.push(`${c.from.state}→${c.to.state}`) }) as never,
        }),
        contribution({
          id: 'it/hook',
          provides: GuestUpgradeHooksToken,
          scope: 'app',
          create: () => ({ id: 'it/hook', afterUpgrade: (u: { guestId: string }) => void seen.push(`upgrade:${u.guestId.startsWith('guest-')}`) }) as never,
        }),
      ],
      overrides: session.units,
    });
    const store = await t.get(SessionToken);
    expect(store).toBe(session.store);
    expect(await t.get(IdentityProviderToken)).toBe(session.provider);
    expect(await t.get(AuthEnvironmentToken)).toBe(session.env);
    await session.ready();
    await session.login('ada');
    expect(seen).toContain('guest→authenticating');
    expect(seen).toContain('authenticating→authenticated');
    expect(seen).toContain('upgrade:true');
    expect(t.spans({ subsystem: 'auth/session', name: 'session.login' })).toHaveLength(1);
    await t.dispose();
    // A disposed store is replaced on next access.
    expect(session.store).not.toBe(store);
  });

  it('a store accessed before the injector is reused and receives contributed listeners', async () => {
    const session = createFakeSession();
    const early = session.store;
    const seen: string[] = [];
    const t = createTestInjector({
      units: [
        contribution({
          id: 'it/listener',
          provides: SessionListenersToken,
          scope: 'app',
          create: () => ({ id: 'it/listener', onSessionChange: (c: SessionChange) => void seen.push(c.to.state) }) as never,
        }),
      ],
      overrides: session.units,
    });
    expect(await t.get(SessionToken)).toBe(early);
    await session.login('ada');
    expect(seen).toContain('authenticated');
    await t.dispose();
  });
});
