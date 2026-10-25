/**
 * User-facing strings of the kit (R14.1): a typed `@staticflux/i18n` catalog. Components
 * take the app's `I18nToken` as a lazy dependency and show the source text until (or
 * unless) it arrives, so the kit works without i18n and switches locale reactively.
 * Apps translate with `defineTranslations(kitMessages, 'fr', { … })` + `catalogLoader`.
 * Component props (`label`, `heading`, …) always win over catalog defaults.
 */
import type { DepHandle } from '@staticflux/core';
import { defineMessages, type I18n, type MessageArgs, type MessageRef } from '@staticflux/i18n';

export const kitMessages = /* @__PURE__ */ defineMessages('kit', {
  close: 'Close',
  dismiss: 'Dismiss',
  notifications: 'Notifications',
  announcements: 'Announcements',
  resizePanel: 'Resize {label}',
  collapsePanel: 'Collapse {label}',
  expandPanel: 'Expand {label}',
  paletteLabel: 'Actions',
  paletteSearch: 'Search actions',
  paletteEmpty: 'No matching actions',
  pickColor: 'Pick {label}',
  invalidColor: 'Enter a hex color such as #3a5bd9',
  numberInvalid: 'Enter a number',
  mixed: 'Mixed',
  nameRequired: 'A name is required',
  nameTooLong: 'Use at most {max} characters',
  renameLabel: '{value} · Rename {label}',
  back: 'Back',
  stepOf: '{step} of {total}',
  discardChanges: 'Discard changes?',
  discard: 'Discard',
  keepEditing: 'Keep editing',
  copy: 'Copy',
  copied: 'Copied',
  copyFailed: 'Allow clipboard access in site settings, or select the text and copy it.',
  cancel: 'Cancel',
  tryAgain: 'Try again',
  reload: 'Reload',
  copyDiagnostics: 'Copy diagnostics',
  hex: 'Hex',
  opacity: 'Opacity',
  eyedropper: 'Pick a color from the screen',
  documentColors: 'Document colors',
  brandColors: 'Brand',
  paletteColors: 'Palette',
  recentColors: 'Recent',
  customColor: 'Custom',
  detachToken: 'Detach from token',
  replaceWith: 'Replace with {hex}',
  hue: 'Hue',
  saturation: 'Saturation and brightness',
  searchFonts: 'Search fonts',
  fontsRecent: 'Recent',
  fontsInDesign: 'In this design',
  fontsAll: 'All',
  noFonts: 'No fonts match',
  notDownloaded: 'Not downloaded yet',
  alignLeft: 'Align left',
  alignCenter: 'Align center',
  alignRight: 'Align right',
  alignTop: 'Align top',
  alignMiddle: 'Align middle',
  alignBottom: 'Align bottom',
  distributeHorizontal: 'Distribute horizontally',
  distributeVertical: 'Distribute vertically',
  tidyUp: 'Tidy up',
  alignTo: 'Align to',
  alignToSelection: 'Selection',
  alignToPage: 'Page',
  more: 'More',
});

/** Format a kit message through the (lazy) I18n dependency, falling back to the source text. */
export function kitText<P>(i18n: DepHandle<I18n> | undefined, ref: MessageRef<P>, ...args: MessageArgs<P>): string {
  const service = i18n?.value;
  if (service !== undefined) return service.t(ref, ...args);
  const params = (args[0] ?? {}) as Readonly<Record<string, unknown>>;
  return ref.source.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''));
}
