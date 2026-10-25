/**
 * User-facing strings of the versioning contributions (IF-16.2): a typed `@staticflux/i18n`
 * catalog. Elements take `I18nToken` as a lazy dependency and show the source text until it arrives.
 */
import type { DepHandle } from '@staticflux/core';
import { defineMessages, type I18n, type MessageArgs, type MessageRef } from '@staticflux/i18n';

export const versioningMessages = /* @__PURE__ */ defineMessages('instaflow-versioning', {
  saved: 'Saved',
  saving: 'Saving…',
  notSaved: 'Not saved yet: {cause}',
  notSavedUnknown: 'Not saved yet: waiting for the browser store',
  mirrorBehind: 'Saved in this browser · folder not updated',
  panelTitle: 'Milestones',
  nameLabel: 'Milestone name',
  noteLabel: 'Note (optional)',
  create: 'Create milestone',
  creating: 'Creating milestone…',
  created: 'Milestone “{name}” created',
  listLabel: 'Milestones',
  empty: 'No milestones yet. Latest is saved continuously; create a milestone to keep a named version.',
  actions: 'Milestone actions',
  open: 'Open',
  compareLatest: 'Compare with Latest',
  compareTwo: 'Compare side by side',
  pin: 'Pin',
  rename: 'Rename',
  renameLabel: 'New name',
  save: 'Save name',
  cancel: 'Cancel',
  newDocument: 'New document from milestone',
  pinned: 'Pinned',
  opened: 'Opened “{name}” read-only',
  pinnedNow: 'Pinned “{name}”',
  unpinnedNow: 'Unpinned “{name}”',
  comparing: 'Comparing side by side',
  renamed: 'Renamed to “{name}”',
  newDocumentCreated: 'New document created from “{name}”',
  commandTitle: 'Milestone',
  commandDescription: 'Create a named, immutable milestone of the open document (Latest keeps saving on its own).',
});

/** Format a message through the (lazy) I18n dependency, falling back to the source text. */
export function versioningText<P>(i18n: DepHandle<I18n> | undefined, ref: MessageRef<P>, ...args: MessageArgs<P>): string {
  const service = i18n?.value;
  if (service !== undefined) return service.t(ref, ...args);
  const params = (args[0] ?? {}) as Readonly<Record<string, unknown>>;
  return ref.source.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''));
}
