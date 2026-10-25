/**
 * The overlay model enforced (OVERLAYS-FEEDBACK §1.1–§1.5, §1.7): the nesting table, one layer-3 surface at a time, a
 * modal closing layer 3, Escape innermost first, consumed vs pass-through presses, focus return when the trigger is
 * gone, the shrink step and the context-menu corner rule.
 */
import { deepFocused, press } from '@staticflux/testkit/a11y';
import { html } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defineButton, type SfButtonElement } from './button.js';
import { announceOverlay, OVERLAY_OPEN_EVENT } from './internal/overlay-session.js';
import { defineMenu, type SfMenuElement } from './menu.js';
import { canNest, flatContains, OVERLAY_GAP, OVERLAY_LAYERS, OVERLAY_NESTING, type OverlayKind, parentOverlay } from './overlay.js';
import { definePopover, popoverReturnsFocus, type SfPopoverElement } from './popover.js';
import { computePointPosition, computePosition } from './position.js';
import { cleanup, events, fixture, settle } from './test-helpers.js';

beforeAll(() => {
  defineButton();
  defineMenu();
  definePopover();
});
afterEach(cleanup);

describe('the nesting table (§1.2)', () => {
  it('allows what the spec allows and refuses the rest with SF-KIT-003', () => {
    const allowed: [OverlayKind | undefined, OverlayKind][] = [
      [undefined, 'menu'],
      ['menu', 'submenu'],
      ['menu', 'dialog'],
      ['popover', 'menu'],
      ['hud', 'popover'],
      ['dialog', 'popover'],
      ['dialog', 'menu'],
      ['sheet', 'dialog'],
      ['takeover', 'menu'],
      ['dialog', 'tooltip'],
      ['submenu', 'toast'],
    ];
    for (const [parent, child] of allowed) expect(canNest(parent, child).ok, `${parent} → ${child}`).toBe(true);
    const refused: [OverlayKind, OverlayKind][] = [
      ['submenu', 'submenu'],
      ['menu', 'popover'],
      ['popover', 'popover'],
      ['dialog', 'dialog'],
      ['takeover', 'dialog'],
      ['menu', 'menu'],
    ];
    for (const [parent, child] of refused) {
      const verdict = canNest(parent, child);
      expect(verdict.ok, `${parent} → ${child}`).toBe(false);
      if (!verdict.ok) {
        expect(verdict.error.code).toBe('SF-KIT-003');
        expect(verdict.error.details).toEqual({ parent, child });
      }
    }
  });

  it('puts every kind in one of the six layers', () => {
    expect(Object.keys(OVERLAY_NESTING).sort()).toEqual(Object.keys(OVERLAY_LAYERS).sort());
    expect(OVERLAY_LAYERS.hud).toBe(1);
    expect(OVERLAY_LAYERS.menu).toBe(3);
    expect(OVERLAY_LAYERS.dialog).toBe(4);
    expect(OVERLAY_LAYERS.toast).toBe(5);
    expect(OVERLAY_LAYERS.tooltip).toBe(6);
    expect(OVERLAY_GAP).toEqual({ menu: 6, tooltip: 6, popover: 8, hud: 12 });
  });

  it('finds the parent overlay through slots and shadow hosts', () => {
    const host = document.createElement('div');
    host.setAttribute('data-sf-overlay', 'dialog');
    const root = host.attachShadow({ mode: 'open' });
    const slot = document.createElement('slot');
    root.append(slot);
    const child = document.createElement('span');
    host.append(child);
    document.body.append(host);
    expect(parentOverlay(child)?.kind).toBe('dialog');
    expect(flatContains(host, child)).toBe(true);
    expect(parentOverlay(host)).toBeUndefined();
  });
});

describe('enforced on kit overlays', () => {
  it('refuses a popover inside a popover and inside a menu', async () => {
    const { element } = await fixture<HTMLDivElement>(
      html`<div>
        <sf-popover label="Outer"><sf-button slot="trigger">Outer</sf-button><sf-popover label="Inner" class="inner"><sf-button slot="trigger">Inner</sf-button><input aria-label="x" /></sf-popover></sf-popover>
        <sf-menu label="Menu"><sf-button slot="trigger">M</sf-button><sf-menu-item value="a">A</sf-menu-item><sf-popover label="Bad" class="bad"><input aria-label="y" /></sf-popover></sf-menu>
      </div>`,
    );
    const outer = element.querySelector('sf-popover') as SfPopoverElement;
    const inner = element.querySelector('.inner') as SfPopoverElement;
    const refused = events(inner, 'sf-overlay-refused');
    outer.show();
    await settle();
    expect(inner.show().ok).toBe(false);
    expect(refused).toHaveLength(1);
    expect(inner.open).toBe(false);
    expect(outer.open).toBe(true);
    const menu = element.querySelector('sf-menu') as SfMenuElement;
    menu.show();
    await settle();
    const bad = element.querySelector('.bad') as SfPopoverElement;
    const verdict = bad.show();
    expect(verdict.ok ? '' : verdict.error.code).toBe('SF-KIT-003');
  });

  it('a popover may open one menu; Escape closes the menu first, then the popover', async () => {
    const { element } = await fixture<SfPopoverElement>(
      html`<sf-popover label="Access"><sf-button slot="trigger">Share</sf-button><sf-menu label="Role"><sf-button slot="trigger">can view</sf-button><sf-menu-item value="edit">can edit</sf-menu-item></sf-menu></sf-popover>`,
    );
    element.show();
    await settle();
    const menu = element.querySelector('sf-menu') as SfMenuElement;
    expect(menu.show().ok).toBe(true);
    await settle();
    press(deepFocused() as Element, 'Escape');
    await settle();
    expect(menu.open).toBe(false);
    expect(element.open).toBe(true);
    press(deepFocused() as Element, 'Escape');
    await settle();
    expect(element.open).toBe(false);
  });

  it('one menu or popover at a time; any modal closes them', async () => {
    const { element } = await fixture<HTMLDivElement>(
      html`<div>
        <sf-menu label="A"><sf-button slot="trigger">A</sf-button><sf-menu-item value="a">A</sf-menu-item></sf-menu>
        <sf-popover label="B"><sf-button slot="trigger">B</sf-button><input aria-label="b" /></sf-popover>
      </div>`,
    );
    const menu = element.querySelector('sf-menu') as SfMenuElement;
    const popover = element.querySelector('sf-popover') as SfPopoverElement;
    menu.show();
    await settle();
    popover.show();
    await settle();
    expect(menu.open).toBe(false);
    expect(popover.open).toBe(true);
    const toggles = events<{ open: boolean; cause?: string }>(popover, 'sf-toggle');
    announceOverlay(document, OVERLAY_OPEN_EVENT, { host: document.createElement('dialog'), kind: 'dialog' });
    await settle();
    expect(popover.open).toBe(false);
    expect(toggles[0]?.detail).toEqual({ open: false, cause: 'replaced' });
  });

  it('chrome popovers consume the outside press and follow on scroll; HUD popovers pass it and close on wheel', async () => {
    const { element } = await fixture<HTMLDivElement>(
      html`<div>
        <sf-popover label="Milestone"><sf-button slot="trigger">Milestone</sf-button><input aria-label="Name" /></sf-popover>
        <sf-popover label="Fill colour" outside="pass" class="hud"><sf-button slot="trigger">Fill</sf-button><input aria-label="Hex" /></sf-popover>
        <button class="canvas">canvas</button>
      </div>`,
    );
    const [chrome, hud] = [...element.querySelectorAll('sf-popover')] as SfPopoverElement[];
    const canvas = element.querySelector('.canvas') as HTMLButtonElement;
    chrome?.show();
    await settle();
    document.body.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    await settle();
    expect(chrome?.open).toBe(true);
    const consumed = new PointerEvent('pointerdown', { bubbles: true, composed: true, cancelable: true });
    canvas.dispatchEvent(consumed);
    canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, composed: true }));
    await settle();
    expect(chrome?.open).toBe(false);
    expect(consumed.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(chrome?.querySelector('sf-button'));
    hud?.show();
    await settle();
    document.body.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    await settle();
    expect(hud?.open).toBe(false);
    expect(popoverReturnsFocus('outside', 'pass')).toBe(false);
    expect(popoverReturnsFocus('escape', 'pass')).toBe(true);
    expect(popoverReturnsFocus('replaced', 'consume')).toBe(false);
  });

  it('returns focus to the fallback when the trigger is gone (§1.3)', async () => {
    const { element } = await fixture<HTMLDivElement>(
      html`<div><div class="canvas" tabindex="-1" data-sf-focus-fallback></div><sf-popover label="Fill"><input aria-label="Hex" /></sf-popover><button class="item">Fill</button></div>`,
    );
    const item = element.querySelector('.item') as HTMLButtonElement;
    const canvas = element.querySelector('.canvas') as HTMLElement;
    const popover = element.querySelector('sf-popover') as SfPopoverElement;
    popover.anchor = item;
    popover.returnFallback = canvas;
    popover.show();
    await settle();
    item.remove();
    press(deepFocused() as Element, 'Escape');
    await settle();
    expect(document.activeElement).toBe(canvas);
  });

  it('keeps the trigger button pressable after a consumed press elsewhere (keyboard is a new gesture)', async () => {
    const { element } = await fixture<SfMenuElement>(html`<sf-menu label="M"><sf-button slot="trigger">M</sf-button><sf-menu-item value="a">A</sf-menu-item></sf-menu>`);
    const trigger = element.querySelector('sf-button') as SfButtonElement;
    element.show();
    await settle();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true, cancelable: true }));
    await settle();
    press(trigger, 'Enter'); // sf-button turns Enter into its click
    await settle();
    expect(element.open).toBe(true);
  });
});

describe('positioning (§1.5)', () => {
  it('shrinks a list taller than its room so it scrolls inside', () => {
    const result = computePosition({ anchor: { x: 10, y: 100, width: 40, height: 20 }, floating: { width: 200, height: 900 }, viewport: { width: 800, height: 600 }, side: 'block-end', offset: 6 });
    expect(result.side).toBe('block-end');
    expect(result.maxHeight).toBe(600 - 120 - 8 - 6);
    expect(result.y).toBe(126);
    const fits = computePosition({ anchor: { x: 10, y: 100, width: 40, height: 20 }, floating: { width: 200, height: 100 }, viewport: { width: 800, height: 600 }, side: 'block-end' });
    expect(fits.maxHeight).toBeUndefined();
  });

  it('context menus put the corner on the pointer and open left or up near the edges', () => {
    const viewport = { width: 800, height: 600 };
    const floating = { width: 200, height: 300 };
    expect(computePointPosition({ point: { x: 100, y: 100 }, floating, viewport })).toEqual({ x: 100, y: 100, side: 'block-end' });
    expect(computePointPosition({ point: { x: 700, y: 500 }, floating, viewport })).toEqual({ x: 500, y: 200, side: 'block-end' });
    const tall = computePointPosition({ point: { x: 100, y: 100 }, floating: { width: 200, height: 2000 }, viewport });
    expect(tall.maxHeight).toBe(584);
    expect(tall.y).toBe(8);
  });
});
