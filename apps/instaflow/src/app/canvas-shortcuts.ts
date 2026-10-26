/**
 * The canvas shortcuts (B3's tool keymap plus the key commands: undo, redo, delete, duplicate, and B11b's structure
 * keys), as data. The editor module runs them on keys from the input ring (B9); main registers the same definitions in
 * Studio's registry so the browser default is prevented, the help lists them and Studio's own shortcuts are shadowed
 * exactly as before, while the handlers live in the editor.
 */
import { defineShortcut, type ShortcutDef } from '@staticflux/a11y';
import { CanvasToolsShortcutScope, TOOL_KEYMAP } from '../tools/keyboard.js';
import { STUDIO_KEY_COMMANDS } from './studio-commands.js';

const keyDef = (id: string): ShortcutDef => STUDIO_KEY_COMMANDS.find((k) => k.def.id === id)?.def as ShortcutDef;
export const UndoShortcut = keyDef('instaflow/undo');
export const RedoShortcut = keyDef('instaflow/redo');
export const DeleteShortcut = keyDef('instaflow/delete');
export const DuplicateShortcut = keyDef('instaflow/duplicate');

/** Every canvas shortcut definition (B3's keymap first, as `bindToolShortcuts` registers it). */
export function canvasShortcutDefs(): readonly ShortcutDef[] {
  return [
    ...TOOL_KEYMAP.map((b) => defineShortcut({ id: b.id, keys: b.keys, scope: CanvasToolsShortcutScope, description: b.description, allowInInputs: false })),
    ...STUDIO_KEY_COMMANDS.map((k) => k.def),
  ];
}
