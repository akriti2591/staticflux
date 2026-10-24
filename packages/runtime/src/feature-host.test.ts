import { createInjector, createMemorySink, createTelemetry, defineError, err, ok, type Scope, token, unit } from '@staticflux/core';
import { describe, expect, it, vi } from 'vitest';
import {
  createFeatureHost,
  createMemoryArchiveStore,
  defineFeature,
  defineFeatureModule,
  type FeatureHostOptions,
  type FeatureId,
  type FeatureLogicContext,
  type FeatureManifest,
  type FeatureModule,
  featureRef,
  type FeatureState,
} from './index.js';

const Boom = defineError('SF-TEST-FT', 'unavailable', 'boom', 'test');

interface DocStore {
  text: string;
  disposed: boolean;
}
const DocStoreToken = token('test/doc-store').type<DocStore>();
const AppConfigToken = token('test/app-config').type<{ name: string }>();

const appConfigUnit = unit({ id: 'test/app-config-unit', provides: AppConfigToken, scope: 'app', create: () => ({ name: 'studio' }) });

function docStoreUnit(onDispose: () => void = () => undefined) {
  return unit({
    id: 'test/doc-store-unit',
    provides: DocStoreToken,
    scope: 'feature',
    create: (_deps, ctx) => {
      const store: DocStore = { text: '', disposed: false };
      ctx.scope.defer(() => {
        store.disposed = true;
        onDispose();
      });
      return store;
    },
  });
}

function feature(id: FeatureId, module: FeatureModule = {}, extra: Partial<FeatureManifest> = {}) {
  const load = vi.fn(async () => module);
  const manifest = defineFeature({ id, weight: 'warm', load, ...extra });
  return { manifest, load };
}

function setup(options: Partial<FeatureHostOptions> = {}) {
  const injector = createInjector({ units: [appConfigUnit] });
  const sink = createMemorySink();
  const telemetry = createTelemetry({ defaultLevel: 'debug' });
  telemetry.addSink(sink);
  const host = createFeatureHost({ injector, telemetry, ...options });
  const transitions: string[] = [];
  host.onTransition(({ id, to }) => transitions.push(`${id}:${to}`));
  return { injector, host, sink, transitions };
}

describe('feature host: lifecycle', () => {
  it('walks declared → … → mounted ⇄ hidden → … → evicted', async () => {
    const { host, transitions } = setup();
    const { manifest } = feature('test/editor', { mount: () => undefined });
    host.register(manifest);
    expect(host.stateOf('test/editor')).toBe('declared');
    expect((await host.load('test/editor')).ok).toBe(true);
    expect(host.stateOf('test/editor')).toBe('loaded');
    expect((await host.mount('test/editor')).ok).toBe(true);
    expect((await host.hide('test/editor')).ok).toBe(true);
    expect(host.handle('test/editor')?.hidden).toBe(true);
    expect((await host.show('test/editor')).ok).toBe(true);
    expect((await host.unmount('test/editor')).ok).toBe(true);
    expect(host.stateOf('test/editor')).toBe('activated');
    expect((await host.deactivate('test/editor')).ok).toBe(true);
    expect((await host.evict('test/editor')).ok).toBe(true);
    const expected: FeatureState[] = [
      'loading',
      'loaded',
      'activating',
      'activated',
      'mounting',
      'mounted',
      'hidden',
      'mounted',
      'unmounting',
      'activated',
      'deactivating',
      'loaded',
      'evicted',
    ];
    expect(transitions).toEqual(expected.map((s) => `test/editor:${s}`));
    // evicted features reload on next use
    expect((await host.activate('test/editor')).ok).toBe(true);
    expect(host.stateOf('test/editor')).toBe('activated');
  });

  it('gives each activation a feature-scoped child injector with the feature units', async () => {
    const disposed = vi.fn();
    const { host } = setup();
    let ctx: FeatureLogicContext | undefined;
    const { manifest } = feature('test/editor', {
      units: [docStoreUnit(disposed)],
      activate: (c) => {
        ctx = c;
      },
    });
    host.register(manifest);
    const activated = await host.activate('test/editor');
    if (!activated.ok) throw activated.error;
    const featureInjector = activated.value;
    expect(featureInjector.level).toBe('feature');
    const store = await featureInjector.get(DocStoreToken);
    const config = await featureInjector.get(AppConfigToken);
    expect(store.ok && config.ok).toBe(true);
    expect(ctx?.injector).toBe(featureInjector);
    expect(ctx?.activation).toBe('fresh');
    expect(host.handle('test/editor')?.injector).toBe(featureInjector);
    await host.deactivate('test/editor');
    expect(disposed).toHaveBeenCalledOnce();
    expect(ctx?.signal.aborted).toBe(true);
    expect(host.handle('test/editor')?.injector).toBeUndefined();
  });

  it('separates logic, UI and visible scopes (hidden features keep DOM, drop effects)', async () => {
    const { host } = setup();
    const scopes: { logic?: Scope; ui?: Scope; visible: Scope[] } = { visible: [] };
    const hide = vi.fn();
    const unmount = vi.fn();
    const { manifest } = feature('test/editor', {
      activate: (c) => void (scopes.logic = c.scope),
      mount: (c) => void (scopes.ui = c.uiScope),
      visible: (_c, scope) => void scopes.visible.push(scope),
      hide,
      unmount,
    });
    host.register(manifest);
    await host.mount('test/editor', { target: 'host-element' });
    expect(scopes.visible).toHaveLength(1);
    await host.hide('test/editor');
    expect(scopes.visible[0]?.disposed).toBe(true);
    expect(scopes.ui?.disposed).toBe(false);
    expect(hide).toHaveBeenCalledOnce();
    await host.show('test/editor');
    expect(scopes.visible).toHaveLength(2);
    expect(scopes.visible[1]?.disposed).toBe(false);
    await host.unmount('test/editor');
    expect(unmount).toHaveBeenCalledOnce();
    expect(scopes.ui?.disposed).toBe(true);
    expect(scopes.visible[1]?.disposed).toBe(true);
    expect(scopes.logic?.disposed).toBe(false); // logic stays warm
  });

  it('passes the mount target and can mount straight into hidden', async () => {
    const { host } = setup();
    const visible = vi.fn();
    let target: unknown;
    const { manifest } = feature('test/editor', { mount: (c) => void (target = c.target), visible });
    host.register(manifest);
    await host.mount('test/editor', { target: 'slot:main', hidden: true });
    expect(target).toBe('slot:main');
    expect(host.stateOf('test/editor')).toBe('hidden');
    expect(visible).not.toHaveBeenCalled();
    await host.show('test/editor');
    expect(visible).toHaveBeenCalledOnce();
  });

  it('serializes concurrent operations; one load for many activations', async () => {
    const { host } = setup();
    const { manifest, load } = feature('test/editor');
    host.register(manifest);
    const results = await Promise.all([host.activate('test/editor'), host.activate('test/editor'), host.mount('test/editor')]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(load).toHaveBeenCalledOnce();
    expect(host.stateOf('test/editor')).toBe('mounted');
  });

  it('I-5: a mount queued behind a deactivation fails with SF-FT-001', async () => {
    const { host } = setup();
    const { manifest } = feature('test/editor');
    host.register(manifest);
    const mounting = host.mount('test/editor');
    const deactivating = host.deactivate('test/editor');
    const [mounted, deactivated] = await Promise.all([mounting, deactivating]);
    expect(deactivated.ok).toBe(true);
    expect(!mounted.ok && mounted.error.code).toBe('SF-FT-001');
    expect(host.stateOf('test/editor')).toBe('loaded');
  });

  it('rejects mount for headless features', async () => {
    const { host } = setup();
    const { manifest } = feature('test/sync', {}, { headless: true });
    host.register(manifest);
    const result = await host.mount('test/sync');
    expect(!result.ok && result.error.code).toBe('SF-FT-008');
    expect(host.stateOf('test/sync')).toBe('activated');
    expect(host.info('test/sync')?.explicit).toBe(true);
  });

  it('invalid transitions return SF-CORE-010', async () => {
    const { host } = setup();
    const { manifest } = feature('test/editor');
    host.register(manifest);
    await host.activate('test/editor');
    const hide = await host.hide('test/editor');
    expect(!hide.ok && hide.error.code).toBe('SF-CORE-010');
    const show = await host.show('test/editor');
    expect(!show.ok && show.error.code).toBe('SF-CORE-010');
  });
});

describe('feature host: failures', () => {
  it('load failure → failed (SF-FT-003); activating again retries', async () => {
    const { host } = setup();
    let attempt = 0;
    const manifest = defineFeature({
      id: 'test/editor',
      weight: 'cheap',
      load: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('chunk 404');
        return defineFeatureModule({});
      },
    });
    host.register(manifest);
    const first = await host.activate('test/editor');
    expect(!first.ok && first.error.code).toBe('SF-FT-003');
    expect(host.stateOf('test/editor')).toBe('failed');
    expect(host.info('test/editor')?.error?.code).toBe('SF-FT-003');
    const second = await host.activate('test/editor');
    expect(second.ok).toBe(true);
    expect(host.info('test/editor')?.error).toBeUndefined();
  });

  it('activation failure → failed (SF-FT-004), logic scope disposed; retry keeps the module', async () => {
    const { host } = setup();
    let fail = true;
    let scope: Scope | undefined;
    const { manifest, load } = feature('test/editor', {
      activate: (c) => {
        scope = c.scope;
        return fail ? err(Boom()) : ok();
      },
    });
    host.register(manifest);
    const first = await host.activate('test/editor');
    expect(!first.ok && first.error.code).toBe('SF-FT-004');
    expect(scope?.disposed).toBe(true);
    expect(host.stateOf('test/editor')).toBe('failed');
    fail = false;
    expect((await host.activate('test/editor')).ok).toBe(true);
    expect(load).toHaveBeenCalledOnce();
    // failed features can also be evicted
    fail = true;
    await host.deactivate('test/editor');
  });

  it('mount failure keeps logic warm (SF-FT-008)', async () => {
    const { host } = setup();
    const { manifest } = feature('test/editor', { mount: () => err(Boom()) });
    host.register(manifest);
    const result = await host.mount('test/editor');
    expect(!result.ok && result.error.code).toBe('SF-FT-008');
    expect(host.stateOf('test/editor')).toBe('activated');
  });

  it('a feature injector registration error fails activation', async () => {
    const { host } = setup();
    const { manifest } = feature('test/editor', { units: [appConfigUnit] }); // app-scoped unit in a feature injector
    host.register(manifest);
    const result = await host.activate('test/editor');
    expect(!result.ok && result.error.code).toBe('SF-FT-004');
  });

  it('unknown, duplicate and cyclic features are rejected', async () => {
    const { host } = setup();
    const unknown = await host.activate('test/nope');
    expect(!unknown.ok && unknown.error.code).toBe('SF-FT-005');
    const a = feature('test/a', {}, { requires: { features: [featureRef('test/b')] } });
    const b = feature('test/b', {}, { requires: { features: [featureRef('test/a')] } });
    expect(host.register(a.manifest).ok).toBe(true);
    const missingDep = await host.activate('test/a');
    expect(!missingDep.ok && missingDep.error.code).toBe('SF-FT-006');
    const cycle = host.register(b.manifest);
    expect(!cycle.ok && cycle.error.code).toBe('SF-FT-007');
    expect(host.has('test/b')).toBe(false);
    const dup = host.register(a.manifest);
    expect(!dup.ok && dup.error.code).toBe('SF-FT-007');
  });

  it('the I-1 gate rejects operations while paused', async () => {
    let paused = true;
    const { host } = setup({
      gate: (op) => (paused ? err(Boom({ message: op })) : ok()),
    });
    const { manifest } = feature('test/editor');
    host.register(manifest);
    const result = await host.activate('test/editor');
    expect(!result.ok && result.error.message).toBe('feature.activate');
    expect(host.stateOf('test/editor')).toBe('declared');
    paused = false;
    expect((await host.activate('test/editor')).ok).toBe(true);
  });
});

describe('feature host: ref-counting (I-6)', () => {
  const studioRef = featureRef('test/studio');

  function pair() {
    const ctx = setup();
    const studio = feature('test/studio', { units: [docStoreUnit()], mount: () => undefined });
    let chatCtx: FeatureLogicContext | undefined;
    const chat = feature('test/chat', { activate: (c) => void (chatCtx = c), mount: () => undefined }, { requires: { features: [studioRef] } });
    ctx.host.register(studio.manifest, chat.manifest);
    return { ...ctx, chatCtx: () => chatCtx };
  }

  it('activating a dependent activates its dependencies first and exposes their injector', async () => {
    const { host, transitions, chatCtx } = pair();
    await host.activate('test/chat');
    expect(transitions.indexOf('test/studio:activated')).toBeLessThan(transitions.indexOf('test/chat:activating'));
    expect(host.refCount('test/studio')).toBe(1);
    expect(host.info('test/studio')?.explicit).toBe(false);
    expect(host.info('test/chat')?.explicit).toBe(true);
    const dep = chatCtx()?.dependency(studioRef);
    expect(dep?.ok).toBe(true);
    if (dep?.ok === true) expect((await dep.value.get(DocStoreToken)).ok).toBe(true);
    const undeclared = chatCtx()?.dependency(featureRef('test/other'));
    expect(undeclared?.ok).toBe(false);
  });

  it('a dependency cannot deactivate while a dependent is mounted (SF-FT-002)', async () => {
    const { host } = pair();
    await host.mount('test/chat');
    expect(host.info('test/studio')?.mountedDependents).toEqual(['test/chat']);
    const blocked = await host.deactivate('test/studio');
    expect(!blocked.ok && blocked.error.code).toBe('SF-FT-002');
    const archive = await host.archive('test/studio');
    expect(!archive.ok && archive.error.code).toBe('SF-FT-002');
    expect(host.stateOf('test/studio')).toBe('activated');
    await host.unmount('test/chat');
    // dependents that are only activated are deactivated first (cascade)
    expect((await host.deactivate('test/studio')).ok).toBe(true);
    expect(host.stateOf('test/chat')).toBe('loaded');
    expect(host.stateOf('test/studio')).toBe('loaded');
    expect(host.refCount('test/studio')).toBe(0);
  });

  it('dispose tears down dependents first', async () => {
    const order: string[] = [];
    const { host } = setup();
    const studio = feature('test/studio', { deactivate: () => void order.push('studio'), mount: () => undefined });
    const chat = feature(
      'test/chat',
      { deactivate: () => void order.push('chat'), unmount: () => void order.push('chat-unmount'), mount: () => undefined },
      { requires: { features: [studioRef] } },
    );
    host.register(studio.manifest, chat.manifest);
    await host.mount('test/chat');
    await host.mount('test/studio');
    await host.dispose();
    expect(order).toEqual(['chat-unmount', 'chat', 'studio']);
    const after = await host.activate('test/chat');
    expect(after.ok).toBe(false);
  });
});

describe('feature host: archive', () => {
  it('heavy features snapshot on archive, drop the module, and restore on reactivation', async () => {
    const archive = createMemoryArchiveStore();
    const { host, sink } = setup({ archive });
    let state = { doc: 'draft' };
    const restore = vi.fn((data: unknown) => {
      state = data as typeof state;
    });
    const activations: string[] = [];
    const { manifest, load } = feature(
      'test/studio',
      {
        activate: (c) => void activations.push(c.activation),
        snapshot: () => state,
        restore,
      },
      { weight: 'heavy', snapshotVersion: 3 },
    );
    host.register(manifest);
    await host.activate('test/studio');
    state = { doc: 'edited' };
    expect((await host.archive('test/studio')).ok).toBe(true);
    expect(host.stateOf('test/studio')).toBe('archived');
    const stored = await archive.get('test/studio');
    expect(stored.ok && stored.value?.data).toEqual({ doc: 'edited' });
    expect(stored.ok && stored.value?.version).toBe(3);
    expect(stored.ok && stored.value?.format).toBe('sf-snapshot/1');
    state = { doc: 'lost' };
    await host.activate('test/studio');
    expect(load).toHaveBeenCalledTimes(2); // module was dropped
    expect(restore).toHaveBeenCalledWith({ doc: 'edited' }, 3, expect.anything());
    expect(state).toEqual({ doc: 'edited' });
    expect(activations).toEqual(['fresh', 'archived']);
    expect(archive.size).toBe(0); // consumed
    const activationMetric = sink.records.filter((r) => r.type === 'metric' && r.metric === 'runtime/feature-activation');
    expect(activationMetric.map((r) => (r.type === 'metric' ? r.attrs['activation'] : undefined))).toEqual(['fresh', 'archived']);
  });

  it('reactivation from loaded is classified warm', async () => {
    const { host } = setup();
    const kinds: string[] = [];
    const { manifest } = feature('test/editor', { activate: (c) => void kinds.push(c.activation) });
    host.register(manifest);
    await host.activate('test/editor');
    await host.deactivate('test/editor');
    await host.activate('test/editor');
    expect(kinds).toEqual(['fresh', 'warm']);
  });

  it('a failing restore fails the activation', async () => {
    const { host } = setup();
    const { manifest } = feature('test/studio', { snapshot: () => ({ a: 1 }), restore: () => err(Boom()) }, { weight: 'heavy' });
    host.register(manifest);
    await host.activate('test/studio');
    await host.archive('test/studio');
    const result = await host.activate('test/studio');
    expect(!result.ok && result.error.code).toBe('SF-FT-004');
  });

  it('archive store failure keeps the feature loaded (SF-FT-009)', async () => {
    const { host } = setup({
      archive: {
        put: async () => err(Boom()),
        get: async () => ok(undefined),
        delete: async () => ok(),
        keys: async () => ok([]),
      },
    });
    const { manifest } = feature('test/studio', { snapshot: () => ({ a: 1 }) }, { weight: 'heavy' });
    host.register(manifest);
    await host.activate('test/studio');
    const result = await host.archive('test/studio');
    expect(!result.ok && result.error.code).toBe('SF-FT-009');
    expect(host.stateOf('test/studio')).toBe('loaded');
  });

  it('evicting an archived feature deletes its snapshot', async () => {
    const archive = createMemoryArchiveStore();
    const { host } = setup({ archive });
    const { manifest } = feature('test/studio', { snapshot: () => ({ a: 1 }) }, { weight: 'heavy' });
    host.register(manifest);
    await host.activate('test/studio');
    await host.archive('test/studio');
    expect(archive.size).toBe(1);
    await host.evict('test/studio');
    expect(host.stateOf('test/studio')).toBe('evicted');
    expect(archive.size).toBe(0);
  });
});

describe('feature host: telemetry and readiness', () => {
  it('emits lifecycle events, spans and once-per-mount readiness marks', async () => {
    const { host, sink } = setup({ now: () => 100 });
    const { manifest } = feature('test/editor', { mount: () => undefined }, { budget: { activationMs: -1 } });
    host.register(manifest);
    await host.mount('test/editor');
    host.mark('test/editor', 'firstRender');
    host.mark('test/editor', 'first-render'); // deprecated alias of the same mark → deduped
    host.mark('test/editor', 'interactive');
    const events = sink.records.filter((r) => r.type === 'event').map((r) => r.name);
    expect(events).toContain('lifecycle.feature.declared→loading');
    expect(events).toContain('lifecycle.feature.mounting→mounted');
    expect(events).toContain('feature.budget-exceeded');
    const marks = sink.records.filter((r) => r.type === 'metric' && r.metric === 'runtime/feature-readiness');
    expect(marks).toHaveLength(2);
    expect(marks.map((r) => (r.type === 'metric' ? r.attrs['mark'] : undefined))).toEqual(['firstRender', 'interactive']);
    const spans = sink.records.filter((r) => r.type === 'span').map((r) => r.name);
    expect(spans).toEqual(expect.arrayContaining(['feature.load', 'feature.activate', 'feature.mount']));
    expect(sink.records.some((r) => r.type === 'metric' && r.metric === 'runtime/active-features')).toBe(true);
  });

  it('touch updates the LRU timestamp', () => {
    let time = 5;
    const { host } = setup({ now: () => time });
    const { manifest } = feature('test/editor');
    host.register(manifest);
    time = 42;
    host.touch('test/editor');
    expect(host.info('test/editor')?.lastUsed).toBe(42);
    expect(host.list()).toHaveLength(1);
  });
});
