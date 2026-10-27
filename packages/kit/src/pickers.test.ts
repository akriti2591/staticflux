/** The shared HUD / inspector popovers (STUDIO-UX-SPEC §4.2.5–§4.2.7): colour popover, font picker, alignment popover. */
import { deepFocused, expectNoA11yIssues, press } from '@staticflux/testkit/a11y';
import { html } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { alignTarget, defineAlignPopover, distributeActions, type SfAlignPopoverElement } from './align-popover.js';
import { completeHex, contrastLevel, contrastRatio, defineColorPopover, gridNextIndex, hexToHsv, hsvToHex, pushRecentColor, rankDocumentColors, type SfColorPopoverElement } from './color-popover.js';
import { defineFontPicker, fontFaceCss, fontRows, fontWindow, type SfFontPickerElement } from './font-picker.js';
import { definePopover, type SfPopoverElement } from './popover.js';
import { cleanup, events, fixture, settle, shadow, shadowAll } from './test-helpers.js';

beforeAll(() => {
  defineColorPopover();
  defineFontPicker();
  defineAlignPopover();
  definePopover();
});
afterEach(cleanup);

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('colour helpers', () => {
  it('round-trips hex and HSV, recognises complete hex, ranks document colours, keeps 8 recent', () => {
    expect(hsvToHex(hexToHsv('#FF5C39') ?? { h: 0, s: 0, v: 0 })).toBe('#FF5C39');
    expect(hexToHsv('nope')).toBeUndefined();
    expect(completeHex('ff5c3')).toBeUndefined();
    expect(completeHex('ff5c39')).toBe('#FF5C39');
    expect(completeHex('#abc')).toBe('#AABBCC');
    const docs = Array.from({ length: 14 }, (_, i) => ({ hex: `#0000${String(i).padStart(2, '0')}`, uses: i }));
    expect(rankDocumentColors(docs).map((d) => d.uses)).toEqual([13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
    expect(pushRecentColor(['#111111', '#222222'], '#222222')).toEqual(['#222222', '#111111']);
    expect(pushRecentColor(Array.from({ length: 8 }, (_, i) => `#00000${i}`), '#ffffff')).toHaveLength(8);
    expect(gridNextIndex(0, 12, 'ArrowDown')).toBe(6);
    expect(gridNextIndex(8, 12, 'ArrowDown')).toBe(8);
    expect(gridNextIndex(3, 12, 'ArrowLeft')).toBe(2);
    expect(gridNextIndex(3, 12, 'Tab')).toBeUndefined();
  });
});

describe('<sf-color-popover>', () => {
  async function picker(extra: Partial<SfColorPopoverElement> = {}): Promise<SfColorPopoverElement> {
    const { element } = await fixture<SfColorPopoverElement>(
      html`<sf-color-popover
        label="Fill"
        value="#FFF4E0"
        .documentColors=${[{ hex: '#FFF4E0', uses: 3 }, { hex: '#1C1A17', uses: 5 }]}
        .brand=${[{ name: 'cream', hex: '#FFF4E0' }, { name: 'primary', hex: undefined }]}
        .palette=${['#FF5C39', '#2B6CB0']}
        .recent=${['#00AA55']}
      ></sf-color-popover>`,
    );
    Object.assign(element, extra);
    await settle();
    return element;
  }

  it('R13.52: the contrast tag against the solid behind (AAA, AA, AA large, ×), outlined below AA, absent without one', async () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    expect(contrastRatio('nope', '#FFFFFF')).toBeUndefined();
    expect([7.2, 4.9, 3.1, 1.8].map(contrastLevel)).toEqual(['AAA', 'AA', 'AA large', '×']);
    const none = await picker();
    expect(none.shadowRoot?.querySelector('.contrast')).toBeNull();
    const dark = await picker({ value: '#16151A', contrastWith: '#ffffff' } as Partial<SfColorPopoverElement>);
    expect(shadow(dark, '.contrast')?.textContent).toBe('AAA 18.2 : 1 on #FFFFFF');
    expect(shadow(dark, '.contrast')?.hasAttribute('data-low')).toBe(false);
    const light = await picker({ contrastWith: '#FFFFFF' } as Partial<SfColorPopoverElement>);
    expect(shadow(light, '.contrast')?.textContent).toMatch(/^× 1\.\d : 1 on #FFFFFF$/);
    expect(shadow(light, '.contrast')?.hasAttribute('data-low')).toBe(true);
    expectNoA11yIssues(light);
  });

  it('previews a complete hex while typing and commits once on Enter; refuses an invalid one inline', async () => {
    const element = await picker();
    const inputs = events<{ hex: string }>(element, 'sf-input');
    const changes = events<{ kind: string; hex?: string }>(element, 'sf-change');
    const field = shadow<HTMLInputElement>(element, '.hex input');
    field.value = 'FF5C3';
    field.dispatchEvent(new Event('input'));
    expect(inputs).toHaveLength(0);
    field.value = 'FF5C39';
    field.dispatchEvent(new Event('input'));
    expect(inputs[0]?.detail.hex).toBe('#FF5C39');
    press(field, 'Enter');
    expect(changes[0]?.detail).toEqual({ kind: 'color', hex: '#FF5C39', opacity: 1 });
    await settle();
    field.value = 'zz';
    field.dispatchEvent(new Event('input'));
    press(field, 'Enter');
    await settle();
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(changes).toHaveLength(1);
    expectNoA11yIssues(element);
  });

  it('lists document colours most used first with uses in the name; brand binds the token; palette and recent commit', async () => {
    const element = await picker();
    const changes = events<{ kind: string; hex?: string; token?: string }>(element, 'sf-change');
    const docCells = shadowAll(element, 'section[aria-labelledby="docs"] .cell');
    expect(docCells.map((c) => c.getAttribute('aria-label'))).toEqual(['#1C1A17 · 5 uses', '#FFF4E0 · 3 uses']);
    expect(docCells[1]?.getAttribute('aria-pressed')).toBe('true');
    const brand = shadowAll(element, 'section[aria-labelledby="brand"] .cell');
    expect(brand[1]?.querySelector('sf-swatch')?.hasAttribute('unresolved')).toBe(true);
    (brand[0] as HTMLElement).click();
    expect(changes[0]?.detail).toEqual({ kind: 'token', token: 'cream' });
    await settle();
    expect(shadow(element, '.link').textContent).toContain('Detach');
    (shadowAll(element, 'section[aria-labelledby="palette"] .cell')[0] as HTMLElement).click();
    expect(changes[1]?.detail).toMatchObject({ kind: 'color', hex: '#FF5C39' });
    // Grid arrows.
    (docCells[0] as HTMLElement).focus();
    press(docCells[0] as HTMLElement, 'ArrowRight');
    expect(deepFocused()).toBe(docCells[1]);
  });

  it('mixed shows a hatched swatch and an empty field; an unresolved token offers Replace with', async () => {
    const element = await picker({ mixed: true, unresolved: true, token: 'primary', fallback: '#ff5c39' } as Partial<SfColorPopoverElement>);
    expect(shadow<HTMLInputElement>(element, '.hex input').value).toBe('');
    expect(shadow(element, '.value sf-swatch').hasAttribute('unresolved')).toBe(true);
    const changes = events<{ hex?: string }>(element, 'sf-change');
    (shadowAll(element, '.link').find((l) => l.textContent?.includes('Replace')) as HTMLElement).click();
    expect(changes[0]?.detail.hex).toBe('#FF5C39');
  });

  it('expands Custom inline and starts expanded in Pro; the eyedropper only where it exists', async () => {
    const element = await picker();
    expect(element.shadowRoot?.querySelector('.area')).toBeNull();
    expect(element.shadowRoot?.querySelector('[aria-label^="Pick"]')).toBeNull();
    (shadow(element, '.toggle') as HTMLElement).click();
    await settle();
    const area = shadow(element, '.area');
    expect(area.getAttribute('role')).toBe('slider');
    const changes = events<{ hex?: string }>(element, 'sf-change');
    press(area, 'ArrowLeft');
    expect(changes).toHaveLength(1);
    expectNoA11yIssues(element);
    const pro = await picker({ customOpen: true } as Partial<SfColorPopoverElement>);
    expect(pro.shadowRoot?.querySelector('.area')).not.toBeNull();
  });

  it('Escape on the surrounding popover restores the opening value', async () => {
    const { element } = await fixture<SfPopoverElement>(
      html`<sf-popover label="Fill colour" outside="pass"><button slot="trigger">Fill</button><sf-color-popover value="#FFF4E0"></sf-color-popover></sf-popover>`,
    );
    const color = element.querySelector('sf-color-popover') as SfColorPopoverElement;
    element.show();
    await settle();
    color.value = '#000000';
    const inputs = events<{ hex: string }>(color, 'sf-input');
    press(deepFocused() as Element, 'Escape');
    await settle();
    expect(element.open).toBe(false);
    expect(inputs.at(-1)?.detail.hex).toBe('#FFF4E0');
  });
});

describe('<sf-font-picker>', () => {
  const fonts = [
    { family: 'Fraunces', token: 'display', cached: true },
    { family: 'Geist', cached: true },
    { family: 'Inter', cached: false },
    { family: 'Bricolage Grotesque', cached: true },
  ];

  it('groups Recent · In this design · All, filters every group, and virtualises', () => {
    const rows = fontRows(fonts, ['Inter'], ['Geist', 'Fraunces'], '');
    expect(rows.filter((r) => r.kind === 'heading').map((r) => (r.kind === 'heading' ? r.label : ''))).toEqual(['recent', 'design', 'all']);
    expect(fontRows(fonts, ['Inter'], [], 'display').map((r) => (r.kind === 'font' ? r.font.family : r.label))).toEqual(['all', 'Fraunces']);
    expect(fontWindow(1000, 3600, 296)).toEqual({ start: 96, end: 113 });
    expect(fontFaceCss('Evil" ; x')).toBe('"Evil ; x", system-ui, sans-serif');
  });

  it('previews on hover after 150 ms, commits on click, arrows + Enter from the filter', async () => {
    const { element } = await fixture<SfFontPickerElement>(html`<sf-font-picker value="Geist" .fonts=${fonts} .recent=${['Inter']} .inDesign=${['Geist']}></sf-font-picker>`);
    const previews = events<{ family: string }>(element, 'sf-preview');
    const changes = events<{ family: string }>(element, 'sf-change');
    const options = shadowAll(element, '[role="option"]');
    expect(options[0]?.getAttribute('aria-label')).toBe('Inter, Not downloaded yet');
    expect(options.find((o) => o.getAttribute('aria-label') === 'Fraunces, @display')).toBeDefined();
    expect(options[1]?.getAttribute('aria-selected')).toBe('true');
    expect(options[0]?.getAttribute('aria-setsize')).toBe(String(options.length));
    expectNoA11yIssues(element);
    options[2]?.dispatchEvent(new PointerEvent('pointerenter'));
    await wait(60);
    expect(previews).toHaveLength(0);
    await wait(120);
    expect(previews[0]?.detail.family).toBe('Fraunces');
    options[3]?.click();
    expect(changes[0]?.detail.family).toBe('Geist');
    const input = shadow<HTMLInputElement>(element, 'input');
    input.value = 'bric';
    input.dispatchEvent(new Event('input'));
    await settle();
    press(input, 'Enter');
    expect(changes[1]?.detail.family).toBe('Bricolage Grotesque');
    input.value = 'zzz';
    input.dispatchEvent(new Event('input'));
    await settle();
    expect(shadow(element, '.empty').textContent).toBe('No fonts match');
    expectNoA11yIssues(element);
  });
});

describe('<sf-align-popover>', () => {
  it('aligns a single element to the page only, shows distribute from three, and stays open', async () => {
    expect(alignTarget(1, 'selection')).toBe('page');
    expect(alignTarget(4, 'selection')).toBe('selection');
    expect(distributeActions(2)).toEqual(['tidy-up']);
    expect(distributeActions(3)).toEqual(['distribute-horizontal', 'distribute-vertical', 'tidy-up']);
    const { element } = await fixture<SfAlignPopoverElement>(html`<sf-align-popover .count=${1}></sf-align-popover>`);
    const aligns = events<{ action: string; to: string }>(element, 'sf-align');
    expect(shadowAll(element, 'sf-icon-button')).toHaveLength(6);
    (shadow(element, '[data-action="center"]') as HTMLElement).click();
    expect(aligns[0]?.detail).toEqual({ action: 'center', to: 'page' });
    expectNoA11yIssues(element);
    element.count = 3;
    await settle();
    expect(shadowAll(element, 'sf-icon-button')).toHaveLength(9);
    (shadow(element, '[data-action="distribute-vertical"]') as HTMLElement).click();
    expect(aligns[1]?.detail).toEqual({ action: 'distribute-vertical', to: 'selection' });
    expectNoA11yIssues(element);
  });
});
