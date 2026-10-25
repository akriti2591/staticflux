/**
 * Keyboard shortcut display: visible labels via `@staticflux/a11y`'s `comboLabel`
 * (`⌘K` on Apple platforms, `Ctrl+K` elsewhere) and `aria-keyshortcuts` values.
 */
import { comboLabel, type KeyCombo } from '@staticflux/a11y';

/** Apple platform (where `Mod` is ⌘), from the element's window. */
export function isApplePlatform(doc: Document = document): boolean {
  const nav = doc.defaultView?.navigator as (Navigator & { userAgentData?: { platform?: string } }) | undefined;
  const platform = nav?.userAgentData?.platform ?? nav?.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** Visible label of a combo for this platform. */
export function shortcutLabel(combo: KeyCombo | string, doc: Document = document): string {
  return comboLabel(combo, isApplePlatform(doc));
}

/** `aria-keyshortcuts` value: `Mod+Shift+K` → `Meta+Shift+K` (Apple) / `Control+Shift+K`. */
export function ariaKeyShortcuts(combo: KeyCombo | string, doc: Document = document): string {
  const apple = isApplePlatform(doc);
  return combo
    .split('+')
    .map((part) => (part === 'Mod' ? (apple ? 'Meta' : 'Control') : part === 'Ctrl' ? 'Control' : part))
    .join('+');
}
