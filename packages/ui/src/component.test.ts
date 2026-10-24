import {
  box,
  createDeferred,
  createInjector,
  createMemorySink,
  createTelemetry,
  defineError,
  err,
  ok,
  token,
  unit,
  type Box,
  type Scope,
} from '@staticflux/core';
import { createFrameScheduler } from '@staticflux/runtime';
import { html } from 'lit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  component,
  type ComponentHooksOf,
  createRenderCounter,
  defineComponent,
  frameRenderScheduler,
  INTENT_ATTR,
  RenderDepNotReadyError,
  SfElement,
  SfErrorEvent,
  SfReadyEvent,
  STATE_ATTR,
} from './index.js';
import { manualVisibility, mountTestRoot, type MountedRoot, settle } from './testing.js';

interface Doc {
  readonly title: Box<string>;
}
const DocToken = token('test/doc').type<Doc>();
const PresenceToken = token('test/presence').type<{ readonly users: number }>();
const ExportToken = token('test/export').type<{ run(): string }>();

let root: MountedRoot | undefined;
afterEach(async () => {
  await root?.dispose();
  root = undefined;
});

function docUnit(gate?: Promise<void>, title = 'Hello') {
  return unit({
    id: 'test/doc-unit',
    provides: DocToken,
    scope: 'app',
    create: () => ({ title: box(title) }),
    ...(gate === undefined ? {} : { init: async () => { await gate; return ok(); } }),
  });
}

const presenceUnit = unit({ id: 'test/presence-unit', provides: PresenceToken, scope: 'app', create: () => ({ users: 3 }) });

let exportCreated = 0;
const exportUnit = unit({
  id: 'test/export-unit',
  provides: ExportToken,
  scope: 'app',
  create: () => {
    exportCreated += 1;
    return { run: () => 'pdf' };
  },
});

// ------------------------------------------------------------ components under test

const toolbarSpec = component({
  tag: 'test-doc-toolbar',
  deps: {
    render: { doc: DocToken },
    lazy: { presence: PresenceToken },
    functional: { exportPdf: { token: ExportToken, init: 'on-intent' } },
  },
  placeholder: () => html`<p class="ph">loading</p>`,
  size: { block: '40px' },
});

class DocToolbar extends SfElement<typeof toolbarSpec> {
  static override readonly spec = toolbarSpec;
  renders = 0;
  override render(): unknown {
    this.renders += 1;
    const { doc, presence } = this.deps;
    return html`<h1>${doc.title.get()}</h1>
      <span class="presence">${presence.state === 'ready' ? presence.value?.users : '-'}</span>
      <button data-sf-intent=${this.intent('exportPdf')}>Export</button>`;
  }
}
defineComponent(DocToolbar);

function text(el: Element, selector: string): string | null | undefined {
  return el.shadowRoot?.querySelector(selector)?.textContent;
}

describe('SfElement: render deps and placeholder', () => {
  it('shows a size-stable, aria-busy placeholder until render deps are ready, then content', async () => {
    const gate = createDeferred<void>();
    root = mountTestRoot({ units: [docUnit(gate.promise), presenceUnit, exportUnit] });
    const el = document.createElement('test-doc-toolbar') as DocToolbar;
    root.container.append(el);
    await settle();
    expect(text(el, '.ph')).toBe('loading');
    expect(el.getAttribute('aria-busy')).toBe('true');
    expect(el.getAttribute(STATE_ATTR)).toBe('resolving');
    expect(el.style.minBlockSize).toBe('40px');
    expect(el.ready).toBe(false);
    // I-11: render deps are never readable before ready.
    expect(() => el.deps.doc).toThrow(expect.objectContaining({ code: RenderDepNotReadyError.code }));
    gate.resolve();
    await settle();
    expect(text(el, 'h1')).toBe('Hello');
    expect(el.hasAttribute('aria-busy')).toBe(false);
    expect(el.style.minBlockSize).toBe('');
    expect(el.getAttribute(STATE_ATTR)).toBe('ready');
    expect(el.componentState).toBe('ready');
  });

  it('re-renders only when values read during render change (fine-grained MobX)', async () => {
    root = mountTestRoot({ units: [docUnit(), presenceUnit, exportUnit] });
    const el = document.createElement('test-doc-toolbar') as DocToolbar;
    root.container.append(el);
    await settle();
    const before = el.renders;
    el.deps.doc.title.set('Changed');
    await settle();
    expect(text(el, 'h1')).toBe('Changed');
    expect(el.renders).toBe(before + 1);
    const unrelated = box(0);
    unrelated.set(1);
    await settle();
    expect(el.renders).toBe(before + 1);
  });

  it('lazy deps arrive reactively; functional deps resolve on first use or on intent', async () => {
    exportCreated = 0;
    root = mountTestRoot({ units: [docUnit(), presenceUnit, exportUnit] });
    const el = document.createElement('test-doc-toolbar') as DocToolbar;
    root.container.append(el);
    await settle();
    expect(text(el, '.presence')).toBe('3');
    expect(el.deps.exportPdf.state).toBe('idle');
    expect(exportCreated).toBe(0);
    const button = el.shadowRoot?.querySelector('button') as HTMLButtonElement;
    expect(button.getAttribute(INTENT_ATTR)).toBe('exportPdf');
    button.dispatchEvent(new Event('pointerover', { bubbles: true, composed: true }));
    await settle();
    expect(exportCreated).toBe(1);
    const got = await el.deps.exportPdf.get();
    expect(got.ok && got.value.run()).toBe('pdf');
    expect(exportCreated).toBe(1);
  });

  it('fails with SF-UI-003 when a render dep fails and dispatches a bubbling sf-error', async () => {
    const Broken = defineError('SF-TEST-UI-1', 'unavailable', 'broken', 'fix it');
    const failing = unit({
      id: 'test/failing-doc',
      provides: DocToken,
      scope: 'app',
      create: () => ({ title: box('x') }),
      init: () => err(Broken()),
    });
    root = mountTestRoot({ units: [failing, presenceUnit, exportUnit] });
    const errors: SfErrorEvent[] = [];
    root.container.addEventListener(SfErrorEvent.type, (e) => errors.push(e));
    const el = document.createElement('test-doc-toolbar') as DocToolbar;
    root.container.append(el);
    await settle();
    expect(el.componentState).toBe('failed');
    expect(el.getAttribute(STATE_ATTR)).toBe('failed');
    expect(errors[0]?.error.code).toBe('SF-UI-003');
    expect(errors[0]?.origin).toBe('deps');
  });

  it('reports a missing injector (SF-UI-002)', async () => {
    const errors: SfErrorEvent[] = [];
    document.body.addEventListener(SfErrorEvent.type, (e) => errors.push(e));
    const el = document.createElement('test-doc-toolbar') as DocToolbar;
    document.body.append(el);
    await settle();
    expect(errors.some((e) => e.error.code === 'SF-UI-002')).toBe(true);
    el.remove();
  });

  it('dispatches sf-ready and notifies render observers on first content', async () => {
    const counter = createRenderCounter();
    const firstContent = vi.fn();
    root = mountTestRoot({ units: [docUnit(), presenceUnit, exportUnit], renderObservers: [counter, { firstContent }] });
    const ready: string[] = [];
    root.container.addEventListener(SfReadyEvent.type, (e) => ready.push(e.tag));
    const el = document.createElement('test-doc-toolbar') as DocToolbar;
    root.container.append(el);
    await settle();
    expect(ready).toEqual(['test-doc-toolbar']);
    expect(counter.countOf('test-doc-toolbar')).toBeGreaterThanOrEqual(1);
    expect(firstContent).toHaveBeenCalledTimes(1);
    expect(firstContent.mock.calls[0]?.[0]).toMatchObject({ tag: 'test-doc-toolbar', outcome: 'content' });
  });
});

// ------------------------------------------------------------ hooks

const hookLog: string[] = [];
let blockingGate = createDeferred<void>();

const hooksSpec = component({
  tag: 'test-hooks',
  deps: { render: { doc: DocToken }, lazy: { presence: PresenceToken } },
});

class HooksElement extends SfElement<typeof hooksSpec> {
  static override readonly spec = hooksSpec;
  protected override wireDeps(on: ComponentHooksOf<typeof hooksSpec>): void {
    on.onInjected('presence', (p) => {
      hookLog.push(`injected:${p.users}`);
    });
    on.onReady(
      'doc',
      async (doc, scope: Scope) => {
        hookLog.push(`ready:${doc.title.get()}`);
        scope.defer(() => {
          hookLog.push('doc-hook-disposed');
        });
        await blockingGate.promise;
      },
      { blocking: true },
    );
    on.whileVisible((scope) => {
      hookLog.push('visible');
      return () => hookLog.push(`hidden:${String(scope.signal.aborted)}`);
    });
  }
  override render(): unknown {
    return html`<b>${this.deps.doc.title.get()}</b>`;
  }
}
defineComponent(HooksElement);

describe('SfElement: dependency hooks', () => {
  it('blocking onReady keeps the placeholder; hook scopes are disposed on disconnect', async () => {
    hookLog.length = 0;
    blockingGate = createDeferred<void>();
    root = mountTestRoot({ units: [docUnit(), presenceUnit] });
    const el = document.createElement('test-hooks') as HooksElement;
    root.container.append(el);
    await settle();
    expect(hookLog).toEqual(expect.arrayContaining(['injected:3', 'ready:Hello', 'visible']));
    expect(el.componentState).toBe('resolving');
    expect(el.shadowRoot?.querySelector('sf-skeleton')).not.toBeNull();
    blockingGate.resolve();
    await settle();
    expect(el.componentState).toBe('ready');
    expect(el.shadowRoot?.querySelector('b')?.textContent).toBe('Hello');
    el.remove();
    await settle();
    expect(hookLog).toContain('doc-hook-disposed');
    expect(hookLog).toContain('hidden:true');
    expect(el.componentState).toBe('detached');
  });

  it('moving an element (disconnect + connect in one task) keeps its binding', async () => {
    hookLog.length = 0;
    blockingGate = createDeferred<void>();
    blockingGate.resolve();
    root = mountTestRoot({ units: [docUnit(), presenceUnit] });
    const el = document.createElement('test-hooks') as HooksElement;
    root.container.append(el);
    await settle();
    const other = document.createElement('div');
    root.container.append(other);
    other.append(el);
    await settle();
    expect(hookLog.filter((h) => h.startsWith('ready:'))).toHaveLength(1);
    expect(el.componentState).toBe('ready');
  });

  it('a throwing non-blocking hook is reported (SF-UI-005), not fatal', async () => {
    const spec = component({ tag: 'test-bad-hook', deps: { lazy: { presence: PresenceToken } } });
    class BadHook extends SfElement<typeof spec> {
      static override readonly spec = spec;
      protected override wireDeps(on: ComponentHooksOf<typeof spec>): void {
        on.onReady('presence', () => {
          throw new Error('nope');
        });
      }
      override render(): unknown {
        return html`ok`;
      }
    }
    defineComponent(BadHook);
    root = mountTestRoot({ units: [presenceUnit] });
    const codes: string[] = [];
    root.container.addEventListener(SfErrorEvent.type, (e) => codes.push(e.error.code));
    const el = document.createElement('test-bad-hook') as BadHook;
    root.container.append(el);
    await settle();
    expect(codes).toContain('SF-UI-005');
    expect(el.componentState).toBe('ready');
  });
});

// ------------------------------------------------------------ timing

describe('SfElement: init timing', () => {
  it('on-visible deps trigger through the injected VisibilityObserver', async () => {
    let created = 0;
    const lazyPresence = unit({
      id: 'test/presence-counted',
      provides: PresenceToken,
      scope: 'app',
      create: () => {
        created += 1;
        return { users: 1 };
      },
    });
    const spec = component({ tag: 'test-visible', deps: { lazy: { presence: { token: PresenceToken, init: 'on-visible' } } } });
    class Visible extends SfElement<typeof spec> {
      static override readonly spec = spec;
      override render(): unknown {
        return html`${this.deps.presence.state}`;
      }
    }
    defineComponent(Visible);
    const visibility = manualVisibility();
    root = mountTestRoot({ units: [lazyPresence], visibility });
    const el = document.createElement('test-visible') as Visible;
    root.container.append(el);
    await settle();
    expect(created).toBe(0);
    expect(el.shadowRoot?.textContent).toContain('idle');
    visibility.show(el);
    await settle();
    expect(created).toBe(1);
    expect(el.shadowRoot?.textContent).toContain('ready');
    expect(visibility.observed).toBe(0);
  });
});

// ------------------------------------------------------------ scheduling

describe('SfElement: render coalescing through the frame scheduler', () => {
  it('renders once per frame and only when the frame flushes', async () => {
    const frames: ((t: number) => void)[] = [];
    const frameScheduler = createFrameScheduler({ raf: (cb) => frames.push(cb) });
    const flushFrame = (): void => {
      const pending = frames.splice(0);
      for (const cb of pending) cb(0);
    };
    root = mountTestRoot({ units: [docUnit(), presenceUnit, exportUnit], scheduler: frameRenderScheduler(frameScheduler) });
    const el = document.createElement('test-doc-toolbar') as DocToolbar;
    root.container.append(el);
    await settle();
    flushFrame();
    await settle();
    flushFrame();
    await settle();
    expect(text(el, 'h1')).toBe('Hello');
    const before = el.renders;
    el.deps.doc.title.set('A');
    el.deps.doc.title.set('B');
    el.requestUpdate();
    await settle();
    expect(el.renders).toBe(before);
    flushFrame();
    await settle();
    expect(el.renders).toBe(before + 1);
    expect(text(el, 'h1')).toBe('B');
  });

  it('measure runs before mutate within a frame', async () => {
    const frames: ((t: number) => void)[] = [];
    const frameScheduler = createFrameScheduler({ raf: (cb) => frames.push(cb) });
    root = mountTestRoot({ units: [docUnit(), presenceUnit, exportUnit], scheduler: frameRenderScheduler(frameScheduler) });
    const el = document.createElement('test-doc-toolbar') as DocToolbar;
    root.container.append(el);
    await settle();
    const order: string[] = [];
    const w = el.mutate(() => order.push('write'));
    const r = el.measure(() => order.push('read'));
    for (const cb of frames.splice(0)) cb(0);
    await Promise.all([w, r]);
    expect(order).toEqual(['read', 'write']);
  });
});

describe('SfElement: telemetry', () => {
  it('traces component resolution under ui/component', async () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'verbose' });
    telemetry.addSink(sink);
    const injector = createInjector({ telemetry, units: [docUnit(), presenceUnit, exportUnit] });
    root = mountTestRoot({ injector });
    root.container.append(document.createElement('test-doc-toolbar'));
    await settle();
    const span = sink.records.find((r) => r.type === 'span' && r.name === 'ui.component.resolve');
    expect(span).toMatchObject({ subsystem: 'ui/component', status: 'ok' });
  });
});
