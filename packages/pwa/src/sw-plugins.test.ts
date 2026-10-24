import { createMemoryStore } from '@staticflux/storage';
import { describe, expect, it } from 'vitest';
import {
  backgroundSyncPlugin,
  COEP_HEADER,
  coepHeadersPlugin,
  COOP_HEADER,
  CORP_HEADER,
  createCoepServiceWorker,
  createFakeSwEnv,
  createServiceWorkerRuntime,
  FakeClient,
  FakeResponse,
  fakeRequest,
  fakeResponseFactory,
  parsePushPayload,
  pushPlugin,
  PWA_MESSAGE,
  type QueuedMutation,
  safeClickUrl,
  SHARE_ID_PARAM,
  type SharePayload,
  shareTargetPlugin,
  withIsolationHeaders,
} from './index.js';

const O = 'https://app.test';

describe('COOP/COEP service worker plugin (R11.16a)', () => {
  it('adds COOP/COEP to documents/workers and CORP to same-origin subresources; leaves opaque responses alone', () => {
    const doc = withIsolationHeaders(new FakeResponse('<html>'), fakeRequest(`${O}/`, { mode: 'navigate' }), fakeResponseFactory, O);
    expect(doc.headers.get(COOP_HEADER)).toBe('same-origin');
    expect(doc.headers.get(COEP_HEADER)).toBe('require-corp');
    const worker = withIsolationHeaders(new FakeResponse(''), fakeRequest(`${O}/w.js`, { destination: 'worker' }), fakeResponseFactory, O, { coep: 'credentialless' });
    expect(worker.headers.get(COEP_HEADER)).toBe('credentialless');
    const img = withIsolationHeaders(new FakeResponse(''), fakeRequest(`${O}/a.png`, { destination: 'image' }), fakeResponseFactory, O);
    expect(img.headers.get(CORP_HEADER)).toBe('same-origin');
    expect(img.headers.get(COEP_HEADER)).toBeNull();
    const opaque = new FakeResponse('', { status: 0, type: 'opaque' });
    expect(withIsolationHeaders(opaque, fakeRequest('https://cdn.test/a.png'), fakeResponseFactory, O)).toBe(opaque);
    const preset = new FakeResponse('', { headers: { [COOP_HEADER]: 'same-origin', [COEP_HEADER]: 'credentialless' } });
    expect(withIsolationHeaders(preset, fakeRequest(`${O}/`, { mode: 'navigate' }), fakeResponseFactory, O)).toBe(preset);
    const cross = new FakeResponse('', { type: 'cors' });
    expect(withIsolationHeaders(cross, fakeRequest('https://cdn.test/a.js'), fakeResponseFactory, O)).toBe(cross);
    const noCorp = new FakeResponse('');
    expect(withIsolationHeaders(noCorp, fakeRequest(`${O}/a.js`), fakeResponseFactory, O, { corp: false })).toBe(noCorp);
  });

  it('standalone COEP SW passes every GET through the network with headers; non-GET untouched', async () => {
    const env = createFakeSwEnv({ routes: { [`${O}/`]: '<html>', [`${O}/app.abcdef12.js`]: 'js' } });
    createCoepServiceWorker({ env }).attach();
    await env.self.install();
    await env.self.activate();
    expect(env.self.claimCalls).toBe(1);
    const page = await env.self.fetch(fakeRequest(`${O}/`, { mode: 'navigate' }));
    expect(page?.headers.get(COEP_HEADER)).toBe('require-corp');
    await env.self.fetch(fakeRequest(`${O}/app.abcdef12.js`));
    await env.self.fetch(fakeRequest(`${O}/app.abcdef12.js`));
    expect(env.network.calls.filter((c) => c.url.endsWith('.js'))).toHaveLength(2); // no caching
    expect(await env.self.fetch(fakeRequest(`${O}/api`, { method: 'POST' }))).toBeUndefined();
  });

  it('as a plugin of the full runtime it also rewrites cached responses', async () => {
    const env = createFakeSwEnv({ routes: { [`${O}/index.html`]: 'shell' } });
    const rt = createServiceWorkerRuntime({
      env,
      config: { version: 'v', frameworkMajor: 1, precache: [{ url: '/index.html', revision: 'v' }], plugins: [coepHeadersPlugin()] },
    });
    rt.attach();
    await env.self.install();
    const res = await env.self.fetch(fakeRequest(`${O}/index.html`, { destination: 'document' }));
    expect(res?.headers.get(COOP_HEADER)).toBe('same-origin');
  });
});

describe('background sync plugin (optional)', () => {
  const mutation = (id: string, overrides: Partial<QueuedMutation> = {}): QueuedMutation => ({
    id,
    url: `${O}/api/docs/${id}`,
    method: 'PUT',
    body: '{}',
    idempotent: true,
    idempotencyKey: `k-${id}`,
    queuedAt: 1000 + Number(id.replace(/\D/g, '') || 0),
    ...overrides,
  });

  async function setup() {
    const env = createFakeSwEnv();
    const store = createMemoryStore<QueuedMutation>();
    const plugin = backgroundSyncPlugin({ store, maxAttempts: 2 });
    const rt = createServiceWorkerRuntime({ env, config: { version: 'v', frameworkMajor: 1, precache: [], plugins: [plugin] } });
    rt.attach();
    const client = new FakeClient('c', `${O}/`);
    env.self.clientList.push(client);
    return { env, store, client };
  }

  it('queues only idempotent mutations and replays in order on sync', async () => {
    const { env, store, client } = await setup();
    await env.self.message({ type: PWA_MESSAGE.queueMutation, id: 'q1', mutation: mutation('m1') }, client);
    await env.self.message({ type: PWA_MESSAGE.queueMutation, id: 'q2', mutation: mutation('m2', { idempotent: false }) }, client);
    await env.self.message({ type: PWA_MESSAGE.queueMutation, id: 'q3', mutation: mutation('m3') }, client);
    expect(client.messages.slice(0, 3)).toEqual([
      { type: PWA_MESSAGE.queued, id: 'q1', queued: true },
      { type: PWA_MESSAGE.queued, id: 'q2', queued: false, reason: 'not-idempotent' },
      { type: PWA_MESSAGE.queued, id: 'q3', queued: true },
    ]);
    env.network.set(`${O}/api/docs/m1`, new FakeResponse('', { status: 204 }));
    env.network.set(`${O}/api/docs/m3`, new FakeResponse('', { status: 200 }));
    const settled = await env.self.dispatch('sync', { tag: 'sf-pwa/replay' });
    expect(settled.every((s) => s.status === 'fulfilled')).toBe(true);
    expect(env.network.calls.map((c) => c.url)).toEqual([`${O}/api/docs/m1`, `${O}/api/docs/m3`]);
    expect(env.network.calls[0]?.init).toMatchObject({ method: 'PUT', headers: { 'Idempotency-Key': 'k-m1' } });
    expect(client.messages.at(-1)).toEqual({ type: PWA_MESSAGE.replayed, replayed: 2, dropped: 0, remaining: 0 });
    expect((await store.seek().keys()).ok).toBe(true);
    expect(await store.seek().toArray()).toEqual({ ok: true, value: [] });
  });

  it('stops at retryable failures (sync rejects → browser retries), drops 4xx, expired and over-attempts', async () => {
    const { env, store, client } = await setup();
    for (const id of ['m1', 'm2', 'm3']) await env.self.message({ type: PWA_MESSAGE.queueMutation, id, mutation: mutation(id) }, client);
    env.network.set(`${O}/api/docs/m1`, new FakeResponse('', { status: 409 }));
    env.network.set(`${O}/api/docs/m2`, new FakeResponse('', { status: 503 }));
    env.network.set(`${O}/api/docs/m3`, new FakeResponse('', { status: 429 }));
    const first = await env.self.dispatch('sync', { tag: 'sf-pwa/replay' });
    expect(first[0]?.status).toBe('rejected');
    expect(client.messages.at(-1)).toMatchObject({ replayed: 0, dropped: 1, remaining: 2 });
    expect(env.network.calls.map((c) => c.url)).not.toContain(`${O}/api/docs/m3`); // order preserved
    await env.self.dispatch('sync', { tag: 'sf-pwa/replay' }); // m2 reaches maxAttempts=2 → dropped
    expect(client.messages.at(-1)).toMatchObject({ dropped: 1, remaining: 1 });
    env.advance(25 * 60 * 60 * 1000); // m3 now expired
    await env.self.message({ type: PWA_MESSAGE.replay, id: 'r' }, client);
    expect(client.messages.at(-1)).toEqual({ type: PWA_MESSAGE.replayed, id: 'r', replayed: 0, dropped: 1, remaining: 0 });
    expect((await store.seek().toArray()).ok && (await store.seek().keys())).toEqual({ ok: true, value: [] });
    // other sync tags are ignored
    expect(await env.self.dispatch('sync', { tag: 'other' })).toEqual([]);
  });

  it('network errors keep the entry for later', async () => {
    const { env, store, client } = await setup();
    await env.self.message({ type: PWA_MESSAGE.queueMutation, id: 'q', mutation: mutation('m1') }, client);
    env.network.offline = true;
    await env.self.message({ type: PWA_MESSAGE.replay, id: 'r' }, client);
    expect(client.messages.at(-1)).toMatchObject({ replayed: 0, remaining: 1 });
    const left = await store.seek().toArray();
    expect(left.ok && left.value[0]?.[1].attempts).toBe(1);
  });
});

describe('push plugin (optional)', () => {
  it('shows a notification from the payload, with a fallback title', async () => {
    const env = createFakeSwEnv();
    createServiceWorkerRuntime({ env, config: { version: 'v', frameworkMajor: 1, precache: [], plugins: [pushPlugin({ fallbackTitle: 'Studio', defaultIcon: '/i.png' })] } }).attach();
    await env.self.dispatch('push', { data: { json: () => ({ title: 'Comment', body: 'Hi', url: '/doc/1', tag: 't' }), text: () => '' } });
    await env.self.dispatch('push', { data: { json: () => { throw new Error('bad'); }, text: () => '' } });
    expect(env.self.notifications).toEqual([
      { title: 'Comment', options: { body: 'Hi', tag: 't', icon: '/i.png', data: { url: '/doc/1' } } },
      { title: 'Studio', options: { icon: '/i.png', data: { url: undefined } } },
    ]);
    expect(parsePushPayload({ title: '' })).toBeUndefined();
    expect(parsePushPayload(null)).toBeUndefined();
  });

  it('notificationclick focuses an open client with a same-origin URL intent, else opens a window', async () => {
    const env = createFakeSwEnv();
    createServiceWorkerRuntime({ env, config: { version: 'v', frameworkMajor: 1, precache: [], plugins: [pushPlugin({ fallbackTitle: 'S' })] } }).attach();
    let closed = 0;
    const click = (url: unknown) => env.self.dispatch('notificationclick', { notification: { data: { url }, close: () => (closed += 1) } });
    await click('/doc/1');
    expect(env.self.opened).toEqual([`${O}/doc/1`]);
    const client = new FakeClient('c', `${O}/studio`);
    env.self.clientList.push(client);
    await click('https://evil.test/phish');
    expect(client.messages).toEqual([{ type: PWA_MESSAGE.notificationClick, url: `${O}/` }]);
    expect(client.focused).toBe(1);
    expect(closed).toBe(2);
    expect(safeClickUrl(42, O, '/')).toBe(`${O}/`);
  });
});

describe('share target plugin (optional, POST with files)', () => {
  it('stores the multipart payload and redirects 303 with a consume-once id', async () => {
    const env = createFakeSwEnv();
    const store = createMemoryStore<SharePayload>({ clone: false });
    const plugin = shareTargetPlugin({ action: '/share', params: { title: 'title', text: 'text', url: 'url', files: 'files' }, store, id: () => 'abc' });
    createServiceWorkerRuntime({ env, config: { version: 'v', frameworkMajor: 1, precache: [], plugins: [plugin] } }).attach();
    const file = { name: 'a.png', size: 3 };
    const res = await env.self.fetch(fakeRequest(`${O}/share`, { method: 'POST', form: { title: 'T', text: '', files: [file, 'not-a-file'] } }));
    expect(res?.status).toBe(303);
    expect(res?.headers.get('location')).toBe(`${O}/share?${SHARE_ID_PARAM}=abc`);
    const stored = await store.get('abc');
    expect(stored.ok && stored.value).toEqual({ title: 'T', files: [file], receivedAt: 1000 });
    // other POSTs and GETs are not claimed
    expect(await env.self.fetch(fakeRequest(`${O}/other`, { method: 'POST', form: {} }))).toBeUndefined();
  });
});
