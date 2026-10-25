/**
 * The canvas shortcuts (B3's tool keymap plus Undo, Redo, Delete, Duplicate), as data. The editor module runs them on
 * keys from the input ring (B9); main registers the same definitions in Studio's registry so the browser default is
 * prevented, the help lists them and Studio's own shortcuts are shadowed exactly as before, while the handlers live in
 * the editor.
 */
import { defineShortcut, type ShortcutDef } from '@staticflux/a11y';
import { CanvasToolsShortcutScope, TOOL_KEYMAP } from '../tools/keyboard.js';

export const UndoShortcut = /* @__PURE__ */ defineShortcut({ id: 'instaflow/undo', keys: ['Mod+Z'], scope: CanvasToolsShortcutScope, description: 'Undo' });
export const RedoShortcut = /* @__PURE__ */ defineShortcut({ id: 'instaflow/redo', keys: ['Mod+Shift+Z'], scope: CanvasToolsShortcutScope, description: 'Redo' });
export const DeleteShortcut = /* @__PURE__ */ defineShortcut({ id: 'instaflow/delete', keys: ['Delete', 'Backspace'], scope: CanvasToolsShortcutScope, description: 'Delete the selection' });
export const DuplicateShortcut = /* @__PURE__ */ defineShortcut({ id: 'instaflow/duplicate', keys: ['Mod+D'], scope: CanvasToolsShortcutScope, description: 'Duplicate the selection' });

/** Every canvas shortcut definition (B3's keymap first, as `bindToolShortcuts` registers it). */
export function canvasShortcutDefs(): readonly ShortcutDef[] {
  return [
    ...TOOL_KEYMAP.map((b) => defineShortcut({ id: b.id, keys: b.keys, scope: CanvasToolsShortcutScope, description: b.description, allowInInputs: false })),
    UndoShortcut,
    RedoShortcut,
    DeleteShortcut,
    DuplicateShortcut,
  ];
}
