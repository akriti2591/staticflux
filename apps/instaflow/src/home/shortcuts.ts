/**
 * Home's keys (B11c; HOME-FILES §1.1, §2.2, §3; STUDIO-UX-SPEC §2.3.1: the cheat sheet's `Home` card shows on Home
 * only), as data: the rows Settings › Keyboard shortcuts lists on Home. `<if-home>` handles these keys; this table is
 * what the person reads, so a key added there is a row added here (`home-element.test.ts` checks both agree).
 */
import type { ShortcutSheetRow } from '@staticflux/kit/shortcut-sheet';

export const HOME_SHORTCUTS: readonly ShortcutSheetRow[] = Object.freeze([
  { id: 'instaflow/home-search', label: 'Search designs', keys: ['/'] },
  { id: 'instaflow/home-import', label: 'Import files', keys: ['Mod+I'] },
  { id: 'instaflow/home-undo', label: 'Undo the last change (the toast’s Undo)', keys: ['Mod+Z'] },
  { id: 'instaflow/home-rename', label: 'Rename the focused file', keys: ['F2', 'Mod+Shift+R'] },
  { id: 'instaflow/home-duplicate', label: 'Duplicate the focused file', keys: ['Mod+D'] },
  { id: 'instaflow/home-trash', label: 'Move to trash', keys: ['Delete', 'Backspace'] },
  { id: 'instaflow/home-menu', label: 'Open the file menu', keys: ['Shift+F10'] },
  { id: 'instaflow/home-select', label: 'Select or deselect the focused file (Files)', keys: ['Space'] },
  { id: 'instaflow/home-select-all', label: 'Select all (Files)', keys: ['Mod+A'] },
  { id: 'instaflow/home-clear', label: 'Clear the selection', keys: ['Escape'] },
]);
