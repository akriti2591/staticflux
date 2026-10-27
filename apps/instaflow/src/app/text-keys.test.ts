/** B11c audit: the text formatting keys work while editing and win over Studio's keys on the same combos. */
import { createShortcutRegistry, defineShortcut } from '@staticflux/a11y';
import { createScope, ok } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { StudioShortcutScope } from '../studio/studio.js';
import type { TypographySummary } from '../text/typography.js';
import { bindTextKeys, TEXT_EDITING_KEYS, TextEditingShortcutScope } from './text-keys.js';

const key = (k: string, init: KeyboardEventInit = {}): KeyboardEvent => new KeyboardEvent('keydown', { key: k, cancelable: true, ...init });

describe('text editing keys', () => {
  it('bind B I U S, super/subscript and the four alignments; while editing they win over Studio’s Mod+. / Mod+,', () => {
    expect(TEXT_EDITING_KEYS.map((k) => k.keys[0])).toEqual(['Mod+B', 'Mod+I', 'Mod+U', 'Mod+Shift+X', 'Mod+.', 'Mod+,', 'Mod+Shift+L', 'Mod+Shift+E', 'Mod+Shift+R', 'Mod+Shift+J', 'Mod+\\']);
    const registry = createShortcutRegistry({ isMac: false });
    const scope = createScope('text-keys-test');
    const ran: string[] = [];
    registry.register(defineShortcut({ id: 'test/density', keys: ['Mod+.'], scope: StudioShortcutScope, description: 'density' }), () => void ran.push('density'));
    registry.activate(StudioShortcutScope, scope);
    let editing = false;
    let summary = { script: undefined } as unknown as TypographySummary;
    const text = {
      toggle: (k: string) => (ran.push(`toggle ${k}`), ok()),
      setScript: (s: string | null) => (ran.push(`script ${s}`), ok()),
      setAlign: (a: string) => (ran.push(`align ${a}`), ok()),
    };
    let selected = false;
    expect(bindTextKeys({ registry, text: text as never, summary: () => summary, editing: () => editing, textSelected: () => selected, problem: () => undefined, scope })).toBeUndefined();
    registry.handle(key('.', { ctrlKey: true }));
    expect(ran).toEqual(['density']);
    editing = true;
    const off = registry.activate(TextEditingShortcutScope, scope);
    registry.handle(key('b', { ctrlKey: true }));
    registry.handle(key('X', { ctrlKey: true, shiftKey: true }));
    registry.handle(key('.', { ctrlKey: true }));
    summary = { script: 'super' } as unknown as TypographySummary;
    registry.handle(key('.', { ctrlKey: true }));
    registry.handle(key('E', { ctrlKey: true, shiftKey: true }));
    expect(ran).toEqual(['density', 'toggle bold', 'toggle strike', 'script super', 'script null', 'align center']);
    off();
    editing = false;
    registry.handle(key('.', { ctrlKey: true }));
    expect(ran.at(-1)).toBe('density');
    // A selected (not edited) text: B I U S apply; Mod+. stays the density.
    selected = true;
    registry.activate(TextEditingShortcutScope, scope);
    registry.handle(key('u', { ctrlKey: true }));
    registry.handle(key('.', { ctrlKey: true }));
    expect(ran.slice(-2)).toEqual(['toggle underline', 'density']);
    void scope.dispose();
  });
});
