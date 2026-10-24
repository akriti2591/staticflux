import { batch, box, createInjector, ok, token, unit } from '@staticflux/core';
import { createFrameScheduler, frameSchedulerUnit } from '@staticflux/runtime';
import { html, LitElement } from 'lit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  component,
  ComponentDefinitionError,
  createIsolationPolicy,
  createRenderTracker,
  createUiEnvironment,
  crossOriginAttr,
  defineComponent,
  MobxController,
  noIsolationPolicy,
  RenderObserversToken,
  SfElement,
  SfScopeElement,
  sfSrc,
  UiEnvironmentToken,
  uiUnits,
  isolationPolicyUnitWith,
  IsolationPolicyToken,
  microtaskRenderScheduler,
  alwaysVisible,
  createRenderCounter,
  frameRenderScheduler,
} from './index.js';
import { mountTestRoot, type MountedRoot, settle } from './testing.js';

let root: MountedRoot | undefined;
afterEach(async () => {
  await root?.dispose();
  root = undefined;
});

const FeatureStoreToken = token('test/feature-store').type<{ readonly count: ReturnType<typeof box<number>> }>();
let featureDisposed = 0;
const featureStoreUnit = unit({
  id: 'test/feature-store-unit',
  provides: FeatureStoreToken,
  scope: 'feature',
  create: (_d, ctx) => {
    ctx.scope.defer(() => {
      featureDisposed += 1;
    });
    return { count: box(0) };
  },
});

const counterSpec = component({ tag: 'test-feature-counter', deps: { render: { store: FeatureStoreToken } } });
class FeatureCounter extends SfElement<typeof counterSpec> {
  static override readonly spec = counterSpec;
  renders = 0;
  override render(): unknown {
    this.renders += 1;
    return html`<i>${this.deps.store.count.get()}</i>`;
  }
}
defineComponent(FeatureCounter);

describe('<sf-scope>', () => {
  it('creates a child injector with its units, provides it to descendants, disposes it on removal', async () => {
    featureDisposed = 0;
    root = mountTestRoot();
    const scope = document.createElement('sf-scope') as SfScopeElement;
    scope.level = 'feature';
    scope.name = 'studio';
    scope.units = [featureStoreUnit];
    const counter = document.createElement('test-feature-counter') as FeatureCounter;
    scope.append(counter);
    root.container.append(scope);
    await settle();
    expect(scope.scope.handle?.injector.level).toBe('feature');
    expect(scope.scope.handle?.parent?.name).toBe('test-root');
    expect(counter.shadowRoot?.querySelector('i')?.textContent).toBe('0');
    expect(scope.style.display).toBe('block');
    scope.remove();
    await settle();
    expect(featureDisposed).toBe(1);
    expect(counter.componentState).toBe('detached');
  });

  it('uses an explicit injector (e.g. the feature host injector) without owning it', async () => {
    root = mountTestRoot();
    const feature = root.injector.child('feature', 'explicit', [featureStoreUnit]);
    const scope = document.createElement('sf-scope') as SfScopeElement;
    scope.injector = feature;
    root.container.append(scope);
    await settle();
    expect(scope.scope.handle?.injector).toBe(feature);
    scope.remove();
    await settle();
    expect(feature.scope.disposed).toBe(false);
  });

  it('frozen: content-visibility hidden, no renders while hidden, one render on thaw (R5.2, R12.16)', async () => {
    root = mountTestRoot();
    const scope = document.createElement('sf-scope') as SfScopeElement;
    scope.level = 'feature';
    scope.units = [featureStoreUnit];
    const counter = document.createElement('test-feature-counter') as FeatureCounter;
    scope.append(counter);
    root.container.append(scope);
    await settle();
    const store = counter.deps.store;
    scope.frozen = true;
    await settle();
    expect(scope.style.contentVisibility).toBe('hidden');
    expect(scope.hasAttribute('frozen')).toBe(true);
    const before = counter.renders;
    store.count.set(1);
    store.count.set(2);
    counter.requestUpdate();
    await settle();
    expect(counter.renders).toBe(before);
    expect(counter.shadowRoot?.querySelector('i')?.textContent).toBe('0');
    scope.frozen = false;
    await settle();
    expect(scope.style.contentVisibility).toBe('');
    expect(counter.renders).toBe(before + 1);
    expect(counter.shadowRoot?.querySelector('i')?.textContent).toBe('2');
    store.count.set(3);
    await settle();
    expect(counter.shadowRoot?.querySelector('i')?.textContent).toBe('3');
  });

  it('nested scopes inherit the environment and frozen state', async () => {
    root = mountTestRoot();
    const outer = document.createElement('sf-scope') as SfScopeElement;
    outer.level = 'route';
    const inner = document.createElement('sf-scope') as SfScopeElement;
    inner.level = 'feature';
    outer.append(inner);
    root.container.append(outer);
    await settle();
    expect(inner.scope.handle?.environment).toBe(root.environment);
    outer.frozen = true;
    await settle();
    expect(inner.scope.handle?.frozen).toBe(true);
  });
});

describe('MobxController', () => {
  class Plain extends LitElement {
    readonly mobx = new MobxController(this);
    readonly value = box('a');
    renders = 0;
    protected override render(): unknown {
      return this.mobx.track(() => {
        this.renders += 1;
        return html`${this.value.get()}`;
      });
    }
  }
  customElements.define('test-plain-mobx', Plain);

  it('tracks observables read during render on a plain LitElement; freezes and disposes', async () => {
    const el = document.createElement('test-plain-mobx') as Plain;
    document.body.append(el);
    await el.updateComplete;
    expect(el.shadowRoot?.textContent).toContain('a');
    el.value.set('b');
    await el.updateComplete;
    await settle(1);
    expect(el.shadowRoot?.textContent).toContain('b');
    expect(el.mobx.watching).toBe(true);
    el.mobx.freeze();
    expect(el.mobx.watching).toBe(false);
    const before = el.renders;
    el.value.set('c');
    await settle(1);
    expect(el.renders).toBe(before);
    el.mobx.thaw();
    await settle(1);
    expect(el.shadowRoot?.textContent).toContain('c');
    el.remove();
    expect(el.mobx.watching).toBe(false);
  });

  it('render tracker fires once per invalidation and handles batches and throws', () => {
    let invalidations = 0;
    const tracker = createRenderTracker(() => {
      invalidations += 1;
    });
    const a = box(1);
    expect(tracker.track(() => a.get() * 2)).toBe(2);
    a.set(2);
    a.set(3);
    expect(invalidations).toBe(1);
    expect(tracker.watching).toBe(false);
    expect(() =>
      tracker.track(() => {
        a.get();
        throw new Error('render bug');
      }),
    ).toThrow('render bug');
    // Inside a batch the pass is still tracked synchronously (no deferred untracked render).
    const before = invalidations;
    const value = batch(() => tracker.track(() => a.get()));
    expect(value).toBe(3);
    expect(tracker.watching).toBe(true);
    a.set(4);
    expect(invalidations).toBe(before + 1);
    tracker.dispose();
    expect(tracker.watching).toBe(false);
    // A disposed tracker can track again (a fresh reaction).
    expect(tracker.track(() => a.get())).toBe(4);
    a.set(5);
    expect(invalidations).toBe(before + 2);
    tracker.dispose();
  });

  it('regression: an observable changing during the tracked pass neither throws nor drops tracking', () => {
    let invalidations = 0;
    const tracker = createRenderTracker(() => {
      invalidations += 1;
    });
    const read = box(1);
    const written = box(0);
    // First pass: writes an observable it read earlier in the same pass (was "Cannot access 'dispose' before initialization").
    expect(() =>
      tracker.track(() => {
        const value = read.get();
        written.get();
        written.set(written.get() + 1);
        return value;
      }),
    ).not.toThrow();
    expect(tracker.watching).toBe(true);
    read.set(2);
    expect(invalidations).toBe(1);
    // Second pass: the written observable is already observed → exactly one invalidation after the pass.
    tracker.track(() => {
      read.get();
      written.set(written.get() + 1);
      return written.get();
    });
    expect(invalidations).toBe(2);
    // Re-tracking after that invalidation still works.
    tracker.track(() => read.get());
    read.set(3);
    expect(invalidations).toBe(3);
    tracker.dispose();
  });

  it('regression: the host keeps re-rendering when its render changes an observable it reads', async () => {
    class Writer extends LitElement {
      readonly mobx = new MobxController(this);
      readonly value = box('x');
      readonly connected = box(0);
      protected override render(): unknown {
        return this.mobx.track(() => {
          const label = this.value.get();
          const connected = this.connected.get();
          // Simulates children connecting synchronously during the commit (converges at 2).
          if (connected < 2) this.connected.set(connected + 1);
          return html`${label}:${connected}`;
        });
      }
    }
    customElements.define('test-writer-mobx', Writer);
    const el = document.createElement('test-writer-mobx') as Writer;
    document.body.append(el);
    await el.updateComplete;
    for (const next of ['y', 'z']) {
      el.value.set(next);
      await settle(3);
      await el.updateComplete;
      expect(el.shadowRoot?.textContent).toContain(`${next}:2`);
      expect(el.mobx.watching).toBe(true);
    }
    el.remove();
  });
});

describe('isolation-aware directives (R11.16b)', () => {
  it('createIsolationPolicy adds crossorigin only for cross-origin URLs when isolated', () => {
    const policy = createIsolationPolicy({
      mode: 'required',
      isolated: true,
      origin: 'https://app.example',
      credentialedOrigins: ['https://api.example'],
    });
    expect(policy.crossOriginFor('https://cdn.example/a.png', 'img')).toBe('anonymous');
    expect(policy.crossOriginFor('https://api.example/me.png', 'img')).toBe('use-credentials');
    expect(policy.crossOriginFor('/local.png', 'img')).toBeUndefined();
    expect(policy.crossOriginFor('data:image/png;base64,AAAA', 'img')).toBeUndefined();
    expect(createIsolationPolicy({ mode: 'preferred', isolated: false })).toBe(noIsolationPolicy);
    expect(createIsolationPolicy({ mode: 'off', isolated: true })).toBe(noIsolationPolicy);
    expect(crossOriginAttr(policy, 'https://cdn.example/v.mp4', 'video')).toBe('anonymous');
  });

  it('sfSrc sets crossorigin before src per the scope policy; SfElement.crossOrigin()', async () => {
    const spec = component({ tag: 'test-media' });
    class Media extends SfElement<typeof spec> {
      static override readonly spec = spec;
      override render(): unknown {
        return html`<img ${sfSrc('https://cdn.example/a.png')} alt="" /><img class="same" ${sfSrc('/b.png')} alt="" />
          <video src="https://cdn.example/v.mp4" crossorigin=${this.crossOrigin('https://cdn.example/v.mp4', 'video')}></video>`;
      }
    }
    defineComponent(Media);
    const injector = createInjector();
    root = mountTestRoot({ injector });
    const scope = document.createElement('sf-scope') as SfScopeElement;
    scope.environment = createUiEnvironment({
      isolation: createIsolationPolicy({ mode: 'required', isolated: true, origin: 'https://app.example' }),
    });
    const el = document.createElement('test-media') as Media;
    scope.append(el);
    root.container.append(scope);
    await settle();
    const img = el.shadowRoot?.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('crossorigin')).toBe('anonymous');
    expect(img.getAttribute('src')).toBe('https://cdn.example/a.png');
    expect(el.shadowRoot?.querySelector('img.same')?.hasAttribute('crossorigin')).toBe(false);
    expect(el.shadowRoot?.querySelector('video')?.getAttribute('crossorigin')).toBe('anonymous');
  });
});

describe('defineComponent', () => {
  it('rejects missing specs and tag collisions (SF-UI-004)', () => {
    class NoSpec extends SfElement {}
    const missing = defineComponent(NoSpec);
    expect(!missing.ok && missing.error.code).toBe(ComponentDefinitionError.code);
    const spec = component({ tag: 'test-collide' });
    class A extends SfElement<typeof spec> {
      static override readonly spec = spec;
    }
    class B extends SfElement<typeof spec> {
      static override readonly spec = spec;
    }
    expect(defineComponent(A).ok).toBe(true);
    expect(defineComponent(A).ok).toBe(true);
    const collision = defineComponent(B);
    expect(!collision.ok && collision.error.code).toBe('SF-UI-004');
  });

  it('component() normalizes edges with default init timing', () => {
    const T = token('test/t').type<number>();
    const spec = component({ tag: 'test-edges', deps: { render: { a: T }, lazy: { b: T }, functional: { c: { token: T, init: 'on-intent' } } } });
    expect(spec.edges.map((e) => `${e.key}:${e.kind}:${e.init}`)).toEqual([
      'a:render:eager',
      'b:lazy:on-arrival',
      'c:functional:on-intent',
    ]);
  });
});

describe('ports and units', () => {
  it('uiUnits resolve a UiEnvironment over the runtime frame scheduler', async () => {
    const counter = createRenderCounter();
    const injector = createInjector({
      units: [
        frameSchedulerUnit,
        ...uiUnits,
        { id: 'test/observer', provides: RenderObserversToken, scope: 'app', create: () => counter } as never,
      ],
    });
    const env = await injector.get(UiEnvironmentToken);
    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.value.renderObservers).toHaveLength(1);
    expect(env.value.scheduler.flushing).toBe(false);
    expect(typeof env.value.now()).toBe('number');
  });

  it('isolationPolicyUnitWith binds the policy', async () => {
    const injector = createInjector({ units: [isolationPolicyUnitWith({ mode: 'required', isolated: true, origin: 'https://a.example' })] });
    const policy = await injector.get(IsolationPolicyToken);
    expect(policy.ok && policy.value.crossOriginFor('https://b.example/x.js', 'script')).toBe('anonymous');
  });

  it('microtask scheduler coalesces jobs; alwaysVisible reports visible', async () => {
    const scheduler = microtaskRenderScheduler();
    let runs = 0;
    const job = (): void => {
      runs += 1;
    };
    scheduler.schedule(job);
    scheduler.schedule(job);
    await settle(1);
    expect(runs).toBe(1);
    const seen: boolean[] = [];
    alwaysVisible().observe(document.body, (v) => seen.push(v));
    await settle(1);
    expect(seen).toEqual([true]);
    const read = await scheduler.measure(() => 1);
    expect(read).toEqual(ok(1));
  });

  it('frameRenderScheduler reports flushing during the frame', () => {
    const frames: ((t: number) => void)[] = [];
    const frame = createFrameScheduler({ raf: (cb) => frames.push(cb) });
    const adapter = frameRenderScheduler(frame);
    let during = false;
    adapter.schedule(() => {
      during = adapter.flushing;
    });
    for (const cb of frames.splice(0)) cb(0);
    expect(during).toBe(true);
    expect(adapter.flushing).toBe(false);
  });
});
