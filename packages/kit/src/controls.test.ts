import { expectNoA11yIssues, press } from '@staticflux/testkit/a11y';
import { html } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defineColorField, pickerValue, SfColorFieldElement } from './color-field.js';
import { defineSegmented, SfSegmentedElement } from './segmented.js';
import { defineSlider, SfSliderElement, snapToStep } from './slider.js';
import { defineTextField, SfTextFieldElement } from './text-field.js';
import { cleanup, events, fixture, settle, shadow, shadowAll } from './test-helpers.js';

beforeAll(() => {
  defineSegmented();
  defineTextField();
  defineSlider();
  defineColorField();
});
afterEach(cleanup);

const densities = [
  { value: 'focus', label: 'Focus' },
  { value: 'standard', label: 'Standard' },
  { value: 'pro', label: 'Pro', disabled: false },
];

describe('<sf-segmented>', () => {
  it('is a labelled radio group with one tab stop on the checked segment', async () => {
    const { element } = await fixture<SfSegmentedElement>(html`<sf-segmented label="Density" .options=${densities} value="standard"></sf-segmented>`);
    expect(element.getAttribute('role')).toBe('radiogroup');
    expect(element.getAttribute('aria-label')).toBe('Density');
    const radios = shadowAll(element, '[role="radio"]');
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(radios.map((r) => r.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
    expectNoA11yIssues(element);
  });

  it('selects with arrows (selection follows focus) and clicks; fires sf-change', async () => {
    const { element } = await fixture<SfSegmentedElement>(html`<sf-segmented label="Density" .options=${densities} value="standard"></sf-segmented>`);
    const changes = events<{ value: string }>(element, 'sf-change');
    const radios = shadowAll(element, '[role="radio"]');
    radios[1]?.focus();
    press(radios[1] as HTMLElement, 'ArrowRight');
    await element.updateComplete;
    expect(element.value).toBe('pro');
    expect(element.shadowRoot?.activeElement).toBe(radios[2]);
    radios[0]?.click();
    await element.updateComplete;
    expect(changes.map((e) => e.detail.value)).toEqual(['pro', 'focus']);
    radios[0]?.click();
    expect(changes).toHaveLength(2);
  });

  it('mirrors arrows in RTL and ignores disabled segments and a disabled group', async () => {
    document.documentElement.setAttribute('dir', 'rtl');
    const options = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B', disabled: true }, { value: 'c', label: 'C' }];
    const { element } = await fixture<SfSegmentedElement>(html`<sf-segmented label="X" .options=${options} value="a"></sf-segmented>`);
    const radios = shadowAll(element, '[role="radio"]');
    radios[0]?.focus();
    press(radios[0] as HTMLElement, 'ArrowLeft'); // RTL: left = next → skips disabled b
    await element.updateComplete;
    expect(element.value).toBe('c');
    expect(radios[1]?.getAttribute('aria-disabled')).toBe('true');
    radios[1]?.click();
    expect(element.value).toBe('c');
    element.disabled = true;
    await element.updateComplete;
    expect(element.getAttribute('aria-disabled')).toBe('true');
    radios[0]?.click();
    expect(element.value).toBe('c');
  });

  it('labels icon-only segments', async () => {
    const { element } = await fixture<SfSegmentedElement>(html`<sf-segmented label="Align" icon-only .options=${[{ value: 'l', label: 'Left', icon: html`<svg></svg>` }]} value="l"></sf-segmented>`);
    expect(shadow(element, '[role="radio"]').getAttribute('aria-label')).toBe('Left');
    expectNoA11yIssues(element);
  });
});

describe('<sf-text-field>', () => {
  it('labels its control, describes hint and error in the same tree', async () => {
    const { element } = await fixture<SfTextFieldElement>(html`<sf-text-field label="Title" hint="Shown in the tab" value="Draft"></sf-text-field>`);
    const input = shadow<HTMLInputElement>(element, 'input');
    expect(input.value).toBe('Draft');
    expect(shadow(element, 'label').getAttribute('for')).toBe(input.id);
    expect(input.getAttribute('aria-describedby')).toBe(shadow(element, '.hint').id);
    expectNoA11yIssues(element);
    element.error = 'Required';
    await element.updateComplete;
    expect(element.hasAttribute('invalid')).toBe(true);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')?.split(' ')).toHaveLength(2);
    expect(shadow(element, '.error').getAttribute('role')).toBe('alert');
    expectNoA11yIssues(element);
  });

  it('tracks input, re-dispatches change, focuses and selects the control', async () => {
    const { element } = await fixture<SfTextFieldElement>(html`<sf-text-field label="Title" label-hidden></sf-text-field>`);
    expect(shadow(element, 'label').classList.contains('sr-only')).toBe(true);
    const changes = events<{ value: string }>(element, 'sf-change');
    let nativeChange = 0;
    element.addEventListener('change', () => (nativeChange += 1), { signal: new AbortController().signal });
    let hostInput = 0;
    element.addEventListener('input', () => (hostInput += 1), { signal: new AbortController().signal });
    const input = shadow<HTMLInputElement>(element, 'input');
    input.value = 'Hello';
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    expect(element.value).toBe('Hello');
    expect(hostInput).toBe(1);
    input.dispatchEvent(new Event('change'));
    expect(nativeChange).toBe(1);
    expect(changes[0]?.detail.value).toBe('Hello');
    element.focus();
    expect(element.shadowRoot?.activeElement).toBe(input);
    element.select();
  });

  it('renders a textarea when multiline', async () => {
    const { element } = await fixture<SfTextFieldElement>(html`<sf-text-field label="Message" multiline rows="4" value="Hi" placeholder="Ask…" maxlength="200"></sf-text-field>`);
    const area = shadow<HTMLTextAreaElement>(element, 'textarea');
    expect(area.value).toBe('Hi');
    expect(area.getAttribute('rows')).toBe('4');
    expect(area.getAttribute('maxlength')).toBe('200');
    expectNoA11yIssues(element);
  });
});

describe('<sf-slider>', () => {
  it('snaps values to the step within bounds', () => {
    expect(snapToStep(7.3, 0, 10, 0.5)).toBe(7.5);
    expect(snapToStep(-3, 0, 10, 1)).toBe(0);
    expect(snapToStep(12, 0, 10, 1)).toBe(10);
    expect(snapToStep(Number.NaN, 2, 10, 1)).toBe(2);
    expect(snapToStep(3.3, 0, 10, 0)).toBe(3.3);
    expect(snapToStep(0.3, 0, 1, 0.1)).toBe(0.3);
  });

  it('is a labelled native slider with value text', async () => {
    const { element } = await fixture<SfSliderElement>(html`<sf-slider label="Opacity" min="0" max="100" value="40" unit="%"></sf-slider>`);
    const input = shadow<HTMLInputElement>(element, 'input');
    expect(input.type).toBe('range');
    expect(input.getAttribute('aria-valuetext')).toBe('40%');
    expect(shadow(element, '.value').getAttribute('aria-hidden')).toBe('true');
    expectNoA11yIssues(element);
    const inputs = events<{ value: number }>(element, 'sf-input');
    const changes = events<{ value: number }>(element, 'sf-change');
    input.value = '55';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('change'));
    expect(inputs[0]?.detail.value).toBe(55);
    expect(changes[0]?.detail.value).toBe(55);
    element.format = (v) => `${v} percent`;
    await element.updateComplete;
    expect(element.valueText).toBe('55 percent');
  });
});

describe('<sf-color-field>', () => {
  it('normalizes typed hex on commit and rejects invalid input', async () => {
    const { element } = await fixture<SfColorFieldElement>(html`<sf-color-field label="Fill" value="#3a5bd9"></sf-color-field>`);
    expectNoA11yIssues(element);
    const changes = events<{ value: string }>(element, 'sf-change');
    const text = shadow<HTMLInputElement>(element, 'input.hex');
    text.value = 'F80';
    text.dispatchEvent(new Event('input'));
    text.dispatchEvent(new Event('change'));
    await element.updateComplete;
    expect(element.value).toBe('#ff8800');
    expect(changes[0]?.detail.value).toBe('#ff8800');
    text.value = 'nope';
    text.dispatchEvent(new Event('input'));
    press(text, 'Enter');
    await element.updateComplete;
    expect(element.invalid).toBe(true);
    expect(element.value).toBe('#ff8800');
    expect(text.getAttribute('aria-invalid')).toBe('true');
    expect(shadow(element, '.error').textContent).toContain('hex color');
    expectNoA11yIssues(element);
    element.commitText('#FF8800');
    expect(element.invalid).toBe(false);
    expect(changes).toHaveLength(1);
  });

  it('syncs with the native picker', async () => {
    const { element } = await fixture<SfColorFieldElement>(html`<sf-color-field label="Fill" value="#000000"></sf-color-field>`);
    const picker = shadow<HTMLInputElement>(element, 'input[type="color"]');
    expect(picker.getAttribute('aria-label')).toBe('Pick Fill');
    const inputs = events<{ value: string }>(element, 'sf-input');
    picker.value = '#123456';
    picker.dispatchEvent(new Event('input'));
    picker.dispatchEvent(new Event('change'));
    await settle();
    expect(element.value).toBe('#123456');
    expect(inputs[0]?.detail.value).toBe('#123456');
    expect(pickerValue('#ABCDEF80')).toBe('#abcdef');
    expect(pickerValue('bad')).toBe('#000000');
  });
});
