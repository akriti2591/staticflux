import { createMemorySink, createScope, createTelemetry } from '@staticflux/core';
import type { SfManifest } from '@staticflux/loader';
import { describe, expect, it } from 'vitest';
import {
  cacheNames,
  createFakeSwEnv,
  createServiceWorkerRuntime,
  createWarmCache,
  FakeCacheStorage,
  FakeClient,
  FakeResponse,
  fakeRequest,
  isHashedUrl,
  lazyAssetRule,
  localeCatalogRule,
  PWA_MESSAGE,
  serviceWorkerConfigFromManifest,
  type ServiceWorkerConfig,
  wasmRules,
} from './index.js';

const O = 'https://app.test';

function config(overrides: Partial<ServiceWorkerConfig> = {}): ServiceWorkerConfig {
  return {
    version: 'b2',
    frameworkMajor: 1,
    precache: [
      { url: '/assets/boot.abcdef12.js', revision: null },
      { url: '/index.html', revision: 'b2' },
    ],
    navigation: { fallbackUrl: '/index.html', timeoutMs: 50 },
    ...overrides,
  };
}

function routes(): Record<string, string> {
  return { [`${O}/assets/boot.abcdef12.js`]: 'boot', [`${O}/index.html`]: '<html>shell</html>' };
}

describe('precache install / activation', () => {
  it('installs every critical file into the versioned precache and activates', async () => {
    const env = createFakeSwEnv({ routes: routes() });
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'verbose' });
    telemetry.addSink(sink);
    const rt = createServiceWorkerRuntime({ env, config: config(), telemetry });
    expect(rt.state).toBe('idle');
    const installed = await rt.install();
    expect(installed.ok && installed.value).toEqual({ cacheName: 'sf-precache-b2', fetched: 2, copied: 0 });
    expect(rt.state).toBe('installed');
    expect([...env.caches.caches.get('sf-precache-b2')!.entries.keys()].sort()).toEqual([`${O}/assets/boot.abcdef12.js`, `${O}/index.html`]);
    // revisioned files bypass the HTTP cache
    expect(env.network.calls.every((c) => c.init?.cache === 'reload')).toBe(true);
    const client = new FakeClient('c1', `${O}/`);
    env.self.clientList.push(client);
    const activated = await rt.activate();
    expect(activated.ok).toBe(true);
    expect(rt.state).toBe('activated');
    expect(env.self.preloadEnabled).toBe(true);
    expect(env.self.claimCalls).toBe(1);
    expect(env.self.skipWaitingCalls).toBe(0); // never on its own
    expect(client.messages).toEqual([{ type: PWA_MESSAGE.activated, version: 'b2', frameworkMajor: 1 }]);
    const names = sink.records.filter((r) => r.type === 'event').map((r) => (r as { name: string }).name);
    expect(names).toEqual(expect.arrayContaining(['lifecycle.pwa/sw-lifecycle.idle→installing', 'lifecycle.pwa/sw-lifecycle.activating→activated']));
  });

  it('is atomic: one failing file deletes the partial cache and fails the install', async () => {
    const env = createFakeSwEnv({ routes: { [`${O}/index.html`]: 'x' } });
    const rt = createServiceWorkerRuntime({ env, config: config() });
    const result = await rt.install();
    expect(!result.ok && result.error.code).toBe('SF-PWA-003');
    expect(rt.state).toBe('failed');
    expect(env.caches.caches.has('sf-precache-b2')).toBe(false);
    // retry is a valid transition
    env.network.set(`${O}/assets/boot.abcdef12.js`, 'boot');
    expect((await rt.install()).ok).toBe(true);
  });

  it('rejects opaque responses and network errors', async () => {
    const env = createFakeSwEnv({ routes: { ...routes(), [`${O}/index.html`]: new FakeResponse('', { status: 0, type: 'opaque' }) } });
    expect((await createServiceWorkerRuntime({ env, config: config() }).install()).ok).toBe(false);
    const offline = createFakeSwEnv({ routes: routes() });
    offline.network.offline = true;
    expect((await createServiceWorkerRuntime({ env: offline, config: config() }).install()).ok).toBe(false);
  });

  it('copies unchanged hashed files from the previous precache and cleans stale caches on activation', async () => {
    const env = createFakeSwEnv({ routes: routes() });
    await createServiceWorkerRuntime({ env, config: config({ version: 'b1' }) }).install();
    (await env.caches.open('sf-rt-old-rule')).entries.set('x', new FakeResponse('x'));
    (await env.caches.open('third-party')).entries.set('y', new FakeResponse('y'));
    env.network.calls.length = 0;
    const rt = createServiceWorkerRuntime({ env, config: config({ version: 'b2' }) });
    const installed = await rt.install();
    expect(installed.ok && installed.value).toMatchObject({ fetched: 1, copied: 1 });
    expect(env.network.calls.map((c) => c.url)).toEqual([`${O}/index.html`]);
    expect(await env.caches.keys()).toContain('sf-precache-b1'); // old version stays until activation
    const activated = await rt.activate();
    expect(activated.ok && [...activated.value.deleted].sort()).toEqual(['sf-precache-b1', 'sf-rt-old-rule']);
    expect(await env.caches.keys()).toContain('third-party'); // never touches foreign caches
  });

  it('invalid lifecycle events are typed errors', async () => {
    const env = createFakeSwEnv({ routes: routes() });
    const rt = createServiceWorkerRuntime({ env, config: config() });
    await rt.install();
    await rt.activate();
    const again = await rt.activate();
    expect(!again.ok && again.error.code).toBe('SF-CORE-010');
  });
});

describe('fetch routing', () => {
  async function ready(overrides: Partial<ServiceWorkerConfig> = {}, extraRoutes: Record<string, string | FakeResponse> = {}) {
    const env = createFakeSwEnv({ routes: { ...routes(), ...extraRoutes } });
    const rt = createServiceWorkerRuntime({ env, config: config(overrides) });
    rt.attach();
    await env.self.install();
    await env.self.activate();
    env.network.calls.length = 0;
    return { env, rt };
  }

  it('serves precached files cache-first without the network', async () => {
    const { env } = await ready();
    const res = await env.self.fetch(fakeRequest(`${O}/assets/boot.abcdef12.js`));
    expect(res?.body).toBe('boot');
    expect(env.network.calls).toEqual([]);
  });

  it('navigations: network-first, preload response preferred, app-shell fallback offline, 503 without fallback', async () => {
    const { env } = await ready({}, { [`${O}/studio`]: 'fresh page' });
    const nav = fakeRequest(`${O}/studio`, { mode: 'navigate' });
    expect((await env.self.fetch(nav))?.body).toBe('fresh page');
    const preloaded = await env.self.fetch(nav, { preloadResponse: Promise.resolve(new FakeResponse('preloaded')) });
    expect(preloaded?.body).toBe('preloaded');
    env.network.offline = true;
    // the cached copy of /studio (last network/preload answer) wins over the shell
    expect((await env.self.fetch(nav))?.body).toBe('preloaded');
    expect((await env.self.fetch(fakeRequest(`${O}/never-seen`, { mode: 'navigate' })))?.body).toBe('<html>shell</html>');

    const bare = await ready({ navigation: {} });
    bare.env.network.offline = true;
    const res = await bare.env.self.fetch(fakeRequest(`${O}/x`, { mode: 'navigate' }));
    expect(res?.status).toBe(503);
  });

  it('navigation timeout falls back to cache, denylist and navigation:false are not handled', async () => {
    const { env } = await ready({ navigation: { fallbackUrl: '/index.html', timeoutMs: 5, denylist: ['/api/'] } });
    env.network.set(`${O}/slow`, () => new Promise((r) => setTimeout(() => r(new FakeResponse('late')), 50)));
    expect((await env.self.fetch(fakeRequest(`${O}/slow`, { mode: 'navigate' })))?.body).toBe('<html>shell</html>');
    expect(await env.self.fetch(fakeRequest(`${O}/api/me`, { mode: 'navigate' }))).toBeUndefined();
    const off = await ready({ navigation: false });
    expect(await off.env.self.fetch(fakeRequest(`${O}/x`, { mode: 'navigate' }))).toBeUndefined();
  });

  it('hashed same-origin chunks are cache-first in the warm cache; others pass through', async () => {
    const { env, rt } = await ready({}, { [`${O}/assets/editor.1234abcd.js`]: 'editor', [`${O}/data.json`]: '{}' });
    const req = fakeRequest(`${O}/assets/editor.1234abcd.js`);
    expect((await env.self.fetch(req))?.body).toBe('editor');
    await Promise.resolve();
    env.network.offline = true;
    expect((await env.self.fetch(req))?.body).toBe('editor');
    expect(await rt.warmCache?.has(`${O}/assets/editor.1234abcd.js`)).toBe(true);
    expect(await env.self.fetch(fakeRequest(`${O}/data.json`))).toBeUndefined();
    expect(await env.self.fetch(fakeRequest('https://cdn.test/lib.abcdef12.js'))).toBeUndefined();
    expect(await env.self.fetch(fakeRequest(`${O}/assets/x.abcdef12.js`, { method: 'POST' }))).toBeUndefined();
  });

  it('a cache-first miss with no network rejects (network error to the page)', async () => {
    const { env } = await ready();
    env.network.offline = true;
    await expect(env.self.fetch(fakeRequest(`${O}/assets/missing.abcdef12.js`))).rejects.toThrow(TypeError);
  });

  it('declared rules: locale catalogs stale-while-revalidate, Wasm cache-first, unhashed Wasm SWR', async () => {
    const { env } = await ready(
      { resources: [localeCatalogRule(), ...wasmRules(), lazyAssetRule('img', /\/img\//)] },
      { [`${O}/locales/de.json`]: 'v1', [`${O}/wasm/codec.1234abcd.wasm`]: 'wasm', [`${O}/wasm/plain.wasm`]: 'p1' },
    );
    const locale = fakeRequest(`${O}/locales/de.json`);
    expect((await env.self.fetch(locale))?.body).toBe('v1');
    env.network.set(`${O}/locales/de.json`, 'v2');
    expect((await env.self.fetch(locale))?.body).toBe('v1'); // stale served, revalidated in background
    await new Promise((r) => setTimeout(r, 0));
    expect((await env.self.fetch(locale))?.body).toBe('v2');
    expect(await env.caches.has('sf-rt-locales')).toBe(true);

    expect((await env.self.fetch(fakeRequest(`${O}/wasm/codec.1234abcd.wasm`)))?.body).toBe('wasm');
    expect(env.caches.caches.get('sf-warm')?.entries.has(`${O}/wasm/codec.1234abcd.wasm`)).toBe(true);
    expect((await env.self.fetch(fakeRequest(`${O}/wasm/plain.wasm`)))?.body).toBe('p1');
    expect(await env.caches.has('sf-rt-wasm-unhashed')).toBe(true);
  });

  it('serviceWorkerConfigFromManifest precaches only the critical closure plus fallbacks', () => {
    const manifest: SfManifest = {
      format: 'sf-manifest/1',
      buildId: 'b9',
      base: '/assets/',
      chunks: {
        'app:boot': { id: 'app:boot', files: ['boot.abcdef12.js'], css: ['boot.abcdef12.css'], deps: ['lib:core'], tier: 'critical', load: 'eager', reason: 'boot' },
        'lib:core': { id: 'lib:core', files: ['core.12345678.js'], css: [], deps: [], tier: 'likely', load: 'lazy' },
        'feature:editor': { id: 'feature:editor', files: ['editor.12345678.js'], css: [], deps: [], tier: 'likely', load: 'lazy' },
      },
    };
    const cfg = serviceWorkerConfigFromManifest(manifest, { frameworkMajor: 2, navigation: { fallbackUrl: '/index.html' }, extraUrls: ['/icons/192.png'] });
    expect(cfg.version).toBe('b9');
    expect(cfg.precache.map((e) => e.url)).toEqual(['/assets/core.12345678.js', '/assets/boot.abcdef12.js', '/assets/boot.abcdef12.css', '/icons/192.png', '/index.html']);
    expect(cfg.precache.find((e) => e.url === '/index.html')?.revision).toBe('b9');
    expect(isHashedUrl('/assets/x.abcdef12.js')).toBe(true);
    expect(isHashedUrl('/assets/x.js')).toBe(false);
  });
});

describe('message protocol and warm bridge (SW side)', () => {
  async function ready(overrides: Partial<ServiceWorkerConfig> = {}) {
    const env = createFakeSwEnv({
      routes: { ...routes(), [`${O}/assets/a.11111111.js`]: 'a', [`${O}/assets/b.22222222.js`]: 'b' },
    });
    const rt = createServiceWorkerRuntime({ env, config: config(overrides) });
    rt.attach();
    await env.self.install();
    await env.self.activate();
    const client = new FakeClient('c', `${O}/`);
    return { env, rt, client };
  }

  it('answers version requests and honours skip-waiting', async () => {
    const { env, client } = await ready();
    await env.self.message({ type: PWA_MESSAGE.getVersion, id: 'q1' }, client);
    expect(client.messages).toEqual([{ type: PWA_MESSAGE.version, id: 'q1', version: 'b2', frameworkMajor: 1 }]);
    await env.self.message({ type: PWA_MESSAGE.skipWaiting }, client);
    expect(env.self.skipWaitingCalls).toBe(1);
    await env.self.message({ type: 'other-lib' }, client);
    expect(client.messages).toHaveLength(1);
  });

  it('warms at low priority, dedupes, respects saveData/offline and same-origin, reports cached files', async () => {
    const { env, client } = await ready();
    env.network.calls.length = 0;
    await env.self.message(
      { type: PWA_MESSAGE.warm, id: 'w1', urls: ['/assets/a.11111111.js', '/assets/a.11111111.js', '/assets/boot.abcdef12.js', 'https://cdn.test/x.js', '/assets/missing.33333333.js'] },
      client,
    );
    expect(client.messages[0]).toEqual({
      type: PWA_MESSAGE.warmed,
      id: 'w1',
      warmed: [`${O}/assets/a.11111111.js`],
      cached: [`${O}/assets/boot.abcdef12.js`],
      skipped: [{ url: 'https://cdn.test/x.js', reason: 'cross-origin' }],
      failed: [`${O}/assets/missing.33333333.js`],
    });
    expect(env.network.calls.find((c) => c.url.endsWith('a.11111111.js'))?.init?.priority).toBe('low');
    await env.self.message({ type: PWA_MESSAGE.warm, id: 'w2', urls: ['/assets/b.22222222.js'], saveData: true }, client);
    await env.self.message({ type: PWA_MESSAGE.warm, id: 'w3', urls: ['/assets/b.22222222.js', '/assets/a.11111111.js'], offline: true }, client);
    expect(client.messages[1]).toMatchObject({ skipped: [{ reason: 'save-data' }] });
    expect(client.messages[2]).toMatchObject({ cached: [`${O}/assets/a.11111111.js`], skipped: [{ reason: 'offline' }] });
    // the warmed file is now served by the SW without the network
    env.network.offline = true;
    expect((await env.self.fetch(fakeRequest(`${O}/assets/a.11111111.js`)))?.body).toBe('a');
    await env.self.message({ type: PWA_MESSAGE.warmQuery, id: 'q', urls: ['/assets/a.11111111.js', '/assets/b.22222222.js'] }, client);
    expect(client.messages[3]).toEqual({ type: PWA_MESSAGE.warmState, id: 'q', warm: [`${O}/assets/a.11111111.js`] });
  });

  it('concurrent warm requests for one URL fetch once', async () => {
    const { env, rt } = await ready();
    env.network.calls.length = 0;
    await Promise.all([rt.warm(['/assets/b.22222222.js']), rt.warm(['/assets/b.22222222.js'])]);
    expect(env.network.calls.filter((c) => c.url.endsWith('b.22222222.js'))).toHaveLength(1);
  });

  it('warm:false disables the bridge', async () => {
    const { rt } = await ready({ warm: false });
    expect((await rt.warm(['/assets/a.11111111.js'])).skipped).toEqual([{ url: `${O}/assets/a.11111111.js`, reason: 'disabled' }]);
  });

  it('attach registers listeners on a scope; dispose removes them', async () => {
    const env = createFakeSwEnv();
    const scope = createScope('sw');
    createServiceWorkerRuntime({ env, config: config() }).attach(scope);
    expect(env.self.listenerCount()).toBe(4);
    await scope.dispose();
    expect(env.self.listenerCount()).toBe(0);
  });
});

describe('warm cache (LRU)', () => {
  it('evicts least-recently-used entries over the entry and byte caps', async () => {
    const caches = new FakeCacheStorage();
    let t = 0;
    const cache = createWarmCache({ caches, name: 'w', maxEntries: 2, maxBytes: 10, now: () => (t += 1) });
    const res = (body: string) => new FakeResponse(body, { headers: { 'content-length': String(body.length) } });
    expect(await cache.put('a', res('aaa'))).toBe(true);
    expect(await cache.put('b', res('bbb'))).toBe(true);
    await cache.match('a'); // a is now most recent
    await cache.put('c', res('ccc'));
    expect([...(await cache.urls())].sort()).toEqual(['a', 'c']);
    await cache.put('d', res('dddddddd')); // 3 + 8 > 10 → evict a
    expect(await cache.urls()).toEqual(['d']);
    expect(await cache.put('huge', res('x'.repeat(11)))).toBe(false);
    expect(await cache.put('bad', new FakeResponse('', { status: 500 }))).toBe(false);
    expect(cache.usage).toEqual({ entries: 1, bytes: 8 });
  });

  it('rebuilds its index from an existing cache (SW restart) and sizes bodies without content-length', async () => {
    const caches = new FakeCacheStorage();
    (await caches.open('w')).entries.set('old', new FakeResponse('x'));
    const cache = createWarmCache({ caches, name: 'w' });
    expect(await cache.has('old')).toBe(true);
    await cache.put('new', new FakeResponse('12345'));
    expect(cache.usage.bytes).toBe(5);
    expect(cacheNames('v', 'app').owns('app-warm')).toBe(true);
  });
});
