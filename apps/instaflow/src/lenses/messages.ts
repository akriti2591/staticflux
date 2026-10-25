/** User-facing strings of the lens chrome (Pages panel), a typed `@staticflux/i18n` catalog. */
import type { DepHandle } from '@staticflux/core';
import { defineMessages, type I18n, type MessageArgs, type MessageRef } from '@staticflux/i18n';

export const lensMessages = /* @__PURE__ */ defineMessages('instaflow-lenses', {
  panelTitle: 'Pages',
  listLabel: 'Pages in story order',
  pageName: 'Page {number}',
  empty: 'This document has no pages yet.',
  noComposition: 'Pages appear here for compositions.',
  actions: 'Page navigation',
  previous: 'Previous page',
  next: 'Next page',
  overview: 'Fit all',
  showing: 'Page {number} of {count}: {name}',
  moved: 'Moved “{name}” to position {number}',
});

/** Format a message through the (lazy) I18n dependency, falling back to the source text. */
export function lensText<P>(i18n: DepHandle<I18n> | undefined, ref: MessageRef<P>, ...args: MessageArgs<P>): string {
  const service = i18n?.value;
  if (service !== undefined) return service.t(ref, ...args);
  const params = (args[0] ?? {}) as Readonly<Record<string, unknown>>;
  return ref.source.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''));
}
