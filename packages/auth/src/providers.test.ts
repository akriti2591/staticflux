import { describe, expect, it, vi } from 'vitest';
import { err, ok } from '@staticflux/core';
import {
  type AuthHostBridge,
  type AuthRequest,
  type AuthTransport,
  type WebAuthnPort,
  base64UrlEncode,
  bffCookieProvider,
  browserWebAuthn,
  createTestAuthEnvironment,
  credentialToJson,
  creationOptionsFromJson,
  customProvider,
  embedHostProvider,
  guestProvider,
  isPasskeySupported,
  oidcPkceProvider,
  parseCallbackUrl,
  passkeyProvider,
  requestOptionsFromJson,
} from './index.js';

type Handler = (request: AuthRequest) => { status: number; body?: unknown };

function mockTransport(routes: Record<string, Handler>): AuthTransport & { calls: AuthRequest[] } {
  const calls: AuthRequest[] = [];
  const transport = async (request: AuthRequest) => {
    calls.push(request);
    const key = `${request.method} ${request.url.split('?')[0]}`;
    const handler = routes[key];
    if (handler === undefined) return { status: 404, json: async () => ({}) };
    const { status, body } = handler(request);
    return { status, json: async () => body };
  };
  return Object.assign(transport, { calls });
}

const signal = new AbortController().signal;
const session = (id = 'u1', extra: Record<string, unknown> = {}) => ({
  status: 200,
  body: { authenticated: true, user: { id, name: 'Ada', email: 'ada@x', roles: ['admin', 3] }, csrfToken: 'csrf-1', ...extra },
});

describe('bff-cookie provider', () => {
  const endpoints = { session: '/auth/session', login: '/auth/login', logout: '/auth/logout', refresh: '/auth/refresh' };

  it('restores from the session endpoint (cookie) and treats 401/anonymous as no session', async () => {
    let mode: 'auth' | 'anon' | '401' = 'auth';
    const transport = mockTransport({
      'GET /auth/session': () => (mode === '401' ? { status: 401 } : mode === 'anon' ? { status: 200, body: { authenticated: false } } : session()),
    });
    const provider = bffCookieProvider({ transport, endpoints });
    const restored = await provider.restore(signal);
    expect(restored).toEqual({ ok: true, value: { principal: { id: 'u1', displayName: 'Ada', email: 'ada@x', roles: ['admin'] }, expiresAt: undefined, embedded: false } });
    expect(transport.calls[0]?.credentials).toBe('include');
    mode = 'anon';
    expect(await provider.restore(signal)).toEqual({ ok: true, value: undefined });
    mode = '401';
    expect(await provider.restore(signal)).toEqual({ ok: true, value: undefined });
  });

  it('rejects malformed session JSON with SF-AUTH-006', async () => {
    const provider = bffCookieProvider({ transport: mockTransport({ 'GET /auth/session': () => ({ status: 200, body: { authenticated: true, user: {} } }) }), endpoints });
    const restored = await provider.restore(signal);
    expect(!restored.ok && restored.error.code).toBe('SF-AUTH-006');
  });

  it('login redirects with returnTo (deep-link intent) and grants carry the CSRF header', async () => {
    const transport = mockTransport({ 'GET /auth/session': () => session(), 'POST /auth/logout': () => ({ status: 204 }) });
    const provider = bffCookieProvider({ transport, endpoints, csrf: { header: 'X-CSRF' } });
    const outcome = await provider.login({ returnTo: '/studio/doc/42?tab=comments' }, signal);
    expect(outcome.ok && outcome.value).toEqual({ kind: 'redirect', url: '/auth/login?returnTo=%2Fstudio%2Fdoc%2F42%3Ftab%3Dcomments' });
    const restored = await provider.restore(signal);
    if (!restored.ok || restored.value === undefined) throw new Error('expected session');
    const grant = await provider.grant(restored.value, signal);
    expect(grant).toEqual({ ok: true, value: { scheme: 'cookie', headers: { 'X-CSRF': 'csrf-1' } } });
    await provider.logout(restored.value, signal);
    expect(transport.calls.at(-1)?.headers).toEqual({ 'X-CSRF': 'csrf-1' });
    const after = await provider.grant(restored.value, signal);
    expect(after.ok && after.value.headers).toEqual({});
  });

  it('refresh rotates via the refresh endpoint then re-reads the session; ended session → SF-AUTH-010', async () => {
    let alive = true;
    const transport = mockTransport({
      'POST /auth/refresh': () => ({ status: 204 }),
      'GET /auth/session': () => (alive ? session('u1', { expiresAt: 99 }) : { status: 401 }),
    });
    const provider = bffCookieProvider({ transport, endpoints });
    const creds = { principal: { id: 'u1' }, expiresAt: 1, embedded: false };
    const refreshed = await provider.refresh?.(creds, signal);
    expect(refreshed?.ok && refreshed.value.expiresAt).toBe(99);
    expect(transport.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /auth/refresh', 'GET /auth/session']);
    alive = false;
    const ended = await provider.refresh?.(creds, signal);
    expect(ended !== undefined && !ended.ok && ended.error.code).toBe('SF-AUTH-010');
  });

  it('refresh propagates a 401 from the refresh endpoint as an auth error', async () => {
    const provider = bffCookieProvider({ transport: mockTransport({ 'POST /auth/refresh': () => ({ status: 401 }) }), endpoints });
    const result = await provider.refresh?.({ principal: { id: 'u' }, expiresAt: undefined, embedded: false }, signal);
    expect(result !== undefined && !result.ok && result.error.kind).toBe('auth');
  });
});

describe('oidc-pkce provider', () => {
  const idToken = (claims: Record<string, unknown>) => `h.${base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)))}.sig`;
  const setup = (tokenHandler?: Handler) => {
    const env = createTestAuthEnvironment({ start: 0 });
    const transport = mockTransport({
      'POST https://idp.test/token':
        tokenHandler ??
        ((req) => {
          const body = new URLSearchParams(req.body);
          if (body.get('grant_type') === 'refresh_token') {
            return { status: 200, body: { access_token: `at-${body.get('refresh_token')}`, expires_in: 60, refresh_token: 'rt-2' } };
          }
          return { status: 200, body: { access_token: 'at-1', expires_in: 300, refresh_token: 'rt-1', id_token: idToken({ sub: 'u1', name: 'Ada', roles: ['r'] }) } };
        }),
      'POST https://idp.test/revoke': () => ({ status: 200, body: {} }),
    });
    const provider = oidcPkceProvider({
      clientId: 'studio',
      authorizationEndpoint: 'https://idp.test/authorize',
      tokenEndpoint: 'https://idp.test/token',
      revocationEndpoint: 'https://idp.test/revoke',
      redirectUri: 'https://app.test/auth/callback',
      transport,
      env,
    });
    return { env, transport, provider };
  };

  const loginAndCallback = async (ctx: ReturnType<typeof setup>) => {
    const outcome = await ctx.provider.login({ returnTo: '/studio' }, signal);
    if (!outcome.ok || outcome.value.kind !== 'redirect') throw new Error('expected redirect');
    const url = new URL(outcome.value.url);
    const state = url.searchParams.get('state') ?? '';
    return { url, state, callback: await ctx.provider.handleCallback?.(`https://app.test/auth/callback?code=c1&state=${state}`, signal) };
  };

  it('builds an S256 authorization request and stores only verifier/state transiently', async () => {
    const ctx = setup();
    const outcome = await ctx.provider.login({ returnTo: '/studio', loginHint: 'ada' }, signal);
    if (!outcome.ok || outcome.value.kind !== 'redirect') throw new Error('expected redirect');
    const url = new URL(outcome.value.url);
    expect(url.origin + url.pathname).toBe('https://idp.test/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('login_hint')).toBe('ada');
    const stored = [...(ctx.env.transientStorage as unknown as { entries: Map<string, string> }).entries.values()];
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0] ?? '{}')).toMatchObject({ returnTo: '/studio' });
    expect(ctx.env.persistentStorage?.get('sf-auth/guest-id')).toBeUndefined();
  });

  it('exchanges the code with the verifier, keeps tokens in memory, returns returnTo', async () => {
    const ctx = setup();
    const { callback } = await loginAndCallback(ctx);
    expect(callback?.ok && callback.value).toEqual({
      credentials: { principal: expect.objectContaining({ id: 'u1', displayName: 'Ada', roles: ['r'] }), expiresAt: 300_000, embedded: false },
      returnTo: '/studio',
    });
    const exchange = new URLSearchParams(ctx.transport.calls[0]?.body);
    expect(exchange.get('grant_type')).toBe('authorization_code');
    expect(exchange.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(exchange.get('client_id')).toBe('studio');
    expect((ctx.env.transientStorage as unknown as { entries: Map<string, string> }).entries.size).toBe(0);
    const creds = callback?.ok ? callback.value?.credentials : undefined;
    if (creds === undefined) throw new Error('no creds');
    const grant = await ctx.provider.grant(creds, signal);
    expect(grant.ok && grant.value).toEqual({ scheme: 'bearer', headers: { Authorization: 'Bearer at-1' }, rawToken: 'at-1' });
    expect(await ctx.provider.restore(signal)).toEqual({ ok: true, value: creds });
  });

  it('rotates refresh tokens and revokes on logout', async () => {
    const ctx = setup();
    const { callback } = await loginAndCallback(ctx);
    const creds = callback?.ok ? callback.value?.credentials : undefined;
    if (creds === undefined) throw new Error('no creds');
    const refreshed = await ctx.provider.refresh?.(creds, signal);
    expect(refreshed?.ok && refreshed.value.expiresAt).toBe(60_000);
    const grant = await ctx.provider.grant(creds, signal);
    expect(grant.ok && grant.value.rawToken).toBe('at-rt-1');
    await ctx.provider.refresh?.(creds, signal);
    expect(new URLSearchParams(ctx.transport.calls.at(-1)?.body).get('refresh_token')).toBe('rt-2');
    await ctx.provider.logout(creds, signal);
    expect(ctx.transport.calls.at(-1)?.url).toBe('https://idp.test/revoke');
    expect((await ctx.provider.grant(creds, signal)).ok).toBe(false);
    const noRefresh = await ctx.provider.refresh?.(creds, signal);
    expect(noRefresh !== undefined && !noRefresh.ok && noRefresh.error.code).toBe('SF-AUTH-010');
  });

  it('rejects unknown state, surfaces AS errors, ignores non-callback urls', async () => {
    const ctx = setup();
    const mismatch = await ctx.provider.handleCallback?.('https://app.test/auth/callback?code=c&state=forged', signal);
    expect(mismatch !== undefined && !mismatch.ok && mismatch.error.code).toBe('SF-AUTH-007');
    const denied = await ctx.provider.handleCallback?.('https://app.test/auth/callback?error=access_denied&state=s', signal);
    expect(denied !== undefined && !denied.ok && denied.error.code).toBe('SF-AUTH-008');
    expect(await ctx.provider.handleCallback?.('https://app.test/studio', signal)).toEqual({ ok: true, value: undefined });
    expect(parseCallbackUrl('not a url', 'https://app.test/cb')).toBeUndefined();
    expect(parseCallbackUrl('https://evil.test/cb?code=1&state=2', 'https://app.test/cb')).toBeUndefined();
  });

  it('rejects token responses without access_token', async () => {
    const ctx = setup(() => ({ status: 200, body: { nope: true } }));
    const { callback } = await loginAndCallback(ctx);
    expect(callback !== undefined && !callback.ok && callback.error.code).toBe('SF-AUTH-006');
  });

  it('needs transient storage to survive the redirect', async () => {
    const env = createTestAuthEnvironment({ transientStorage: undefined });
    const provider = oidcPkceProvider({ clientId: 'c', authorizationEndpoint: 'https://i/a', tokenEndpoint: 'https://i/t', redirectUri: 'https://a/cb', transport: mockTransport({}), env });
    const outcome = await provider.login({}, signal);
    expect(!outcome.ok && outcome.error.code).toBe('SF-AUTH-013');
  });

  it('uses userinfo when configured', async () => {
    const env = createTestAuthEnvironment();
    const transport = mockTransport({
      'POST https://i/t': () => ({ status: 200, body: { access_token: 'a' } }),
      'GET https://i/me': (req) => ({ status: 200, body: { sub: req.headers?.['Authorization'] === 'Bearer a' ? 'me' : 'x' } }),
    });
    const provider = oidcPkceProvider({ clientId: 'c', authorizationEndpoint: 'https://i/a', tokenEndpoint: 'https://i/t', userinfoEndpoint: 'https://i/me', redirectUri: 'https://a/cb', transport, env });
    const login = await provider.login({}, signal);
    const state = login.ok && login.value.kind === 'redirect' ? new URL(login.value.url).searchParams.get('state') : '';
    const cb = await provider.handleCallback?.(`https://a/cb?code=1&state=${state}`, signal);
    expect(cb?.ok && cb.value?.credentials.principal.id).toBe('me');
    expect(cb?.ok && cb.value?.credentials.expiresAt).toBeUndefined();
  });
});

describe('passkey provider', () => {
  const endpoints = { options: '/pk/options', verify: '/pk/verify', session: '/pk/session', logout: '/pk/logout', registerOptions: '/pk/reg', registerVerify: '/pk/reg/verify' };
  const port = (overrides: Partial<WebAuthnPort> = {}): WebAuthnPort => ({
    supported: true,
    conditionalMediationAvailable: async () => true,
    get: vi.fn(async () => ok({ id: 'cred', response: {} })),
    create: vi.fn(async () => ok({ id: 'new' })),
    ...overrides,
  });

  it('runs the ceremony: options → navigator.credentials.get → verify → session', async () => {
    const transport = mockTransport({
      'POST /pk/options': () => ({ status: 200, body: { challenge: 'abc' } }),
      'POST /pk/verify': (req) => (JSON.parse(req.body ?? '{}').id === 'cred' ? session('pk-user') : { status: 401 }),
    });
    const webauthn = port();
    const provider = passkeyProvider({ transport, webauthn, endpoints });
    const outcome = await provider.login({ mediation: 'conditional' }, signal);
    expect(outcome.ok && outcome.value.kind === 'authenticated' && outcome.value.credentials.principal.id).toBe('pk-user');
    expect(webauthn.get).toHaveBeenCalledWith({ challenge: 'abc' }, { signal, mediation: 'conditional' });
  });

  it('is unavailable without WebAuthn and maps cancellation', async () => {
    const unsupported = passkeyProvider({ transport: mockTransport({}), webauthn: port({ supported: false }), endpoints });
    const a = await unsupported.login({}, signal);
    expect(!a.ok && a.error.code).toBe('SF-AUTH-009');
    expect((await unsupported.register(signal)).ok).toBe(false);
    const { PasskeyCancelledError } = await import('./errors.js');
    const cancelled = passkeyProvider({
      transport: mockTransport({ 'POST /pk/options': () => ({ status: 200, body: { challenge: 'abc' } }) }),
      webauthn: port({ get: async () => err(PasskeyCancelledError()) }),
      endpoints,
    });
    const b = await cancelled.login({}, signal);
    expect(!b.ok && b.error.code).toBe('SF-AUTH-016');
  });

  it('registers a passkey and restores via the session endpoint', async () => {
    const transport = mockTransport({
      'POST /pk/reg': () => ({ status: 200, body: { challenge: 'c', user: { id: 'dQ' } } }),
      'POST /pk/reg/verify': () => ({ status: 200, body: { ok: true } }),
      'GET /pk/session': () => session('u9'),
      'POST /pk/logout': () => ({ status: 204 }),
    });
    const provider = passkeyProvider({ transport, webauthn: port(), endpoints, csrf: { header: 'X-CSRF' } });
    const restored = await provider.restore(signal);
    expect(restored.ok && restored.value?.principal.id).toBe('u9');
    expect((await provider.register(signal)).ok).toBe(true);
    expect(transport.calls.find((c) => c.url === '/pk/reg/verify')?.headers).toMatchObject({ 'X-CSRF': 'csrf-1' });
    const refreshed = await provider.refresh(
      { principal: { id: 'u9' }, expiresAt: undefined, embedded: false },
      signal,
    );
    expect(refreshed.ok).toBe(true);
    expect((await provider.logout(undefined, signal)).ok).toBe(true);
  });

  it('converts WebAuthn JSON options and serializes credentials (fallback path)', () => {
    const id = base64UrlEncode(new Uint8Array([1, 2, 3]));
    const request = requestOptionsFromJson({ challenge: id, allowCredentials: [{ id, type: 'public-key' }], rpId: 'app.test' });
    expect(new Uint8Array(request.challenge as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
    expect(request.allowCredentials?.[0]?.id).toBeInstanceOf(ArrayBuffer);
    expect(request.rpId).toBe('app.test');
    const creation = creationOptionsFromJson({ challenge: id, user: { id, name: 'a', displayName: 'A' }, excludeCredentials: [{ id }] });
    expect(new Uint8Array(creation.user.id as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
    expect(creation.excludeCredentials?.[0]?.type).toBe('public-key');
    const json = credentialToJson({
      id: 'cid',
      rawId: new Uint8Array([9]).buffer,
      type: 'public-key',
      response: { clientDataJSON: new Uint8Array([1]).buffer, signature: new Uint8Array([2]), other: 'ignored' },
    });
    expect(json).toEqual({
      id: 'cid',
      rawId: 'CQ',
      type: 'public-key',
      response: { clientDataJSON: 'AQ', signature: 'Ag' },
      authenticatorAttachment: null,
      clientExtensionResults: {},
    });
  });

  it('feature-detects and adapts navigator.credentials', async () => {
    expect(isPasskeySupported({})).toBe(false);
    const unsupported = browserWebAuthn({});
    expect(unsupported.supported).toBe(false);
    expect(await unsupported.conditionalMediationAvailable()).toBe(false);
    expect((await unsupported.get({}, { signal })).ok).toBe(false);
    const credential = { toJSON: () => ({ id: 'native' }) };
    const notAllowed = Object.assign(new Error('no'), { name: 'NotAllowedError' });
    const container = { get: vi.fn(async () => credential), create: vi.fn(async () => Promise.reject(notAllowed)) };
    function PublicKeyCredential() {}
    PublicKeyCredential.isConditionalMediationAvailable = async () => true;
    const scope = { PublicKeyCredential, navigator: { credentials: container as unknown as CredentialsContainer } };
    const adapted = browserWebAuthn(scope);
    expect(adapted.supported).toBe(true);
    expect(await adapted.conditionalMediationAvailable()).toBe(true);
    expect(await adapted.get({ challenge: 'AQ' }, { signal, mediation: 'conditional' })).toEqual({ ok: true, value: { id: 'native' } });
    expect(container.get).toHaveBeenCalledWith(expect.objectContaining({ mediation: 'conditional' }));
    const created = await adapted.create({ challenge: 'AQ', user: { id: 'AQ' } }, signal);
    expect(!created.ok && created.error.code).toBe('SF-AUTH-016');
  });
});

describe('embed-host provider', () => {
  const bridge = (identity: { subject: string } | undefined): AuthHostBridge & { fire(): void } => {
    let listener: (() => void) | undefined;
    let current = identity;
    return {
      hostKind: 'mcp-apps',
      identity: async () => ok(current),
      requestAuthentication: async () => {
        current = { subject: 'linked' };
        return ok();
      },
      onIdentityChange: (l) => {
        listener = l;
        return () => {
          listener = undefined;
        };
      },
      fire: () => listener?.(),
    };
  };

  it('reports the host identity as the embedded flavour and never holds tokens', async () => {
    const provider = embedHostProvider(bridge({ subject: 'h1' }));
    const restored = await provider.restore(signal);
    expect(restored).toEqual({ ok: true, value: { principal: { id: 'h1' }, expiresAt: undefined, embedded: true } });
    if (!restored.ok || restored.value === undefined) return;
    const grant = await provider.grant(restored.value, signal);
    expect(grant).toEqual({ ok: true, value: { scheme: 'host', headers: {} } });
    expect(provider.capabilities.embedded).toBe(true);
  });

  it('login asks the host to link the account; watch forwards identity changes', async () => {
    const b = bridge(undefined);
    const provider = embedHostProvider(b);
    expect(await provider.restore(signal)).toEqual({ ok: true, value: undefined });
    const login = await provider.login({}, signal);
    expect(login.ok && login.value.kind === 'authenticated' && login.value.credentials.principal.id).toBe('linked');
    const events: unknown[] = [];
    const stop = provider.watch?.((e) => events.push(e));
    b.fire();
    expect(events).toEqual([{ type: 'changed' }]);
    stop?.();
    const refreshed = await provider.refresh?.({ principal: { id: 'linked' }, expiresAt: undefined, embedded: true }, signal);
    expect(refreshed?.ok).toBe(true);
  });

  it('maps a throwing bridge to SF-AUTH-014', async () => {
    const provider = embedHostProvider({ ...bridge(undefined), identity: () => Promise.reject(new Error('no bridge')) });
    const restored = await provider.restore(signal);
    expect(!restored.ok && restored.error.code).toBe('SF-AUTH-014');
  });
});

describe('custom and guest providers', () => {
  it('custom fills safe defaults', async () => {
    const provider = customProvider({ restore: async () => ok(undefined), login: async () => ok({ kind: 'redirect', url: '/x' }) });
    expect(provider.kind).toBe('custom');
    expect(provider.capabilities.refresh).toBe(false);
    expect(await provider.logout(undefined, signal)).toEqual({ ok: true, value: undefined });
    expect(await provider.grant({ principal: { id: 'a' }, expiresAt: undefined, embedded: false }, signal)).toEqual({ ok: true, value: { scheme: 'none', headers: {} } });
    const withRefresh = customProvider({ id: 'app/sso', restore: async () => ok(undefined), login: async () => ok({ kind: 'redirect', url: '/x' }), refresh: async (c) => ok(c) });
    expect(withRefresh.capabilities.refresh).toBe(true);
    expect(withRefresh.id).toBe('app/sso');
  });

  it('guest never authenticates', async () => {
    const provider = guestProvider();
    expect(await provider.restore(signal)).toEqual({ ok: true, value: undefined });
    const login = await provider.login({}, signal);
    expect(!login.ok && login.error.code).toBe('SF-AUTH-009');
    expect((await provider.grant({ principal: { id: 'x' }, expiresAt: undefined, embedded: false }, signal)).ok).toBe(false);
  });
});
