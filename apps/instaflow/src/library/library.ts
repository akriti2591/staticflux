/**
 * The library service: the workspace's asset list over the library document. Reads are reactive
 * (`entries()` re-reads when the part changes, locally or from another tab); every mutation is one
 * validated commit through the open document, so it is persisted, attributed and undoable per actor.
 *
 * Trash is a state, not a delete (IF-3.6): `trash` stamps `trashedAt`, `restore` clears it, and the
 * entry stays a GC root for `TRASH_RETENTION_MS` (30 days, IF-3.10) after which GC may sweep it.
 */
import { box, err, ok, type Result } from '@staticflux/core';
import type { Digest } from '@staticflux/blob';
import type { Committed, JsonValue, PartChange, PartOp, TransactionMeta } from '@staticflux/document/v2';
import { actorRecord, type Actor } from '@staticflux/stage';
import { AssetListedError, LibraryDisposedError, LibraryMetadataError, UnknownAssetError } from './errors.js';
import type { LibraryAssetKind } from './kinds.js';
import {
  entryCreateOps,
  LIBRARY_PART,
  type LibraryEntry,
  type LibraryPartReader,
  LibraryPaths,
  libraryRegistry,
  type NewLibraryEntry,
  readLibraryEntries,
  readLibraryEntry,
  type Rendition,
  type RenditionRole,
} from './library-doc.js';
import type { AssetId } from './records.js';

/** How long a trashed entry stays a GC root (IF-3.10 grace period). */
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_TITLE = 200;
export const MAX_TAG = 40;
export const MAX_FOLDER_SEGMENT = 60;

/** The open library document (structurally a `DocumentRepo` `OpenDocument` and its loaded part). */
export interface LibrarySource {
  readonly part: LibraryPartReader & { observe(listener: (change: PartChange) => void): () => void };
  commit(meta: TransactionMeta, changes: Readonly<Record<string, readonly PartOp[]>>): Result<Committed>;
}

export interface LibraryOptions {
  readonly source: LibrarySource;
  readonly actor: () => Actor;
  readonly now?: () => number;
}

export interface Library {
  /** Every entry, newest first (reactive: reads are tracked). */
  entries(): readonly LibraryEntry[];
  entry(asset: AssetId): LibraryEntry | undefined;
  /** A live entry with this content digest (import dedupe). */
  findByContent(digest: Digest): LibraryEntry | undefined;
  add(entry: NewLibraryEntry): Result<LibraryEntry>;
  rename(asset: AssetId, title: string): Result<void>;
  setFolder(asset: AssetId, folder: string): Result<void>;
  setFavorite(asset: AssetId, favorite: boolean): Result<void>;
  addTag(asset: AssetId, tag: string): Result<void>;
  removeTag(asset: AssetId, tag: string): Result<void>;
  trash(assets: readonly AssetId[]): Result<void>;
  restore(assets: readonly AssetId[]): Result<void>;
  /** Delete forever (B11c, HOME-FILES §2.4): the entries go; their blobs are left to GC (no longer roots). */
  purge(assets: readonly AssetId[]): Result<void>;
  setRendition(asset: AssetId, role: RenditionRole, rendition: Rendition): Result<void>;
  /** GC roots: live entries plus trashed ones still inside the retention period. */
  gcRoots(): readonly AssetId[];
  dispose(): void;
}

/** Validate and normalize a title (trimmed, 1–200 characters). */
export function validateTitle(title: string): Result<string> {
  const trimmed = title.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TITLE) return err(LibraryMetadataError({ message: `A title must be 1–${MAX_TITLE} characters.`, details: { field: 'title' } }));
  return ok(trimmed);
}

/** Validate and normalize a tag (trimmed, lower case, 1–40 characters, no commas). */
export function validateTag(tag: string): Result<string> {
  const trimmed = tag.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > MAX_TAG || trimmed.includes(',')) return err(LibraryMetadataError({ message: `A tag must be 1–${MAX_TAG} characters without commas.`, details: { field: 'tag' } }));
  return ok(trimmed);
}

/** Validate and normalize a folder path (`''` = top level; segments 1–60 characters). */
export function validateFolder(folder: string): Result<string> {
  const segments = folder
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.some((s) => s.length > MAX_FOLDER_SEGMENT)) return err(LibraryMetadataError({ message: `Folder names must be 1–${MAX_FOLDER_SEGMENT} characters.`, details: { field: 'folder' } }));
  return ok(segments.join('/'));
}

const newestFirst = (a: LibraryEntry, b: LibraryEntry): number => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.asset < b.asset ? -1 : 1);

export function createLibrary(options: LibraryOptions): Library {
  const { source } = options;
  const now = options.now ?? (() => Date.now());
  const version = box(0);
  let disposed = false;
  const stop = source.part.observe(() => version.set(version.get() + 1));

  let cache: { version: number; list: readonly LibraryEntry[] } | undefined;
  const all = (): readonly LibraryEntry[] => {
    const v = version.get();
    if (cache?.version !== v) cache = { version: v, list: readLibraryEntries(source.part).sort(newestFirst) };
    return cache.list;
  };

  const live = (asset: AssetId): Result<LibraryEntry> => {
    if (disposed) return err(LibraryDisposedError());
    const entry = readLibraryEntry(source.part, asset);
    return entry === undefined ? err(UnknownAssetError({ details: { asset } })) : ok(entry);
  };

  const commit = (label: string, ops: readonly PartOp[]): Result<void> => {
    if (disposed) return err(LibraryDisposedError());
    if (ops.length === 0) return ok();
    const valid = libraryRegistry.validateOps(ops, (node) => source.part.node(node)?.kind);
    if (!valid.ok) return valid;
    const committed = source.commit({ actor: actorRecord(options.actor()), label }, { [LIBRARY_PART]: ops });
    return committed.ok ? ok() : committed;
  };

  const set = (label: string, asset: AssetId, path: string, value: JsonValue): Result<void> => {
    const entry = live(asset);
    return entry.ok ? commit(label, [{ op: 'set', node: asset, path, value }]) : entry;
  };

  const each = (assets: readonly AssetId[], fn: (entry: LibraryEntry) => PartOp[]): Result<PartOp[]> => {
    const ops: PartOp[] = [];
    for (const asset of new Set(assets)) {
      const entry = live(asset);
      if (!entry.ok) return entry;
      ops.push(...fn(entry.value));
    }
    return ok(ops);
  };

  return {
    entries: all,
    entry: (asset) => {
      version.get();
      return readLibraryEntry(source.part, asset);
    },
    findByContent: (digest) => all().find((e) => e.trashedAt === undefined && e.content?.digest === digest),
    add(entry) {
      if (disposed) return err(LibraryDisposedError());
      if (source.part.node(entry.asset) !== undefined) return err(AssetListedError({ details: { asset: entry.asset } }));
      const title = validateTitle(entry.title);
      if (!title.ok) return title;
      const tags: string[] = [];
      for (const tag of entry.tags ?? []) {
        const valid = validateTag(tag);
        if (!valid.ok) return valid;
        tags.push(valid.value);
      }
      const folder = validateFolder(entry.folder ?? '');
      if (!folder.ok) return folder;
      const added = commit(`Add ${title.value}`, entryCreateOps({ ...entry, title: title.value, tags, folder: folder.value }));
      if (!added.ok) return added;
      const read = readLibraryEntry(source.part, entry.asset);
      return read === undefined ? err(UnknownAssetError({ details: { asset: entry.asset } })) : ok(read);
    },
    rename(asset, title) {
      const valid = validateTitle(title);
      return valid.ok ? set(`Rename ${valid.value}`, asset, LibraryPaths.title, valid.value) : valid;
    },
    setFolder(asset, folder) {
      const valid = validateFolder(folder);
      return valid.ok ? set('Move to folder', asset, LibraryPaths.folder, valid.value) : valid;
    },
    setFavorite: (asset, favorite) => set(favorite ? 'Favorite' : 'Unfavorite', asset, LibraryPaths.favorite, favorite),
    addTag(asset, tag) {
      const valid = validateTag(tag);
      if (!valid.ok) return valid;
      const entry = live(asset);
      if (!entry.ok) return entry;
      if (entry.value.tags.includes(valid.value)) return ok();
      const at = source.part.list(asset, LibraryPaths.tags)?.length ?? 0;
      return commit(`Tag ${valid.value}`, [{ op: 'list.insert', node: asset, path: LibraryPaths.tags, at, value: valid.value }]);
    },
    removeTag(asset, tag) {
      const entry = live(asset);
      if (!entry.ok) return entry;
      const normalized = tag.trim().toLowerCase();
      const list = source.part.list(asset, LibraryPaths.tags) ?? [];
      // Delete from the end so earlier indices stay valid (concurrent duplicates go too).
      const ops: PartOp[] = list.flatMap((value, at): PartOp[] => (value === normalized ? [{ op: 'list.delete', node: asset, path: LibraryPaths.tags, at, count: 1 }] : [])).reverse();
      return commit(`Untag ${normalized}`, ops);
    },
    trash(assets) {
      const stamp = new Date(now()).toISOString();
      const ops = each(assets, (e): PartOp[] => (e.trashedAt === undefined ? [{ op: 'set', node: e.asset, path: LibraryPaths.trashedAt, value: stamp }] : []));
      return ops.ok ? commit(assets.length === 1 ? 'Move to trash' : `Move ${assets.length} to trash`, ops.value) : ops;
    },
    restore(assets) {
      const ops = each(assets, (e): PartOp[] => (e.trashedAt === undefined ? [] : [{ op: 'set', node: e.asset, path: LibraryPaths.trashedAt, value: null }]));
      return ops.ok ? commit(assets.length === 1 ? 'Restore' : `Restore ${assets.length}`, ops.value) : ops;
    },
    purge(assets) {
      const ops = each(assets, (e): PartOp[] => [{ op: 'delete', node: e.asset }]);
      return ops.ok ? commit(ops.value.length === 1 ? 'Delete forever' : `Delete ${ops.value.length} forever`, ops.value) : ops;
    },
    setRendition: (asset, role, rendition) => set(`Rendition ${role}`, asset, LibraryPaths.rendition(role), rendition as unknown as JsonValue),
    gcRoots() {
      const cutoff = now() - TRASH_RETENTION_MS;
      return all()
        .filter((e) => e.trashedAt === undefined || Date.parse(e.trashedAt) > cutoff)
        .map((e) => e.asset);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
    },
  };
}

/** Library filters (Assets panel) as data: each is a predicate over an entry. */
export const LIBRARY_FILTERS = ['all', 'images', 'video', 'audio', 'designs', 'favorites', 'trash'] as const;
export type LibraryFilter = (typeof LIBRARY_FILTERS)[number];

const kindsIn = (...kinds: LibraryAssetKind[]) => (e: LibraryEntry): boolean => e.trashedAt === undefined && kinds.includes(e.kind);

export const LIBRARY_FILTER_TESTS: Readonly<Record<LibraryFilter, (entry: LibraryEntry) => boolean>> = Object.freeze({
  all: (e) => e.trashedAt === undefined,
  images: kindsIn('image', 'vector', 'matte'),
  video: kindsIn('video', 'lottie'),
  audio: kindsIn('audio'),
  designs: kindsIn('composition', 'template', 'brand-kit', 'motion-preset', 'workflow', 'prompt'),
  favorites: (e) => e.trashedAt === undefined && e.favorite,
  trash: (e) => e.trashedAt !== undefined,
});

export interface LibraryQuery {
  readonly filter: LibraryFilter;
  /** Case-insensitive match on title and tags. */
  readonly text?: string;
  readonly tag?: string;
  /** Exact folder (`''` = top level); undefined = every folder. */
  readonly folder?: string;
}

/** Filter entries (pure; keeps the input order). */
export function queryLibrary(entries: readonly LibraryEntry[], query: LibraryQuery): LibraryEntry[] {
  const text = query.text?.trim().toLowerCase() ?? '';
  const test = LIBRARY_FILTER_TESTS[query.filter];
  return entries.filter(
    (e) =>
      test(e) &&
      (query.tag === undefined || e.tags.includes(query.tag)) &&
      (query.folder === undefined || e.folder === query.folder) &&
      (text.length === 0 || e.title.toLowerCase().includes(text) || e.tags.some((t) => t.includes(text))),
  );
}
