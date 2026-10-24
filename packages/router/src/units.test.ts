import { contribution, createInjector, ok } from '@staticflux/core';
import {
  bootApp,
  createFeatureHost,
  defineFeature,
  FeatureHostToken,
  FeatureManifestsToken,
  featureRef,
  runtimeUnits,
} from '@staticflux/runtime';
import { describe, expect, it, vi } from 'vitest';
import {
  bindCapability,
  block,
  defineDialog,
  defineRoute,
  defineStage,
  dialogUnit,
  featureHostDriver,
  type HistoryAdapter,
  HistoryAdapterToken,
  memoryHistoryUnitWith,
  modesPredicate,
  profileUnit,
  routerUnits,
  RouterToken,
  routeUnit,
  StagePluginsToken,
  stagePlugin,
  stagePluginUnit,
  stageUnit,
  proceed,
  browserHistoryUnit,
  routerUnitWith,
  memoryHistoryUnit,
  type Router,
  type MemoryHistory,
} from './index.js';

const desktop = featureRef('it/desktop');
const mobile = featureRef('it/mobile');
const home = defineRoute({ id: 'it/home', path: '/' });
const editor = defineRoute({
  id: 'it/editor',
  path: 'editor/:id',
  feature: bindCapability('it/editor', [{ feature: desktop }, { feature: mobile }]),
});
const share = defineDialog({ id: 'it/share', key: 'share', owner: editor });

function manifest(id: 'it/desktop' | 'it/mobile', modes: readonly string[], log: string[]) {
  return defineFeature({
    id,
    weight: 'warm',
    modes,
    load: async () => ({
      activate: () => void log.push(`activate:${id}`),
      mount: () => void log.push(`mount:${id}`),
      unmount: () => void log.push(`unmount:${id}`),
    }),
  });
}

describe('router DI units + runtime feature host', () => {
  it('boots with contributions, starts via the subsystem and drives the feature host', async () => {
    const log: string[] = [];
    const pluginRuns = vi.fn(() => proceed());
    const consent = defineStage({ id: 'it/consent', position: 'before:authorize' });
    const result = await bootApp({
      sleep: async () => ok(),
      units: [
        ...runtimeUnits,
        ...routerUnits,
        memoryHistoryUnitWith({ initial: '/editor/7' }),
        profileUnit(modesPredicate(() => ['compact'])),
        routeUnit(home),
        routeUnit(editor),
        dialogUnit(share),
        stageUnit(consent),
        stagePluginUnit(stagePlugin({ id: 'it/consent-plugin', stage: consent, run: pluginRuns })),
        contribution({ id: 'it/desktop-manifest', provides: FeatureManifestsToken, scope: 'app', create: () => manifest('it/desktop', ['expanded'], log) }),
        contribution({ id: 'it/mobile-manifest', provides: FeatureManifestsToken, scope: 'app', create: () => manifest('it/mobile', ['compact'], log) }),
      ],
    });
    if (!result.ok) throw result.error;
    const app = result.value;
    const router = (await app.injector.get(RouterToken)) as { ok: true; value: Router };
    expect(router.ok).toBe(true);
    await vi.waitFor(() => expect(router.value.current?.route).toBe(editor));
    const host = await app.injector.get(FeatureHostToken);
    if (!host.ok) throw host.error;
    expect(host.value.stateOf('it/mobile')).toBe('mounted');
    expect(host.value.stateOf('it/desktop')).toBe('declared');
    expect(log).toEqual(['activate:it/mobile', 'mount:it/mobile']);
    expect(pluginRuns).toHaveBeenCalledOnce();
    await router.value.navigate({ to: home });
    expect(host.value.stateOf('it/mobile')).toBe('activated'); // logic stays warm
    const history = await app.injector.get(HistoryAdapterToken);
    expect(history.ok && (history.value as MemoryHistory).entries.map((e) => e.url)).toEqual(['/editor/7', '/']);
    await app.shutdown();
  });

  it('invalid definitions fail the router unit (fail fast)', async () => {
    const injector = createInjector({ units: [routerUnitWith(), memoryHistoryUnit, routeUnit(home), routeUnit(home)] });
    const r = await injector.get(RouterToken);
    expect(r.ok).toBe(false);
  });

  it('browser history unit uses the window history; stage plugins contribute via the multi token', async () => {
    const injector = createInjector({
      units: [browserHistoryUnit, stagePluginUnit(stagePlugin({ id: 'it/deny', stage: 'authorize', run: () => block() }))],
    });
    const h = await injector.get(HistoryAdapterToken);
    expect(h.ok && (h.value as HistoryAdapter).kind).toMatch(/history|navigation/);
    const plugins = await injector.get(StagePluginsToken);
    expect(plugins.ok && plugins.value.map((p) => p.id)).toEqual(['it/deny']);
    await injector.dispose();
  });

  it('featureHostDriver reports activation kinds and releases by policy', async () => {
    const log: string[] = [];
    const host = createFeatureHost({ injector: createInjector(), features: [manifest('it/desktop', [], log)] });
    const driver = featureHostDriver(host, { targetFor: (route) => route.id });
    const released: string[] = [];
    driver.onReleased?.((id) => released.push(id));
    expect(driver.has('it/desktop')).toBe(true);
    expect(driver.modesOf('it/desktop')).toEqual([]);
    const signal = new AbortController().signal;
    expect(await driver.activate('it/desktop', signal)).toEqual({ ok: true, value: 'fresh' });
    expect(await driver.activate('it/desktop', signal)).toEqual({ ok: true, value: 'warm' });
    expect((await driver.mount('it/desktop', { route: editor, signal })).ok).toBe(true);
    expect((await driver.mount('it/desktop', { route: editor, signal })).ok).toBe(true);
    expect(driver.isMounted('it/desktop')).toBe(true);
    expect((await driver.release('it/desktop', 'hide')).ok).toBe(true);
    expect(host.stateOf('it/desktop')).toBe('hidden');
    expect((await driver.mount('it/desktop', { route: editor, signal })).ok).toBe(true);
    expect(host.stateOf('it/desktop')).toBe('mounted');
    expect((await driver.release('it/desktop', 'unmount')).ok).toBe(true);
    expect((await driver.release('it/desktop', 'unmount')).ok).toBe(true);
    expect(driver.isMounted('it/desktop')).toBe(false);
    expect(released).toEqual(['it/desktop']);
    expect(log).toEqual(['activate:it/desktop', 'mount:it/desktop', 'unmount:it/desktop']);
    await host.dispose();
  });
});
