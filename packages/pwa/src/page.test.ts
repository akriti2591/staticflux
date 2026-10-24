import { createScope } from '@staticflux/core';
import type { SfManifest } from '@staticflux/loader';
import { createMemoryStore } from '@staticflux/storage';
import { describe, expect, it } from 'vitest';
import {
  backgroundSyncPlugin,
  consumeLaunchQueue,
  coordinateIsolationReload,
  createFakePageEnv,
  createFakeSwEnv,
  createMutationQueueClient,
  createServiceWorkerRuntime,
  createSwWarmup,
  FakeLaunchQueue,
  FakeServiceWorker,
  ISOLATION_RELOAD_KEY,
  type LaunchIntent,
  linkWorker,
  PWA_MESSAGE,
  type QueuedMutation,
  receiveNotificationIntents,
  receiveProtocolLaunch,
  receiveShareTarget,
  SHARE_ID_PARAM,
  type SharePayload,
  type SwPlugin,
} from './index.js';

const O = 'https://app.test';

function controlled(plugins: readonly SwPlugin[] = []) {
  const page = createFakePageEnv({ sync: false });
  const container = page.serviceWorker!;
  const sw = createFakeSwEnv({ routes: { [`${O}/assets/editor.11111111.js`]: 'e', [`${O}/assets/editor.11111111.css`]: 'c', [`${O}/assets/lib.22222222.js`]: 'l' } });
  const runtime = createServiceWorkerRuntime({ env: sw, config: { version: 'v', frameworkMajor: 1, precache: [], plugins } });
  runtime.attach();
  const worker = new FakeServiceWorker('activated');
  linkWorker(worker, sw.self, container);
  container.controller = worker;
  return { page, container, sw, runtime };
}

const manifest: SfManifest = {
  format: 'sf-manifest/1',
  buildId: 'b',
  base: '/assets/',
  chunks: {
    'feature:editor': { id: 'feature:editor', files: ['editor.11111111.js'], css: ['editor.11111111.css'], deps: ['lib:x'], tier: 'likely', load: 'lazy' },
    'lib:x': { id: 'lib:x', files: ['lib.22222222.js'], css: [], deps: [], tier: 'likely', load: 'lazy' },
  },
};

describe('warm bridge (page side)', () => {
  it('warms chunk closures through the SW and remembers what is warm', async () => {
    const { page, container, sw } = controlled();
    const warmup = createSwWarmup({ container, origin: O, manifest, facts: () => ({ saveData: page.saveData(), offline: !page.onLine() }) });
    expect(warmup.available).toBe(true);
    const report = await warmup.warmChunks(['feature:editor']);
    expect(report.ok && [...report.value.warmed].sort()).toEqual([`${O}/assets/editor.11111111.css`, `${O}/assets/editor.11111111.js`, `${O}/assets/lib.22222222.js`]);
    expect(warmup.isWarm('/assets/lib.22222222.js')).toBe(true);
    sw.network.calls.length = 0;
    const again = await warmup.warm(['/assets/lib.22222222.js']);
    expect(again.ok && again.value.cached).toEqual([`${O}/assets/lib.22222222.js`]);
    expect(sw.network.calls).toEqual([]); // known warm: no SW round trip
    const refreshed = await warmup.refresh();
    expect(refreshed.ok && refreshed.value.length).toBe(3);
    const unknown = await warmup.warmChunks(['feature:nope']);
    expect(!unknown.ok && unknown.error.code).toBe('SF-LOAD-001');
  });

  it('passes saveData/offline so the SW skips; no controller → SF-PWA-001 (caller falls back to modulepreload)', async () => {
    const { page, container } = controlled();
    page.saveDataOn = true;
    const warmup = createSwWarmup({ container, origin: O, facts: () => ({ saveData: page.saveData(), offline: false }) });
    const skipped = await warmup.warm(['/assets/lib.22222222.js']);
    expect(skipped.ok && skipped.value.skipped).toEqual([{ url: `${O}/assets/lib.22222222.js`, reason: 'save-data' }]);
    expect(warmup.isWarm('/assets/lib.22222222.js')).toBe(false);
    expect((await createSwWarmup({ container, origin: O }).warmChunks(['feature:editor'])).ok).toBe(true);
    container.controller = null;
    expect(warmup.available).toBe(false);
    const none = await warmup.warm(['/x']);
    expect(!none.ok && none.error.code).toBe('SF-PWA-001');
    expect((await warmup.refresh()).ok).toBe(false);
    const missing = await createSwWarmup({ container: undefined, origin: O }).warm(['/x']);
    expect(!missing.ok && missing.error.code).toBe('SF-PWA-001');
  });

  it('a silent SW times out with SF-PWA-010', async () => {
    const page = createFakePageEnv();
    const container = page.serviceWorker!;
    container.controller = new FakeServiceWorker('activated');
    const result = await createSwWarmup({ container, origin: O, timeoutMs: 5 }).warm(['/a.js']);
    expect(!result.ok && result.error.code).toBe('SF-PWA-010');
  });
});

describe('COOP/COEP one-time reload coordination', () => {
  it('reloads once after the SW takes control, then stops with SF-PWA-009 if still not isolated', async () => {
    const page = createFakePageEnv();
    const store = createMemoryStore<number>();
    let registered = 0;
    const register = async () => {
      registered += 1;
      setTimeout(() => page.serviceWorker!.setController(new FakeServiceWorker('activated')), 1);
      return { ok: true as const, value: undefined };
    };
    const first = await coordinateIsolationReload({ env: page, register, store, now: () => 5 });
    expect(first).toEqual({ ok: true, value: 'reloading' });
    expect(page.reloads).toBe(1);
    expect(await store.get(ISOLATION_RELOAD_KEY)).toEqual({ ok: true, value: 5 });
    const second = await coordinateIsolationReload({ env: page, register, store });
    expect(!second.ok && second.error.code).toBe('SF-PWA-009');
    expect(page.reloads).toBe(1);
    expect(registered).toBe(1);
    page.isolated = true;
    expect(await coordinateIsolationReload({ env: page, register, store })).toEqual({ ok: true, value: 'isolated' });
    expect(await store.get(ISOLATION_RELOAD_KEY)).toEqual({ ok: true, value: undefined });
  });

  it('already controlled → reload right away; embedded / no SW → unsupported; never controlled → SF-PWA-009', async () => {
    const page = createFakePageEnv();
    page.serviceWorker!.controller = new FakeServiceWorker('activated');
    const ok = async () => ({ ok: true as const, value: undefined });
    expect(await coordinateIsolationReload({ env: page, register: ok, store: createMemoryStore() })).toEqual({ ok: true, value: 'reloading' });
    expect(await coordinateIsolationReload({ env: createFakePageEnv({ embedded: true }), register: ok, store: createMemoryStore() })).toEqual({ ok: true, value: 'unsupported' });
    expect(await coordinateIsolationReload({ env: createFakePageEnv({ serviceWorker: false }), register: ok, store: createMemoryStore() })).toEqual({ ok: true, value: 'unsupported' });
    const stuck = await coordinateIsolationReload({ env: createFakePageEnv(), register: ok, store: createMemoryStore(), timeoutMs: 5 });
    expect(!stuck.ok && stuck.error.code).toBe('SF-PWA-009');
  });
});

describe('mutation queue client (optional background sync)', () => {
  it('refuses non-idempotent mutations locally; queues idempotent ones; replays on online without Background Sync', async () => {
    const store = createMemoryStore<QueuedMutation>();
    const { page, container, sw } = controlled([backgroundSyncPlugin({ store })]);
    const scope = createScope('t');
    const client = createMutationQueueClient({ container, scope, window: page.window!, registration: () => container.registration, now: () => 1 });
    const refused = await client.enqueue({ url: `${O}/api/x`, method: 'POST', idempotent: false });
    expect(!refused.ok && refused.error.code).toBe('SF-PWA-008');
    expect((await client.enqueue({ id: 'm1', url: `${O}/api/x`, method: 'PUT', body: '{}', idempotent: true })).ok).toBe(true);
    const queued = await store.seek().toArray();
    expect(queued.ok && queued.value.map(([, m]) => m.id)).toEqual(['m1']);
    sw.network.set(`${O}/api/x`, 'ok');
    page.goOnline();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(sw.network.calls.map((c) => c.url)).toEqual([`${O}/api/x`]);
    expect(await client.replay()).toEqual({ ok: true, value: { replayed: 0, dropped: 0, remaining: 0 } });
    await scope.dispose();
    expect(page.windowTarget.count()).toBe(0);
  });

  it('registers a Background Sync tag where available; no controller → SF-PWA-001', async () => {
    const store = createMemoryStore<QueuedMutation>();
    const { container } = controlled([backgroundSyncPlugin({ store })]);
    const page = createFakePageEnv({ sync: true });
    const reg = page.serviceWorker!.registration;
    const scope = createScope('t');
    const client = createMutationQueueClient({ container, scope, registration: () => reg });
    expect((await client.enqueue({ url: `${O}/api/x`, method: 'DELETE', idempotent: true })).ok).toBe(true);
    expect(reg.syncTags).toEqual(['sf-pwa/replay']);
    container.controller = null;
    const none = await client.enqueue({ url: `${O}/api/x`, method: 'DELETE', idempotent: true });
    expect(!none.ok && none.error.code).toBe('SF-PWA-001');
    expect((await client.replay()).ok).toBe(false);
  });

  it('a SW without the plugin refuses → typed error', async () => {
    const { container } = controlled([]);
    const client = createMutationQueueClient({ container, scope: createScope('t'), timeoutMs: 5 });
    const result = await client.enqueue({ url: `${O}/api/x`, method: 'PUT', idempotent: true });
    expect(!result.ok && result.error.code).toBe('SF-PWA-010');
  });
});

describe('launch receivers → intent port', () => {
  const port = () => {
    const delivered: LaunchIntent[] = [];
    return { delivered, deliver: (intent: LaunchIntent) => delivered.push(intent) };
  };

  it('consumes launchQueue (links and files); unsupported → false; scope dispose detaches', async () => {
    const queue = new FakeLaunchQueue();
    const intents = port();
    const scope = createScope('t');
    expect(consumeLaunchQueue({ launchQueue: queue, intents, scope })).toBe(true);
    queue.launch({ targetURL: `${O}/doc/1` });
    queue.launch({ targetURL: `${O}/open`, files: [{ name: 'a.studio' }] });
    queue.launch({});
    expect(intents.delivered).toEqual([
      { kind: 'link', url: `${O}/doc/1`, source: 'launch-queue' },
      { kind: 'files', url: `${O}/open`, files: [{ name: 'a.studio' }], source: 'file-handler' },
    ]);
    await scope.dispose();
    queue.launch({ targetURL: `${O}/doc/2` });
    expect(intents.delivered).toHaveLength(2);
    expect(consumeLaunchQueue({ launchQueue: undefined, intents })).toBe(false);
  });

  it('GET share target: reads declared params, strips them, delivers a share intent (prefill data only)', async () => {
    const intents = port();
    const stripped: string[] = [];
    const params = { title: 'title', text: 'text', url: 'link' };
    const r = await receiveShareTarget({ href: `${O}/share?title=T&link=https%3A%2F%2Fx.test&keep=1`, action: '/share', params, intents, strip: (h) => stripped.push(h) });
    expect(r).toEqual({ ok: true, value: true });
    expect(intents.delivered).toEqual([{ kind: 'share', url: `${O}/share?keep=1`, files: [], source: 'share-target', title: 'T', sharedUrl: 'https://x.test' }]);
    expect(stripped).toEqual([`${O}/share?keep=1`]);
    expect(await receiveShareTarget({ href: `${O}/other?title=T`, action: '/share', params, intents })).toEqual({ ok: true, value: false });
    expect(await receiveShareTarget({ href: `${O}/share`, action: '/share', params, intents })).toEqual({ ok: true, value: false });
  });

  it('POST share target: consume-once payload from the SW store', async () => {
    const intents = port();
    const store = createMemoryStore<SharePayload>({ clone: false });
    await store.set('abc', { text: 'hello', files: [{ name: 'a.png' }], receivedAt: 1 });
    const href = `${O}/share?${SHARE_ID_PARAM}=abc`;
    expect(await receiveShareTarget({ href, action: '/share', params: {}, intents, store })).toEqual({ ok: true, value: true });
    expect(intents.delivered[0]).toEqual({ kind: 'share', url: `${O}/share`, files: [{ name: 'a.png' }], source: 'share-target', text: 'hello' });
    const again = await receiveShareTarget({ href, action: '/share', params: {}, intents, store });
    expect(!again.ok && again.error.code).toBe('SF-PWA-011');
  });

  it('protocol handler launches and notification clicks become link intents (same-origin only)', async () => {
    const intents = port();
    expect(receiveProtocolLaunch({ href: `${O}/open?url=web%2Bstudio%3A%2F%2Fdoc%2F7`, path: '/open', intents })).toBe(true);
    expect(receiveProtocolLaunch({ href: `${O}/open`, path: '/open', intents })).toBe(false);
    expect(receiveProtocolLaunch({ href: `${O}/x?url=1`, path: '/open', intents })).toBe(false);
    const page = createFakePageEnv();
    const scope = createScope('t');
    expect(receiveNotificationIntents({ container: page.serviceWorker, intents, scope, origin: O })).toBe(true);
    page.serviceWorker!.receive({ type: PWA_MESSAGE.notificationClick, url: '/doc/1' });
    page.serviceWorker!.receive({ type: PWA_MESSAGE.notificationClick, url: 'https://evil.test/' });
    page.serviceWorker!.receive({ type: 'other' });
    expect(intents.delivered).toEqual([
      { kind: 'link', url: 'web+studio://doc/7', source: 'protocol' },
      { kind: 'link', url: `${O}/doc/1`, source: 'notification' },
    ]);
    await scope.dispose();
    expect(page.serviceWorker!.count()).toBe(0);
    expect(receiveNotificationIntents({ container: undefined, intents, scope, origin: O })).toBe(false);
  });
});
