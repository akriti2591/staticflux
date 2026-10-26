import { expectNoA11yIssues } from '@staticflux/testkit/a11y';
import { html } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defineSizeField, keepRatio, orientationOf, type SfSizeFieldElement, type SizeChangeDetail, sizeFromUnit, sizeInUnit, validateSide } from './size-field.js';
import { cleanup, events, fixture, shadowAll } from './test-helpers.js';

beforeAll(() => defineSizeField());
afterEach(cleanup);

describe('size helpers', () => {
  it('convert at 96 px per inch: whole pixels, one decimal for mm / in / pt', () => {
    expect(sizeInUnit(1080.4, 'px')).toBe(1080);
    expect(sizeInUnit(96, 'in')).toBe(1);
    expect(sizeInUnit(794, 'mm')).toBe(210.1);
    expect(sizeInUnit(96, 'pt')).toBe(72);
    expect(sizeFromUnit(210, 'mm')).toBe(794);
    expect(sizeFromUnit(8.5, 'in')).toBe(816);
  });

  it('validate a side and keep the ratio', () => {
    expect(validateSide(16_384, { min: 1, max: 16_384 })).toEqual({ ok: true, value: 16_384 });
    const big = validateSide(16_385, { min: 1, max: 16_384 });
    expect(big.ok ? undefined : big.error.code).toBe('SF-KIT-005');
    expect(validateSide(Number.NaN, { min: 1, max: 10 }).ok).toBe(false);
    expect(keepRatio({ width: 1080, height: 1350 }, 'width', 540)).toEqual({ width: 540, height: 675 });
    expect(keepRatio({ width: 1080, height: 1350 }, 'height', 2700)).toEqual({ width: 2160, height: 2700 });
    expect(keepRatio({ width: 0, height: 10 }, 'width', 5)).toEqual({ width: 5, height: 10 });
    expect(orientationOf(1920, 1080)).toBe('landscape');
    expect(orientationOf(1080, 1080)).toBe('portrait');
  });
});

const field = (el: SfSizeFieldElement, side: 'width' | 'height'): HTMLElement => shadowAll(el, `sf-number-field[data-side="${side}"]`)[0] as HTMLElement;
const change = (el: HTMLElement, value: number): void => void el.dispatchEvent(new CustomEvent('sf-change', { detail: { value, delta: 0, source: 'type' }, bubbles: true, composed: true }));

describe('<sf-size-field>', () => {
  it('is a named group of labelled fields, a lock, an orientation switch and units; accessible', async () => {
    const { element } = await fixture<SfSizeFieldElement>(html`<sf-size-field label="Size" .width=${1080} .height=${1350}></sf-size-field>`);
    expect(element.shadowRoot?.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Size');
    expect(shadowAll(element, 'sf-number-field').map((f) => f.getAttribute('label'))).toEqual(['Width', 'Height']);
    expectNoA11yIssues(element);
  });

  it('edits in px; with the lock on, the other side follows; orientation swaps; units convert the shown value', async () => {
    const { element } = await fixture<SfSizeFieldElement>(html`<sf-size-field .width=${1080} .height=${1350}></sf-size-field>`);
    const seen = events<SizeChangeDetail>(element, 'sf-change');
    change(field(element, 'width'), 1200);
    expect(seen.at(-1)?.detail).toEqual({ width: 1200, height: 1350, unit: 'px' });
    element.locked = true;
    change(field(element, 'width'), 600);
    expect(seen.at(-1)?.detail).toEqual({ width: 600, height: 675, unit: 'px' });
    const segmented = shadowAll(element, 'sf-segmented')[0] as HTMLElement;
    segmented.dispatchEvent(new CustomEvent('sf-change', { detail: { value: 'landscape' } }));
    expect([element.width, element.height]).toEqual([675, 600]);
    const select = element.shadowRoot?.querySelector('select') as HTMLSelectElement;
    select.value = 'in';
    select.dispatchEvent(new Event('change'));
    await element.updateComplete;
    expect(element.unit).toBe('in');
    change(field(element, 'height'), 2);
    expect(seen.at(-1)?.detail).toEqual({ width: 216, height: 192, unit: 'in' });
  });

  it('a side over the limit shows the inline error and fires nothing; Enter submits a valid size', async () => {
    const { element } = await fixture<SfSizeFieldElement>(html`<sf-size-field .width=${1080} .height=${1080}></sf-size-field>`);
    const seen = events<SizeChangeDetail>(element, 'sf-change');
    const submits = events(element, 'sf-submit');
    change(field(element, 'width'), 20_000);
    await element.updateComplete;
    expect(seen).toHaveLength(0);
    expect(element.shadowRoot?.querySelector('[role="alert"]')?.textContent).toBe('Too large for this device (max 16 384 px)');
    expectNoA11yIssues(element);
    field(element, 'width').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
    expect(submits).toHaveLength(0);
    change(field(element, 'width'), 2000);
    field(element, 'width').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
    expect(submits).toHaveLength(1);
  });
});
