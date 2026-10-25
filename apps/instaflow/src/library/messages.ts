/**
 * User-facing strings of the Assets panel (IF-16.2): a typed `@staticflux/i18n` catalog. Elements take
 * `I18nToken` as a lazy dependency and show the source text until it arrives.
 */
import type { DepHandle } from '@staticflux/core';
import { defineMessages, type I18n, type MessageArgs, type MessageRef } from '@staticflux/i18n';

export const libraryMessages = /* @__PURE__ */ defineMessages('instaflow-library', {
  panelTitle: 'Assets',
  import: 'Import',
  importing: 'Importing {name} · {percent}%',
  searchLabel: 'Search assets',
  filterLabel: 'Show',
  filterAll: 'All',
  filterImages: 'Images',
  filterVideo: 'Video',
  filterAudio: 'Audio',
  filterDesigns: 'Designs',
  filterFavorites: 'Favorites',
  filterTrash: 'Trash',
  listLabel: 'Assets',
  empty: 'No assets here yet. Import images, video, audio or fonts, or drop files on this panel.',
  emptyTrash: 'The trash is empty.',
  actions: 'Asset actions',
  place: 'Place',
  favorite: 'Favorite',
  rename: 'Rename',
  renameLabel: 'New title',
  save: 'Save title',
  cancel: 'Cancel',
  trash: 'Move to trash',
  restore: 'Restore',
  previewLabel: 'Preview of {title}',
  noPreview: 'No preview yet',
  imported: 'Imported {count} asset(s)',
  alreadyThere: '{name} is already in the library',
  importFailed: '{name} could not be imported: {message}',
  placed: 'Placed “{title}”',
  favorited: 'Added “{title}” to favorites',
  unfavorited: 'Removed “{title}” from favorites',
  renamed: 'Renamed to “{title}”',
  trashed: 'Moved “{title}” to the trash',
  restored: 'Restored “{title}”',
  favoriteBadge: 'Favorite',
});

/** Format a message through the (lazy) I18n dependency, falling back to the source text. */
export function libraryText<P>(i18n: DepHandle<I18n> | undefined, ref: MessageRef<P>, ...args: MessageArgs<P>): string {
  const service = i18n?.value;
  if (service !== undefined) return service.t(ref, ...args);
  const params = (args[0] ?? {}) as Readonly<Record<string, unknown>>;
  return ref.source.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''));
}
