import { createMemorySink, createTelemetry, ok, unwrap } from '@staticflux/core';
import { createLink, createPortPair } from '@staticflux/worker';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushMicrotasks, hostElement, testEnv } from './fakes.test.js';
import {
  type CanvasLike,
  type CompactInputEvent,
  createAccessibleLayer,
  createHtmlInCanvas,
  createRenderSurface,
  createSurfaceImageLoader,
  createWorkerSurface,
  defaultImageLoaderPorts,
  detectHtmlInCanvas,
  EngineInitError,
  hostRenderSurfaces,
  imageCredentials,
  ImageLoadError,
  type ImageLoaderPorts,
  InputCode,
  MainThreadOnlyError,
  NO_HTML_IN_CANVAS,
  OffscreenUnsupportedError,
  type RenderContext,
  type RenderEngine,
  RenderWorkerError,
  SurfaceChannels,
  SurfaceContextError,
  TaintedImageError,
} from './index.js';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------- HTML-in-Canvas

const proto = (methods: Record<string, unknown>): { prototype: object } => ({ prototype: methods });

describe('HTML-in-Canvas detection', () => {
  it('detects each API generation behind one support record', () => {
    const fakeDoc = (withLayoutSubtree: boolean): Document =>
      ({ createElement: () => (withLayoutSubtree ? { layoutSubtree: false } : {}) }) as unknown as Document;
    expect(detectHtmlInCanvas({})).toBe(NO_HTML_IN_CANVAS);
    expect(detectHtmlInCanvas({ document })).toEqual({ native: false, attribute: undefined, draw2d: undefined, webgl: undefined, webgpu: undefined });
    expect(
      detectHtmlInCanvas({
        document: fakeDoc(true),
        CanvasRenderingContext2D: proto({ drawElement() {} }),
        WebGLRenderingContext: proto({ texElementImage2D() {} }),
        GPUQueue: proto({ copyElementImageToTexture() {} }),
      }),
    ).toEqual({ native: true, attribute: 'layoutsubtree', draw2d: 'drawElement', webgl: 'texElementImage2D', webgpu: 'copyElementImageToTexture' });
    expect(
      detectHtmlInCanvas({
        document: fakeDoc(false),
        CanvasRenderingContext2D: proto({ drawElementImage() {}, drawElement() {} }),
        WebGL2RenderingContext: proto({ texElementImage2D() {} }),
        GPUQueue: proto({ drawElementImageToTexture() {}, copyElementImageToTexture() {} }),
      }),
    ).toEqual({ native: true, attribute: 'content-drawable', draw2d: 'drawElementImage', webgl: 'texElementImage2D', webgpu: 'drawElementImageToTexture' });
    expect(detectHtmlInCanvas({ document: fakeDoc(true) })).toMatchObject({ native: false, attribute: 'layoutsubtree' });
  });
});

describe('HTML-in-Canvas adapter', () => {
  const native = { native: true, attribute: 'layoutsubtree', draw2d: 'drawElementImage', webgl: 'texElementImage2D', webgpu: 'drawElementImageToTexture' } as const;

  it('native mode: opts the canvas in, draws elements and syncs the hit-testing transform', async () => {
    const canvas = document.createElement('canvas');
    hostElement().appendChild(canvas);
    const adapter = unwrap(createHtmlInCanvas({ canvas, document, support: native }));
    expect(adapter.mode).toBe('native');
    expect(adapter.providesAccessibility).toBe(true);
    expect(canvas.hasAttribute('layoutsubtree')).toBe(true);
    const button = document.createElement('button');
    adapter.add(button);
    expect(button.parentElement).toBe(canvas);
    const drawn: unknown[][] = [];
    const ctx = {
      drawElementImage: (...args: unknown[]) => {
        drawn.push(args);
        return { toString: () => 'matrix(1, 0, 0, 1, 5, 6)' };
      },
    };
    adapter.draw(ctx, button, 5, 6);
    adapter.draw(ctx, button, 1, 2, 30);
    adapter.draw(ctx, button, 1, 2, 30, 40);
    expect(drawn.map((a) => a.length)).toEqual([3, 4, 5]);
    expect(button.style.transform).toBe('matrix(1, 0, 0, 1, 5, 6)');
    adapter.draw({ drawElementImage: () => undefined } as never, button, 0, 0);

    const gl = { texElementImage2D: vi.fn() };
    unwrap(adapter.drawToTexture('webgl', gl, button, 'TEXTURE_2D', 0));
    expect(gl.texElementImage2D).toHaveBeenCalledWith('TEXTURE_2D', 0, button);
    const queue = { drawElementImageToTexture: vi.fn() };
    unwrap(adapter.drawToTexture('webgpu', queue, button, { texture: 't' }));
    expect(queue.drawElementImageToTexture).toHaveBeenCalledWith(button, { texture: 't' });
    expect(adapter.drawToTexture('webgpu', {}, button).ok).toBe(false);
    const throwing = adapter.drawToTexture('webgl', { texElementImage2D: () => {
      throw new Error('bad');
    } }, button);
    expect(throwing.ok ? undefined : throwing.error.code).toBe(SurfaceContextError.code);

    const paints: number[] = [];
    const off = adapter.onPaint(() => paints.push(1));
    canvas.dispatchEvent(new Event('paint'));
    (canvas as unknown as { requestPaint: () => void }).requestPaint = () => canvas.dispatchEvent(new Event('paint'));
    adapter.requestPaint();
    expect(paints).toEqual([1, 1]);
    off();
    adapter.place(button, { a: 1, b: 0, c: 0, d: 1, e: 3, f: 4 });
    adapter.remove(button);
    expect(button.parentElement).toBeNull();
    adapter.dispose();
    expect(canvas.hasAttribute('layoutsubtree')).toBe(false);

    const drawable = unwrap(createHtmlInCanvas({ canvas, document, support: { ...native, attribute: 'content-drawable' } }));
    expect(canvas.getAttribute('content')).toBe('drawable');
    delete (canvas as unknown as { requestPaint?: unknown }).requestPaint;
    const later: number[] = [];
    drawable.onPaint(() => later.push(1));
    drawable.requestPaint();
    await flushMicrotasks();
    expect(later).toEqual([1]);
    drawable.dispose();
  });

  it('overlay fallback: positions real DOM over the canvas following the context transform', async () => {
    const host = hostElement();
    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 300;
    host.appendChild(canvas);
    const adapter = unwrap(createHtmlInCanvas({ canvas, document, support: NO_HTML_IN_CANVAS, cssSize: () => ({ width: 300, height: 150 }) }));
    expect(adapter.mode).toBe('overlay');
    const label = document.createElement('span');
    adapter.add(label);
    expect(adapter.overlay?.previousElementSibling).toBe(canvas);
    expect(label.parentElement).toBe(adapter.overlay);
    expect(adapter.overlay?.style.width).toBe('300px');
    // Context scaled by DPR 2: (10, 20) in CSS px → backing (20, 40) → CSS (10, 20).
    adapter.draw({ getTransform: () => ({ a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }) }, label, 10, 20, 50, 10);
    expect(label.style.transform).toBe('matrix(1, 0, 0, 1, 10, 20)');
    expect(label.style.width).toBe('50px');
    expect(label.style.height).toBe('10px');
    expect(label.style.pointerEvents).toBe('auto');
    adapter.draw({}, label, 4, 6); // no getTransform → identity, scaled to CSS
    expect(label.style.transform).toBe('matrix(0.5, 0, 0, 0.5, 2, 3)');
    adapter.place(label, { a: 2, b: 0, c: 0, d: 2, e: 100, f: 50 }, 20);
    expect(label.style.transform).toBe('matrix(1, 0, 0, 1, 50, 25)');
    const texture = adapter.drawToTexture('webgl', {}, label);
    expect(texture.ok ? undefined : texture.error.code).toBe(SurfaceContextError.code);
    const paints: number[] = [];
    adapter.onPaint(() => paints.push(1));
    adapter.requestPaint();
    await flushMicrotasks();
    expect(paints).toEqual([1]);
    adapter.dispose();
    expect(host.querySelector('[data-sf-html-overlay]')).toBeNull();

    const detached = document.createElement('canvas');
    const defaults = unwrap(createHtmlInCanvas({ canvas: detached, document, support: NO_HTML_IN_CANVAS }));
    defaults.draw({}, label, 1, 1);
    expect(defaults.overlay?.parentElement).toBeNull(); // canvas not in the DOM yet
    const zero = document.createElement('canvas');
    zero.width = 0;
    unwrap(createHtmlInCanvas({ canvas: zero, document, support: NO_HTML_IN_CANVAS })).place(label, { a: 1, b: 0, c: 0, d: 1, e: 1, f: 1 });
    expect(unwrap(createHtmlInCanvas({ canvas: detached, document })).mode).toBe('overlay'); // happy-dom: detected unsupported
  });

  it('is main-thread only', () => {
    const result = createHtmlInCanvas({ canvas: document.createElement('canvas'), document: undefined });
    expect(result.ok ? undefined : result.error.code).toBe(MainThreadOnlyError.code);
  });
});

// ---------------------------------------------------------------- accessible layer

describe('accessible DOM layer', () => {
  it('reconciles projection nodes into positioned, labelled DOM by id', () => {
    const host = hostElement();
    const actions: string[] = [];
    const layer = unwrap(createAccessibleLayer({ host, document, label: 'Page 1', onAction: (id, action) => actions.push(`${action}:${id}`) }));
    expect(layer.root.getAttribute('aria-label')).toBe('Page 1');
    layer.update([
      {
        id: 'block-1',
        role: 'group',
        label: 'Title block',
        bounds: { x: 10, y: 10, width: 200, height: 50 },
        children: [
          { id: 'text-1', role: 'textbox', label: 'Title', text: 'Hello', bounds: { x: 20, y: 15, width: 100, height: 20 }, focusable: true },
          { id: 'img-1', role: 'img', label: 'Logo', description: 'Company logo', selected: true },
        ],
      },
      { id: 'btn', role: 'button', label: 'Add', focusable: true, disabled: false, checked: false },
    ]);
    expect(layer.size).toBe(4);
    const block = layer.element('block-1') as HTMLElement;
    const text = layer.element('text-1') as HTMLElement;
    expect(block.getAttribute('role')).toBe('group');
    expect(text.parentElement).toBe(block);
    expect(text.textContent).toBe('Hello');
    expect(text.style.left).toBe('10px'); // relative to the parent's bounds
    expect(text.style.top).toBe('5px');
    expect(text.getAttribute('tabindex')).toBe('0');
    expect(layer.element('img-1')?.getAttribute('aria-selected')).toBe('true');
    expect(layer.element('img-1')?.getAttribute('aria-description')).toBe('Company logo');
    expect(layer.element('btn')?.getAttribute('aria-disabled')).toBe('false');
    expect([...layer.root.children].map((el) => el.getAttribute('data-sf-a11y-id'))).toEqual(['block-1', 'btn']);

    // Reorder + update + remove keeps element identity for surviving ids.
    layer.update([
      { id: 'btn', role: 'button', label: 'Add block', focusable: true },
      {
        id: 'block-1',
        role: 'group',
        label: 'Title block',
        children: [{ id: 'text-1', role: 'textbox', label: 'Title', text: 'Hello world', focusable: true }],
      },
    ]);
    expect(layer.element('text-1')).toBe(text);
    expect(text.textContent).toBe('Hello world');
    expect(layer.element('img-1')).toBeUndefined();
    expect(layer.element('btn')?.getAttribute('aria-label')).toBe('Add block');
    expect([...layer.root.children].map((el) => el.getAttribute('data-sf-a11y-id'))).toEqual(['btn', 'block-1']);
    layer.update([{ id: 'block-1', role: 'group', label: 'Title block', children: [{ id: 'text-1', role: 'textbox', label: 'Title', focusable: true }] }]);
    expect(text.textContent).toBe('');

    expect(layer.focus('text-1')).toBe(true);
    expect(layer.focus('block-1')).toBe(false);
    expect(layer.focus('nope')).toBe(false);
    // Focus options reach the element (e.g. `focusVisible: false` for a move a pointer press caused, #41).
    const seen: unknown[] = [];
    const focus = text.focus.bind(text);
    text.focus = (options?: FocusOptions) => {
      seen.push(options);
      focus(options);
    };
    const options = { preventScroll: true, focusVisible: false };
    expect(layer.focus('text-1', options)).toBe(true);
    expect(seen).toEqual([options]);
    text.click();
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    text.dispatchEvent(enter);
    text.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
    layer.root.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(actions).toEqual(['focus:text-1', 'activate:text-1', 'activate:text-1']);
    layer.dispose();
    expect(host.querySelector('[data-sf-a11y-layer]')).toBeNull();
    expect(layer.size).toBe(0);
  });

  it('nests children in order and needs a document', () => {
    const layer = unwrap(createAccessibleLayer({ host: hostElement(), document }));
    layer.update([{ id: 'list', role: 'list', label: 'Items', text: 'Items', children: [{ id: 'a', role: 'listitem', label: 'A' }, { id: 'b', role: 'listitem', label: 'B' }] }]);
    layer.update([{ id: 'list', role: 'list', label: 'Items', text: 'Items', children: [{ id: 'b', role: 'listitem', label: 'B' }, { id: 'a', role: 'listitem', label: 'A' }] }]);
    const list = layer.element('list') as HTMLElement;
    expect([...list.children].map((el) => el.getAttribute('data-sf-a11y-id'))).toEqual(['b', 'a']);
    expect(list.firstChild?.textContent).toBe('Items');
    layer.update([{ id: 'list', role: 'list', label: 'Items', children: [{ id: 'a', role: 'listitem', label: 'A' }] }]);
    expect([...list.childNodes].map((n) => (n as Element).getAttribute?.('data-sf-a11y-id') ?? 'text')).toEqual(['a']);
    const result = createAccessibleLayer({ host: hostElement(), document: undefined });
    expect(result.ok ? undefined : result.error.code).toBe(MainThreadOnlyError.code);
  });
});

describe('accessible DOM layer: editor options (R11.60–R11.62)', () => {
  it('sets role descriptions, levels, a roving tab order and no empty names', () => {
    const layer = unwrap(createAccessibleLayer({ host: hostElement(), document }));
    layer.update([
      { id: 'h', role: 'heading', label: 'Title', level: 2, focusable: true, tabIndex: -1 },
      { id: 'r', role: 'img', label: 'Box', roleDescription: 'rectangle', focusable: true, tabIndex: 0 },
      { id: 'g', role: 'group', label: '' },
    ]);
    expect(layer.element('h')?.getAttribute('aria-level')).toBe('2');
    expect(layer.element('h')?.getAttribute('tabindex')).toBe('-1');
    expect(layer.element('r')?.getAttribute('tabindex')).toBe('0');
    expect(layer.element('r')?.getAttribute('aria-roledescription')).toBe('rectangle');
    expect(layer.element('g')?.hasAttribute('aria-label')).toBe(false);
    expect(layer.focus('h')).toBe(true);
    layer.update([{ id: 'h', role: 'heading', label: 'Title', focusable: true }]);
    expect(layer.element('h')?.hasAttribute('aria-level')).toBe(false);
    expect(layer.element('h')?.getAttribute('tabindex')).toBe('0');
    layer.dispose();
  });

  it('leaves keys to the app with activateKeys: [] and draws a focus ring when asked', () => {
    const host = hostElement();
    const actions: string[] = [];
    const layer = unwrap(createAccessibleLayer({ host, document, activateKeys: [], focusRing: '2px solid var(--ring)', onAction: (id, a) => actions.push(`${a}:${id}`) }));
    layer.update([{ id: 'a', role: 'img', label: 'A', focusable: true }, { id: 'b', role: 'img', label: 'B', focusable: true }]);
    const a = layer.element('a') as HTMLElement;
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    a.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(actions).toEqual([]);
    const style = layer.root.querySelector('style');
    expect(style?.textContent).toContain('outline:2px solid var(--ring);outline-offset:2px');
    expect(a.style.opacity).toBe('');
    // The style element stays first; nodes keep projection order after it.
    layer.update([{ id: 'b', role: 'img', label: 'B', focusable: true }, { id: 'a', role: 'img', label: 'A', focusable: true }]);
    expect([...layer.root.children].map((el) => el.localName === 'style' ? 'style' : el.getAttribute('data-sf-a11y-id'))).toEqual(['style', 'b', 'a']);
    layer.dispose();
  });
});

// ---------------------------------------------------------------- images

describe('CORS-clean image loading', () => {
  function ports(response: Partial<Awaited<ReturnType<ImageLoaderPorts['fetch']>>> | Error, decodeFails = false) {
    const requests: { url: string; mode: string; credentials: string }[] = [];
    const value: ImageLoaderPorts = {
      origin: 'https://app.test',
      fetch: (url, init) => {
        requests.push({ url, mode: init.mode, credentials: init.credentials });
        return response instanceof Error
          ? Promise.reject(response)
          : Promise.resolve({ ok: true, status: 200, type: 'cors', blob: () => Promise.resolve(new Blob(['x'])), ...response });
      },
      decode: () => (decodeFails ? Promise.reject(new Error('bad image')) : Promise.resolve({ width: 2, height: 3 } as ImageBitmap)),
    };
    return { value, requests };
  }

  it('decides credentials from origin and policy', () => {
    const anon = { crossOriginFor: () => 'anonymous' as const };
    const creds = { crossOriginFor: () => 'use-credentials' as const };
    expect(imageCredentials('/a.png', 'https://app.test', anon)).toBe('same-origin');
    expect(imageCredentials('https://app.test/a.png', 'https://app.test', creds)).toBe('same-origin');
    expect(imageCredentials('https://cdn.test/a.png', 'https://app.test', anon)).toBe('omit');
    expect(imageCredentials('https://cdn.test/a.png', 'https://app.test', creds)).toBe('include');
    expect(imageCredentials('https://cdn.test/a.png', 'https://app.test', { crossOriginFor: () => undefined })).toBe('omit');
    expect(imageCredentials('http://[bad', 'null', anon)).toBe('omit');
  });

  it('loads in cors mode, dedupes concurrent loads and decodes', async () => {
    const { value, requests } = ports({});
    const loader = createSurfaceImageLoader({ ports: value });
    const [a, b] = await Promise.all([loader.load('https://cdn.test/a.png'), loader.load('https://cdn.test/a.png')]);
    expect(unwrap(a)).toEqual({ width: 2, height: 3 });
    expect(unwrap(b)).toEqual({ width: 2, height: 3 });
    expect(requests).toEqual([{ url: 'https://cdn.test/a.png', mode: 'cors', credentials: 'omit' }]);
  });

  it('fails with typed errors: tainted (opaque), HTTP, network, decode, abort', async () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry();
    telemetry.addSink(sink);
    const tainted = await createSurfaceImageLoader({ ports: ports({ type: 'opaque' }).value, telemetry }).load('https://cdn.test/x.png');
    expect(tainted.ok ? undefined : tainted.error.code).toBe(TaintedImageError.code);
    expect(tainted.ok ? undefined : tainted.error.fix).toContain('Access-Control-Allow-Origin');
    expect(sink.records.some((r) => r.type === 'event' && r.name === 'surface.tainted-image')).toBe(true);
    const http = await createSurfaceImageLoader({ ports: ports({ ok: false, status: 404 }).value }).load('/x.png');
    expect(http.ok ? undefined : http.error.details).toMatchObject({ status: 404 });
    const network = await createSurfaceImageLoader({ ports: ports(new TypeError('Failed to fetch')).value }).load('/x.png');
    expect(network.ok ? undefined : network.error.code).toBe(ImageLoadError.code);
    const decode = await createSurfaceImageLoader({ ports: ports({}, true).value }).load('/x.png');
    expect(decode.ok ? undefined : decode.error.code).toBe(ImageLoadError.code);
    const aborted = await createSurfaceImageLoader({ ports: ports(new DOMException('stop', 'AbortError')).value }).load('/x.png');
    expect(aborted.ok ? undefined : aborted.error.kind).toBe('aborted');
    const controller = new AbortController();
    controller.abort();
    expect((await createSurfaceImageLoader({ ports: ports({}).value }).load('/y.png', controller.signal)).ok).toBe(false);
  });

  it('builds default ports from globals', () => {
    expect(defaultImageLoaderPorts({})).toBeUndefined();
    const created = defaultImageLoaderPorts({ fetch: () => undefined, createImageBitmap: () => undefined, location: { origin: 'https://o.test' } });
    expect(created?.origin).toBe('https://o.test');
    expect(defaultImageLoaderPorts({ fetch: () => undefined, createImageBitmap: () => undefined })?.origin).toBe('null');
  });
});

// ---------------------------------------------------------------- render worker

interface FakeOffscreen extends CanvasLike {
  readonly transferable: true;
}

function fakeOffscreen(contextFor: (id: string) => unknown = (id) => (id === 'webgl2' ? { gl: 2 } : null)): FakeOffscreen {
  return { transferable: true, width: 0, height: 0, getContext: contextFor };
}

function workerEngine(log: string[], options: { init?: () => ReturnType<RenderEngine['init']>; throwOnFrame?: boolean } = {}): RenderEngine<{ tick: number }> {
  return {
    init(context: RenderContext) {
      log.push(`init:${context.kind}:${context.thread}:${context.canvas.width}x${context.canvas.height}`);
      return options.init?.() ?? ok();
    },
    frame(state, dt) {
      if (options.throwOnFrame === true) throw new Error('engine frame failed');
      log.push(`frame:${state.tick}:${dt}`);
    },
    resize(size) {
      log.push(`resize:${size.width}x${size.height}@${size.dpr}`);
    },
    input(events) {
      log.push(`input:${events.length}`);
    },
    dispose() {
      log.push('dispose');
    },
  };
}

function setup(options: { engineInit?: () => ReturnType<RenderEngine['init']>; throwOnFrame?: boolean; metricsEvery?: number } = {}) {
  const pair = createPortPair({ clone: false }); // OffscreenCanvas fakes are not cloneable
  const mainLink = createLink({ port: pair.a, name: 'main' });
  const workerLink = createLink({ port: pair.b, name: 'render-worker' });
  const mainEnv = testEnv({ dpr: 2, timeOrigin: 1000 });
  const workerEnv = testEnv({ document: undefined, timeOrigin: 1000 });
  const log: string[] = [];
  const intents: { intents: readonly unknown[]; surface: string }[] = [];
  let tick = 0;
  const host = hostRenderSurfaces<{ tick: number }, { action: string }>({
    link: workerLink,
    engines: { scene: () => workerEngine(log, { ...(options.engineInit === undefined ? {} : { init: options.engineInit }), ...(options.throwOnFrame === undefined ? {} : { throwOnFrame: options.throwOnFrame }) }) },
    state: () => ({ tick: (tick += 1) }),
    mapper: (event) => (event.t === InputCode.keyDown ? { action: `key:${event.key}` } : undefined),
    onIntents: (batch, surface) => intents.push({ intents: batch, surface }),
    env: workerEnv,
    metricsEvery: options.metricsEvery ?? 2,
  });
  const offscreen = fakeOffscreen();
  const transfer = vi.spyOn(HTMLCanvasElement.prototype, 'transferControlToOffscreen').mockImplementation(() => offscreen as unknown as OffscreenCanvas);
  return { pair, mainLink, workerLink, mainEnv, workerEnv, log, intents, host, offscreen, transfer };
}

describe('render-worker surfaces', () => {
  it('transfers the canvas, runs the engine in the worker frame loop and reports metrics', async () => {
    const t = setup();
    const surface = createWorkerSurface({ id: 'studio/scene', kind: 'webgl', engine: 'scene', link: t.mainLink, env: t.mainEnv, label: 'Scene' });
    const hostEl = hostElement(300, 150);
    unwrap(await surface.attach(hostEl));
    expect(surface.thread).toBe('worker');
    expect(t.transfer).toHaveBeenCalledTimes(1);
    expect([t.offscreen.width, t.offscreen.height]).toEqual([600, 300]);
    const canvas = hostEl.querySelector('canvas') as HTMLCanvasElement;
    expect(canvas.style.width).toBe('300px');
    expect(canvas.getAttribute('aria-label')).toBe('Scene');
    expect(t.log).toEqual(['init:webgl:worker:600x300', 'resize:300x150@2']);
    await flushMicrotasks(); // run → worker loop starts
    expect(t.host.surfaces()).toMatchObject([{ id: 'studio/scene', kind: 'webgl', engine: 'scene', running: true }]);

    t.workerEnv.frames.tick(16);
    t.workerEnv.frames.tick(32);
    expect(t.log.slice(2)).toEqual(['frame:1:0', 'frame:2:16']);
    await flushMicrotasks();
    expect(surface.metrics().frames).toBe(2); // snapshot sent every 2 frames

    // Input: main → worker → engine.input + intents; latency measured in the worker.
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
    t.workerEnv.clock.time = 40;
    const key = new KeyboardEvent('keydown', { key: 'z' });
    Object.defineProperty(key, 'timeStamp', { value: 35 });
    canvas.dispatchEvent(key);
    await flushMicrotasks();
    await flushMicrotasks();
    t.workerEnv.frames.tick(48);
    expect(t.log).toContain('input:1');
    expect(t.intents).toEqual([{ intents: [{ action: 'key:z' }], surface: 'studio/scene' }]);
    expect(t.host.surfaces()[0]?.metrics.lastInputLatencyMs).toBe(13);
    canvas.dispatchEvent(new Event('pointermove'));
    await flushMicrotasks();
    await flushMicrotasks();
    t.workerEnv.frames.tick(64);
    expect(t.intents).toHaveLength(1);

    // Resize → worker sets the backing store and resizes the engine.
    t.mainEnv.ro.resize(100, 50);
    await flushMicrotasks();
    expect([t.offscreen.width, t.offscreen.height]).toEqual([200, 100]);
    expect(canvas.style.width).toBe('100px');
    expect(t.log).toContain('resize:100x50@2');

    surface.pause();
    await flushMicrotasks();
    expect(t.host.surfaces()[0]?.running).toBe(false);
    surface.start();
    await flushMicrotasks();
    expect(t.host.surfaces()[0]?.running).toBe(true);

    await surface.detach();
    expect(t.log.at(-1)).toBe('dispose');
    expect(t.host.surfaces()).toEqual([]);
    expect(hostEl.querySelector('canvas')).toBeNull();
    t.host.dispose();
  });

  it('reports unknown engines, engine init failures and missing OffscreenCanvas', async () => {
    const t = setup({ engineInit: () => ({ ok: false, error: SurfaceContextError({ message: 'no GPU adapter' }) }) });
    const unknown = createWorkerSurface({ id: 's/unknown', kind: 'webgl', engine: 'nope', link: t.mainLink, env: t.mainEnv });
    const unknownResult = await unknown.attach(hostElement());
    expect(unknownResult.ok ? undefined : unknownResult.error.code).toBe(RenderWorkerError.code);
    expect(unknown.state).toBe('failed');

    const failing = createWorkerSurface({ id: 's/failing', kind: 'webgl', engine: 'scene', link: t.mainLink, env: t.mainEnv, input: false });
    const failed = await failing.attach(hostElement());
    expect(failed.ok ? undefined : failed.error.code).toBe(EngineInitError.code);

    const noContext = createWorkerSurface({ id: 's/gpu', kind: 'webgpu', engine: 'scene', link: t.mainLink, env: t.mainEnv });
    const gpu = await noContext.attach(hostElement());
    expect(gpu.ok ? undefined : gpu.error.code).toBe(SurfaceContextError.code);

    t.transfer.mockRestore();
    const original = HTMLCanvasElement.prototype.transferControlToOffscreen;
    // @ts-expect-error simulate Safari < 16.4
    delete HTMLCanvasElement.prototype.transferControlToOffscreen;
    try {
      const old = createWorkerSurface({ id: 's/old', kind: 'webgl', engine: 'scene', link: t.mainLink, env: t.mainEnv });
      const result = await old.attach(hostElement());
      expect(result.ok ? undefined : result.error.code).toBe(OffscreenUnsupportedError.code);
    } finally {
      HTMLCanvasElement.prototype.transferControlToOffscreen = original;
    }
    const noDom = await createWorkerSurface({ id: 's/nodom', kind: 'webgl', engine: 'scene', link: t.mainLink, env: testEnv({ document: undefined }) }).attach(hostElement());
    expect(noDom.ok ? undefined : noDom.error.code).toBe(MainThreadOnlyError.code);
    t.host.dispose();
  });

  it('forwards engine frame errors and cleans up when the link closes', async () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry();
    telemetry.addSink(sink);
    const t = setup({ throwOnFrame: true });
    const surface = createWorkerSurface({ id: 's/err', kind: 'webgl', engine: 'scene', link: t.mainLink, env: t.mainEnv, telemetry, budget: { frameMs: 1 }, targetFrameMs: 8, timeoutMs: 100 });
    unwrap(await surface.attach(hostElement(), { autoStart: false }));
    surface.start();
    await flushMicrotasks();
    t.workerEnv.frames.tick(1);
    await flushMicrotasks();
    expect(sink.records.some((r) => r.type === 'event' && r.name === 'surface.worker-error')).toBe(true);
    // Re-attach of the same id replaces the hosted surface.
    t.workerLink.send(SurfaceChannels.input, { surfaceId: 'unknown', events: [] });
    t.workerLink.send(SurfaceChannels.resize, { surfaceId: 's/err' });
    t.mainLink.send(SurfaceChannels.run, { surfaceId: 'unknown', running: true });
    t.pair.close();
    t.mainLink.close();
    t.workerLink.close();
    expect(t.host.surfaces()).toEqual([]);
    await surface.dispose();
    expect(surface.state).toBe('disposed');
  });

  it('createRenderSurface prefers the worker, falls back to the main thread', async () => {
    const t = setup();
    const features = { OffscreenCanvas: function OffscreenCanvas() {}, HTMLCanvasElement: { prototype: { transferControlToOffscreen() {} } } };
    const engine = (): RenderEngine<{ tick: number }, 'webgl'> => workerEngine(t.log) as RenderEngine<{ tick: number }, 'webgl'>;
    const viaWorker = createRenderSurface({
      id: 's/auto',
      kind: 'webgl',
      engineId: 'scene',
      engine,
      link: t.mainLink,
      state: () => ({ tick: 0 }),
      env: t.mainEnv,
      features,
      input: { captureWheel: true, keyboard: false },
      budget: { frameMs: 10 },
      targetFrameMs: 16,
      label: 'auto',
    });
    expect(viaWorker.thread).toBe('worker');
    unwrap(await viaWorker.attach(hostElement()));
    await viaWorker.dispose();
    const noInput = createRenderSurface({ id: 's/auto2', kind: 'webgl', engineId: 'scene', engine, link: t.mainLink, state: () => ({ tick: 0 }), env: t.mainEnv, features, input: false });
    expect(noInput.thread).toBe('worker');
    const defaults = createRenderSurface({ id: 's/auto3', kind: 'webgl', engineId: 'scene', engine, link: t.mainLink, state: () => ({ tick: 0 }), features });
    expect(defaults.thread).toBe('worker');
    const fallback = createRenderSurface({ id: 's/main', kind: 'webgl', engineId: 'scene', engine, state: () => ({ tick: 0 }), env: t.mainEnv, features: {} });
    expect(fallback.thread).toBe('main');
    const noLink = createRenderSurface({ id: 's/main2', kind: 'webgl', engineId: 'scene', engine, state: () => ({ tick: 0 }), env: t.mainEnv, features });
    expect(noLink.thread).toBe('main');
    t.host.dispose();
  });

  it('input events are compact and structured-clone friendly', () => {
    const event: CompactInputEvent = { t: InputCode.pointerDown, ts: 1, x: 1, y: 2, b: 1, m: 0, p: 1, k: 0 };
    expect(structuredClone(event)).toEqual(event);
  });
});
