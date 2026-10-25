// @vitest-environment happy-dom
import { createInjector } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import {
  applyTextIntent,
  codePointBoundary,
  createEditContextTextInput,
  createHiddenTextareaTextInput,
  editContextTextInputFactory,
  editContextTextInputUnit,
  hiddenTextareaTextInputFactory,
  hiddenTextareaTextInputUnit,
  keyIntent,
  type TextInputState,
  TextInputFactoryToken,
  textInputBindings,
} from './text-input.js';

const key = (k: string, m: Partial<KeyboardEvent> = {}) => ({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, ...m });

describe('keyIntent', () => {
  it('maps editor keys and Select All, leaves the rest to the platform', () => {
    expect(keyIntent(key('Enter'))).toEqual({ kind: 'key', key: 'Enter', shift: false, mod: false, alt: false });
    expect(keyIntent(key('ArrowLeft', { shiftKey: true, altKey: true }))).toEqual({ kind: 'key', key: 'ArrowLeft', shift: true, mod: false, alt: true });
    expect(keyIntent(key('a', { metaKey: true }))).toMatchObject({ key: 'SelectAll', mod: true });
    expect(keyIntent(key('A', { ctrlKey: true }))).toMatchObject({ key: 'SelectAll' });
    expect(keyIntent(key('a'))).toBeUndefined();
    expect(keyIntent(key('Enter', { isComposing: true }))).toBeUndefined();
  });
});

describe('applyTextIntent', () => {
  const s: TextInputState = { text: 'a😀b', selection: [4, 4] };
  it('inserts, deletes (collapsed by boundary), composes and selects', () => {
    expect(applyTextIntent(s, { kind: 'insert', text: 'X', range: [1, 3] })).toEqual({ text: 'aXb', selection: [2, 2] });
    expect(applyTextIntent(s, { kind: 'delete', range: [3, 3], direction: 'backward', unit: 'grapheme' })).toEqual({ text: 'ab', selection: [1, 1] });
    expect(applyTextIntent(s, { kind: 'delete', range: [1, 1], direction: 'forward', unit: 'grapheme' })).toEqual({ text: 'ab', selection: [1, 1] });
    expect(applyTextIntent(s, { kind: 'delete', range: [3, 1], direction: 'backward', unit: 'selection' })).toEqual({ text: 'ab', selection: [1, 1] });
    expect(applyTextIntent(s, { kind: 'compose-update', text: 'にほ', range: [4, 4], selection: [5, 6] })).toEqual({ text: 'a😀bにほ', selection: [5, 6] });
    expect(applyTextIntent(s, { kind: 'compose-commit', text: '日本', range: [0, 1] })).toEqual({ text: '日本😀b', selection: [2, 2] });
    expect(applyTextIntent(s, { kind: 'compose-cancel', range: [3, 4] })).toEqual({ text: 'a😀', selection: [3, 3] });
    expect(applyTextIntent(s, { kind: 'selection', selection: [0, 4] })).toEqual({ text: 'a😀b', selection: [0, 4] });
    for (const kind of ['compose-start', 'key', 'format'] as const) {
      const intent = kind === 'key' ? { kind, key: 'Enter' as const, shift: false, mod: false, alt: false } : kind === 'format' ? { kind, formats: [] } : { kind, range: [0, 0] as const };
      expect(applyTextIntent(s, intent)).toBe(s);
    }
    // a custom boundary (the editor's layout) decides how far a collapsed delete reaches
    expect(applyTextIntent(s, { kind: 'delete', range: [4, 4], direction: 'backward', unit: 'word' }, () => 0)).toEqual({ text: '', selection: [0, 0] });
  });

  it('codePointBoundary keeps surrogate pairs and clamps', () => {
    expect(codePointBoundary('a😀b', 3, 'backward')).toBe(1);
    expect(codePointBoundary('a😀b', 1, 'forward')).toBe(3);
    expect(codePointBoundary('ab', 0, 'backward')).toBe(0);
    expect(codePointBoundary('ab', 2, 'forward')).toBe(2);
  });
});

describe('implementations', () => {
  it('EditContext is unavailable without the API; the textarea needs a document', () => {
    const host = document.createElement('div');
    const r = createEditContextTextInput({ host });
    expect(!r.ok && r.error.code).toBe('SF-SURF-017');
    const noDoc = createHiddenTextareaTextInput({ host: { ownerDocument: null } as unknown as HTMLElement });
    expect(!noDoc.ok && noDoc.error.code).toBe('SF-SURF-017');
  });

  it('the hidden textarea follows the selection bounds and is removed on dispose', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const input = createHiddenTextareaTextInput({ host, label: 'Headline' });
    if (!input.ok) throw input.error;
    const area = host.querySelector('textarea') as HTMLTextAreaElement;
    expect(area.getAttribute('aria-label')).toBe('Headline');
    expect(input.value.kind).toBe('hidden-textarea');
    input.value.setSelectionBounds({ x: 40, y: 60, width: 1, height: 24 });
    expect([area.style.left, area.style.top, area.style.height]).toEqual(['40px', '60px', '24px']);
    input.value.setState({ text: 'hello', selection: [1, 3] });
    expect([area.value, area.selectionStart, area.selectionEnd]).toEqual(['hello', 1, 3]);
    input.value.setControlBounds({ x: 0, y: 0, width: 10, height: 10 });
    input.value.focus();
    expect(input.value.focused).toBe(true);
    input.value.blur();
    expect(input.value.focused).toBe(false);
    input.value.dispose();
    expect(host.querySelector('textarea')).toBeNull();
  });

  it('factories create their kind', () => {
    expect(editContextTextInputFactory.kind).toBe('edit-context');
    expect(hiddenTextareaTextInputFactory.kind).toBe('hidden-textarea');
    const host = document.createElement('div');
    const made = hiddenTextareaTextInputFactory.create({ host });
    expect(made.ok && made.value.kind).toBe('hidden-textarea');
    expect(editContextTextInputFactory.create({ host }).ok).toBe(false);
  });
});

describe('variant binding (no browser branches in feature code)', () => {
  it('binds EditContext when the platform fact says so, the textarea otherwise', async () => {
    const withEc = createInjector({ units: textInputBindings({ editContext: () => true }) });
    const a = await withEc.get(TextInputFactoryToken);
    expect(a.ok && a.value.kind).toBe('edit-context');
    const without = createInjector({ units: textInputBindings({ editContext: () => false }) });
    const b = await without.get(TextInputFactoryToken);
    expect(b.ok && b.value.kind).toBe('hidden-textarea');
    expect(hiddenTextareaTextInputUnit().provides.id).toBe(editContextTextInputUnit().provides.id);
  });
});
