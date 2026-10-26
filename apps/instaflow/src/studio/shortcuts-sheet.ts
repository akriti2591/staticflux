/**
 * The keyboard cheat sheet (B11b, STUDIO-UX-SPEC §2.3.1): the kit's `<sf-shortcut-sheet>` over Studio's shortcut
 * registry in a settings-size dialog. The registry is the source of truth (rows of shortcuts that are not registered
 * here are absent); this module only names each registered shortcut's card, in the order a person works: Tools ·
 * Selection · Edit · Arrange · Transform · Text · View · Studio. `?` (or `Shift+?`) toggles it; Escape closes.
 */
import type { ActiveShortcut } from '@staticflux/a11y';
import { defineDialogSurface } from '@staticflux/kit/surface-defs';
import { type SfShortcutSheetElement, shortcutSheetGroups, type ShortcutSheetGroup } from '@staticflux/kit/shortcut-sheet';
import type { SurfaceDef } from '@staticflux/messaging';
import { html } from 'lit';
import { ref } from 'lit/directives/ref.js';

export const SHORTCUT_GROUPS = ['Tools', 'Selection', 'Edit', 'Arrange', 'Transform', 'Text', 'View', 'Studio'] as const;
export type ShortcutGroupName = (typeof SHORTCUT_GROUPS)[number];

export const shortcutsSheetMessages = Object.freeze({ title: 'Keyboard shortcuts' });

/** What the grouping knows beyond the id (the registered lenses, the key commands' own cards). */
export interface ShortcutGroupContext {
  /** Lens ids (their `<id>-shortcut` keys are Studio's; every other `<id>-shortcut` is a tool's). */
  readonly lenses: ReadonlySet<string>;
  /** Key command id → its card (`Style` keys sit on the Edit card). */
  readonly commands: ReadonlyMap<string, ShortcutGroupName>;
}

const PATTERNS: readonly (readonly [RegExp, ShortcutGroupName])[] = [
  [/^instaflow\/(select-|extend-|deselect$)/, 'Selection'],
  [/^instaflow\/(arrow-|resize-|rotate-|flip-|free-transform$|transform-)/, 'Transform'],
  [/^instaflow\/(zoom-|fit-all$|toggle-dock$|toggle-inspector$|next-page$|previous-page$|first-page$|last-page$)/, 'View'],
  [/^instaflow\/text-/, 'Text'],
  [/^instaflow\/(cut|copy|paste|paste-in-place)-key$/, 'Edit'],
];

/** The card a registered shortcut belongs to; Studio's own keys (focus, rename, save, help, export…) are `Studio`. */
export function shortcutGroupOf(entry: Pick<ActiveShortcut, 'id'>, ctx: ShortcutGroupContext): ShortcutGroupName {
  const id = entry.id.replace(/-chrome$/, '');
  const command = ctx.commands.get(id);
  if (command !== undefined) return command;
  const owner = id.replace(/-shortcut$/, '');
  if (id.endsWith('-shortcut')) return ctx.lenses.has(owner) ? 'Studio' : 'Tools';
  for (const [pattern, group] of PATTERNS) if (pattern.test(id)) return group;
  return 'Studio';
}

/** The sheet's cards from a registry snapshot. */
export function shortcutSheet(list: readonly ActiveShortcut[], ctx: ShortcutGroupContext): readonly ShortcutSheetGroup[] {
  return shortcutSheetGroups(list, (e: Pick<ActiveShortcut, 'id'>) => shortcutGroupOf(e, ctx), SHORTCUT_GROUPS);
}

/** The dialog (one instance; the app requests it with the registry snapshot taken at open time). */
export function shortcutsSheetSurface(groups: () => readonly ShortcutSheetGroup[]): SurfaceDef<void, void> {
  return defineDialogSurface<void, void>({
    id: 'instaflow/shortcuts-sheet',
    scope: 'app',
    title: () => shortcutsSheetMessages.title,
    size: 'settings',
    body: (context) =>
      html`<sf-shortcut-sheet
        .groups=${groups()}
        ${ref((el) => void (el as SfShortcutSheetElement | undefined)?.focusSearch())}
        @keydown=${(e: KeyboardEvent) => {
          // `?` again closes (typing `?` in the search field does not).
          if (e.key === '?' && !(e.composedPath()[0] instanceof HTMLInputElement)) {
            e.preventDefault();
            context.dismiss('user');
          }
        }}
      ></sf-shortcut-sheet>`,
  });
}
