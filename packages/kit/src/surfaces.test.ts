import { createScope, ok, unit } from '@staticflux/core';
import { createRoutableDialogBridge, createSurfaceManager, defineSurface, type SurfaceManager, SurfaceManagerToken } from '@staticflux/messaging';
import { auditA11y, deepFocused, press } from '@staticflux/testkit/a11y';
import { html } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defineDialogSurface, defineSurfaces, defineToastSurface, isBackdropClick, type SfSurfaceLayerElement, supportsModalDialog } from './surfaces.js';
import { cleanup, fixture, settle, shadow } from './test-helpers.js';

beforeAll(() => defineSurfaces());
afterEach(cleanup);

async function layer(): Promise<{ manager: SurfaceManager; element: SfSurfaceLayerElement; owner: { scope: ReturnType<typeof createScope> } }> {
  const manager = createSurfaceManager();
  const managerUnit = unit({ id: 'test/surfaces', provides: SurfaceManagerToken, scope: 'app', create: () => manager });
  const { element } = await fixture<SfSurfaceLayerElement>(html`<sf-surface-layer></sf-surface-layer>`, { units: [managerUnit] });
  return { manager, element, owner: { scope: createScope('feature') } };
}

const confirm = defineDialogSurface<{ readonly name: string }, boolean>({
  id: 'test/confirm',
  scope: 'feature',
  title: (p) => `Delete ${p.name}?`,
  body: () => html`<p>This cannot be undone.</p>`,
  actions: ({ dismiss }) => html`<button class="cancel" @click=${() => dismiss('action', false)}>Cancel</button><button class="ok" @click=${() => dismiss('action', true)}>Delete</button>`,
});

const saved = defineToastSurface<{ readonly what: string }>({
  id: 'test/saved',
  scope: 'feature',
  durationMs: null,
  tone: 'success',
  message: (p) => `${p.what} saved`,
  action: { label: () => 'Undo', run: () => undefined },
});

function dialogs(element: Element): HTMLDialogElement[] {
  return [...(element.shadowRoot?.querySelectorAll<HTMLDialogElement>('dialog') ?? [])];
}

describe('<sf-surface-layer> modals', () => {
  it('opens a native modal dialog named by its title, focuses into it, Escape dismisses and restores focus', async () => {
    const { manager, element, owner } = await layer();
    const trigger = document.createElement('button');
    trigger.textContent = 'open';
    document.body.append(trigger);
    trigger.focus();
    const handle = manager.request(confirm, { owner, props: { name: 'page 2' } });
    await settle();
    const [dialog] = dialogs(element);
    expect(dialog?.open).toBe(true);
    expect(dialog?.hasAttribute('data-native')).toBe(supportsModalDialog(dialog as HTMLDialogElement));
    expect(dialog?.getAttribute('aria-label')).toBe('Delete page 2?');
    const frame = dialog?.querySelector('sf-dialog') as HTMLElement;
    expect(shadow(frame, 'h2').textContent).toBe('Delete page 2?');
    // first focusable in the composed tree: the frame's close button
    expect(deepFocused()?.localName).toBe('sf-icon-button');
    expect(auditA11y(element)).toEqual([]);
    press(document.body, 'Escape');
    const outcome = await handle.closed;
    expect(outcome.reason).toBe('escape');
    await settle();
    expect(dialogs(element)).toHaveLength(0);
    expect(document.activeElement).toBe(trigger);
  });

  it('returns results from actions and the close button', async () => {
    const { manager, element, owner } = await layer();
    const first = manager.request(confirm, { owner, props: { name: 'x' } });
    await settle();
    (dialogs(element)[0]?.querySelector('.ok') as HTMLButtonElement).click();
    expect((await first.closed).result).toBe(true);
    await settle();
    const second = manager.request(confirm, { owner, props: { name: 'y' } });
    await settle();
    const frame = dialogs(element)[0]?.querySelector('sf-dialog') as HTMLElement;
    (shadow(frame, 'sf-icon-button') as HTMLElement).click();
    expect((await second.closed).reason).toBe('user');
  });

  it('dismisses on a backdrop click only when dismissible', async () => {
    const { manager, element, owner } = await layer();
    const locked = defineSurface({ id: 'test/locked', kind: 'dialog', scope: 'feature', dismissible: false, label: 'Reconnecting', render: () => html`<p>Wait…</p>` });
    const handle = manager.request(locked, { owner });
    await settle();
    const dialog = dialogs(element)[0] as HTMLDialogElement;
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: -5, clientY: -5 }));
    press(document.body, 'Escape');
    await settle();
    expect(handle.state).toBe('showing');
    expect(dialog.querySelector('.content')?.textContent).toContain('Wait');
    handle.dismiss('programmatic');
    const open = manager.request(confirm, { owner, props: { name: 'z' } });
    await settle();
    const next = dialogs(element)[0] as HTMLDialogElement;
    const inside = next.querySelector('sf-dialog') as HTMLElement;
    inside.click();
    expect(open.state).toBe('showing');
    next.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: -5, clientY: -5 }));
    expect((await open.closed).reason).toBe('backdrop');
  });

  it('stacks modals: the lower one is suspended and inert', async () => {
    const { manager, element, owner } = await layer();
    manager.request(confirm, { owner, props: { name: 'a' } });
    await settle();
    const top = manager.request(confirm, { owner, props: { name: 'b' }, stack: true });
    await settle();
    const [lower, upper] = dialogs(element);
    expect(lower?.dataset['state']).toBe('suspended');
    expect(lower?.hasAttribute('inert')).toBe(true);
    expect(upper?.hasAttribute('inert')).toBe(false);
    press(document.body, 'Escape');
    expect((await top.closed).reason).toBe('escape');
    await settle();
    expect(dialogs(element)[0]?.dataset['state']).toBe('showing');
  });

  it('renders routable dialogs opened through the messaging bridge (deep links)', async () => {
    const { manager, element } = await layer();
    const share = defineDialogSurface<{ readonly doc: string }>({
      id: 'test/share',
      scope: 'route',
      title: (p) => `Share ${p.doc}`,
      routable: { key: 'share', params: (raw) => ok({ doc: raw['doc'] ?? '' }) },
      body: () => html`<input aria-label="Email" class="email" />`,
    });
    const bridge = createRoutableDialogBridge({ manager, owner: { scope: createScope('app') }, surfaces: [share] });
    const opened = await bridge.openDialog('share', { doc: '42' }, { source: 'deep-link' });
    expect(opened.ok).toBe(true);
    await settle();
    expect(dialogs(element)[0]?.getAttribute('aria-label')).toBe('Share 42');
  });

  it('falls back to an explicit backdrop and focus trap without showModal', async () => {
    const original = HTMLDialogElement.prototype.showModal;
    // @ts-expect-error simulate a DOM without native modal dialogs
    delete HTMLDialogElement.prototype.showModal;
    try {
      const { manager, element, owner } = await layer();
      const outside = document.createElement('button');
      document.body.append(outside);
      manager.request(confirm, { owner, props: { name: 'f' } });
      await settle();
      const dialog = dialogs(element)[0] as HTMLDialogElement;
      expect(dialog.hasAttribute('open')).toBe(true);
      expect(dialog.hasAttribute('data-native')).toBe(false);
      expect(element.shadowRoot?.querySelector('.backdrop')).not.toBeNull();
      expect(outside.hasAttribute('inert')).toBe(true);
      const ok = dialog.querySelector('.ok') as HTMLButtonElement;
      ok.focus();
      const tab = press(document.body, 'Tab');
      expect(tab.defaultPrevented).toBe(true);
      (element.shadowRoot?.querySelector('.backdrop') as HTMLElement).click();
      await settle();
      expect(outside.hasAttribute('inert')).toBe(false);
    } finally {
      HTMLDialogElement.prototype.showModal = original;
    }
  });
});

describe('<sf-surface-layer> toasts, banners and anchored surfaces', () => {
  it('renders toasts in a polite live region with action and dismiss', async () => {
    const { manager, element, owner } = await layer();
    let undone = 0;
    const undoable = defineToastSurface<void>({ id: 'test/undo', scope: 'feature', durationMs: null, message: () => 'Deleted', action: { label: () => 'Undo', run: () => (undone += 1) } });
    const a = manager.request(saved, { owner, props: { what: 'Draft' } });
    const b = manager.request(undoable, { owner });
    await settle();
    const region = element.shadowRoot?.querySelector('.toasts') as HTMLElement;
    expect(region.hasAttribute('data-open')).toBe(true);
    expect(region.querySelector('[role="status"]')?.getAttribute('aria-live')).toBe('polite');
    const toasts = [...region.querySelectorAll('sf-toast')];
    expect(toasts[0]?.getAttribute('tone')).toBe('success');
    expect(toasts[0]?.textContent).toContain('Draft saved');
    (toasts[1]?.querySelector('sf-button') as HTMLElement).click();
    expect((await b.closed).reason).toBe('action');
    expect(undone).toBe(1);
    (shadow(toasts[0] as Element, 'sf-icon-button') as HTMLElement).click();
    expect((await a.closed).reason).toBe('user');
    await settle();
    expect(region.hasAttribute('data-open')).toBe(false);
  });

  it('moves the toast region into the open modal (stays announced) and marks urgent toasts as alerts', async () => {
    const { manager, element, owner } = await layer();
    manager.request(confirm, { owner, props: { name: 'm' } });
    const urgent = defineSurface<void>({ id: 'test/urgent', kind: 'toast', scope: 'feature', priority: 'urgent', render: () => html`Offline` });
    manager.request(urgent, { owner });
    await settle();
    const dialog = dialogs(element)[0] as HTMLDialogElement;
    const region = dialog.querySelector('.toasts') as HTMLElement;
    expect(region.dataset['inModal']).toBe('true');
    expect(region.querySelector('[role="alert"]')?.textContent).toContain('Offline');
  });

  it('renders banners and anchored popovers positioned at their anchor', async () => {
    const { manager, element, owner } = await layer();
    const banner = defineSurface<void>({ id: 'test/banner', kind: 'banner', scope: 'feature', render: () => html`Low credits` });
    const tip = defineSurface<void>({ id: 'test/pop', kind: 'popover', scope: 'feature', label: 'Details', render: () => html`More` });
    const anchor = document.createElement('button');
    anchor.textContent = 'i';
    document.body.append(anchor);
    manager.request(banner, { owner });
    const pop = manager.request(tip, { owner, anchor });
    await settle();
    expect(element.shadowRoot?.querySelector('.banner')?.textContent).toContain('Low credits');
    const floating = element.shadowRoot?.querySelector('.anchored') as HTMLElement;
    expect(floating.getAttribute('role')).toBe('dialog');
    expect(floating.hasAttribute('data-open')).toBe(true);
    expect(floating.style.top).not.toBe('');
    press(document.body, 'Escape');
    expect((await pop.closed).reason).toBe('escape');
    await settle();
    expect(element.shadowRoot?.querySelector('.anchored')).toBeNull();
  });

  it('detects backdrop clicks geometrically', () => {
    const dialog = document.createElement('dialog');
    document.body.append(dialog);
    const rect = { left: 10, top: 10, right: 110, bottom: 110, width: 100, height: 100, x: 10, y: 10, toJSON: () => ({}) };
    dialog.getBoundingClientRect = () => rect;
    const at = (x: number, y: number, target: EventTarget = dialog): MouseEvent => {
      const event = new MouseEvent('click', { clientX: x, clientY: y });
      Object.defineProperty(event, 'target', { value: target });
      return event;
    };
    expect(isBackdropClick(dialog, at(5, 50))).toBe(true);
    expect(isBackdropClick(dialog, at(50, 50))).toBe(false);
    expect(isBackdropClick(dialog, at(5, 50, document.body))).toBe(false);
  });
});
