import { auditA11y, deepFocused, expectNoA11yIssues, press } from '@staticflux/testkit/a11y';
import { html } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defineButton, type SfButtonElement } from './button.js';
import { closeLayer, lightDismiss, openLayer, supportsPopover } from './internal/layer.js';
import { defineMenu, type SfMenuElement, type SfMenuItemElement, typeaheadIndex } from './menu.js';
import { definePopover, firstFocusable, type SfPopoverElement } from './popover.js';
import { defineTooltip, type SfTooltipElement } from './tooltip.js';
import { cleanup, events, fixture, settle, shadow } from './test-helpers.js';

beforeAll(() => {
  defineButton();
  definePopover();
  defineTooltip();
  defineMenu();
});
afterEach(cleanup);

describe('layers', () => {
  it('uses the Popover API when present and data-open otherwise', () => {
    const plain = document.createElement('div');
    document.body.append(plain);
    expect(supportsPopover(plain)).toBe(false);
    openLayer(plain);
    expect(plain.hasAttribute('data-open')).toBe(true);
    closeLayer(plain);
    expect(plain.hasAttribute('data-open')).toBe(false);

    const native = document.createElement('div');
    let open = false;
    Object.assign(native, { showPopover: () => (open = true), hidePopover: () => (open = false) });
    native.matches = ((selector: string) => (selector === ':popover-open' ? open : false)) as typeof native.matches;
    openLayer(native);
    expect(native.getAttribute('popover')).toBe('manual');
    expect(open).toBe(true);
    closeLayer(native);
    expect(open).toBe(false);
  });

  it('dismisses on Escape, outside presses and focus leaving', () => {
    const inside = document.createElement('div');
    const outside = document.createElement('button');
    document.body.append(inside, outside);
    const causes: string[] = [];
    const controller = new AbortController();
    lightDismiss(() => [inside], (cause) => causes.push(cause), document, controller.signal, { focusOut: true });
    inside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
    const escape = press(inside, 'Escape');
    outside.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));
    expect(causes).toEqual(['outside', 'escape', 'focus-out']);
    expect(escape.defaultPrevented).toBe(true);
    controller.abort();
    press(inside, 'Escape');
    expect(causes).toHaveLength(3);
  });
});

describe('<sf-popover>', () => {
  it('toggles from its trigger, moves focus in, closes on Escape and returns focus', async () => {
    const { element } = await fixture<SfPopoverElement>(
      html`<sf-popover label="Text options"><sf-button slot="trigger">Aa</sf-button><input aria-label="Size" class="size" /></sf-popover>`,
    );
    const trigger = element.querySelector('sf-button') as SfButtonElement;
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    const toggles = events<{ open: boolean }>(element, 'sf-toggle');
    trigger.click();
    await settle();
    expect(element.open).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(shadow(element, '.panel').hasAttribute('data-open')).toBe(true);
    expect(document.activeElement).toBe(element.querySelector('.size'));
    expectNoA11yIssues(element);
    press(element.querySelector('.size') as HTMLElement, 'Escape');
    await settle();
    expect(element.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
    expect(toggles.map((e) => e.detail.open)).toEqual([true, false]);
  });

  it('pass-through: closes on an outside press, lets it through and does not steal focus back', async () => {
    const { element } = await fixture<HTMLDivElement>(html`<div><sf-popover label="P" outside="pass"><sf-button slot="trigger">Open</sf-button><p>Text</p></sf-popover><button class="other">x</button></div>`);
    const popover = element.querySelector('sf-popover') as SfPopoverElement;
    popover.show();
    await settle();
    const other = element.querySelector('.other') as HTMLButtonElement;
    const down = new PointerEvent('pointerdown', { bubbles: true, composed: true, cancelable: true });
    other.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(false);
    other.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, composed: true }));
    other.focus();
    await settle();
    expect(popover.open).toBe(false);
    expect(document.activeElement).toBe(other);
    popover.toggle();
    await settle();
    expect(popover.open).toBe(true);
    popover.hide();
    await settle();
    expect(shadow(popover, '.panel').hasAttribute('data-open')).toBe(false);
  });

  it('#58: stays open with its menu and submenu while the pointer moves away; an outside press still closes them', async () => {
    const { element } = await fixture<HTMLDivElement>(
      html`<div>
        <sf-popover label="Fill colour" outside="pass">
          <sf-button slot="trigger">Fill</sf-button>
          <sf-menu label="Type">
            <sf-button slot="trigger">Type</sf-button>
            <sf-menu-item value="gradient">Gradient</sf-menu-item>
            <sf-menu slot="submenu" label="Gradient"><sf-menu-item value="linear">Linear</sf-menu-item></sf-menu>
          </sf-menu>
        </sf-popover>
        <div class="canvas"></div>
      </div>`,
    );
    const popover = element.querySelector('sf-popover') as SfPopoverElement;
    const menu = popover.querySelector('sf-menu') as SfMenuElement;
    const sub = menu.querySelector('sf-menu') as SfMenuElement;
    const canvas = element.querySelector('.canvas') as HTMLElement;
    const changes = [...events(element, 'sf-select'), ...events(element, 'sf-change')];
    popover.show();
    await settle();
    menu.show();
    await settle();
    (menu.querySelector('sf-menu-item') as SfMenuItemElement).dispatchEvent(new PointerEvent('pointerover', { bubbles: true, composed: true, pointerType: 'mouse' }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sub.open).toBe(true);
    const move = { bubbles: true, composed: true, pointerType: 'mouse', relatedTarget: canvas } as const;
    for (const host of [sub, menu, popover]) {
      host.dispatchEvent(new PointerEvent('pointerout', move));
      host.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse', relatedTarget: canvas }));
      host.dispatchEvent(new MouseEvent('mouseleave', { relatedTarget: canvas }));
    }
    canvas.dispatchEvent(new PointerEvent('pointerover', move));
    canvas.dispatchEvent(new PointerEvent('pointermove', move));
    await new Promise((resolve) => setTimeout(resolve, 400));
    await settle();
    expect([popover.open, menu.open, sub.open]).toEqual([true, true, true]);
    expect(changes).toHaveLength(0);
    const down = new PointerEvent('pointerdown', { bubbles: true, composed: true, cancelable: true, pointerType: 'mouse' });
    canvas.dispatchEvent(down);
    await settle();
    expect([popover.open, menu.open, sub.open]).toEqual([false, false, false]);
  });

  it('anchors to an external element and finds the first focusable child', async () => {
    const anchor = document.createElement('div');
    document.body.append(anchor);
    const { element } = await fixture<SfPopoverElement>(html`<sf-popover label="Selection" .anchor=${anchor}><span>Hi</span></sf-popover>`);
    const before = deepFocused();
    element.show();
    await settle();
    // Nothing to type into or press: focus stays where it was (OVERLAYS-FEEDBACK §1.3).
    expect(deepFocused()).toBe(before);
    const box = document.createElement('div');
    box.innerHTML = '<span></span><a href="#">link</a>';
    expect(firstFocusable([box])?.localName).toBe('a');
    expect(firstFocusable([document.createElement('p')])).toBeUndefined();
  });
});

describe('<sf-tooltip>', () => {
  it('describes its anchor from the same tree and shows on focus', async () => {
    const { element } = await fixture<SfTooltipElement>(html`<sf-tooltip text="Align left" shortcut="Mod+Shift+L"><sf-button>L</sf-button></sf-tooltip>`);
    const button = element.querySelector('sf-button') as SfButtonElement;
    const tip = element.tipElement;
    expect(tip.getAttribute('role')).toBe('tooltip');
    expect(tip.textContent).toMatch(/^Align left .*L$/);
    expect(button.getAttribute('aria-describedby')).toBe(tip.id);
    expect(auditA11y(element)).toEqual([]);
    button.focus();
    await settle();
    expect(shadow(element, '.tooltip').hasAttribute('data-open')).toBe(true);
    button.blur();
    element.dispatchEvent(new FocusEvent('focusout'));
    await settle();
    expect(shadow(element, '.tooltip').hasAttribute('data-open')).toBe(false);
    element.text = 'Align start';
    await element.updateComplete;
    expect(tip.textContent).toContain('Align start');
    expect(button.getAttribute('aria-describedby')).toBe(tip.id);
  });
});

describe('<sf-menu>', () => {
  async function menu(): Promise<{ element: SfMenuElement; trigger: SfButtonElement; items: SfMenuItemElement[] }> {
    const { element } = await fixture<SfMenuElement>(
      html`<sf-menu label="Insert">
        <sf-button slot="trigger">Insert</sf-button>
        <sf-menu-item value="image" shortcut="Mod+I">Image</sf-menu-item>
        <sf-menu-item value="text">Text</sf-menu-item>
        <sf-menu-item value="table" disabled>Table</sf-menu-item>
        <div role="separator"></div>
        <sf-menu-item value="snap" type="checkbox">Snap to grid</sf-menu-item>
      </sf-menu>`,
    );
    return { element, trigger: element.querySelector('sf-button') as SfButtonElement, items: [...element.querySelectorAll('sf-menu-item')] as SfMenuItemElement[] };
  }

  it('wires the menu button pattern and item roles', async () => {
    const { element, trigger, items } = await menu();
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(items.map((i) => i.getAttribute('role'))).toEqual(['menuitem', 'menuitem', 'menuitem', 'menuitemcheckbox']);
    expect(items[3]?.getAttribute('aria-checked')).toBe('false');
    expect(items[2]?.getAttribute('aria-disabled')).toBe('true');
    expect(items[0]?.getAttribute('aria-keyshortcuts')).toMatch(/\+I$/);
    expectNoA11yIssues(element);
  });

  it('opens from the keyboard, navigates, type-ahead, activates and returns focus', async () => {
    const { element, trigger, items } = await menu();
    const selections = events<{ value: string; checked: boolean | undefined }>(element, 'sf-select');
    trigger.focus();
    press(trigger, 'ArrowDown');
    await settle();
    expect(element.open).toBe(true);
    expect(document.activeElement).toBe(items[0]);
    press(items[0] as HTMLElement, 'ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    press(items[1] as HTMLElement, 'ArrowDown'); // skips disabled "Table"
    expect(document.activeElement).toBe(items[3]);
    press(items[3] as HTMLElement, 'i'); // type-ahead
    expect(document.activeElement).toBe(items[0]);
    press(items[0] as HTMLElement, 'ArrowUp'); // wraps
    expect(document.activeElement).toBe(items[3]);
    press(items[3] as HTMLElement, 'Enter');
    await settle();
    expect(selections[0]?.detail).toEqual({ value: 'snap', checked: true });
    expect(items[3]?.checked).toBe(true);
    expect(element.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
    press(trigger, 'ArrowUp');
    await settle();
    expect(document.activeElement).toBe(items[3]);
    press(items[3] as HTMLElement, 'Escape');
    await settle();
    expect(element.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('toggles by click, activates items by click, closes on Tab without moving focus back', async () => {
    const { element, trigger, items } = await menu();
    const selections = events<{ value: string }>(element, 'sf-select');
    trigger.click();
    await settle();
    expect(element.open).toBe(true);
    items[1]?.click();
    await settle();
    expect(selections[0]?.detail.value).toBe('text');
    trigger.click();
    await settle();
    trigger.click();
    await settle();
    expect(element.open).toBe(false);
    element.show();
    await settle();
    press(items[0] as HTMLElement, 'Tab');
    await settle();
    expect(element.open).toBe(false);
    items[2]?.click();
    expect(selections).toHaveLength(1);
  });

  it('checks radio items exclusively', async () => {
    const { element } = await fixture<SfMenuElement>(
      html`<sf-menu label="Zoom"><sf-button slot="trigger">Zoom</sf-button><sf-menu-item type="radio" value="50">50%</sf-menu-item><sf-menu-item type="radio" value="100" checked>100%</sf-menu-item></sf-menu>`,
    );
    const [a, b] = [...element.querySelectorAll('sf-menu-item')] as SfMenuItemElement[];
    element.activate(a as SfMenuItemElement);
    await settle();
    expect([a?.checked, b?.checked]).toEqual([true, false]);
    expect(a?.getAttribute('role')).toBe('menuitemradio');
  });

  it('finds type-ahead matches after the current item', () => {
    expect(typeaheadIndex(['Image', 'Text', 'Table'], 1, 't')).toBe(2);
    expect(typeaheadIndex(['Image', 'Text', 'Table'], 2, 't')).toBe(1);
    expect(typeaheadIndex(['Image'], 0, 'z')).toBe(-1);
  });
});
