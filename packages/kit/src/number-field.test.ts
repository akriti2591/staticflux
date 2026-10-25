import { createMachine } from '@staticflux/core';
import { expectNoA11yIssues, press } from '@staticflux/testkit/a11y';
import { html } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  clampNumber,
  defineNumberField,
  formatNumberValue,
  normalizeAngle,
  type NumberChangeDetail,
  numberScrubMachine,
  parseNumberInput,
  roundTo,
  scrubDelta,
  SfNumberFieldElement,
  stepMultiplier,
} from './number-field.js';
import { cleanup, events, fixture, shadow } from './test-helpers.js';

const PAGE_UNITS = { px: 1, in: 96, mm: 96 / 25.4, pt: 96 / 72 };

const value = (text: string, context = {}): number | string => {
  const r = parseNumberInput(text, context);
  return r.ok ? r.value : r.error.code;
};

describe('parseNumberInput', () => {
  it('reads numbers, decimals with a comma, signs and expressions', () => {
    expect(value('120')).toBe(120);
    expect(value(' 12.5 ')).toBe(12.5);
    expect(value('0,5')).toBe(0.5);
    expect(value('-40')).toBe(-40);
    expect(value('(100 + 20) / 2')).toBe(60);
    expect(value('2 * -3')).toBe(-6);
    expect(value('10 - 2 - 3')).toBe(5);
  });

  it('applies a leading +, * or / to the current value (a leading - is a negative number)', () => {
    expect(value('+10', { current: 120 })).toBe(130);
    expect(value('*2', { current: 120 })).toBe(240);
    expect(value('/4', { current: 120 })).toBe(30);
    expect(value('-10', { current: 120 })).toBe(-10);
    expect(value('+10')).toBe(10);
  });

  it('converts units to the field unit and percentages of a reference', () => {
    expect(value('2in', { unit: 'px', units: PAGE_UNITS })).toBe(192);
    expect(value('72 pt', { unit: 'px', units: PAGE_UNITS })).toBe(96);
    expect(value('10px', { unit: 'px', units: PAGE_UNITS })).toBe(10);
    expect(value('1in + 4', { unit: 'px', units: PAGE_UNITS })).toBe(100);
    expect(value('50%', { percentOf: 1080 })).toBe(540);
    expect(value('45°', { unit: '°' })).toBe(45);
    expect(value('50%', { unit: '%' })).toBe(50);
  });

  it('refuses empty text, junk, unknown units and division by zero with SF-KIT-001', () => {
    for (const text of ['', '  ', 'abc', '12px3', '2ft', '50%', '10/0', '(1 + 2', '1 +', '45°']) expect(value(text, { unit: 'px', units: PAGE_UNITS }), text).toBe('SF-KIT-001');
    const r = parseNumberInput('2ft', { unit: 'px' });
    expect(r.ok ? undefined : r.error.fix).toContain('units');
  });
});

describe('number helpers', () => {
  it('steps ×10 with Shift and ×0.1 with Alt', () => {
    expect([stepMultiplier({}), stepMultiplier({ shiftKey: true }), stepMultiplier({ altKey: true })]).toEqual([1, 10, 0.1]);
  });

  it('scrubs one step per 2 px of travel', () => {
    expect(scrubDelta(1, 1, {})).toBe(0);
    expect(scrubDelta(10, 1, {})).toBe(5);
    expect(scrubDelta(-10, 1, {})).toBe(-5);
    expect(scrubDelta(10, 1, { shiftKey: true })).toBe(50);
    expect(scrubDelta(10, 1, { altKey: true })).toBe(0.5);
  });

  it('rounds without float noise, formats without trailing zeros, and never shows -0', () => {
    expect(roundTo(0.1 + 0.2, 2)).toBe(0.3);
    expect(roundTo(1.005, 2)).toBe(1.01);
    expect(formatNumberValue(12.5)).toBe('12.5');
    expect(formatNumberValue(12)).toBe('12');
    expect(formatNumberValue(1 / 3, 3)).toBe('0.333');
    expect(formatNumberValue(-0.0001)).toBe('0');
  });

  it('normalises angles to (−180, 180] and clamps to limits', () => {
    expect([normalizeAngle(180), normalizeAngle(-180), normalizeAngle(270), normalizeAngle(-190), normalizeAngle(720)]).toEqual([180, 180, -90, 170, 0]);
    expect(clampNumber(0, { min: 1 })).toBe(1);
    expect(clampNumber(500, { max: 100 })).toBe(100);
    expect(clampNumber(190, { wrap: 'angle' })).toBe(-170);
  });

  it('has a scrub machine: press, then moves, then release or cancel', () => {
    const m = createMachine(numberScrubMachine);
    expect(m.send('move').ok).toBe(false);
    m.send('press');
    m.send('move');
    expect(m.state).toBe('scrubbing');
    m.send('cancel');
    expect(m.state).toBe('idle');
  });
});

describe('<sf-number-field>', () => {
  beforeAll(() => defineNumberField());
  afterEach(cleanup);

  const mount = async (template = html`<sf-number-field label="W" unit="px" .units=${PAGE_UNITS} .value=${920} min="1"></sf-number-field>`): Promise<{ readonly field: SfNumberFieldElement; readonly input: HTMLInputElement; readonly label: HTMLElement }> => {
    const { element } = await fixture<SfNumberFieldElement>(template);
    return { field: element, input: shadow<HTMLInputElement>(element, 'input'), label: shadow(element, 'label') };
  };

  const type = async (field: SfNumberFieldElement, input: HTMLInputElement, text: string): Promise<void> => {
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    await field.updateComplete;
  };

  it('is a labelled spinbutton with its unit and passes the audit', async () => {
    const { field, input, label } = await mount();
    expect(input.getAttribute('role')).toBe('spinbutton');
    expect(input.getAttribute('aria-valuenow')).toBe('920');
    expect(input.getAttribute('aria-valuetext')).toBe('920 px');
    expect(input.getAttribute('aria-valuemin')).toBe('1');
    expect(input.value).toBe('920');
    expect(label.getAttribute('for')).toBe(input.id);
    expect(shadow(field, '.unit').textContent).toBe('px');
    expectNoA11yIssues(field);
  });

  it('commits typed expressions on Enter, clamped, with one sf-change', async () => {
    const { field, input } = await mount();
    const changes = events<NumberChangeDetail>(field, 'sf-change');
    await type(field, input, '+80');
    press(input, 'Enter');
    await field.updateComplete;
    expect(changes.map((e) => e.detail)).toEqual([{ value: 1000, delta: undefined, source: 'type' }]);
    expect(field.value).toBe(1000);
    await type(field, input, '-5');
    input.dispatchEvent(new Event('blur'));
    await field.updateComplete;
    expect(changes.at(-1)?.detail.value).toBe(1);
  });

  it('keeps invalid text with an inline error, and Escape restores', async () => {
    const { field, input } = await mount();
    const changes = events(field, 'sf-change');
    await type(field, input, '12 apples');
    press(input, 'Enter');
    await field.updateComplete;
    expect(changes).toHaveLength(0);
    expect(field.error).toBe('Enter a number');
    expect(field.hasAttribute('invalid')).toBe(true);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(shadow(field, '.error').id);
    expectNoA11yIssues(field);
    press(input, 'Escape');
    await field.updateComplete;
    expect(field.error).toBe('');
    expect(input.value).toBe('920');
  });

  it('steps with ↑/↓ (Shift ×10) and commits each step', async () => {
    const { field, input } = await mount();
    const changes = events<NumberChangeDetail>(field, 'sf-change');
    press(input, 'ArrowUp');
    press(input, 'ArrowDown', { shift: true });
    await field.updateComplete;
    expect(changes.map((e) => [e.detail.value, e.detail.delta, e.detail.source])).toEqual([
      [921, 1, 'step'],
      [911, -10, 'step'],
    ]);
  });

  it('shows Mixed: typing sets every value, stepping sends a delta', async () => {
    const { field, input } = await mount(html`<sf-number-field label="X" unit="px" mixed></sf-number-field>`);
    const changes = events<NumberChangeDetail>(field, 'sf-change');
    expect(input.placeholder).toBe('Mixed');
    expect(input.hasAttribute('aria-valuenow')).toBe(false);
    expect(input.getAttribute('aria-valuetext')).toBe('Mixed');
    press(input, 'ArrowUp');
    expect(changes[0]?.detail).toEqual({ value: undefined, delta: 1, source: 'step' });
    expect(field.mixed).toBe(true);
    await type(field, input, '40');
    press(input, 'Enter');
    await field.updateComplete;
    expect(changes[1]?.detail).toEqual({ value: 40, delta: undefined, source: 'type' });
    expect(field.mixed).toBe(false);
    expectNoA11yIssues(field);
  });

  it('scrubs on the label: live sf-input, one sf-change on release', async () => {
    const { field, label } = await mount();
    const inputs = events<NumberChangeDetail>(field, 'sf-input');
    const changes = events<NumberChangeDetail>(field, 'sf-change');
    label.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 100, pointerId: 1, bubbles: true }));
    expect(field.scrubState).toBe('pressed');
    label.dispatchEvent(new PointerEvent('pointermove', { clientX: 110, pointerId: 1, bubbles: true }));
    label.dispatchEvent(new PointerEvent('pointermove', { clientX: 120, pointerId: 1, shiftKey: true, bubbles: true }));
    expect(field.scrubState).toBe('scrubbing');
    label.dispatchEvent(new PointerEvent('pointerup', { clientX: 120, pointerId: 1, shiftKey: true, bubbles: true }));
    await field.updateComplete;
    expect(inputs.map((e) => e.detail.value)).toEqual([925, 1020]);
    expect(changes.map((e) => e.detail)).toEqual([{ value: 1020, delta: 100, source: 'scrub' }]);
    expect(field.value).toBe(1020);
    expect(field.scrubState).toBe('idle');
  });

  it('cancels a scrub on Escape and restores the start value', async () => {
    const { field, label, input } = await mount();
    const inputs = events<NumberChangeDetail>(field, 'sf-input');
    const changes = events(field, 'sf-change');
    label.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 0, pointerId: 2, bubbles: true }));
    label.dispatchEvent(new PointerEvent('pointermove', { clientX: 40, pointerId: 2, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    label.dispatchEvent(new PointerEvent('pointerup', { clientX: 40, pointerId: 2, bubbles: true }));
    await field.updateComplete;
    expect(inputs.map((e) => [e.detail.value, e.detail.delta])).toEqual([
      [940, 20],
      [920, 0],
    ]);
    expect(changes).toHaveLength(0);
    expect(input.value).toBe('920');
  });

  it('a press without movement focuses the field; disabled and scrub=false never scrub', async () => {
    const { field, label } = await mount(html`<sf-number-field label="Angle" unit="°" wrap="angle" .value=${170} .scrub=${false}></sf-number-field>`);
    label.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 0, pointerId: 3, bubbles: true }));
    expect(field.scrubState).toBe('idle');
    field.scrub = true;
    label.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 0, pointerId: 3, bubbles: true }));
    label.dispatchEvent(new PointerEvent('pointerup', { clientX: 0, pointerId: 3, bubbles: true }));
    expect(field.shadowRoot?.activeElement).toBe(shadow(field, 'input'));
  });

  it('wraps angles while scrubbing', async () => {
    const { field, label } = await mount(html`<sf-number-field label="Angle" unit="°" wrap="angle" .value=${170}></sf-number-field>`);
    const changes = events<NumberChangeDetail>(field, 'sf-change');
    label.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 0, pointerId: 4, bubbles: true }));
    label.dispatchEvent(new PointerEvent('pointermove', { clientX: 40, pointerId: 4, bubbles: true }));
    label.dispatchEvent(new PointerEvent('pointerup', { clientX: 40, pointerId: 4, bubbles: true }));
    expect(changes[0]?.detail.value).toBe(-170);
  });
});
