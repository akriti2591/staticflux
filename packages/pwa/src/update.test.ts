import { createMemorySink, createTelemetry, err, ok, type Result, sfError } from '@staticflux/core';
import { describe, expect, it, vi } from 'vitest';
import {
  createFakePageEnv,
  createFakeSwEnv,
  createPwaUpdater,
  createServiceWorkerRuntime,
  FakeServiceWorker,
  linkWorker,
  PWA_MESSAGE,
  type PwaUpdaterOptions,
  type ReinitializePort,
  type UpdateInfo,
  type UpdatePromptPort,
} from './index.js';

function world(options: { readonly nextMajor?: number; readonly controlled?: boolean; readonly linkNext?: boolean } = {}) {
  const page = createFakePageEnv();
  const container = page.serviceWorker!;
  const reg = container.registration;
  const activeEnv = createFakeSwEnv();
  createServiceWorkerRuntime({ env: activeEnv, config: { version: 'v1', frameworkMajor: 1, precache: [] } }).attach();
  const active = new FakeServiceWorker('activated');
  linkWorker(active, activeEnv.self, container);
  reg.active = active;
  if (options.controlled !== false) container.controller = active;

  const nextEnv = createFakeSwEnv();
  createServiceWorkerRuntime({ env: nextEnv, config: { version: 'v2', frameworkMajor: options.nextMajor ?? 1, precache: [] } }).attach();
  const next = new FakeServiceWorker('installing');
  if (options.linkNext !== false) linkWorker(next, nextEnv.self, container);
  // The browser activates the waiting worker when it calls skipWaiting().
  Object.assign(nextEnv.self, {
    skipWaiting: async () => {
      reg.waiting = null;
      reg.active = next;
      next.setState('activated');
      container.setController(next);
    },
  });
  return { page, container, reg, next, nextEnv };
}

const reinitPort = (result: Result<void> = ok()): ReinitializePort & { calls: unknown[] } => {
  const calls: unknown[] = [];
  return {
    calls,
    reinitialize: async (reason) => {
      calls.push(reason);
      return result;
    },
  };
};

function updater(w: ReturnType<typeof world>, extra: Partial<PwaUpdaterOptions> = {}) {
  return createPwaUpdater({ env: w.page, scriptUrl: '/sw.js', frameworkMajor: 1, versionTimeoutMs: 20, activationTimeoutMs: 50, ...extra });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('registration', () => {
  it('is feature-detected: embedded, disabled and missing SW → SF-PWA-001 and no registration', async () => {
    const embedded = createFakePageEnv({ embedded: true });
    const u1 = createPwaUpdater({ env: embedded, scriptUrl: '/sw.js', frameworkMajor: 1 });
    expect(u1.supported).toBe(false);
    const r1 = await u1.register();
    expect(!r1.ok && r1.error.code).toBe('SF-PWA-001');
    expect(!r1.ok && r1.error.details).toEqual({ reason: 'embedded' });
    expect(embedded.serviceWorker?.registerCalls).toEqual([]);
    const r2 = await createPwaUpdater({ env: createFakePageEnv(), scriptUrl: '/sw.js', frameworkMajor: 1, enabled: false }).register();
    expect(!r2.ok && r2.error.details).toEqual({ reason: 'disabled' });
    const r3 = await createPwaUpdater({ env: createFakePageEnv({ serviceWorker: false }), scriptUrl: '/sw.js', frameworkMajor: 1 }).register();
    expect(!r3.ok && r3.error.details).toEqual({ reason: 'no-service-worker' });
  });

  it('registers once with updateViaCache none; failures are SF-PWA-002', async () => {
    const w = world();
    const u = updater(w, { scope: '/', type: 'module' });
    expect((await u.register()).ok).toBe(true);
    expect((await u.register()).ok).toBe(true);
    expect(w.container.registerCalls).toEqual([{ url: '/sw.js', options: { scope: '/', type: 'module', updateViaCache: 'none' } }]);
    const w2 = world();
    w2.container.failRegister = new Error('SecurityError');
    const failed = await updater(w2).register();
    expect(!failed.ok && failed.error.code).toBe('SF-PWA-002');
  });
});

describe('update flow', () => {
  it('found by the browser → typed event → accept → skipWaiting → controllerchange → reinitialize (no reload)', async () => {
    const w = world();
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'verbose' });
    telemetry.addSink(sink);
    const reinit = reinitPort();
    const u = updater(w, { reinitialize: reinit, telemetry });
    const seen: UpdateInfo[] = [];
    u.onUpdateAvailable((info) => seen.push(info));
    await u.register();
    w.reg.startInstall(w.next);
    w.reg.finishInstall();
    await vi.waitFor(() => expect(u.state).toBe('available'));
    expect(seen).toEqual([{ version: 'v2', frameworkMajor: 1, currentFrameworkMajor: 1, reloadRequired: false }]);
    expect(u.info?.version).toBe('v2');
    const outcome = await u.accept();
    expect(outcome).toEqual({ ok: true, value: 'reinitialized' });
    expect(w.next.posted).toContainEqual({ type: PWA_MESSAGE.skipWaiting });
    expect(reinit.calls).toEqual([{ kind: 'sw-update', version: 'v2' }]);
    expect(w.page.reloads).toBe(0);
    expect(u.state).toBe('activated');
    const names = sink.records.filter((r) => r.type === 'event').map((r) => (r as { name: string }).name);
    expect(names).toEqual(
      expect.arrayContaining(['lifecycle.pwa/update.idle→available', 'lifecycle.pwa/update.available→activating', 'lifecycle.pwa/update.activating→activated']),
    );
  });

  it('a framework-major change reloads instead of reinitializing', async () => {
    const w = world({ nextMajor: 2 });
    const reinit = reinitPort();
    const u = updater(w, { reinitialize: reinit });
    await u.register();
    w.reg.startInstall(w.next);
    w.reg.finishInstall();
    await vi.waitFor(() => expect(u.info?.reloadRequired).toBe(true));
    expect(await u.accept()).toEqual({ ok: true, value: 'reloaded' });
    expect(reinit.calls).toEqual([]);
    expect(w.page.reloads).toBe(1);
  });

  it('an unknown version (SW does not answer) is treated as reload-required', async () => {
    const w = world({ linkNext: false });
    Object.assign(w.next, {
      postMessage: (m: unknown) => {
        if ((m as { type: string }).type === PWA_MESSAGE.skipWaiting) void w.nextEnv.self.skipWaiting();
      },
    });
    const u = updater(w, { reinitialize: reinitPort() });
    await u.register();
    w.reg.startInstall(w.next);
    w.reg.finishInstall();
    await vi.waitFor(() => expect(u.state).toBe('available'));
    expect(u.info).toMatchObject({ version: undefined, reloadRequired: true });
    expect(await u.accept()).toEqual({ ok: true, value: 'reloaded' });
  });

  it('reinitialize failure (or no port) falls back to reload', async () => {
    const w = world();
    const u = updater(w, { reinitialize: reinitPort(err(sfError({ code: 'SF-APP-009', kind: 'unknown', message: 'x' }))) });
    await u.register();
    w.reg.startInstall(w.next);
    w.reg.finishInstall();
    await vi.waitFor(() => expect(u.state).toBe('available'));
    expect(await u.accept()).toEqual({ ok: true, value: 'reloaded' });
    expect(w.page.reloads).toBe(1);

    const w2 = world();
    const u2 = updater(w2);
    await u2.register();
    w2.reg.startInstall(w2.next);
    w2.reg.finishInstall();
    await vi.waitFor(() => expect(u2.state).toBe('available'));
    expect(await u2.accept()).toEqual({ ok: true, value: 'reloaded' });
  });

  it('accept without a waiting worker is SF-PWA-005; activation timeout is SF-PWA-004 → failed → check again', async () => {
    const w = world();
    const u = updater(w);
    await u.register();
    const none = await u.accept();
    expect(!none.ok && none.error.code).toBe('SF-PWA-005');
    Object.assign(w.nextEnv.self, { skipWaiting: async () => undefined }); // never takes control
    w.reg.startInstall(w.next);
    w.reg.finishInstall();
    await vi.waitFor(() => expect(u.state).toBe('available'));
    const timedOut = await u.accept();
    expect(!timedOut.ok && timedOut.error.code).toBe('SF-PWA-004');
    expect(u.state).toBe('failed');
    expect(u.machine.can('check')).toBe(true);
  });

  it('check(): update() → installing → installed is available; nothing new returns to idle', async () => {
    const w = world();
    const u = updater(w);
    expect(await u.check()).toEqual({ ok: true, value: false }); // registers first
    expect(u.state).toBe('idle');
    w.reg.onUpdate = () => {
      w.reg.startInstall(w.next);
      setTimeout(() => w.reg.finishInstall(), 5);
    };
    expect(await u.check()).toEqual({ ok: true, value: true });
    expect(u.state).toBe('available');
    expect(await u.check()).toEqual({ ok: true, value: true });
    expect(w.reg.updates).toBe(2);
    w.reg.onUpdate = () => {
      throw new Error('offline');
    };
    const w2 = world();
    const u2 = updater(w2);
    await u2.register();
    w2.reg.onUpdate = () => {
      throw new Error('offline');
    };
    const failed = await u2.check();
    expect(!failed.ok && failed.error.code).toBe('SF-PWA-002');
    expect(u2.state).toBe('failed');
  });

  it('an already-waiting worker at registration is offered immediately', async () => {
    const w = world();
    w.reg.waiting = w.next;
    w.next.state = 'installed';
    const u = updater(w);
    await u.register();
    await vi.waitFor(() => expect(u.state).toBe('available'));
  });

  it('the prompt port drives accept / dismiss (dismissed updates are not offered again)', async () => {
    const w = world();
    const offers: UpdateInfo[] = [];
    const accepting: UpdatePromptPort = { offer: async (info) => (offers.push(info), 'accept') };
    const reinit = reinitPort();
    const u = updater(w, { prompt: accepting, reinitialize: reinit });
    await u.register();
    w.reg.startInstall(w.next);
    w.reg.finishInstall();
    await vi.waitFor(() => expect(u.state).toBe('activated'));
    expect(offers).toHaveLength(1);
    expect(reinit.calls).toHaveLength(1);

    const w2 = world();
    let count = 0;
    const u2 = updater(w2, { prompt: { offer: async () => ((count += 1), 'dismiss') } });
    await u2.register();
    w2.reg.startInstall(w2.next);
    w2.reg.finishInstall();
    await vi.waitFor(() => expect(count).toBe(1));
    await flush();
    expect(u2.state).toBe('available');
    w2.next.setState('installed');
    await u2.check();
    await flush();
    expect(count).toBe(1);
  });

  it('another tab activating the update takes this tab over too (reinitialize, no prompt needed)', async () => {
    const w = world();
    const reinit = reinitPort();
    const u = updater(w, { reinitialize: reinit });
    await u.register();
    w.reg.startInstall(w.next);
    w.reg.finishInstall();
    await vi.waitFor(() => expect(u.state).toBe('available'));
    await w.nextEnv.self.skipWaiting(); // other tab's accept
    await vi.waitFor(() => expect(u.state).toBe('activated'));
    expect(reinit.calls).toEqual([{ kind: 'sw-update', version: 'v2' }]);
  });

  it('first install: the initial clients.claim() controllerchange is not an update; waiting without controller is ignored', async () => {
    const w = world({ controlled: false });
    const reinit = reinitPort();
    const u = updater(w, { reinitialize: reinit });
    await u.register();
    w.reg.startInstall(w.next);
    w.reg.finishInstall();
    await flush();
    expect(u.state).toBe('idle');
    w.container.setController(w.next);
    await flush();
    expect(reinit.calls).toEqual([]);
    expect(w.page.reloads).toBe(0);
  });

  it('dispose removes every listener', async () => {
    const w = world();
    const u = updater(w);
    await u.register();
    w.reg.startInstall(w.next);
    const before = w.container.count();
    expect(before).toBeGreaterThan(0);
    await u.dispose();
    expect(w.reg.count()).toBe(0);
    expect(w.container.count()).toBe(0);
    expect(w.next.count()).toBe(0);
  });
});
