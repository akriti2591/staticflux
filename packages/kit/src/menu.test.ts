/**
 * Menus of FOUNDATIONS §4.8 / OVERLAYS-FEEDBACK §1: icons and checkmarks, group headings, one submenu level, the
 * searchable variant, context menus at a point, the consumed outside press, bottom sheets on narrow Home widths.
 */
import { deepFocused, expectNoA11yIssues, press } from '@staticflux/testkit/a11y';
import { html } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defineButton, type SfButtonElement } from './button.js';
import { copyIcon } from './icons/copy.js';
import { bindContextMenu, defineMenu, menuFilterMatch, menuPresentation, type SfMenuElement, type SfMenuItemElement } from './menu.js';
import { cleanup, events, fixture, settle, shadow, shadowAll } from './test-helpers.js';

beforeAll(() => {
  defineButton();
  defineMenu();
});
afterEach(cleanup);

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function arrangeMenu(): Promise<{ menu: SfMenuElement; trigger: SfButtonElement; row: SfMenuItemElement; sub: SfMenuElement }> {
  const { element } = await fixture<SfMenuElement>(
    html`<sf-menu label="More">
      <sf-button slot="trigger">More</sf-button>
      <sf-menu-group label="Edit">
        <sf-menu-item value="copy" .icon=${copyIcon} shortcut="Mod+C">Copy</sf-menu-item>
        <sf-menu-item value="snap" type="checkbox" checked>Snap</sf-menu-item>
      </sf-menu-group>
      <sf-menu-item value="arrange">Arrange</sf-menu-item>
      <sf-menu slot="submenu" label="Arrange">
        <sf-menu-item value="front">Bring to front</sf-menu-item>
        <sf-menu-item value="back">Send to back</sf-menu-item>
      </sf-menu>
      <sf-menu-item value="delete">Delete</sf-menu-item>
    </sf-menu>`,
  );
  const row = [...element.querySelectorAll<SfMenuItemElement>(':scope > sf-menu-item')][0] as SfMenuItemElement;
  return { menu: element, trigger: element.querySelector('sf-button') as SfButtonElement, row, sub: element.querySelector('sf-menu') as SfMenuElement };
}

describe('<sf-menu> rows', () => {
  it('draws icons, the check icon and the radio dot instead of text glyphs, and group headings', async () => {
    const { element } = await fixture<SfMenuElement>(
      html`<sf-menu label="View">
        <sf-button slot="trigger">View</sf-button>
        <sf-menu-group label="Density">
          <sf-menu-item type="radio" value="focus">Focus</sf-menu-item>
          <sf-menu-item type="radio" value="standard" checked>Standard</sf-menu-item>
        </sf-menu-group>
        <sf-menu-item type="checkbox" value="rulers" checked .icon=${copyIcon}>Rulers</sf-menu-item>
      </sf-menu>`,
    );
    const items = [...element.querySelectorAll<SfMenuItemElement>('sf-menu-item')];
    const group = element.querySelector('sf-menu-group') as HTMLElement;
    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-label')).toBe('Density');
    expect(shadow(group, '.heading').textContent).toBe('Density');
    expect(shadow(items[1] as Element, '.check sf-icon').getAttribute('name')).toBe('circle');
    expect(shadow(items[2] as Element, '.check sf-icon').getAttribute('name')).toBe('check');
    expect(shadow(items[2] as Element, 'sf-icon.icon').getAttribute('name')).toBe('copy');
    for (const item of items) expect(item.shadowRoot?.textContent ?? '').not.toMatch(/[✓●✕]/);
    expect(element.items).toHaveLength(3);
    element.show();
    await settle();
    expectNoA11yIssues(element);
  });
});

describe('submenus (one level)', () => {
  it('opens with → into the first row, closes with ← back to its row, Escape closes the submenu only', async () => {
    const { menu, trigger, row, sub } = await arrangeMenu();
    expect(row.getAttribute('aria-haspopup')).toBe('menu');
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(shadow(row, '.chevron').getAttribute('name')).toBe('chevron-right');
    trigger.focus();
    press(trigger, 'ArrowDown');
    await settle();
    row.focus();
    press(row, 'ArrowRight');
    await settle();
    expect(sub.open).toBe(true);
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(deepFocused()).toBe(sub.querySelector('sf-menu-item'));
    expect(sub.getAttribute('data-sf-overlay')).toBe('submenu');
    expectNoA11yIssues(menu);
    press(deepFocused() as Element, 'ArrowLeft');
    await settle();
    expect(sub.open).toBe(false);
    expect(menu.open).toBe(true);
    expect(deepFocused()).toBe(row);
    press(row, 'Enter');
    await settle();
    expect(sub.open).toBe(true);
    press(deepFocused() as Element, 'Escape');
    await settle();
    expect(sub.open).toBe(false);
    expect(menu.open).toBe(true);
    press(row, 'Escape');
    await settle();
    expect(menu.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('opens on hover after 150 ms, closes 300 ms after the pointer left both, and a pick closes every level', async () => {
    const { menu, trigger, row, sub } = await arrangeMenu();
    const picks = events<{ value: string }>(menu, 'sf-select');
    trigger.click();
    await settle();
    row.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, composed: true, pointerType: 'mouse' }));
    await wait(60);
    expect(sub.open).toBe(false);
    await wait(160);
    expect(sub.open).toBe(true);
    menu.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }));
    await wait(350);
    expect(sub.open).toBe(false);
    row.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, composed: true, pointerType: 'mouse' }));
    await wait(200);
    (sub.querySelectorAll('sf-menu-item')[1] as HTMLElement).click();
    await settle();
    expect(picks.map((e) => e.detail.value)).toEqual(['back']);
    expect(sub.open).toBe(false);
    expect(menu.open).toBe(false);
  });

  it('refuses a submenu inside a submenu (SF-KIT-003)', async () => {
    const { element } = await fixture<SfMenuElement>(
      html`<sf-menu label="A">
        <sf-button slot="trigger">A</sf-button>
        <sf-menu-item value="b">B</sf-menu-item>
        <sf-menu slot="submenu" label="B">
          <sf-menu-item value="c">C</sf-menu-item>
          <sf-menu slot="submenu" label="C"><sf-menu-item value="d">D</sf-menu-item></sf-menu>
        </sf-menu>
      </sf-menu>`,
    );
    const b = element.querySelector('sf-menu') as SfMenuElement;
    const c = b.querySelector('sf-menu') as SfMenuElement;
    element.show();
    await settle();
    expect(b.show().ok).toBe(true);
    await settle();
    const refused = events<{ error: { code: string } }>(c, 'sf-overlay-refused');
    const result = c.show();
    await settle();
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error.code).toBe('SF-KIT-003');
    expect(refused[0]?.detail.error.code).toBe('SF-KIT-003');
    expect(c.open).toBe(false);
  });
});

describe('searchable menu', () => {
  it('filters rows by every typed word, hides empty groups, Enter runs the first match', async () => {
    const { element } = await fixture<SfMenuElement>(
      html`<sf-menu label="More" filterable filter-label="Search actions" empty-label="No matching actions">
        <sf-button slot="trigger">More</sf-button>
        <sf-menu-group label="Arrange"><sf-menu-item value="front">Bring to front</sf-menu-item></sf-menu-group>
        <sf-menu-group label="Style"><sf-menu-item value="outline">Outline stroke</sf-menu-item><sf-menu-item value="flatten">Flatten</sf-menu-item></sf-menu-group>
      </sf-menu>`,
    );
    const picks = events<{ value: string }>(element, 'sf-select');
    element.show();
    await settle();
    const input = shadow<HTMLInputElement>(element, 'input');
    expect(deepFocused()).toBe(input);
    expect(input.getAttribute('aria-label')).toBe('Search actions');
    input.value = 'stroke out';
    input.dispatchEvent(new Event('input'));
    await settle();
    expect(element.items.map((i) => i.value)).toEqual(['outline']);
    expect((element.querySelector('sf-menu-group') as HTMLElement).hidden).toBe(true);
    expectNoA11yIssues(element);
    press(input, 'ArrowDown');
    expect(deepFocused()).toBe(element.items[0]);
    input.value = 'zzz';
    input.dispatchEvent(new Event('input'));
    await settle();
    expect(shadow(element, '.empty').textContent).toBe('No matching actions');
    input.value = 'flat';
    input.dispatchEvent(new Event('input'));
    press(input, 'Enter');
    await settle();
    expect(picks[0]?.detail.value).toBe('flatten');
    expect(element.open).toBe(false);
    expect(element.items).toHaveLength(3); // the filter resets on close
    expect(menuFilterMatch('Bring to front', 'FRONT bring')).toBe(true);
    expect(menuFilterMatch('Bring to front', 'back')).toBe(false);
  });
});

describe('context menus', () => {
  it('opens at the pointer with nothing focused, or from the keyboard on the first row, and returns focus', async () => {
    const { element } = await fixture<HTMLDivElement>(
      html`<div>
        <button class="canvas">Canvas</button>
        <sf-menu label="Canvas actions"><sf-menu-item value="paste">Paste</sf-menu-item><sf-menu-item value="select-all">Select all</sf-menu-item></sf-menu>
      </div>`,
    );
    const canvas = element.querySelector('.canvas') as HTMLButtonElement;
    const menu = element.querySelector('sf-menu') as SfMenuElement;
    const controller = new AbortController();
    bindContextMenu(canvas, menu, controller.signal);
    canvas.focus();
    const right = new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, clientX: 200, clientY: 120 });
    canvas.dispatchEvent(right);
    await settle();
    expect(right.defaultPrevented).toBe(true);
    expect(menu.open).toBe(true);
    const panel = shadow(menu, '.menu');
    expect(panel.style.left).toBe('200px');
    expect(panel.style.top).toBe('120px');
    expect(deepFocused()).toBe(shadow(menu, '.list'));
    press(shadow(menu, '.list'), 'ArrowDown');
    expect(deepFocused()).toBe(menu.items[0]);
    press(menu.items[0] as HTMLElement, 'Escape');
    await settle();
    expect(document.activeElement).toBe(canvas);
    press(canvas, 'F10', { shift: true });
    await settle();
    expect(menu.open).toBe(true);
    expect(deepFocused()).toBe(menu.items[0]);
    controller.abort();
  });

  it('consumes the outside press that closes it: the canvas never sees the pointerdown or the click', async () => {
    const { element } = await fixture<HTMLDivElement>(
      html`<div><button class="canvas">Canvas</button><sf-menu label="M"><sf-button slot="trigger">M</sf-button><sf-menu-item value="a">A</sf-menu-item></sf-menu></div>`,
    );
    const canvas = element.querySelector('.canvas') as HTMLButtonElement;
    const menu = element.querySelector('sf-menu') as SfMenuElement;
    const seen: string[] = [];
    canvas.addEventListener('pointerdown', () => seen.push('pointerdown'));
    canvas.addEventListener('click', () => seen.push('click'));
    menu.show();
    await settle();
    const down = new PointerEvent('pointerdown', { bubbles: true, composed: true, cancelable: true });
    canvas.dispatchEvent(down);
    canvas.click();
    canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, composed: true }));
    await settle();
    expect(menu.open).toBe(false);
    expect(down.defaultPrevented).toBe(true);
    expect(seen).toEqual([]);
    canvas.click();
    expect(seen).toEqual(['click']);
  });

  it('closes on wheel outside and on window resize', async () => {
    const { element } = await fixture<SfMenuElement>(html`<sf-menu label="M"><sf-button slot="trigger">M</sf-button><sf-menu-item value="a">A</sf-menu-item></sf-menu>`);
    element.show();
    await settle();
    document.body.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    await settle();
    expect(element.open).toBe(false);
    element.show();
    await settle();
    window.dispatchEvent(new Event('resize'));
    await settle();
    expect(element.open).toBe(false);
  });
});

describe('bottom sheets on narrow Home widths (§1.6)', () => {
  it('picks the sheet below 720 px only when the menu opts in', async () => {
    expect(menuPresentation('narrow', 719)).toBe('sheet');
    expect(menuPresentation('narrow', 720)).toBe('anchored');
    expect(menuPresentation('none', 320)).toBe('anchored');
    const width = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 480 });
    try {
      const { element } = await fixture<SfMenuElement>(html`<sf-menu label="Card" sheet="narrow"><sf-button slot="trigger">⋯</sf-button><sf-menu-item value="rename">Rename</sf-menu-item></sf-menu>`);
      element.show();
      await settle();
      expect(shadow(element, '.menu').hasAttribute('data-sheet')).toBe(true);
      const panel = shadow(element, '.menu');
      panel.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true, clientY: 300 }));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientY: 400 }));
      await settle();
      expect(element.open).toBe(false);
      expect(shadowAll(element, '.menu')).toHaveLength(1);
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    }
  });
});
