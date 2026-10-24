import { describe, expect, it, vi } from 'vitest';
import {
  base64UrlDecode,
  base64UrlEncode,
  broadcastChannelPort,
  createMemoryChannelHub,
  createPkcePair,
  createTestAuthEnvironment,
  decodeJwtPayload,
  fetchTransport,
  formBody,
  memoryStorage,
  pkceChallenge,
  randomUrlSafe,
  requestJson,
  sessionMachine,
  stableGuestId,
  statusError,
  webStorage,
  GUEST_ID_STORAGE_KEY,
} from './index.js';
import { createMachine } from '@staticflux/core';

const signal = new AbortController().signal;

describe('pkce', () => {
  it('matches the RFC 7636 appendix B test vector', async () => {
    const challenge = await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', globalThis.crypto.subtle);
    expect(challenge).toEqual({ ok: true, value: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM' });
  });

  it('creates a 43-char url-safe verifier and S256 challenge', async () => {
    const env = createTestAuthEnvironment();
    const pair = await createPkcePair(env.randomBytes, env.subtle);
    expect(pair.ok).toBe(true);
    if (!pair.ok) return;
    expect(pair.value.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.value.method).toBe('S256');
    expect(await pkceChallenge(pair.value.verifier, env.subtle)).toEqual({ ok: true, value: pair.value.challenge });
  });

  it('fails with SF-AUTH-013 without WebCrypto', async () => {
    const noRandom = await createPkcePair(undefined, globalThis.crypto.subtle);
    const noSubtle = await createPkcePair((n) => new Uint8Array(n), undefined);
    expect(!noRandom.ok && noRandom.error.code).toBe('SF-AUTH-013');
    expect(!noSubtle.ok && noSubtle.error.code).toBe('SF-AUTH-013');
    expect(randomUrlSafe(undefined).ok).toBe(false);
  });

  it('round-trips base64url and decodes JWT payloads (advisory)', () => {
    const bytes = new Uint8Array([0, 255, 62, 63, 250, 1]);
    expect(base64UrlDecode(base64UrlEncode(bytes))).toEqual(bytes);
    expect(base64UrlEncode(bytes)).not.toMatch(/[+/=]/);
    const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ sub: 'u1', name: 'Zoë' })));
    expect(decodeJwtPayload(`h.${payload}.s`)).toEqual({ sub: 'u1', name: 'Zoë' });
    expect(decodeJwtPayload('garbage')).toBeUndefined();
    expect(decodeJwtPayload('a.!!!.c')).toBeUndefined();
  });
});

describe('transport', () => {
  it('maps HTTP statuses to typed errors', () => {
    expect(statusError(200, 'u')).toBeUndefined();
    expect(statusError(401, 'u')?.code).toBe('SF-AUTH-002');
    expect(statusError(403, 'u')?.kind).toBe('forbidden');
    expect(statusError(429, 'u')?.kind).toBe('rate');
    expect(statusError(503, 'u')?.kind).toBe('unavailable');
    expect(statusError(418, 'u')?.code).toBe('SF-AUTH-006');
  });

  it('requestJson handles success, 204, network failure, abort and bad JSON', async () => {
    const json = await requestJson(async () => ({ status: 200, json: async () => ({ a: 1 }) }), { url: 'u', method: 'GET', signal });
    expect(json).toEqual({ ok: true, value: { a: 1 } });
    const empty = await requestJson(async () => ({ status: 204, json: async () => undefined }), { url: 'u', method: 'GET', signal });
    expect(empty).toEqual({ ok: true, value: undefined });
    const network = await requestJson(async () => Promise.reject(new TypeError('offline')), { url: 'u', method: 'GET', signal });
    expect(!network.ok && network.error.code).toBe('SF-AUTH-004');
    const controller = new AbortController();
    controller.abort();
    const aborted = await requestJson(async () => Promise.reject(new Error('x')), { url: 'u', method: 'GET', signal: controller.signal });
    expect(!aborted.ok && aborted.error.kind).toBe('aborted');
    const bad = await requestJson(async () => ({ status: 200, json: async () => Promise.reject(new SyntaxError('x')) }), { url: 'u', method: 'GET', signal });
    expect(!bad.ok && bad.error.code).toBe('SF-AUTH-006');
  });

  it('fetchTransport forwards method, headers, body and credentials', async () => {
    const fetchFn = vi.fn(async () => ({ status: 200, json: async () => ({}) }));
    await fetchTransport(fetchFn)({ url: '/x', method: 'POST', headers: { a: 'b' }, body: 'q', credentials: 'include', signal });
    expect(fetchFn).toHaveBeenCalledWith('/x', { method: 'POST', signal, headers: { a: 'b' }, body: 'q', credentials: 'include' });
    expect(formBody({ a: '1', b: undefined, c: 'x y' })).toBe('a=1&c=x+y');
  });
});

describe('environment', () => {
  it('webStorage degrades when storage throws (Safari private mode)', () => {
    const throwing = { setItem: () => { throw new Error('QuotaExceeded'); } } as unknown as Storage;
    expect(webStorage(() => throwing)).toBeUndefined();
    expect(webStorage(() => undefined)).toBeUndefined();
    const ok = webStorage(() => globalThis.localStorage);
    ok?.set('k', 'v');
    expect(ok?.get('k')).toBe('v');
    ok?.remove('k');
    expect(ok?.get('k')).toBeUndefined();
  });

  it('broadcastChannelPort returns undefined without BroadcastChannel', () => {
    expect(broadcastChannelPort('x', {})).toBeUndefined();
    const port = broadcastChannelPort('x');
    expect(port === undefined || typeof port.post === 'function').toBe(true);
    port?.close();
  });

  it('memory channel hub delivers to peers but not to the sender', () => {
    const hub = createMemoryChannelHub();
    const a = hub.open('c');
    const b = hub.open('c');
    const other = hub.open('other');
    const seenA = vi.fn();
    const seenB = vi.fn();
    const seenOther = vi.fn();
    a.subscribe(seenA);
    b.subscribe(seenB);
    other.subscribe(seenOther);
    a.post({ hi: 1 });
    expect(seenA).not.toHaveBeenCalled();
    expect(seenB).toHaveBeenCalledWith({ hi: 1 });
    expect(seenOther).not.toHaveBeenCalled();
    b.close();
    a.post({ hi: 2 });
    expect(seenB).toHaveBeenCalledTimes(1);
  });

  it('test environment fires timers in order when advancing the clock', () => {
    const env = createTestAuthEnvironment({ start: 0 });
    const order: string[] = [];
    env.setTimer(() => order.push('b'), 20);
    env.setTimer(() => order.push('a'), 10);
    const cancel = env.setTimer(() => order.push('never'), 15);
    cancel();
    env.advance(25);
    expect(order).toEqual(['a', 'b']);
    expect(env.now()).toBe(25);
  });
});

describe('guest identity', () => {
  it('is stable across calls and persisted', () => {
    const env = createTestAuthEnvironment();
    const first = stableGuestId(env);
    expect(first).toMatch(/^guest-/);
    expect(stableGuestId(env)).toBe(first);
    expect(env.persistentStorage?.get(GUEST_ID_STORAGE_KEY)).toBe(first);
  });

  it('works without storage or WebCrypto (memory only)', () => {
    const id = stableGuestId({ persistentStorage: undefined, randomBytes: undefined, now: () => 5 });
    expect(id).toMatch(/^guest-/);
    const storage = memoryStorage({ [GUEST_ID_STORAGE_KEY]: 'guest-fixed' });
    expect(stableGuestId({ persistentStorage: storage, randomBytes: undefined, now: () => 5 })).toBe('guest-fixed');
  });
});

describe('session machine', () => {
  it('allows exactly the LIFECYCLES §9 transitions', () => {
    const m = createMachine(sessionMachine);
    expect(m.state).toBe('guest');
    expect(m.can('refresh')).toBe(false);
    expect(m.send('login').ok).toBe(true);
    expect(m.send('succeed').ok).toBe(true);
    expect(m.send('refresh').ok).toBe(true);
    expect(m.send('refreshed').ok).toBe(true);
    expect(m.send('expire').ok).toBe(true);
    expect(m.state).toBe('expired');
    expect(m.send('refresh').ok).toBe(false);
    expect(m.send('login').ok).toBe(true);
    expect(m.send('fail').ok).toBe(true);
    expect(m.state).toBe('guest');
    const r = createMachine(sessionMachine, { initial: 'authenticated' });
    expect(r.send('revoke').ok).toBe(true);
    expect(r.can('restore')).toBe(false);
    expect(r.send('logout').ok).toBe(true);
  });
});
