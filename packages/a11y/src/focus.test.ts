import { createMemorySink, createScope, createTelemetry } from '@staticflux/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFocusManager as create, type FocusManager, KEEP_INTERACTIVE_ATTR, tabbablesOf } from './focus.js';

const managers: FocusManager[] = [];
const createFocusManager = (...args: Parameters<typeof create>): FocusManager => {
  const manager = create(...args);
  managers.push(manager);
  return manager;
};

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

const inertAttr = (): 'inert' | 'aria-hidden' => ('inert' in document.createElement('div') ? 'inert' : 'aria-hidden');

beforeEach(() => {
  document.body.innerHTML = `
    <header id="header"><a id="home" href="/">Home</a></header>
    <main id="main"><h1 id="title">Doc</h1><button id="open">Open</button></main>
    <div id="dialog" role="dialog">
      <button id="d1">One</button>
      <input id="d2" />
      <button id="d3" disabled>Disabled</button>
      <span id="d4" tabindex="-1">skip</span>
      <a id="d5" href="#">Last</a>
    </div>
    <div id="toasts" ${KEEP_INTERACTIVE_ATTR}><button id="toast-btn">Undo</button></div>
  `;
});

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose();
  document.body.innerHTML = '';
});

const byId = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

describe('tabbablesOf', () => {
  it('returns focusable elements in tab order, skipping disabled/negative/hidden/inert', () => {
    const container = byId('dialog');
    container.insertAdjacentHTML('beforeend', '<div hidden><button id="h">h</button></div><button id="p" tabindex="2">p</button><input type="hidden" />');
    expect(tabbablesOf(container).map((el) => el.id)).toEqual(['p', 'd1', 'd2', 'd5']);
  });
});

describe('focusRouteTarget', () => {
  it('prefers explicit target, then registered target, then data attribute, then main h1', () => {
    const fm = createFocusManager({ document });
    const r1 = fm.focusRouteTarget();
    expect(r1.ok && (r1.value as HTMLElement).id).toBe('title');
    expect(document.activeElement?.id).toBe('title');
    expect(byId('title').getAttribute('tabindex')).toBe('-1');

    byId('main').insertAdjacentHTML('afterbegin', '<p id="marked" data-sf-route-focus>here</p>');
    fm.focusRouteTarget();
    expect(document.activeElement?.id).toBe('marked');

    const scope = createScope('route');
    fm.registerRouteTarget(byId('open'), scope);
    fm.focusRouteTarget();
    expect(document.activeElement?.id).toBe('open');

    fm.focusRouteTarget({ target: byId('home') });
    expect(document.activeElement?.id).toBe('home');

    void scope.dispose();
    fm.focusRouteTarget();
    expect(document.activeElement?.id).toBe('marked');
  });

  it('falls back to main, then body; unregister function works', () => {
    document.body.innerHTML = '<main id="m">no heading</main>';
    const fm = createFocusManager({ document });
    const off = fm.registerRouteTarget(document.createElement('div')); // detached: ignored
    fm.focusRouteTarget();
    expect(document.activeElement?.id).toBe('m');
    off();
    document.body.innerHTML = '<p>nothing</p>';
    const r = fm.focusRouteTarget();
    expect(r.ok).toBe(true);
  });

  it('records a telemetry span', () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'verbose' });
    telemetry.addSink(sink);
    createFocusManager({ document, telemetry }).focusRouteTarget();
    expect(sink.records.some((r) => r.type === 'span' && r.name === 'a11y.route-focus')).toBe(true);
  });

  it('returns SF-A11Y-004 without a document', () => {
    const fm = createFocusManager({ document: undefined });
    const r = fm.focusRouteTarget();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('SF-A11Y-004');
    const t = fm.trap(byId('dialog'));
    expect(t.ok).toBe(false);
  });
});

describe('focus traps', () => {
  it('focuses the first tabbable, makes the background inert and restores everything on release', () => {
    const fm = createFocusManager({ document });
    byId('open').focus();
    const result = fm.trap(byId('dialog'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const trap = result.value;
    expect(trap.state).toBe('active');
    expect(fm.activeTrap).toBe(trap);
    expect(document.activeElement?.id).toBe('d1');
    const attr = inertAttr();
    expect(byId('header').hasAttribute(attr)).toBe(true);
    expect(byId('main').hasAttribute(attr)).toBe(true);
    expect(byId('dialog').hasAttribute(attr)).toBe(false);
    expect(byId('toasts').hasAttribute(attr)).toBe(false); // kept interactive

    trap.release();
    expect(trap.state).toBe('released');
    expect(fm.trapCount).toBe(0);
    expect(byId('header').hasAttribute(attr)).toBe(false);
    expect(document.activeElement?.id).toBe('open');
    trap.release(); // idempotent
  });

  it('cycles Tab and Shift+Tab inside the container', () => {
    const fm = createFocusManager({ document });
    fm.trap(byId('dialog'));
    press('Tab');
    expect(document.activeElement?.id).toBe('d2');
    press('Tab');
    expect(document.activeElement?.id).toBe('d5');
    const e = press('Tab');
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe('d1');
    press('Tab', { shiftKey: true });
    expect(document.activeElement?.id).toBe('d5');
  });

  it('focuses the container when it has nothing tabbable', () => {
    document.body.insertAdjacentHTML('beforeend', '<div id="empty">text only</div>');
    const fm = createFocusManager({ document });
    fm.trap(byId('empty'));
    expect(document.activeElement?.id).toBe('empty');
    press('Tab');
    expect(document.activeElement?.id).toBe('empty');
  });

  it('honours initialFocus and onEscape', () => {
    const fm = createFocusManager({ document });
    const onEscape = vi.fn();
    fm.trap(byId('dialog'), { initialFocus: () => byId('d5'), onEscape });
    expect(document.activeElement?.id).toBe('d5');
    press('Escape');
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('pulls stray focus back inside, but allows keep-interactive regions', () => {
    const fm = createFocusManager({ document });
    fm.trap(byId('dialog'), { inertBackground: false });
    byId('home').focus();
    expect(document.activeElement?.id).toBe('d1');
    byId('toast-btn').focus();
    expect(document.activeElement?.id).toBe('toast-btn');
  });

  it('stacks traps: only the top is active; releasing restores the lower one', () => {
    document.body.insertAdjacentHTML('beforeend', '<div id="confirm"><button id="c1">Yes</button></div>');
    const fm = createFocusManager({ document });
    const outer = fm.trap(byId('dialog'));
    const inner = fm.trap(byId('confirm'), { label: 'confirm' });
    if (!outer.ok || !inner.ok) throw new Error('trap failed');
    expect(outer.value.state).toBe('paused');
    expect(inner.value.label).toBe('confirm');
    expect(document.activeElement?.id).toBe('c1');
    const attr = inertAttr();
    expect(byId('dialog').hasAttribute(attr)).toBe(true);
    press('Tab');
    expect(document.activeElement?.id).toBe('c1');
    inner.value.release();
    expect(outer.value.state).toBe('active');
    expect(document.activeElement?.id).toBe('d1');
    expect(byId('dialog').hasAttribute(attr)).toBe(false);
    expect(byId('header').hasAttribute(attr)).toBe(true); // still inert for the outer trap
    outer.value.release();
    expect(byId('header').hasAttribute(attr)).toBe(false);
  });

  it('out-of-order release keeps shared background inert (ref-counted)', () => {
    document.body.insertAdjacentHTML('beforeend', '<div id="confirm"><button id="c1">Yes</button></div>');
    const fm = createFocusManager({ document });
    const outer = fm.trap(byId('dialog'));
    const inner = fm.trap(byId('confirm'));
    if (!outer.ok || !inner.ok) throw new Error('trap failed');
    outer.value.release();
    expect(byId('header').hasAttribute(inertAttr())).toBe(true);
    expect(fm.activeTrap).toBe(inner.value);
    inner.value.release();
    expect(byId('header').hasAttribute(inertAttr())).toBe(false);
  });

  it('preserves pre-existing attribute values and is released with its scope', async () => {
    const attr = inertAttr();
    byId('header').setAttribute(attr, attr === 'inert' ? '' : 'false');
    const before = byId('header').getAttribute(attr);
    const fm = createFocusManager({ document });
    const scope = createScope('dialog');
    const r = fm.trap(byId('dialog'), { scope, restoreFocus: false });
    await scope.dispose();
    expect(r.ok && r.value.state).toBe('released');
    expect(byId('header').getAttribute(attr)).toBe(before);
  });

  it('rejects detached containers and releases all on dispose', async () => {
    const fm = createFocusManager({ document });
    const detached = fm.trap(document.createElement('div'));
    expect(detached.ok).toBe(false);
    if (!detached.ok) expect(detached.error.code).toBe('SF-A11Y-001');
    const r = fm.trap(byId('dialog'));
    await fm.dispose();
    expect(r.ok && r.value.state).toBe('released');
  });

  it('falls back to aria-hidden where inert is unsupported', () => {
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'inert');
    if (descriptor !== undefined) delete proto['inert'];
    try {
      const fm = createFocusManager({ document });
      const r = fm.trap(byId('dialog'));
      expect(byId('header').getAttribute('aria-hidden')).toBe('true');
      if (r.ok) r.value.release();
      expect(byId('header').hasAttribute('aria-hidden')).toBe(false);
    } finally {
      if (descriptor !== undefined) Object.defineProperty(proto, 'inert', descriptor);
    }
  });

  it('emits lifecycle telemetry', () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'verbose' });
    telemetry.addSink(sink);
    const fm = createFocusManager({ document, telemetry });
    const r = fm.trap(byId('dialog'));
    if (r.ok) r.value.release();
    const names = sink.records.flatMap((rec) => (rec.type === 'event' ? [rec.name] : []));
    expect(names).toContain('a11y.trap-activated');
    expect(names).toContain('lifecycle.a11y/focus-trap.active→released');
  });
});
