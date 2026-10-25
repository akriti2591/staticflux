import { auditA11y } from '@staticflux/testkit/a11y';
import { html } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defineSwatch, SfSwatchElement, swatchColor, swatchOpacity } from './swatch.js';
import { cleanup, fixture, shadow } from './test-helpers.js';

beforeAll(() => defineSwatch());
afterEach(cleanup);

describe('swatch helpers', () => {
  it('accepts CSS colours and rejects anything that could break out of the property', () => {
    expect(swatchColor(' #FF5C39 ')).toBe('#FF5C39');
    expect(swatchColor('rgb(255, 92, 57)')).toBe('rgb(255, 92, 57)');
    expect(swatchColor('oklch(0.7 0.2 40 / 50%)')).toBe('oklch(0.7 0.2 40 / 50%)');
    expect(swatchColor('tomato')).toBe('tomato');
    for (const bad of ['red; background: url(x)', '#12', 'url(evil)x', '', 'var(--x);}']) expect(swatchColor(bad), bad).toBe('');
  });

  it('clamps opacity to 0–1', () => {
    expect([swatchOpacity(undefined), swatchOpacity(Number.NaN), swatchOpacity(-1), swatchOpacity(0.4), swatchOpacity(3)]).toEqual([1, 1, 0, 0.4, 1]);
  });
});

describe('<sf-swatch>', () => {
  it('is decorative and fills with the resolved colour at its opacity', async () => {
    const { element } = await fixture<SfSwatchElement>(html`<sf-swatch color="#FF5C39" .opacity=${0.5}></sf-swatch>`);
    expect(element.getAttribute('aria-hidden')).toBe('true');
    expect(element.hasAttribute('role')).toBe(false);
    expect(shadow(element, '.chip').getAttribute('style')).toBe('--_fill:color-mix(in srgb, #FF5C39 50%, transparent)');
    expect(auditA11y(element.parentElement as HTMLElement)).toEqual([]);
  });

  it('hatches when unresolved and is transparent without a usable colour', async () => {
    const { element } = await fixture<SfSwatchElement>(html`<sf-swatch unresolved color="nope;"></sf-swatch>`);
    expect(element.hasAttribute('unresolved')).toBe(true);
    expect(shadow(element, '.chip').getAttribute('style')).toBe('--_fill:transparent');
    const cssText = SfSwatchElement.styles.map((s) => String(s)).join('\n');
    expect(cssText).toContain('repeating-linear-gradient');
    expect(cssText).toContain('border-radius: var(--sf-radius-full)');
    expect(cssText).toContain('forced-colors');
  });

  it('reflects size 24', async () => {
    const { element } = await fixture<SfSwatchElement>(html`<sf-swatch color="#fff" size="24"></sf-swatch>`);
    expect(element.getAttribute('size')).toBe('24');
  });
});
