/**
 * Dialog types and feedback surfaces on `<sf-surface-layer>` (OVERLAYS-FEEDBACK §1.1, §1.3, §2, §3.5): confirm and
 * destructive, the wizard step frame, held changes and the inline discard row, the takeover, toasts (count, sticky ×,
 * paused on hover), a modal closing layer 3, focus return when the trigger is gone.
 */
import { createScope, unit } from '@staticflux/core';
import { createManualClock, createSurfaceManager, defineSurface, strictSurfacePolicy, type SurfaceManager, SurfaceManagerToken } from '@staticflux/messaging';
import { deepFocused, expectNoA11yIssues, press } from '@staticflux/testkit/a11y';
import { html } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defineConfirmRow, type SfConfirmRowElement } from './confirm-row.js';
import { defineMenu, type SfMenuElement } from './menu.js';
import {
  defineConfirmSurface,
  defineDialogSurface,
  defineSurfaces,
  defineToastSurface,
  dialogInitialFocus,
  type SfDialogElement,
  type SfSurfaceLayerElement,
  toastDuration,
} from './surfaces.js';
import { cleanup, events, fixture, settle, shadow } from './test-helpers.js';

beforeAll(() => {
  defineSurfaces();
  defineMenu();
  defineConfirmRow();
});
afterEach(cleanup);

const clock = createManualClock();

async function layer(): Promise<{ manager: SurfaceManager; element: SfSurfaceLayerElement; owner: { scope: ReturnType<typeof createScope> } }> {
  const manager = createSurfaceManager({ policy: strictSurfacePolicy, clock });
  const managerUnit = unit({ id: 'test/surfaces', provides: SurfaceManagerToken, scope: 'app', create: () => manager });
  const { element } = await fixture<SfSurfaceLayerElement>(html`<sf-surface-layer></sf-surface-layer>`, { units: [managerUnit] });
  return { manager, element, owner: { scope: createScope('feature') } };
}

const dialogEl = (layerEl: Element): HTMLDialogElement => layerEl.shadowRoot?.querySelector('dialog') as HTMLDialogElement;
const frameOf = (layerEl: Element): SfDialogElement => dialogEl(layerEl).querySelector('sf-dialog') as SfDialogElement;

describe('confirm and destructive dialogs', () => {
  const deleteForever = defineConfirmSurface<{ readonly count: number }>({
    id: 'test/delete-forever',
    scope: 'feature',
    destructive: true,
    title: (p) => `Delete ${p.count} designs forever?`,
    message: (p) => `${p.count} designs will be deleted. This cannot be undone.`,
    confirmLabel: (p) => `Delete ${p.count} designs forever`,
  });

  it('is an alertdialog with focus on Cancel; the backdrop does nothing; Escape is Cancel', async () => {
    const { manager, element, owner } = await layer();
    const handle = manager.request(deleteForever, { owner, props: { count: 14 } });
    await settle();
    const dialog = dialogEl(element);
    expect(dialog.getAttribute('role')).toBe('alertdialog');
    expect(frameOf(element).size).toBe('confirm');
    expect(frameOf(element).tone).toBe('danger');
    expect(deepFocused()?.textContent).toBe('Cancel');
    expectNoA11yIssues(element);
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: -5, clientY: -5 }));
    await settle();
    expect(handle.state).toBe('showing');
    press(document.body, 'Escape');
    expect((await handle.closed).reason).toBe('escape');
  });

  it('resolves true from the verb; a second dialog is refused while one is open', async () => {
    const { manager, element, owner } = await layer();
    const handle = manager.request(deleteForever, { owner, props: { count: 2 } });
    await settle();
    const second = manager.request(deleteForever, { owner, props: { count: 3 } });
    expect((await second.closed).reason).toBe('busy');
    const verb = [...frameOf(element).querySelectorAll('sf-button')].find((b) => b.textContent?.includes('forever')) as HTMLElement;
    verb.click();
    expect((await handle.closed).result).toBe(true);
  });
});

describe('wizard step frame and held changes', () => {
  const share = defineDialogSurface<{ step: number; dirty: boolean }>({
    id: 'test/share',
    scope: 'feature',
    size: 'wizard',
    title: (p) => (p.step === 1 ? 'Share' : 'Link settings'),
    body: ({ props }) => html`<input aria-label="Expires" />${props.step}`,
  });

  it('shows the back chevron from step 2 and the indicator from three steps; Escape on a later step goes back', async () => {
    const { manager, element, owner } = await layer();
    const props = { step: 1, dirty: false };
    const handle = manager.request(share, { owner, props });
    await settle();
    const frame = frameOf(element);
    frame.steps = 3;
    frame.step = 2;
    await frame.updateComplete;
    expect(shadow(frame, '.indicator').textContent).toBe('2 of 3');
    expect(shadow(frame, '.body').dataset['slide']).toBeUndefined();
    const backs = events<{ step: number }>(frame, 'sf-back');
    press(document.body, 'Escape');
    await settle();
    expect(handle.state).toBe('showing');
    expect(backs[0]?.detail.step).toBe(2);
    frame.step = 3;
    await frame.updateComplete;
    expect(shadow(frame, '.body').dataset['slide']).toBe('next');
    (shadow(frame, 'sf-icon-button') as HTMLElement).click();
    expect(backs).toHaveLength(2);
    frame.step = 1;
    await frame.updateComplete;
    expect(shadow(frame, '.body').dataset['slide']).toBe('back');
    press(document.body, 'Escape');
    expect((await handle.closed).reason).toBe('escape');
  });

  it('a dirty form shows the inline discard row instead of closing, never a second dialog', async () => {
    const { manager, element, owner } = await layer();
    const handle = manager.request(share, { owner, props: { step: 1, dirty: true } });
    await settle();
    const frame = frameOf(element);
    frame.dirty = true;
    await frame.updateComplete;
    press(document.body, 'Escape');
    await settle();
    expect(handle.state).toBe('showing');
    const row = shadow<SfConfirmRowElement>(frame, 'sf-confirm-row');
    expect(row.message).toBe('Discard changes?');
    await settle();
    expect(deepFocused()?.textContent).toBe('Keep editing');
    expectNoA11yIssues(element);
    // Escape on the row = Keep editing.
    press(deepFocused() as Element, 'Escape');
    await settle();
    expect(frame.discarding).toBe(false);
    expect(handle.state).toBe('showing');
    (shadow(frame, 'sf-icon-button') as HTMLElement).click(); // ×
    await frame.updateComplete;
    const discard = events(frame, 'sf-discard');
    (shadow(shadow(frame, 'sf-confirm-row'), '.confirm') as HTMLElement).click();
    expect(discard).toHaveLength(1);
    expect((await handle.closed).reason).toBe('user');
  });
});

describe('takeover frame', () => {
  it('fills the surface with a one-line header; Back is its own event, Escape closes', async () => {
    const { manager, element, owner } = await layer();
    const preview = defineSurface({
      id: 'test/preview',
      kind: 'dialog',
      scope: 'feature',
      label: "Milestone 'Client v1'",
      render: ({ dismiss }) =>
        html`<sf-takeover heading="Milestone 'Client v1'" meta="today 14:02 · Read-only" back-label="Back to Latest" @sf-back=${() => dismiss('user')}
          ><sf-button slot="actions">Open as new design</sf-button><p>canvas</p></sf-takeover
        >`,
    });
    const handle = manager.request(preview, { owner });
    await settle();
    const takeover = dialogEl(element).querySelector('sf-takeover') as HTMLElement;
    expect(shadow(takeover, '.meta').textContent).toBe('today 14:02 · Read-only');
    expectNoA11yIssues(element);
    (shadow(takeover, 'header > sf-button') as HTMLElement).click();
    expect((await handle.closed).reason).toBe('user');
  });
});

describe('layer order and focus', () => {
  it('opening a modal closes a kit menu opened before it; focus falls back to a landmark when the trigger is gone', async () => {
    const { manager, owner, element } = await layer();
    const panel = document.createElement('section');
    panel.setAttribute('aria-label', 'Layers');
    const row = document.createElement('button');
    row.textContent = 'Row';
    panel.append(row);
    document.body.append(panel);
    // Inside the test root, so the menu renders with the injector.
    const menuHost = document.createElement('div');
    element.parentElement?.append(menuHost);
    const { render } = await import('lit');
    render(html`<sf-menu label="Row"><sf-menu-item value="x">X</sf-menu-item></sf-menu>`, menuHost);
    const menu = menuHost.querySelector('sf-menu') as SfMenuElement;
    await settle();
    menu.show();
    await settle();
    expect(menu.open).toBe(true);
    row.focus();
    const confirm = defineConfirmSurface({ id: 'test/c', scope: 'feature', title: () => 'Delete?', message: () => 'Gone.', confirmLabel: () => 'Delete' });
    const handle = manager.request(confirm, { owner });
    await settle();
    expect(menu.open).toBe(false);
    row.remove();
    handle.dismiss('user');
    await settle();
    expect(document.activeElement).toBe(panel);
  });

  it('initial focus: autofocus, then the first field, then the primary', () => {
    const box = document.createElement('div');
    box.innerHTML = '<button>Close</button><sf-button variant="primary" tabindex="0">Save</sf-button>';
    document.body.append(box);
    expect(dialogInitialFocus(box)?.textContent).toBe('Save');
    box.insertAdjacentHTML('beforeend', '<input aria-label="Name" />');
    expect(dialogInitialFocus(box)?.localName).toBe('input');
    box.insertAdjacentHTML('beforeend', '<button autofocus>Cancel</button>');
    expect(dialogInitialFocus(box)?.textContent).toBe('Cancel');
  });
});

describe('toasts', () => {
  it('count repeats, show × only when sticky, sit bottom-centre and pause while hovered', async () => {
    const { manager, element, owner } = await layer();
    const copied = defineToastSurface({ id: 'test/copied', scope: 'feature', dedupe: true, durationMs: 5000, message: () => 'Copied' });
    const full = defineToastSurface({ id: 'test/full', scope: 'feature', priority: 'urgent', tone: 'danger', message: () => 'Storage is full. Nothing is lost until the tab closes.' });
    const first = manager.request(copied, { owner });
    manager.request(copied, { owner });
    manager.request(copied, { owner });
    manager.request(full, { owner });
    await settle();
    const toasts = [...(element.shadowRoot?.querySelectorAll('sf-toast') ?? [])] as HTMLElement[];
    expect(shadow(toasts[0] as Element, '.count').textContent).toBe('×3');
    expect(toasts[0]?.shadowRoot?.querySelector('sf-icon-button')).toBeNull();
    expect(toasts[1]?.shadowRoot?.querySelector('sf-icon-button')).not.toBeNull();
    expectNoA11yIssues(element);
    const region = element.shadowRoot?.querySelector('.toasts') as HTMLElement;
    region.dispatchEvent(new PointerEvent('pointerenter'));
    expect(manager.toastsHeld).toBe(true);
    clock.advance(10_000);
    expect(first.state).toBe('showing');
    region.dispatchEvent(new PointerEvent('pointerleave'));
    expect(manager.toastsHeld).toBe(false);
    clock.advance(5000);
    expect(first.state).toBe('dismissed');
    expect(toastDuration('neutral', false)).toBe(5000);
    expect(toastDuration('success', true)).toBe(8000);
    expect(toastDuration('danger', true)).toBe(10_000);
    expect(toastDuration('warning', false, true)).toBeNull();
  });
});
