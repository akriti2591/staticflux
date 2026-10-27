/**
 * The keyboard cheat sheet (B11b, STUDIO-UX-SPEC §2.3.1): the kit's `<sf-shortcut-sheet>` over Studio's shortcut
 * registry in a settings-size dialog. The registry is the source of truth (rows of shortcuts that are not registered
 * here are absent); this module only names each registered shortcut's card, in the order a person works: Tools ·
 * Selection · Edit · Arrange · Transform · Text · View · Studio. `?` (or `Shift+?`) toggles it; Escape closes.
 * B11c: `Print` in the header prints the cards (`shortcutsPrintHtml`: a plain page, both platforms' keys).
 */
import { type ActiveShortcut, comboLabel } from '@staticflux/a11y';
import { defineDialogSurface } from '@staticflux/kit/surface-defs';
import { type SfShortcutSheetElement, shortcutSheetGroups, type ShortcutSheetGroup } from '@staticflux/kit/shortcut-sheet';
import type { SurfaceDef } from '@staticflux/messaging';
import { html } from 'lit';
import { ref } from 'lit/directives/ref.js';

export const SHORTCUT_GROUPS = ['Tools', 'Selection', 'Edit', 'Arrange', 'Transform', 'Text', 'View', 'Studio'] as const;
export type ShortcutGroupName = (typeof SHORTCUT_GROUPS)[number];

export const shortcutsSheetMessages = Object.freeze({ title: 'Keyboard shortcuts', print: 'Print', printTitle: 'Instaflow keyboard shortcuts' });

const ENTITIES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escapeHtml = (t: string): string => t.replace(/[&<>"]/g, (c) => ENTITIES[c] ?? c);

/** A plain printable page of the cards (B11c): each card a table of action and keys, both platforms' labels. */
export function shortcutsPrintHtml(groups: readonly ShortcutSheetGroup[]): string {
  const keys = (combos: readonly string[], mac: boolean): string => combos.map((c) => `<kbd>${escapeHtml(comboLabel(c, mac))}</kbd>`).join(' or ');
  const row = (r: ShortcutSheetGroup['rows'][number]): string => `<tr><td>${escapeHtml(r.label)}</td><td>${keys(r.keys, false)}</td><td>${keys(r.keys, true)}</td></tr>`;
  const cards = groups
    .map((g) => `<section><h2>${escapeHtml(g.heading)}</h2><table><thead><tr><th>Action</th><th>Windows, Linux</th><th>macOS</th></tr></thead><tbody>${g.rows.map(row).join('')}</tbody></table></section>`)
    .join('');
  const style =
    'body{font:12px system-ui,sans-serif;color:#16151a;margin:24px}h1{font-size:18px}h2{font-size:13px;margin:16px 0 4px}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:3px 6px;border-bottom:1px solid #dce3ea}kbd{font-family:ui-monospace,monospace}section{break-inside:avoid}';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${shortcutsSheetMessages.printTitle}</title><style>${style}</style></head><body><h1>${shortcutsSheetMessages.printTitle}</h1>${cards}</body></html>`;
}

/** Print the cards from a hidden frame (the page itself is not printed). */
export function printShortcuts(groups: readonly ShortcutSheetGroup[], doc: Document = document): void {
  const frame = doc.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  Object.assign(frame.style, { position: 'fixed', inlineSize: '0', blockSize: '0', border: '0', insetInlineStart: '-10000px' });
  doc.body.append(frame);
  const win = frame.contentWindow;
  if (win === null) {
    frame.remove();
    return;
  }
  win.document.open();
  win.document.write(shortcutsPrintHtml(groups));
  win.document.close();
  win.addEventListener('afterprint', () => frame.remove(), { once: true });
  win.focus();
  win.print();
}

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
      html`<sf-button slot="header-actions" class="print-shortcuts" size="sm" variant="ghost" @click=${() => printShortcuts(groups())}>${shortcutsSheetMessages.print}</sf-button
        ><sf-shortcut-sheet
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
