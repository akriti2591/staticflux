import {
  createDeferred,
  createInjector,
  createMemorySink,
  createTelemetry,
  defineError,
  err,
  ok,
  type Result,
  type SpanEndRecord,
  type MetricRecord,
} from '@staticflux/core';
import { s } from '@staticflux/data';
import { createChunkLoader, MANIFEST_FORMAT, type SfManifest } from '@staticflux/loader';
import { describe, expect, it, vi } from 'vitest';
import {
  createIslandHydrator,
  defineIsland,
  type IslandChunkLoader,
  type IslandContext,
  type IslandEnv,
  type IslandHydratorOptions,
  type IslandMarksPort,
  type IslandSize,
  isReplayedEvent,
  ISLAND_STATE_ATTR,
  renderIslandMarker,
} from './index.js';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

const NetworkFail = defineError('TEST-HYD-001', 'network', 'boom', 'none');
const Forbidden = defineError('TEST-HYD-002', 'forbidden', 'nope', 'none');

interface FakeEnv extends IslandEnv {
  readonly visible: Map<Element, () => void>;
  readonly idleQueue: (() => void)[];
  readonly frames: (() => void)[];
  readonly sizes: Map<Element, IslandSize>;
  show(element: Element): void;
  runIdle(): void;
  runFrames(): void;
}

function fakeEnv(): FakeEnv {
  const visible = new Map<Element, () => void>();
  const idleQueue: (() => void)[] = [];
  const frames: (() => void)[] = [];
  const sizes = new Map<Element, IslandSize>();
  let t = 0;
  return {
    visible,
    idleQueue,
    frames,
    sizes,
    whenVisible: (element, cb, signal) => {
      if (!signal.aborted) visible.set(element, cb);
    },
    idle: (cb, signal) => {
      idleQueue.push(() => {
        if (!signal.aborted) cb();
      });
    },
    afterFrame: (cb, signal) => {
      frames.push(() => {
        if (!signal.aborted) cb();
      });
    },
    measure: (element) => sizes.get(element) ?? { width: 0, height: 0 },
    now: () => (t += 5),
    show(element) {
      visible.get(element)?.();
    },
    runIdle() {
      for (const cb of idleQueue.splice(0)) cb();
    },
    runFrames() {
      for (const cb of frames.splice(0)) cb();
    },
  };
}

interface FakeLoader extends IslandChunkLoader {
  readonly loads: string[];
  readonly preloads: { id: string; origin: string | undefined }[];
  modules: Record<string, unknown>;
  gateDenied: Set<string>;
  hold: ReturnType<typeof createDeferred<void>> | undefined;
  failNext: boolean;
}

function fakeLoader(modules: Record<string, unknown> = {}): FakeLoader {
  const loader: FakeLoader = {
    loads: [],
    preloads: [],
    modules,
    gateDenied: new Set(),
    hold: undefined,
    failNext: false,
    check(id) {
      return loader.gateDenied.has(id) ? err(Forbidden({ details: { id } })) : ok([]);
    },
    async load<T>(id: `${string}:${string}`, options?: { signal?: AbortSignal }): Promise<Result<T>> {
      loader.loads.push(id);
      if (loader.hold !== undefined) await loader.hold.promise;
      if (options?.signal?.aborted === true) return err(NetworkFail());
      if (loader.failNext) {
        loader.failNext = false;
        return err(NetworkFail());
      }
      const module = loader.modules[id];
      return module === undefined ? err(NetworkFail({ message: `no module ${id}` })) : ok(module as T);
    },
    preload(id, options) {
      loader.preloads.push({ id, origin: options?.origin });
      return ok();
    },
  };
  return loader;
}

function mount(markup: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = markup;
  document.body.append(root);
  return root;
}

function marker(options: Parameters<typeof renderIslandMarker>[0]): string {
  const result = renderIslandMarker(options);
  if (!result.ok) throw result.error;
  return result.value;
}

function setup(markup: string, modules: Record<string, unknown>, extra: Partial<IslandHydratorOptions> = {}) {
  const root = mount(markup);
  const env = fakeEnv();
  const loader = fakeLoader(modules);
  const sink = createMemorySink();
  const telemetry = createTelemetry({ defaultLevel: 'debug' });
  telemetry.addSink(sink);
  const issues: string[] = [];
  const hydrator = createIslandHydrator({ loader, env, telemetry, onIssue: (e) => issues.push(e.code), ...extra });
  return { root, env, loader, sink, hydrator, issues };
}

/** A counter island: increments on click of its button (attached to the existing DOM). */
function counterModule(log: string[] = []) {
  return {
    hydrate: vi.fn((element: Element, ctx: IslandContext<unknown>) => {
      const button = element.querySelector('button');
      const out = element.querySelector('output');
      let n = Number((ctx.props as { start?: number } | undefined)?.start ?? 0);
      button?.addEventListener('click', (event) => {
        n += 1;
        if (out) out.textContent = String(n);
        log.push(`click${isReplayedEvent(event) ? ':replayed' : ''}`);
      }, { signal: ctx.signal });
    }),
  };
}

const COUNTER_HTML = '<button>+</button><output>0</output>';

describe('island hydration triggers', () => {
  it('eager: hydrates after a microtask, keeping the existing DOM', async () => {
    const mod = counterModule();
    const { root, hydrator, loader } = setup(
      marker({ chunk: 'feature:counter', hydrate: 'eager', reason: 'hero', props: { start: 5 }, html: COUNTER_HTML }),
      { 'feature:counter': mod },
    );
    const button = root.querySelector('button');
    const [handle] = hydrator.start(root);
    expect(handle?.state).toBe('idle');
    await flush();
    expect(handle?.state).toBe('hydrated');
    expect(loader.loads).toEqual(['feature:counter']);
    expect(root.querySelector('button')).toBe(button); // same node: no re-render, no flash
    expect(handle?.element.getAttribute(ISLAND_STATE_ATTR)).toBe('hydrated');
    const [element, ctx] = mod.hydrate.mock.calls[0] as [Element, IslandContext<unknown>];
    expect(element).toBe(handle?.element);
    expect(ctx.props).toEqual({ start: 5 });
    expect(ctx.signal.aborted).toBe(false);
    expect(ctx.scope.disposed).toBe(false);
    expect(ctx.island).toEqual({ id: 'feature:counter#0', chunk: 'feature:counter', strategy: 'eager' });
    button?.click();
    expect(root.querySelector('output')?.textContent).toBe('6');
  });

  it('visible: waits for the visibility trigger', async () => {
    const mod = counterModule();
    const { root, hydrator, env, loader } = setup(marker({ chunk: 'feature:counter', html: COUNTER_HTML }), { 'feature:counter': mod });
    const [handle] = hydrator.start(root);
    await flush();
    expect(handle?.state).toBe('idle');
    expect(loader.loads).toEqual([]);
    env.show(handle?.element as Element);
    await flush();
    expect(handle?.state).toBe('hydrated');
  });

  it('visible without IntersectionObserver degrades to hydrate-now', async () => {
    const mod = counterModule();
    const root = mount(marker({ chunk: 'feature:counter', html: COUNTER_HTML }));
    const env = { ...fakeEnv(), whenVisible: undefined };
    const hydrator = createIslandHydrator({ loader: fakeLoader({ 'feature:counter': mod }), env });
    const [handle] = hydrator.start(root);
    await flush();
    expect(handle?.state).toBe('hydrated');
  });

  it('idle: waits for the idle callback', async () => {
    const { root, hydrator, env } = setup(marker({ chunk: 'feature:counter', hydrate: 'idle', html: COUNTER_HTML }), { 'feature:counter': counterModule() });
    const [handle] = hydrator.start(root);
    await flush();
    expect(handle?.state).toBe('idle');
    env.runIdle();
    await flush();
    expect(handle?.state).toBe('hydrated');
  });

  it('interaction: first interaction hydrates; hover preloads (speculative)', async () => {
    const { root, hydrator, loader } = setup(marker({ chunk: 'feature:counter', hydrate: 'interaction', html: COUNTER_HTML }), { 'feature:counter': counterModule() });
    const [handle] = hydrator.start(root);
    const button = root.querySelector('button') as HTMLButtonElement;
    button.dispatchEvent(new Event('pointerover', { bubbles: true }));
    button.dispatchEvent(new Event('pointerover', { bubbles: true }));
    expect(loader.preloads).toEqual([{ id: 'feature:counter', origin: 'speculative' }]);
    expect(loader.loads).toEqual([]);
    button.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await flush();
    expect(handle?.state).toBe('hydrated');
    expect(loader.loads).toEqual(['feature:counter']);
  });

  it('never: stays static, loads nothing, hydrate() refuses', async () => {
    const { root, hydrator, loader } = setup(marker({ chunk: 'feature:counter', hydrate: 'never', html: COUNTER_HTML }), { 'feature:counter': counterModule() });
    const [handle] = hydrator.start(root);
    expect(handle?.state).toBe('skipped');
    root.querySelector('button')?.click();
    const result = await handle?.hydrate();
    expect(result?.ok).toBe(false);
    expect(loader.loads).toEqual([]);
  });

  it('manual hydrate() ignores the trigger and is single-flight', async () => {
    const mod = counterModule();
    const { root, hydrator, loader } = setup(marker({ chunk: 'feature:counter', hydrate: 'idle', html: COUNTER_HTML }), { 'feature:counter': mod });
    const [handle] = hydrator.start(root);
    const [a, b] = await Promise.all([handle?.hydrate(), hydrator.hydrate(handle?.id ?? '')]);
    expect(a?.ok && b?.ok).toBe(true);
    expect(loader.loads).toEqual(['feature:counter']);
    expect(mod.hydrate).toHaveBeenCalledTimes(1);
    expect((await handle?.hydrate())?.ok).toBe(true);
    expect((await hydrator.hydrate('missing')).ok).toBe(false);
  });
});

describe('event replay', () => {
  it('replays clicks that happened before hydration, after hydrate()', async () => {
    const log: string[] = [];
    const { root, hydrator, loader, sink } = setup(
      marker({ chunk: 'feature:counter', hydrate: 'interaction', html: COUNTER_HTML }),
      { 'feature:counter': counterModule(log) },
    );
    loader.hold = createDeferred<void>();
    const [handle] = hydrator.start(root);
    const button = root.querySelector('button') as HTMLButtonElement;
    button.click(); // triggers hydration AND is queued
    button.click();
    expect(handle?.queuedEvents).toBe(2);
    expect(handle?.state).toBe('loading');
    loader.hold.resolve();
    await flush();
    expect(handle?.state).toBe('hydrated');
    expect(log).toEqual(['click:replayed', 'click:replayed']);
    expect(root.querySelector('output')?.textContent).toBe('2');
    button.click();
    expect(log).toEqual(['click:replayed', 'click:replayed', 'click']);
    const replayed = sink.records.filter((r): r is MetricRecord => r.type === 'metric' && r.metric === 'hydrate/events-replayed');
    expect(replayed).toHaveLength(2);
  });

  it('replays input/keydown with the typed value intact; prevents submit navigation while queued', async () => {
    const seen: string[] = [];
    const formIsland = {
      hydrate(element: Element) {
        const input = element.querySelector('input') as HTMLInputElement;
        input.addEventListener('input', () => seen.push(`input:${input.value}`));
        input.addEventListener('keydown', (e) => seen.push(`key:${(e as KeyboardEvent).key}`));
        element.querySelector('form')?.addEventListener('submit', (e) => {
          seen.push(`submit:${e.defaultPrevented}`);
          e.preventDefault();
        });
      },
    };
    const { root, hydrator, loader } = setup(
      marker({ chunk: 'feature:search', hydrate: 'visible', html: '<form><input name="q"></form>' }),
      { 'feature:search': formIsland },
    );
    loader.hold = createDeferred<void>();
    const [handle] = hydrator.start(root);
    const input = root.querySelector('input') as HTMLInputElement;
    const form = root.querySelector('form') as HTMLFormElement;
    input.value = 'hel';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const submit = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);
    void handle?.hydrate();
    loader.hold.resolve();
    await flush();
    expect(seen).toEqual(['key:l', 'input:hel', 'submit:false']);
  });

  it('drops events whose target left the DOM and caps the queue', async () => {
    const { root, hydrator, loader, sink } = setup(
      marker({ chunk: 'feature:list', hydrate: 'visible', html: '<p>a</p><p>b</p>' }),
      { 'feature:list': { hydrate: () => undefined } },
      { replay: { maxQueued: 2 } },
    );
    loader.hold = createDeferred<void>();
    const [handle] = hydrator.start(root);
    const [a, b] = Array.from(root.querySelectorAll('p'));
    a?.click();
    b?.click();
    b?.click(); // over the cap
    a?.remove();
    void handle?.hydrate();
    loader.hold.resolve();
    await flush();
    const dropped = sink.records.filter((r): r is MetricRecord => r.type === 'metric' && r.metric === 'hydrate/events-dropped');
    expect(dropped.map((r) => r.value)).toEqual([2]);
    const replayed = sink.records.filter((r): r is MetricRecord => r.type === 'metric' && r.metric === 'hydrate/events-replayed');
    expect(replayed).toHaveLength(1);
  });

  it('events inside a nested island belong to the nested island only', async () => {
    const outerLog: string[] = [];
    const innerLog: string[] = [];
    const inner = marker({ chunk: 'feature:inner', hydrate: 'visible', id: 'inner', html: '<button id="ib">i</button>' });
    const { root, hydrator, loader } = setup(
      marker({ chunk: 'feature:outer', hydrate: 'visible', id: 'outer', html: `<button id="ob">o</button>${inner}` }),
      {
        'feature:outer': { hydrate: (el: Element) => el.querySelector('#ob')?.addEventListener('click', () => outerLog.push('o')) },
        'feature:inner': { hydrate: (el: Element) => el.querySelector('#ib')?.addEventListener('click', () => innerLog.push('i')) },
      },
    );
    loader.hold = createDeferred<void>();
    hydrator.start(root);
    (root.querySelector('#ib') as HTMLElement).click();
    expect(hydrator.get('outer')?.queuedEvents).toBe(0);
    expect(hydrator.get('inner')?.queuedEvents).toBe(1);
    void hydrator.hydrate('outer');
    void hydrator.hydrate('inner');
    loader.hold.resolve();
    await flush();
    expect(innerLog).toEqual(['i']);
    expect(outerLog).toEqual([]);
  });
});

describe('gating and failures', () => {
  it('island gate denial: never fetched, skipped; retry after the decision changes', async () => {
    let allow = false;
    const { root, hydrator, loader, issues } = setup(
      marker({ chunk: 'feature:counter', hydrate: 'eager', reason: 'x', html: COUNTER_HTML }),
      { 'feature:counter': counterModule() },
      { gate: () => (allow ? true : { allow: false, reason: 'plan' }) },
    );
    const [handle] = hydrator.start(root);
    await flush();
    expect(handle?.state).toBe('skipped');
    expect(loader.loads).toEqual([]);
    expect(issues).toContain('SF-HYD-003');
    expect(handle?.error?.details['reason']).toBe('plan');
    allow = true;
    expect((await handle?.retry())?.ok).toBe(true);
    expect(handle?.state).toBe('hydrated');
  });

  it('chunk gate (loader.check) denial maps to skipped and does not fetch', async () => {
    const { root, hydrator, loader } = setup(marker({ chunk: 'feature:counter', hydrate: 'eager', reason: 'x', html: COUNTER_HTML }), { 'feature:counter': counterModule() });
    loader.gateDenied.add('feature:counter');
    const [handle] = hydrator.start(root);
    await flush();
    expect(handle?.state).toBe('skipped');
    expect(handle?.error?.code).toBe('SF-HYD-003');
    expect(loader.loads).toEqual([]);
  });

  it('interaction islands do not preload when the gate denies', () => {
    const { root, hydrator, loader } = setup(
      marker({ chunk: 'feature:counter', hydrate: 'interaction', html: COUNTER_HTML }),
      { 'feature:counter': counterModule() },
      { gate: () => false },
    );
    hydrator.start(root);
    root.querySelector('button')?.dispatchEvent(new Event('pointerover', { bubbles: true }));
    expect(loader.preloads).toEqual([]);
  });

  it('load failure → failed (events dropped, static DOM kept) → retry hydrates', async () => {
    const log: string[] = [];
    const { root, hydrator, loader, sink } = setup(marker({ chunk: 'feature:counter', hydrate: 'visible', html: COUNTER_HTML }), { 'feature:counter': counterModule(log) });
    loader.failNext = true;
    const [handle] = hydrator.start(root);
    root.querySelector('button')?.click();
    const result = await handle?.hydrate();
    expect(result?.ok).toBe(false);
    expect(handle?.state).toBe('failed');
    expect(handle?.error?.code).toBe('SF-HYD-004');
    expect(handle?.queuedEvents).toBe(0);
    const span = sink.records.find((r): r is SpanEndRecord => r.type === 'span' && r.name === 'island.hydrate');
    expect(span?.status).toBe('error');
    expect((await handle?.retry())?.ok).toBe(true);
    expect(handle?.state).toBe('hydrated');
    expect(log).toEqual([]); // the pre-failure click was dropped, not replayed late
  });

  it('module without the island contract → SF-HYD-005', async () => {
    const { root, hydrator } = setup(marker({ chunk: 'feature:x', hydrate: 'visible', html: '' }), { 'feature:x': { notHydrate: 1 } });
    const [handle] = hydrator.start(root);
    const result = await handle?.hydrate();
    expect(result?.ok === false && result.error.code).toBe('SF-HYD-005');
  });

  it('invalid props JSON → SF-HYD-002', async () => {
    const { root, hydrator } = setup(`<sf-island chunk="feature:x" props="{oops"></sf-island>`, { 'feature:x': { hydrate: () => undefined } });
    const [handle] = hydrator.start(root);
    const result = await handle?.hydrate();
    expect(result?.ok === false && result.error.code).toBe('SF-HYD-002');
  });

  it('props validated by the module schema (defineIsland + s.*)', async () => {
    const seen: unknown[] = [];
    const island = defineIsland({ props: s.object({ sku: s.string() }), hydrate: (_el, ctx) => void seen.push(ctx.props.sku) });
    const good = setup(marker({ chunk: 'feature:x', props: { sku: 'a1' }, html: '' }), { 'feature:x': { default: island } });
    const [g] = good.hydrator.start(good.root);
    expect((await g?.hydrate())?.ok).toBe(true);
    expect(seen).toEqual(['a1']);
    const bad = setup(marker({ chunk: 'feature:x', props: { sku: 1 }, html: '' }), { 'feature:x': { default: island } });
    const [b] = bad.hydrator.start(bad.root);
    const result = await b?.hydrate();
    expect(result?.ok === false && result.error.code).toBe('SF-HYD-002');
  });

  it('hydrate() throwing or returning err → SF-HYD-006 and its scope is disposed', async () => {
    let scopeRef: IslandContext<unknown>['scope'] | undefined;
    const { root, hydrator } = setup(
      marker({ chunk: 'feature:a', id: 'a', html: '' }) + marker({ chunk: 'feature:b', id: 'b', html: '' }),
      {
        'feature:a': { hydrate: (_el: Element, ctx: IslandContext<unknown>) => { scopeRef = ctx.scope; throw new Error('kaboom'); } },
        'feature:b': { hydrate: async () => err(NetworkFail()) },
      },
    );
    hydrator.start(root);
    const a = await hydrator.hydrate('a');
    const b = await hydrator.hydrate('b');
    expect(a.ok === false && a.error.code).toBe('SF-HYD-006');
    expect(b.ok === false && b.error.code).toBe('SF-HYD-006');
    await flush();
    expect(scopeRef?.disposed).toBe(true);
  });

  it('resolves named exports (export attribute) and default exports', async () => {
    const named = vi.fn();
    const { root, hydrator } = setup(
      marker({ chunk: 'feature:a', id: 'a', exportName: 'widget', html: '' }) + marker({ chunk: 'feature:b', id: 'b', html: '' }),
      { 'feature:a': { widget: named }, 'feature:b': { default: { hydrate: named } } },
    );
    hydrator.start(root);
    expect((await hydrator.hydrate('a')).ok).toBe(true);
    expect((await hydrator.hydrate('b')).ok).toBe(true);
    expect(named).toHaveBeenCalledTimes(2);
  });
});

describe('size-stable check (R12.19)', () => {
  it('reports a declared-size mismatch before hydration', async () => {
    const { root, hydrator, env, issues, sink } = setup(marker({ chunk: 'feature:x', size: { width: 300, height: 50 }, html: '<p>x</p>' }), { 'feature:x': { hydrate: () => undefined } });
    const [handle] = hydrator.start(root);
    env.sizes.set(handle?.element as Element, { width: 300, height: 80 });
    await handle?.hydrate();
    expect(issues).toContain('SF-HYD-007');
    expect(hydrator.violations()[0]).toMatchObject({ phase: 'declared', expected: { width: 300, height: 50 }, actual: { width: 300, height: 80 } });
    expect(sink.records.some((r) => r.type === 'metric' && r.metric === 'hydrate/layout-shift-risk')).toBe(true);
  });

  it('reports a size change caused by hydration (after the next frame)', async () => {
    const marks: string[] = [];
    const port: IslandMarksPort = {
      start: (f) => marks.push(`start:${f}`),
      renderCommitted: (f) => marks.push(`render:${f}`),
      renderDepsResolved: (f) => marks.push(`interactive:${f}`),
      layoutShift: (f) => marks.push(`shift:${f}`),
    };
    const { root, hydrator, env } = setup(
      marker({ chunk: 'feature:x', id: 'x', html: '<p>x</p>' }),
      { 'feature:x': { hydrate: (el: Element) => void env.sizes.set(el, { width: 100, height: 140 }) } },
      { marks: [port] },
    );
    const [handle] = hydrator.start(root);
    env.sizes.set(handle?.element as Element, { width: 100, height: 40 });
    await handle?.hydrate();
    expect(hydrator.violations()).toEqual([]);
    env.runFrames();
    expect(hydrator.violations()[0]).toMatchObject({ phase: 'hydration', expected: { width: 100, height: 40 }, actual: { width: 100, height: 140 } });
    expect(marks).toEqual(['start:x', 'render:x', 'interactive:x', 'shift:x']);
  });

  it('within tolerance and not-laid-out islands are not reported', async () => {
    const { root, hydrator, env } = setup(
      marker({ chunk: 'feature:x', id: 'x', size: { width: 10, height: 10 }, html: '' }) + marker({ chunk: 'feature:y', id: 'y', size: { width: 10, height: 10 }, html: '' }),
      { 'feature:x': { hydrate: (el: Element) => void env.sizes.set(el, { width: 10.5, height: 10 }) }, 'feature:y': { hydrate: () => undefined } },
    );
    hydrator.start(root);
    env.sizes.set(hydrator.get('x')?.element as Element, { width: 10, height: 10.5 });
    await hydrator.hydrate('x');
    await hydrator.hydrate('y'); // 0×0 (hidden): no comparison
    env.runFrames();
    expect(hydrator.violations()).toEqual([]);
  });
});

describe('telemetry and marks', () => {
  it('one span per island with gate/loaded/replayed events, static + interactive marks', async () => {
    const { root, hydrator, sink } = setup(marker({ chunk: 'feature:x', id: 'x', html: '' }), { 'feature:x': { hydrate: () => undefined } });
    hydrator.start(root);
    await hydrator.hydrate('x');
    const spans = sink.records.filter((r): r is SpanEndRecord => r.type === 'span' && r.name === 'island.hydrate');
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ subsystem: 'hydrate/island', status: 'ok', attrs: { island: 'x', chunk: 'feature:x', strategy: 'visible', outcome: 'hydrated' } });
    const events = sink.records.filter((r) => r.type === 'event' && r.spanId === spans[0]?.context.spanId).map((r) => (r.type === 'event' ? r.name : ''));
    expect(events).toEqual(['gate', 'loaded', 'replayed']);
    const metrics = sink.records.filter((r): r is MetricRecord => r.type === 'metric').map((r) => r.metric);
    expect(metrics).toEqual(expect.arrayContaining(['hydrate/island-static', 'hydrate/island-interactive', 'hydrate/island-duration']));
  });

  it('a throwing marks port is reported, not fatal', async () => {
    const bad: IslandMarksPort = { start: () => { throw new Error('x'); }, renderCommitted: () => undefined, renderDepsResolved: () => undefined, layoutShift: () => undefined };
    const { root, hydrator, issues } = setup(marker({ chunk: 'feature:x', id: 'x', html: '' }), { 'feature:x': { hydrate: () => undefined } }, { marks: [bad] });
    hydrator.start(root);
    expect((await hydrator.hydrate('x')).ok).toBe(true);
    expect(issues).toContain('SF-CORE-000');
  });
});

describe('registration and lifecycle', () => {
  it('start() is idempotent per element and keeps ids stable; duplicate explicit ids are made unique', () => {
    const { root, hydrator, issues } = setup(
      marker({ chunk: 'feature:x', html: '' }) + marker({ chunk: 'feature:y', id: 'dup', html: '' }) + marker({ chunk: 'feature:z', id: 'dup', html: '' }),
      {},
    );
    const first = hydrator.start(root);
    expect(first.map((h) => h.id)).toEqual(['feature:x#0', 'dup', 'dup~1']);
    expect(issues).toContain('SF-HYD-001');
    expect(hydrator.start(root)).toEqual([]);
    root.insertAdjacentHTML('beforeend', marker({ chunk: 'feature:x', html: '' }));
    expect(hydrator.start(root).map((h) => h.id)).toEqual(['feature:x#1']);
    expect(hydrator.islands()).toHaveLength(4);
  });

  it('reports scan issues (eager without reason) through onIssue', () => {
    const { root, hydrator, issues } = setup('<sf-island chunk="feature:x" hydrate="eager"></sf-island>', {});
    const [handle] = hydrator.start(root);
    expect(handle?.strategy).toBe('idle');
    expect(issues).toEqual(['SF-HYD-008']);
    root.insertAdjacentHTML('beforeend', '<sf-island chunk="broken"></sf-island>');
    hydrator.start(root);
    hydrator.start(root);
    expect(hydrator.issues().map((e) => e.code)).toEqual(['SF-HYD-008', 'SF-HYD-001']);
    expect(hydrator.scan(root).islands).toHaveLength(1);
  });

  it('dispose() aborts the island signal and scope; whenHydrated settles', async () => {
    let ctxRef: IslandContext<unknown> | undefined;
    const { root, hydrator } = setup(marker({ chunk: 'feature:x', id: 'x', html: '' }), { 'feature:x': { hydrate: (_el: Element, ctx: IslandContext<unknown>) => void (ctxRef = ctx) } });
    const [handle] = hydrator.start(root);
    const waiting = handle?.whenHydrated();
    await handle?.hydrate();
    expect((await waiting)?.ok).toBe(true);
    await hydrator.dispose();
    expect(ctxRef?.signal.aborted).toBe(true);
    expect(ctxRef?.scope.disposed).toBe(true);
    expect(handle?.state).toBe('disposed');
    expect((await handle?.whenHydrated())?.ok).toBe(false);
    expect(hydrator.islands()).toEqual([]);
    expect(hydrator.start(root)).toEqual([]);
  });

  it('disposing while loading aborts and never calls hydrate', async () => {
    const mod = counterModule();
    const { root, hydrator, loader } = setup(marker({ chunk: 'feature:x', id: 'x', html: '' }), { 'feature:x': mod });
    loader.hold = createDeferred<void>();
    const [handle] = hydrator.start(root);
    const pending = handle?.hydrate();
    const waiting = handle?.whenHydrated();
    await handle?.dispose();
    loader.hold.resolve();
    expect((await pending)?.ok).toBe(false);
    expect((await waiting)?.ok).toBe(false);
    expect(mod.hydrate).not.toHaveBeenCalled();
  });

  it('whenHydrated respects its abort signal and reports failure', async () => {
    const { root, hydrator, loader } = setup(marker({ chunk: 'feature:x', id: 'x', html: '' }), {});
    const [handle] = hydrator.start(root);
    const controller = new AbortController();
    const waiting = handle?.whenHydrated(controller.signal);
    controller.abort();
    expect((await waiting)?.ok).toBe(false);
    loader.failNext = true;
    const failing = handle?.whenHydrated();
    await handle?.hydrate();
    const result = await failing;
    expect(result?.ok === false && result.error.code).toBe('SF-HYD-004');
  });

  it('passes a per-island feature-level child injector, disposed with the island', async () => {
    const app = createInjector();
    let ctxRef: IslandContext<unknown> | undefined;
    const { root, hydrator } = setup(marker({ chunk: 'feature:x', id: 'x', html: '' }), { 'feature:x': { hydrate: (_el: Element, ctx: IslandContext<unknown>) => void (ctxRef = ctx) } });
    hydrator.start(root, { injector: app });
    await hydrator.hydrate('x');
    expect(ctxRef?.injector?.level).toBe('feature');
    expect(ctxRef?.injector?.parent).toBe(app);
    await hydrator.dispose();
    expect(ctxRef?.injector?.scope.disposed).toBe(true);
  });
});

describe('integration with the real chunk loader', () => {
  it('loads the island chunk through createChunkLoader (gate + importer)', async () => {
    const manifest: SfManifest = {
      format: MANIFEST_FORMAT,
      buildId: 'b1',
      base: '/assets/',
      chunks: {
        'feature:counter': { id: 'feature:counter', files: ['counter.js'], css: [], deps: [], tier: 'on-demand', load: 'lazy' },
        'feature:admin': { id: 'feature:admin', files: ['admin.js'], css: [], deps: [], tier: 'on-demand', load: 'lazy' },
      },
    };
    const imported: string[] = [];
    const mod = counterModule();
    const loader = createChunkLoader({
      manifest,
      importer: async (url) => {
        imported.push(url);
        return mod;
      },
      canLoad: (id) => id !== 'feature:admin',
      document: undefined,
    });
    const root = mount(
      marker({ chunk: 'feature:counter', id: 'c', html: COUNTER_HTML }) + marker({ chunk: 'feature:admin', id: 'a', html: '<p>admin</p>' }),
    );
    const hydrator = createIslandHydrator({ loader, env: fakeEnv() });
    hydrator.start(root);
    expect((await hydrator.hydrate('c')).ok).toBe(true);
    const denied = await hydrator.hydrate('a');
    expect(denied.ok).toBe(false);
    expect(hydrator.get('a')?.state).toBe('skipped');
    expect(imported).toEqual(['/assets/counter.js']);
  });
});
