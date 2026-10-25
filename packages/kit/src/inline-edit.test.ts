import { createMachine } from '@staticflux/core';
import { expectNoA11yIssues, press } from '@staticflux/testkit/a11y';
import { html } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defineInlineEdit, type InlineEditChangeDetail, inlineEditMachine, SfInlineEditElement, validateName } from './inline-edit.js';
import { cleanup, events, fixture, settle, shadow } from './test-helpers.js';

describe('validateName', () => {
  it('trims, requires a name by default and enforces a maximum length (SF-KIT-002)', () => {
    expect(validateName('  Night market ')).toEqual({ ok: true, value: 'Night market' });
    const empty = validateName('   ');
    expect(empty.ok ? '' : `${empty.error.code} ${String(empty.error.details?.['reason'])}`).toBe('SF-KIT-002 required');
    expect(validateName('', { required: false })).toEqual({ ok: true, value: '' });
    const long = validateName('abcdef', { maxLength: 5 });
    expect(long.ok ? '' : String(long.error.details?.['reason'])).toBe('too-long');
    expect(validateName('abcde', { maxLength: 5 }).ok).toBe(true);
  });

  it('has a viewing ⇄ editing machine', () => {
    const m = createMachine(inlineEditMachine);
    expect(m.send('commit').ok).toBe(false);
    m.send('start');
    m.send('refuse');
    expect(m.state).toBe('editing');
    m.send('cancel');
    expect(m.state).toBe('viewing');
  });
});

describe('<sf-inline-edit>', () => {
  beforeAll(() => defineInlineEdit());
  afterEach(cleanup);

  const input = (el: SfInlineEditElement): HTMLInputElement => shadow<HTMLInputElement>(el, 'input');
  const type = async (el: SfInlineEditElement, text: string): Promise<void> => {
    input(el).value = text;
    input(el).dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    await el.updateComplete;
  };

  it('shows the name; double-click opens a labelled field with the text selected', async () => {
    const { element } = await fixture<SfInlineEditElement>(html`<sf-inline-edit label="Layer name" value="Rectangle 1"></sf-inline-edit>`);
    const starts = events(element, 'sf-edit-start');
    expect(shadow(element, '.text').textContent).toBe('Rectangle 1');
    expectNoA11yIssues(element);
    shadow(element, '.text').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await settle();
    expect(element.editing).toBe(true);
    expect(element.state).toBe('editing');
    expect(starts).toHaveLength(1);
    expect(input(element).getAttribute('aria-label')).toBe('Layer name');
    expect(input(element).value).toBe('Rectangle 1');
    expect(element.shadowRoot?.activeElement).toBe(input(element));
    expect([input(element).selectionStart, input(element).selectionEnd]).toEqual([0, 'Rectangle 1'.length]);
    expectNoA11yIssues(element);
  });

  it('Enter saves a changed, trimmed name once; an unchanged name fires nothing', async () => {
    const { element } = await fixture<SfInlineEditElement>(html`<sf-inline-edit label="Name" value="Old"></sf-inline-edit>`);
    const changes = events<InlineEditChangeDetail>(element, 'sf-change');
    element.edit();
    await settle();
    await type(element, '  New  ');
    press(input(element), 'Enter');
    await settle();
    expect(changes.map((e) => e.detail)).toEqual([{ value: 'New', previous: 'Old' }]);
    expect(element.value).toBe('New');
    expect(element.editing).toBe(false);
    element.edit();
    await settle();
    press(input(element), 'Enter');
    await settle();
    expect(changes).toHaveLength(1);
  });

  it('Escape cancels, and keys never reach the surroundings', async () => {
    const { element } = await fixture<HTMLDivElement>(html`<div><sf-inline-edit label="Name" value="Keep"></sf-inline-edit></div>`);
    const edit = element.firstElementChild as SfInlineEditElement;
    const outside = events(element, 'keydown');
    const cancels = events(edit, 'sf-cancel');
    edit.edit();
    await settle();
    await type(edit, 'Changed');
    press(input(edit), 'Escape');
    await settle();
    expect(edit.value).toBe('Keep');
    expect(edit.editing).toBe(false);
    expect(cancels).toHaveLength(1);
    expect(outside).toHaveLength(0);
  });

  it('refuses an empty name inline, then a blur restores the previous name', async () => {
    const { element } = await fixture<SfInlineEditElement>(html`<sf-inline-edit label="Name" value="Poster"></sf-inline-edit>`);
    const changes = events(element, 'sf-change');
    element.edit();
    await settle();
    await type(element, '   ');
    press(input(element), 'Enter');
    await settle();
    expect(element.editing).toBe(true);
    expect(element.error).toBe('A name is required');
    expect(input(element).getAttribute('aria-invalid')).toBe('true');
    expect(shadow(element, '.error').getAttribute('role')).toBe('alert');
    expectNoA11yIssues(element);
    input(element).dispatchEvent(new Event('blur'));
    await settle();
    expect(element.editing).toBe(false);
    expect(element.value).toBe('Poster');
    expect(changes).toHaveLength(0);
  });

  it('blur saves a valid draft; too-long names are refused with the limit', async () => {
    const { element } = await fixture<SfInlineEditElement>(html`<sf-inline-edit label="Name" value="A" maxlength="4"></sf-inline-edit>`);
    const changes = events<InlineEditChangeDetail>(element, 'sf-change');
    element.edit();
    await settle();
    expect(input(element).maxLength).toBe(4);
    element.maxlength = 3;
    await type(element, 'Abcd');
    press(input(element), 'Enter');
    await settle();
    expect(element.error).toBe('Use at most 3 characters');
    await type(element, 'Abc');
    input(element).dispatchEvent(new Event('blur'));
    await settle();
    expect(changes.map((e) => e.detail.value)).toEqual(['Abc']);
  });

  it('trigger="click" renders a named button that click, Enter and F2 open; focus returns to it', async () => {
    const { element } = await fixture<SfInlineEditElement>(html`<sf-inline-edit label="design title" value="" placeholder="Untitled design" trigger="click"></sf-inline-edit>`);
    const button = shadow<HTMLButtonElement>(element, 'button.text');
    expect(button.getAttribute('aria-label')).toBe('Untitled design · Rename design title');
    expect(button.textContent?.trim()).toBe('Untitled design');
    expectNoA11yIssues(element);
    press(button, 'F2');
    await settle();
    expect(element.editing).toBe(true);
    press(input(element), 'Escape');
    await settle();
    expect(element.shadowRoot?.activeElement).toBe(shadow(element, 'button.text'));
    shadow<HTMLButtonElement>(element, 'button.text').click();
    await settle();
    expect(element.editing).toBe(true);
  });

  it('starts when an app sets editing, and trigger="none" ignores double-clicks', async () => {
    const { element } = await fixture<SfInlineEditElement>(html`<sf-inline-edit label="Name" value="Row" trigger="none"></sf-inline-edit>`);
    shadow(element, '.text').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await settle();
    expect(element.editing).toBe(false);
    element.editing = true;
    await settle();
    expect(element.state).toBe('editing');
    expect(element.shadowRoot?.querySelector('input')).not.toBeNull();
  });
});
