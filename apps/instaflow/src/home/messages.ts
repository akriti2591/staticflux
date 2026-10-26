/**
 * User-facing strings of Home (IF-16.2): a typed `@staticflux/i18n` catalog. `<if-home>` takes `I18nToken` as a lazy
 * dependency and shows the source text until it arrives.
 */
import type { DepHandle } from '@staticflux/core';
import { defineMessages, type I18n, type MessageArgs, type MessageRef } from '@staticflux/i18n';

export const homeMessages = /* @__PURE__ */ defineMessages('instaflow-home', {
  home: 'Instaflow home',
  newDesign: 'New design',
  heroBefore: 'Make something',
  heroBold: 'bold',
  heroAfter: 'today',
  heroLead: 'Open a blank canvas, or start from a template.',
  formats: 'Start a design',
  newFormats: 'New design formats',
  customSize: 'Custom size…',
  customSizeShort: 'Custom…',
  quickActions: 'Quick actions',
  recents: 'Jump back in',
  recentsEmpty: 'No designs yet. Choose New design or a quick action to start one.',
  templates: 'Templates',
  templatesEmpty: 'No templates yet. In Studio, choose “Save as template” to make one from a design.',
  templateMeta: 'Template · starts a new design',
  files: 'Files',
  filesEmpty: 'Your designs, templates and imported media appear here.',
  filesList: 'Files in this workspace',
  loading: 'Loading your workspace…',
  failed: 'Home could not read your workspace: {message}',
  retry: 'Try again',
  opening: 'Opening {title}…',
  edited: 'Edited {when}',
  size: '{width} × {height}',
  kindComposition: 'Design',
  kindTemplate: 'Template',
  kindMedia: 'Media',
});

/** Format a message through the (lazy) I18n dependency, falling back to the source text. */
export function homeText<P>(i18n: DepHandle<I18n> | undefined, ref: MessageRef<P>, ...args: MessageArgs<P>): string {
  const service = i18n?.value;
  if (service !== undefined) return service.t(ref, ...args);
  const params = (args[0] ?? {}) as Readonly<Record<string, unknown>>;
  return ref.source.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''));
}

const UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ['year', 365 * 24 * 3600_000],
  ['month', 30 * 24 * 3600_000],
  ['week', 7 * 24 * 3600_000],
  ['day', 24 * 3600_000],
  ['hour', 3600_000],
  ['minute', 60_000],
];

/** "2 minutes ago", "yesterday", "now" (Intl, the page's locale); `iso` in the future reads as now. */
export function relativeTime(iso: string, now: number, locale?: string): string {
  const elapsed = Math.max(0, now - Date.parse(iso));
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, ms] of UNITS) {
    if (elapsed >= ms) return format.format(-Math.floor(elapsed / ms), unit);
  }
  return format.format(0, 'second');
}
