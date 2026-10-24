import { describe, expect, it, vi } from 'vitest';
import { type Result, createDeferred, createMemorySink, createTelemetry, err, ok } from '@staticflux/core';
import {
  type AuthRequest,
  type Credentials,
  type IdentityProvider,
  type ProviderEvent,
  type SessionChange,
  createAuthorizedTransport,
  createMemoryChannelHub,
  createSessionStore,
  createTestAuthEnvironment,
  customProvider,
  NotAuthenticatedError,
  RefreshUnavailableError,
  UnauthorizedResponseError,
  AuthNetworkError,
  ForbiddenResponseError,
} from './index.js';

const creds = (id = 'u1', expiresAt?: number, embedded = false): Credentials => ({ principal: { id }, expiresAt, embedded });

interface FakeOptions {
  restore?: () => Promise<Result<Credentials | undefined>>;
  refresh?: (c: Credentials) => Promise<Result<Credentials>>;
  login?: IdentityProvider['login'];
  handleCallback?: IdentityProvider['handleCallback'];
  noRefresh?: boolean;
}

function fakeProvider(opts: FakeOptions = {}) {
  let watcher: ((e: ProviderEvent) => void) | undefined;
  const calls = { restore: 0, refresh: 0, logout: 0, clear: 0, grant: 0 };
  let token = 'tok-0';
  const provider = customProvider({
    id: 'test/fake',
    capabilities: { refresh: opts.noRefresh !== true },
    restore: async () => {
      calls.restore += 1;
      return opts.restore === undefined ? ok(undefined) : opts.restore();
    },
    login: opts.login ?? (async () => ok({ kind: 'authenticated', credentials: creds('u1') })),
    ...(opts.handleCallback === undefined ? {} : { handleCallback: opts.handleCallback }),
    ...(opts.noRefresh === true
      ? {}
      : {
          refresh: async (c: Credentials) => {
            calls.refresh += 1;
            token = `tok-${calls.refresh}`;
            return opts.refresh === undefined ? ok(c) : opts.refresh(c);
          },
        }),
    logout: async () => {
      calls.logout += 1;
      return ok();
    },
    clear: () => {
      calls.clear += 1;
    },
    grant: async () => {
      calls.grant += 1;
      return ok({ scheme: 'bearer', headers: { Authorization: `Bearer ${token}` }, rawToken: token });
    },
    watch: (listener) => {
      watcher = listener;
      return () => {
        watcher = undefined;
      };
    },
  });
  return { provider, calls, emit: (e: ProviderEvent) => watcher?.(e) };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('session store: boot and restore', () => {
  it('starts as guest with a stable guest id and restores silently (R6.3)', async () => {
    const { provider } = fakeProvider({ restore: async () => ok(creds('u1')) });
    const env = createTestAuthEnvironment();
    const store = createSessionStore({ provider, env });
    expect(store.state).toBe('guest');
    expect(store.guestId).toMatch(/^guest-/);
    const started = store.start();
    expect(store.state).toBe('authenticating');
    expect(store.snapshot.state === 'authenticating' && store.snapshot.silent).toBe(true);
    expect(await started).toEqual({ ok: true, value: { returnTo: undefined, callbackError: undefined } });
    expect(store.state).toBe('authenticated');
    expect(store.isAuthenticated).toBe(true);
    expect(store.principal?.id).toBe('u1');
    expect(store.start()).toBe(started);
    store.dispose();
  });

  it('falls back to guest when there is no session or restore fails', async () => {
    const none = createSessionStore({ provider: fakeProvider().provider, env: createTestAuthEnvironment() });
    await none.start();
    expect(none.state).toBe('guest');
    const failing = createSessionStore({ provider: fakeProvider({ restore: async () => err(AuthNetworkError()) }).provider, env: createTestAuthEnvironment() });
    const result = await failing.start();
    expect(!result.ok && result.error.code).toBe('SF-AUTH-004');
    expect(failing.state).toBe('guest');
  });

  it('whenSettled waits for the silent probe (route guards for /studio)', async () => {
    const gate = createDeferred<Result<Credentials | undefined>>();
    const store = createSessionStore({ provider: fakeProvider({ restore: () => gate.promise }).provider, env: createTestAuthEnvironment() });
    void store.start();
    let settled = false;
    const waiting = store.whenSettled().then((s) => {
      settled = true;
      return s;
    });
    await tick();
    expect(settled).toBe(false);
    gate.resolve(ok(creds('u2')));
    expect((await waiting).state).toBe('authenticated');
  });

  it('whenSettled resolves with the current snapshot on abort', async () => {
    const gate = createDeferred<Result<Credentials>>();
    const store = createSessionStore({ provider: fakeProvider({ refresh: () => gate.promise }).provider, env: createTestAuthEnvironment() });
    await store.start();
    await store.login();
    void store.refresh();
    const controller = new AbortController();
    const waiting = store.whenSettled(controller.signal);
    controller.abort();
    expect((await waiting).state).toBe('refreshing');
    gate.resolve(ok(creds('u1')));
    expect((await store.whenSettled()).state).toBe('authenticated');
  });

  it('completes a redirect callback on start and returns the deep-link intent', async () => {
    const handleCallback = vi.fn(async (url: string) =>
      url.includes('code=') ? ok({ credentials: creds('u3'), returnTo: '/studio/doc/42' }) : ok(undefined),
    );
    const { provider, calls } = fakeProvider({ handleCallback });
    const env = createTestAuthEnvironment();
    env.url = 'https://app.test/auth/callback?code=1&state=s';
    const upgrade = { id: 'test/handoff' as const, afterUpgrade: vi.fn(() => ok()) };
    const store = createSessionStore({ provider, env, upgradeHooks: [upgrade] });
    const started = await store.start();
    expect(started).toEqual({ ok: true, value: { returnTo: '/studio/doc/42', callbackError: undefined } });
    expect(store.principal?.id).toBe('u3');
    expect(calls.restore).toBe(0);
    expect(upgrade.afterUpgrade).toHaveBeenCalledWith({ guestId: store.guestId, principal: { id: 'u3' } }, expect.anything());
  });

  it('reports a failed callback but still probes silently', async () => {
    const { CallbackStateMismatchError } = await import('./errors.js');
    const { provider, calls } = fakeProvider({ handleCallback: async () => err(CallbackStateMismatchError()) });
    const store = createSessionStore({ provider, env: createTestAuthEnvironment() });
    const started = await store.start();
    expect(started.ok && started.value.callbackError?.code).toBe('SF-AUTH-007');
    expect(calls.restore).toBe(1);
    expect(store.state).toBe('guest');
  });
});

describe('session store: login / logout', () => {
  it('interactive login runs guest-upgrade hooks before and after (R6.4)', async () => {
    const order: string[] = [];
    const hook = {
      id: 'test/handoff' as const,
      beforeUpgrade: () => {
        order.push('before');
        return ok();
      },
      afterUpgrade: () => {
        order.push('after');
        return ok();
      },
    };
    const failingHook = { id: 'test/broken' as const, beforeUpgrade: () => { throw new Error('boom'); } };
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'verbose' });
    telemetry.addSink(sink);
    const store = createSessionStore({ provider: fakeProvider().provider, env: createTestAuthEnvironment(), upgradeHooks: [hook, failingHook], telemetry });
    const result = await store.login();
    expect(result).toEqual({ ok: true, value: { kind: 'authenticated', principal: { id: 'u1' } } });
    expect(order).toEqual(['before', 'after']);
    expect(sink.records.some((r) => r.type === 'event' && r.name === 'session.upgrade-hook-failed')).toBe(true);
    expect(sink.records.some((r) => r.type === 'event' && r.name === 'lifecycle.session.guest→authenticating')).toBe(true);
    expect(sink.records.some((r) => r.type === 'span' && r.name === 'session.login')).toBe(true);
    expect(await store.login()).toEqual({ ok: true, value: { kind: 'authenticated', principal: { id: 'u1' } } });
  });

  it('redirect logins navigate and stay authenticating; a second login is rejected', async () => {
    const env = createTestAuthEnvironment();
    const store = createSessionStore({ provider: fakeProvider({ login: async () => ok({ kind: 'redirect', url: 'https://idp/authorize' }) }).provider, env });
    expect(await store.login({ returnTo: '/studio' })).toEqual({ ok: true, value: { kind: 'redirecting', url: 'https://idp/authorize' } });
    expect(env.navigations).toEqual(['https://idp/authorize']);
    expect(store.state).toBe('authenticating');
    const again = await store.login();
    expect(!again.ok && again.error.code).toBe('SF-AUTH-017');
  });

  it('failed login returns to guest', async () => {
    const store = createSessionStore({ provider: fakeProvider({ login: async () => err(NotAuthenticatedError()) }).provider, env: createTestAuthEnvironment() });
    const result = await store.login();
    expect(result.ok).toBe(false);
    expect(store.state).toBe('guest');
  });

  it('logout clears locally, calls the provider and emits an epoch-refresh change', async () => {
    const { provider, calls } = fakeProvider();
    const changes: SessionChange[] = [];
    const listener = { id: 'test/runtime' as const, onSessionChange: (c: SessionChange) => changes.push(c) };
    const store = createSessionStore({ provider, env: createTestAuthEnvironment(), listeners: [listener] });
    await store.login();
    expect(changes.at(-1)).toMatchObject({ reason: 'login', principalChanged: true, requiresEpochRefresh: true });
    expect((await store.logout()).ok).toBe(true);
    expect(store.state).toBe('guest');
    expect(calls).toMatchObject({ logout: 1, clear: 1 });
    expect(changes.at(-1)).toMatchObject({ reason: 'logout', principalChanged: true, requiresEpochRefresh: true, to: { state: 'guest' } });
    expect((await store.logout()).ok).toBe(true);
    expect(calls.logout).toBe(1);
  });

  it('a throwing listener does not break transitions', async () => {
    const onChange = vi.fn();
    const store = createSessionStore({
      provider: fakeProvider().provider,
      env: createTestAuthEnvironment(),
      listeners: [{ id: 'test/bad', onSessionChange: () => { throw new Error('x'); } }],
    });
    const unsubscribe = store.onChange(onChange);
    await store.login();
    expect(store.state).toBe('authenticated');
    expect(onChange).toHaveBeenCalledTimes(2);
    unsubscribe();
    await store.logout();
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe('session store: refresh, expiry, revocation', () => {
  it('coalesces concurrent refreshes into one provider call (single-flight)', async () => {
    const gate = createDeferred<Result<Credentials>>();
    const { provider, calls } = fakeProvider({ refresh: () => gate.promise });
    const store = createSessionStore({ provider, env: createTestAuthEnvironment() });
    await store.login();
    const all = Array.from({ length: 10 }, () => store.refresh());
    expect(store.state).toBe('refreshing');
    gate.resolve(ok(creds('u1', undefined)));
    const results = await Promise.all(all);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(calls.refresh).toBe(1);
    expect(store.state).toBe('authenticated');
  });

  it('refreshes ahead of expiry using the injected clock', async () => {
    const env = createTestAuthEnvironment({ start: 0 });
    const { provider, calls } = fakeProvider({ refresh: async () => ok(creds('u1', env.now() + 600_000)) });
    const store = createSessionStore({ provider: { ...provider, login: async () => ok({ kind: 'authenticated', credentials: creds('u1', 300_000) }) }, env, refreshLeewayMs: 60_000 });
    await store.login();
    env.advance(239_000);
    expect(calls.refresh).toBe(0);
    env.advance(1_000);
    await tick();
    expect(calls.refresh).toBe(1);
    expect(store.snapshot.state === 'authenticated' && store.snapshot.expiresAt).toBe(840_000);
  });

  it('expires at expiresAt when the provider cannot refresh', async () => {
    const env = createTestAuthEnvironment({ start: 0 });
    const { provider } = fakeProvider({ noRefresh: true });
    const store = createSessionStore({ provider: { ...provider, login: async () => ok({ kind: 'authenticated', credentials: creds('u1', 1_000) }) }, env });
    await store.login();
    env.advance(999);
    expect(store.state).toBe('authenticated');
    env.advance(1);
    expect(store.state).toBe('expired');
    const refreshed = await store.refresh();
    expect(!refreshed.ok && refreshed.error.code).toBe('SF-AUTH-011');
    const relogin = await store.login();
    expect(relogin.ok).toBe(true);
    expect(store.state).toBe('authenticated');
  });

  it('auth failure during refresh expires; forbidden revokes; transient keeps the session', async () => {
    let next: Result<Credentials> = err(AuthNetworkError());
    const { provider } = fakeProvider({ refresh: async () => next });
    const store = createSessionStore({ provider, env: createTestAuthEnvironment() });
    await store.login();
    const transient = await store.refresh();
    expect(!transient.ok && transient.error.kind).toBe('network');
    expect(store.state).toBe('authenticated');
    next = err(RefreshUnavailableError());
    const rejected = await store.refresh();
    expect(!rejected.ok && rejected.error.code).toBe('SF-AUTH-011');
    expect(store.state).toBe('expired');
    await store.login();
    next = err(ForbiddenResponseError());
    const forbidden = await store.refresh();
    expect(!forbidden.ok && forbidden.error.code).toBe('SF-AUTH-012');
    expect(store.state).toBe('revoked');
    expect(store.snapshot.state === 'revoked' && store.snapshot.reason).toBe('refresh-forbidden');
  });

  it('retries a transient refresh failure with a bounded delay, then expires', async () => {
    const env = createTestAuthEnvironment({ start: 0 });
    const { provider, calls } = fakeProvider({ refresh: async () => err(AuthNetworkError()) });
    const store = createSessionStore({ provider: { ...provider, login: async () => ok({ kind: 'authenticated', credentials: creds('u1', 100_000) }) }, env, refreshLeewayMs: 60_000 });
    await store.login();
    env.advance(40_000);
    await tick();
    expect(calls.refresh).toBe(1);
    env.advance(30_000);
    await tick();
    expect(calls.refresh).toBe(2);
    env.advance(30_000);
    await tick();
    expect(store.state).toBe('expired');
  });

  it('revoke() (server push / 403) moves to revoked and broadcasts', async () => {
    const changes: SessionChange[] = [];
    const store = createSessionStore({ provider: fakeProvider().provider, env: createTestAuthEnvironment() });
    store.onChange((c) => changes.push(c));
    store.revoke('ignored-while-guest');
    expect(store.state).toBe('guest');
    await store.login();
    store.revoke('server-push');
    expect(store.state).toBe('revoked');
    expect(changes.at(-1)).toMatchObject({ reason: 'revoke', requiresEpochRefresh: true });
    expect(store.isAuthenticated).toBe(false);
  });

  it('reportUnauthorized refreshes when authenticated and errors for guests', async () => {
    const { provider, calls } = fakeProvider();
    const store = createSessionStore({ provider, env: createTestAuthEnvironment() });
    expect((await store.reportUnauthorized()).ok).toBe(false);
    await store.login();
    expect((await store.reportUnauthorized()).ok).toBe(true);
    expect(calls.refresh).toBe(1);
  });
});

describe('session store: token broker', () => {
  it('strips raw tokens by default and exposes them only when configured', async () => {
    const hidden = createSessionStore({ provider: fakeProvider().provider, env: createTestAuthEnvironment() });
    await hidden.login();
    await hidden.withAccessToken(async (grant) => {
      expect(grant).toEqual({ scheme: 'bearer', headers: { Authorization: 'Bearer tok-0' } });
      expect('rawToken' in grant).toBe(false);
      return ok();
    });
    const exposed = createSessionStore({ provider: fakeProvider().provider, env: createTestAuthEnvironment(), exposeRawToken: true });
    await exposed.login();
    const raw = await exposed.withAccessToken(async (grant) => ok(grant.rawToken));
    expect(raw).toEqual({ ok: true, value: 'tok-0' });
  });

  it('refreshes once on an auth error and retries the task', async () => {
    const { provider, calls } = fakeProvider();
    const store = createSessionStore({ provider, env: createTestAuthEnvironment() });
    await store.login();
    const seen: string[] = [];
    const result = await store.withAccessToken(async (grant) => {
      seen.push(grant.headers['Authorization'] ?? '');
      return seen.length === 1 ? err(UnauthorizedResponseError()) : ok('data');
    });
    expect(result).toEqual({ ok: true, value: 'data' });
    expect(seen).toEqual(['Bearer tok-0', 'Bearer tok-1']);
    expect(calls.refresh).toBe(1);
    const always401 = await store.withAccessToken(async () => err(UnauthorizedResponseError()));
    expect(!always401.ok && always401.error.code).toBe('SF-AUTH-002');
  });

  it('refuses for guests, expired and revoked sessions, and aborted signals', async () => {
    const store = createSessionStore({ provider: fakeProvider().provider, env: createTestAuthEnvironment() });
    const guest = await store.withAccessToken(async () => ok(1));
    expect(!guest.ok && guest.error.code).toBe('SF-AUTH-001');
    await store.login();
    const controller = new AbortController();
    controller.abort();
    const aborted = await store.withAccessToken(async () => ok(1), controller.signal);
    expect(!aborted.ok && aborted.error.kind).toBe('aborted');
    store.revoke('x');
    const revoked = await store.withAccessToken(async () => ok(1));
    expect(!revoked.ok && revoked.error.code).toBe('SF-AUTH-012');
  });

  it('createAuthorizedTransport attaches grant headers and retries 401 once', async () => {
    const { provider, calls } = fakeProvider();
    const store = createSessionStore({ provider, env: createTestAuthEnvironment() });
    await store.login();
    const requests: AuthRequest[] = [];
    let status = 401;
    const transport = async (request: AuthRequest) => {
      requests.push(request);
      const response = { status, json: async () => ({ ok: true }) };
      status = 200;
      return response;
    };
    const authorized = createAuthorizedTransport(store, transport);
    const result = await authorized({ url: '/api/docs', method: 'GET', headers: { Accept: 'json' }, signal: new AbortController().signal });
    expect(result.ok && result.value.status).toBe(200);
    expect(requests.map((r) => r.headers)).toEqual([
      { Accept: 'json', Authorization: 'Bearer tok-0' },
      { Accept: 'json', Authorization: 'Bearer tok-1' },
    ]);
    expect(calls.refresh).toBe(1);
  });
});

describe('session store: multi-tab sync and host events', () => {
  it('logout in one tab logs out the other; login in one tab restores in the other', async () => {
    const hub = createMemoryChannelHub();
    let serverSession: Credentials | undefined;
    const makeTab = () => {
      const fake = fakeProvider({ restore: async () => ok(serverSession) });
      const store = createSessionStore({
        provider: { ...fake.provider, login: async () => { serverSession = creds('shared'); return ok({ kind: 'authenticated', credentials: serverSession }); } },
        env: createTestAuthEnvironment({ channels: hub }),
      });
      return { store, fake };
    };
    const a = makeTab();
    const b = makeTab();
    await a.store.start();
    await b.store.start();
    await a.store.login();
    await tick();
    await tick();
    expect(b.store.state).toBe('authenticated');
    expect(b.store.principal?.id).toBe('shared');
    serverSession = undefined;
    await a.store.logout();
    expect(b.store.state).toBe('guest');
    expect(b.fake.calls.logout).toBe(0);
    expect(b.fake.calls.clear).toBeGreaterThan(0);
    a.store.dispose();
    b.store.dispose();
  });

  it('revocation propagates across tabs; foreign messages are ignored', async () => {
    const hub = createMemoryChannelHub();
    const a = createSessionStore({ provider: fakeProvider().provider, env: createTestAuthEnvironment({ channels: hub }) });
    const b = createSessionStore({ provider: fakeProvider({ restore: async () => ok(creds('u1')) }).provider, env: createTestAuthEnvironment({ channels: hub }) });
    await a.start();
    await b.start();
    await a.login();
    await tick();
    const spy = hub.open('sf-auth/session');
    spy.post({ hello: 'world' });
    spy.post({ v: 1, kind: 'sf-auth/session', type: 'nope', tab: 'x' });
    expect(b.state).toBe('authenticated');
    a.revoke('admin');
    expect(b.state).toBe('revoked');
  });

  it('works single-tab without a channel (degrades)', async () => {
    const store = createSessionStore({ provider: fakeProvider().provider, env: createTestAuthEnvironment({ openChannel: () => undefined }) });
    await store.start();
    await store.login();
    expect(store.state).toBe('authenticated');
  });

  it('provider watch events: changed → resync, revoked → revoked, signed-out → guest', async () => {
    let identity: Credentials | undefined = creds('h1', undefined, true);
    const fake = fakeProvider({ restore: async () => ok(identity) });
    const store = createSessionStore({ provider: fake.provider, env: createTestAuthEnvironment() });
    await store.start();
    expect(store.principal?.id).toBe('h1');
    expect(store.embedded).toBe(true);
    const changes: SessionChange[] = [];
    store.onChange((c) => changes.push(c));
    identity = creds('h2', undefined, true);
    fake.emit({ type: 'changed' });
    await tick();
    expect(store.principal?.id).toBe('h2');
    expect(changes.some((c) => c.principalChanged && c.reason === 'host')).toBe(true);
    fake.emit({ type: 'signed-out' });
    expect(store.state).toBe('guest');
    identity = creds('h3');
    fake.emit({ type: 'changed' });
    await tick();
    expect(store.principal?.id).toBe('h3');
    fake.emit({ type: 'revoked', reason: 'host-revoked' });
    expect(store.state).toBe('revoked');
    identity = undefined;
    store.dispose();
    fake.emit({ type: 'changed' });
    expect(store.state).toBe('revoked');
  });
});
