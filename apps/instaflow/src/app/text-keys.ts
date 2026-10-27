/**
 * The text formatting keys while a text element is being edited (B11c slice 5 audit; TEXT-FONTS §4.2, STUDIO §7): the
 * inspector and the pill show `⌘B`, `⌘I`, `⌘U`, `⌘⇧X`, `⌘.` / `⌘,` and the alignment keys, so they must work. They live
 * in their own scope, active only while editing, so they win over Studio's keys on the same combos (`Mod+.` cycles the
 * density and `Mod+,` opens Settings when no text is edited; `Mod+Shift+R` renames and `Mod+\\` toggles the dock then).
 *
 * Not bound (no valid or free combo): size `⌘⇧> / <` and letter spacing `⌥> / <` (`>` and `<` are Shift+symbols the
 * registry folds into `.` / `,`), line height `⌥⇧↑ / ↓` (opacity steps), link `⌘K` (the command bar); their fields do it.
 */
import { defineShortcut, defineShortcutScope, type ShortcutRegistry } from '@staticflux/a11y';
import type { Result, Scope } from '@staticflux/core';
import type { Script, TextAlign } from '../text/model.js';
import type { TypographyService, TypographySummary } from '../text/typography.js';
import { StudioShortcutScope } from '../studio/studio.js';

export const TextEditingShortcutScope = /* @__PURE__ */ defineShortcutScope('instaflow/text-editing', { parent: StudioShortcutScope });

type Run = (text: Pick<TypographyService, 'toggle' | 'setScript' | 'setAlign' | 'clearFormatting'>, summary: TypographySummary | undefined) => Result<void>;

const script = (want: Script, s: TypographySummary | undefined): Script | null => (s?.script === want ? null : want);
const align = (a: TextAlign): Run => (text) => text.setAlign(a);

/** The keys (data): id, combo, the cheat sheet's words, what runs. */
export const TEXT_EDITING_KEYS: readonly { readonly id: `instaflow/${string}`; readonly keys: readonly ['Mod+B' | 'Mod+I' | 'Mod+U' | 'Mod+Shift+X' | 'Mod+.' | 'Mod+,' | 'Mod+Shift+L' | 'Mod+Shift+E' | 'Mod+Shift+R' | 'Mod+Shift+J' | 'Mod+\\']; readonly description: string; readonly run: Run; readonly selected?: true }[] = Object.freeze([
  // B I U S also apply to a selected text element (its whole text): no Studio key uses these combos.
  { id: 'instaflow/text-bold', keys: ['Mod+B'], description: 'Bold', run: (t) => t.toggle('bold'), selected: true },
  { id: 'instaflow/text-italic', keys: ['Mod+I'], description: 'Italic', run: (t) => t.toggle('italic'), selected: true },
  { id: 'instaflow/text-underline', keys: ['Mod+U'], description: 'Underline', run: (t) => t.toggle('underline'), selected: true },
  { id: 'instaflow/text-strike', keys: ['Mod+Shift+X'], description: 'Strikethrough', run: (t) => t.toggle('strike'), selected: true },
  { id: 'instaflow/text-superscript', keys: ['Mod+.'], description: 'Superscript', run: (t, s) => t.setScript(script('super', s)) },
  { id: 'instaflow/text-subscript', keys: ['Mod+,'], description: 'Subscript', run: (t, s) => t.setScript(script('sub', s)) },
  { id: 'instaflow/text-align-start', keys: ['Mod+Shift+L'], description: 'Align text left', run: align('start') },
  { id: 'instaflow/text-align-center', keys: ['Mod+Shift+E'], description: 'Centre text', run: align('center') },
  { id: 'instaflow/text-align-end', keys: ['Mod+Shift+R'], description: 'Align text right', run: align('end') },
  { id: 'instaflow/text-align-justify', keys: ['Mod+Shift+J'], description: 'Justify text', run: align('justify') },
  { id: 'instaflow/text-clear-formatting', keys: ['Mod+\\'], description: 'Clear formatting', run: (t) => t.clearFormatting() },
]);

export interface TextKeysOptions {
  readonly registry: ShortcutRegistry;
  readonly text: Pick<TypographyService, 'toggle' | 'setScript' | 'setAlign' | 'clearFormatting'>;
  readonly summary: () => TypographySummary | undefined;
  /** Is a text element being edited now? */
  readonly editing: () => boolean;
  /** Is one text element selected (not edited)? B I U S apply to all its text then. */
  readonly textSelected?: () => boolean;
  readonly problem: (message: string) => void;
  readonly scope: Scope;
}

/** Register the keys for `scope`'s life; the caller activates `TextEditingShortcutScope` while editing or a text is selected. */
export function bindTextKeys(options: TextKeysOptions): Result<void> | undefined {
  for (const key of TEXT_EDITING_KEYS) {
    const def = defineShortcut({ id: key.id, keys: key.keys, scope: TextEditingShortcutScope, description: key.description, allowInInputs: true });
    const done = options.registry.register(
      def,
      () => {
        const r = key.run(options.text, options.summary());
        if (!r.ok) options.problem(r.error.message);
        return true;
      },
      { scope: options.scope, when: key.selected === true ? () => options.editing() || options.textSelected?.() === true : options.editing },
    );
    if (!done.ok) return done;
  }
  return undefined;
}
