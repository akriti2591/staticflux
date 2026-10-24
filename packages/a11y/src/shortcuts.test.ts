import { createMemorySink, createScope, createTelemetry } from '@staticflux/core';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  checkShortcuts,
  comboLabel,
  createShortcutRegistry,
  defineShortcut,
  defineShortcutScope,
  eventComboId,
  GlobalShortcutScope,
  type KeyCombo,
  parseCombo,
} from './shortcuts.js';

const EditorScope = defineShortcutScope('studio/editor');
const DialogScope = defineShortcutScope('studio/share-dialog', { parent: EditorScope });
const OtherScope = defineShortcutScope('agent-chat/panel');

const Save = defineShortcut({ id: 'studio/save', keys: ['Mod+S'], scope: EditorScope, description: 'Save' });
const Palette = defineShortcut({ id: 'shell/palette', keys: ['Mod+K', 'Mod+Shift+P'], description: 'Command palette' });
const Help = defineShortcut({ id: 'shell/help', keys: ['?'], description: 'Help' });
const Bold = defineShortcut({ id: 'studio/bold', keys: ['Mod+B'], scope: EditorScope, description: 'Bold' });
const Next = defineShortcut({ id: 'studio/next', keys: ['J'], scope: EditorScope, description: 'Next block' });

function key(k: string, init: KeyboardEventInit = {}, target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function event(k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: k, cancelable: true, ...init });
}

describe('combo parsing', () => {
  it('maps Mod per platform and validates', () => {
    expect(parseCombo('Mod+Shift+K', true)).toEqual({ ok: true, value: { ctrl: false, alt: false, shift: true, meta: true, key: 'K' } });
    expect(parseCombo('Mod+K', false).ok && parseCombo('Mod+K', false)).toMatchObject({ value: { ctrl: true, meta: false } });
    expect(parseCombo('Ctrl++', false)).toMatchObject({ ok: true, value: { ctrl: true, key: '+' } });
    expect(parseCombo('+', false)).toMatchObject({ ok: true, value: { key: '+' } });
    for (const bad of ['Shift+Mod+K', 'Hyper+K', 'Mod+', 'Mod+k', 'Mod+Banana']) {
      const r = parseCombo(bad, false);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('SF-A11Y-003');
    }
  });

  it('types combos', () => {
    expectTypeOf<'Mod+Shift+K'>().toMatchTypeOf<KeyCombo>();
    expectTypeOf<'Alt+ArrowUp'>().toMatchTypeOf<KeyCombo>();
    // @ts-expect-error modifiers out of order
    const bad: KeyCombo = 'Shift+Mod+K';
    expect(bad).toBeDefined();
  });

  it('normalizes keyboard events', () => {
    expect(eventComboId(event('k', { metaKey: true, shiftKey: true }))).toBe('Shift+Meta+K');
    expect(eventComboId(event('?', { shiftKey: true }))).toBe('?');
    expect(eventComboId(event(' '))).toBe('Space');
    expect(eventComboId(event('Esc'))).toBe('Escape');
    expect(eventComboId(event('˚', { altKey: true, code: 'KeyK' }))).toBe('Alt+K');
    expect(eventComboId(event('¡', { altKey: true, code: 'Digit1' }))).toBe('Alt+1');
    expect(eventComboId(event('Shift', { shiftKey: true }))).toBeUndefined();
    expect(eventComboId(event('Dead'))).toBeUndefined();
  });

  it('labels per platform', () => {
    expect(comboLabel('Mod+Shift+K', true)).toBe('⇧⌘K');
    expect(comboLabel('Mod+Shift+K', false)).toBe('Ctrl+Shift+K');
    expect(comboLabel('Meta+K', false)).toBe('Win+K');
    expect(comboLabel('nonsense', false)).toBe('nonsense');
  });
});

describe('shortcut registry', () => {
  it('dispatches global shortcuts and prevents default', () => {
    const registry = createShortcutRegistry({ isMac: false });
    const handler = vi.fn();
    expect(registry.register(Palette, handler).ok).toBe(true);
    const e = event('k', { ctrlKey: true });
    expect(registry.handle(e)).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    expect(registry.handle(event('P', { shiftKey: true, ctrlKey: true }))).toBe(true);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(registry.handle(event('k', { metaKey: true }))).toBe(false); // Mod = Ctrl on non-mac
  });

  it('scoped shortcuts only fire while their scope is active (incl. via an active child)', () => {
    const registry = createShortcutRegistry({ isMac: true });
    const save = vi.fn();
    registry.register(Save, save);
    expect(registry.handle(event('s', { metaKey: true }))).toBe(false);
    const deactivate = registry.activate(DialogScope);
    expect(registry.activeScopes).toEqual(['studio/share-dialog', 'studio/editor', 'a11y/global']);
    expect(registry.handle(event('s', { metaKey: true }))).toBe(true);
    deactivate();
    expect(registry.handle(event('s', { metaKey: true }))).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('rejects same-scope conflicts and duplicate ids; allows other scopes', () => {
    const registry = createShortcutRegistry({ isMac: false });
    registry.register(Save, () => undefined);
    const clash = defineShortcut({ id: 'studio/settings', keys: ['Ctrl+S'], scope: EditorScope, description: 'x' });
    const r = registry.register(clash, () => undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('SF-A11Y-002');
      expect(r.error.details).toMatchObject({ ids: ['studio/save', 'studio/settings'], combo: 'Ctrl+S' });
    }
    const dup = registry.register(Save, () => undefined);
    expect(dup.ok).toBe(false);
    const elsewhere = defineShortcut({ id: 'agent-chat/send', keys: ['Mod+S'], scope: OtherScope, description: 'x' });
    expect(registry.register(elsewhere, () => undefined).ok).toBe(true);
    const invalid = registry.register({ ...Save, id: 'studio/bad', keys: ['Bogus+K' as KeyCombo] }, () => undefined);
    expect(invalid.ok).toBe(false);
  });

  it('innermost active scope wins; shadows are reported; false passes the event on', () => {
    const registry = createShortcutRegistry({ isMac: false });
    const order: string[] = [];
    const globalSave = defineShortcut({ id: 'shell/save-all', keys: ['Mod+S'], description: 'Save all' });
    registry.register(globalSave, () => {
      order.push('global');
    });
    registry.register(Save, () => {
      order.push('editor');
      return order.length > 1 ? false : undefined;
    });
    registry.activate(EditorScope);
    registry.handle(event('s', { ctrlKey: true }));
    registry.handle(event('s', { ctrlKey: true }));
    expect(order).toEqual(['editor', 'editor', 'global']);
    const conflicts = registry.conflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ code: 'shadow', ids: ['studio/save', 'shell/save-all'] });
    const listed = registry.list();
    expect(listed.find((s) => s.id === 'shell/save-all')).toMatchObject({ active: false, shadowedBy: 'studio/save' });
    expect(listed.find((s) => s.id === 'studio/save')).toMatchObject({ active: true, labels: ['Ctrl+S'] });
  });

  it('ignores plain keys in text fields unless allowed; Mod combos work in inputs', () => {
    const registry = createShortcutRegistry({ isMac: false });
    const next = vi.fn();
    const save = vi.fn();
    registry.register(Next, next);
    registry.register(Save, save);
    registry.activate(EditorScope);
    const input = document.createElement('input');
    const checkbox = Object.assign(document.createElement('input'), { type: 'checkbox' });
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const textarea = document.createElement('textarea');
    document.body.append(input, checkbox, editable, textarea);
    const scope = createScope('t');
    registry.attach(document, scope);
    key('j', {}, input);
    key('j', {}, textarea);
    key('j', {}, editable);
    expect(next).not.toHaveBeenCalled();
    key('j', {}, checkbox);
    expect(next).toHaveBeenCalledTimes(1);
    key('s', { ctrlKey: true }, input);
    expect(save).toHaveBeenCalledTimes(1);
    const typing = defineShortcut({ id: 'studio/slash', keys: ['/'], scope: EditorScope, description: 'x', allowInInputs: true });
    const slash = vi.fn();
    registry.register(typing, slash);
    key('/', {}, input);
    expect(slash).toHaveBeenCalledTimes(1);
    void scope.dispose();
    key('j', {}, checkbox);
    expect(next).toHaveBeenCalledTimes(1);
    document.body.innerHTML = '';
  });

  it('respects when(), preventDefault: false, defaultPrevented, and scope-bound unregistration', async () => {
    const registry = createShortcutRegistry({ isMac: false });
    let enabled = false;
    const handler = vi.fn();
    const scope = createScope('feature');
    const help = defineShortcut({ ...Help, preventDefault: false });
    registry.register(help, handler, { when: () => enabled, scope });
    expect(registry.handle(event('?'))).toBe(false);
    enabled = true;
    const e = event('?');
    expect(registry.handle(e)).toBe(true);
    expect(e.defaultPrevented).toBe(false);
    const prevented = event('?');
    prevented.preventDefault();
    expect(registry.handle(prevented)).toBe(false);
    await scope.dispose();
    expect(registry.handle(event('?'))).toBe(false);
    expect(registry.list()).toHaveLength(0);
  });

  it('activation is scope-bound and unregister is idempotent', async () => {
    const registry = createShortcutRegistry({ isMac: false });
    const r = registry.register(Bold, () => undefined);
    const lifetime = createScope('panel');
    registry.activate(EditorScope, lifetime);
    expect(registry.activeScopes).toContain('studio/editor');
    await lifetime.dispose();
    expect(registry.activeScopes).toEqual([GlobalShortcutScope.id]);
    if (r.ok) {
      r.value();
      r.value();
    }
    expect(registry.list()).toHaveLength(0);
  });

  it('emits telemetry for handled shortcuts', () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'verbose' });
    telemetry.addSink(sink);
    const registry = createShortcutRegistry({ isMac: true, telemetry });
    registry.register(Palette, () => undefined);
    registry.handle(event('k', { metaKey: true }));
    const rec = sink.records.find((r) => r.type === 'event' && r.name === 'a11y.shortcut');
    expect(rec?.type === 'event' && rec.attrs).toEqual({ id: 'shell/palette', combo: 'Meta+K', scope: 'a11y/global' });
  });
});

describe('checkShortcuts', () => {
  it('finds conflicts per platform, shadows, reserved combos, invalid combos and duplicate ids', () => {
    const ctrlS = defineShortcut({ id: 'studio/ctrl-s', keys: ['Ctrl+S'], scope: EditorScope, description: 'x' });
    const close = defineShortcut({ id: 'studio/close', keys: ['Mod+W'], scope: EditorScope, description: 'x' });
    const dialogSave = defineShortcut({ id: 'studio/dialog-save', keys: ['Mod+S'], scope: DialogScope, description: 'x' });
    const broken = defineShortcut({ id: 'studio/broken', keys: ['Nope+X' as KeyCombo], description: 'x' });
    const issues = checkShortcuts([Save, ctrlS, close, dialogSave, broken, Save, { ...Save }]);
    const summary = issues.map((i) => `${i.code}:${i.platform}:${i.ids.join('|')}`);
    expect(summary).toContain('conflict:other:studio/save|studio/ctrl-s'); // Mod = Ctrl off-mac
    expect(summary).not.toContain('conflict:mac:studio/save|studio/ctrl-s');
    expect(summary).toContain('reserved:mac:studio/close');
    expect(summary).toContain('shadow:mac:studio/dialog-save|studio/save');
    expect(summary).toContain('invalid:mac:studio/broken');
    expect(summary).toContain('duplicate-id:other:studio/save');
    expect(issues.find((i) => i.code === 'shadow')?.severity).toBe('warning');
  });

  it('symbols ignore Shift, so "?" and "Shift+?" are the same combo', () => {
    const a = defineShortcut({ id: 'shell/help-a', keys: ['?'], description: 'x' });
    const b = defineShortcut({ id: 'shell/help-b', keys: ['Shift+?'], description: 'x' });
    expect(checkShortcuts([a, b]).filter((i) => i.code === 'conflict')).toHaveLength(2);
  });

  it('is clean for a well-formed set', () => {
    expect(checkShortcuts([Save, Palette, Help, Bold, Next])).toEqual([]);
  });
});
