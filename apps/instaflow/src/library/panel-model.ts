/**
 * The Assets panel's model: the query (filter, search text), the visible rows, imports in flight,
 * the actions on entries and lazily loaded thumbnail URLs. The element only renders it, so every
 * action has the same path by keyboard, pointer and test.
 *
 * Placing an asset in the document and showing a file picker are the host's (`LibraryHost`): element
 * creation is B1/B3's, the picker is the platform's (`browserPickFiles`).
 */
import type { BlobStore, Digest } from '@staticflux/blob';
import { AbortedError, box, derived, err, ok, type Result, type SfError } from '@staticflux/core';
import { UnknownAssetError } from './errors.js';
import type { IngestFile, IngestService, PendingIngest } from './ingest.js';
import { MEDIA_TYPES } from './kinds.js';
import { type Library, type LibraryQuery, queryLibrary } from './library.js';
import type { LibraryEntry } from './library-doc.js';
import type { AssetId } from './records.js';

export interface LibraryHost {
  /** Ask the person for files. AbortedError (`SF-CORE-002`) when they cancel. */
  pickFiles(signal: AbortSignal): Promise<Result<readonly IngestFile[]>>;
  /** Place the asset in the open document (the element tools create it; undoable there). */
  place(entry: LibraryEntry, signal: AbortSignal): Promise<Result<void>>;
}

/** Object URLs for thumbnails (injectable; the default uses `URL.createObjectURL`). */
export interface ObjectUrls {
  create(bytes: Uint8Array, mime: string): string;
  revoke(url: string): void;
}

export const browserObjectUrls: ObjectUrls = {
  create: (bytes, mime) => URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime })),
  revoke: (url) => URL.revokeObjectURL(url),
};

export interface ImportSummary {
  readonly imported: readonly LibraryEntry[];
  readonly deduplicated: readonly LibraryEntry[];
  readonly failed: readonly { readonly name: string; readonly error: SfError }[];
}

export interface LibraryPanelModelOptions {
  readonly library: Library;
  readonly ingest: IngestService;
  readonly blobs: Pick<BlobStore, 'get'>;
  readonly host: LibraryHost;
  readonly urls?: ObjectUrls;
  /** The panel's lifetime (thumbnail URLs are revoked when it aborts). */
  readonly signal: AbortSignal;
}

export interface LibraryPanelModel {
  query(): LibraryQuery;
  setQuery(patch: Partial<LibraryQuery>): void;
  /** Entries matching the query, newest first (reactive). */
  rows(): readonly LibraryEntry[];
  pending(): readonly PendingIngest[];
  entry(asset: AssetId): LibraryEntry | undefined;
  importFiles(files: readonly IngestFile[]): Promise<Result<ImportSummary>>;
  /** Pick files with the host's picker, then import them. */
  pickAndImport(): Promise<Result<ImportSummary>>;
  rename(asset: AssetId, title: string): Result<void>;
  toggleFavorite(asset: AssetId): Result<boolean>;
  trash(assets: readonly AssetId[]): Result<void>;
  restore(assets: readonly AssetId[]): Result<void>;
  place(asset: AssetId): Promise<Result<void>>;
  /** An object URL of the thumbnail once loaded (reactive; starts loading on first read). */
  thumbnail(asset: AssetId): string | undefined;
}

export function createLibraryPanelModel(options: LibraryPanelModelOptions): LibraryPanelModel {
  const { library, signal } = options;
  const urls = options.urls ?? browserObjectUrls;
  const query = box<LibraryQuery>({ filter: 'all' });
  const rows = derived(() => queryLibrary(library.entries(), query.get()));
  const loaded = new Map<Digest, string>();
  const loading = new Set<Digest>();
  const tick = box(0);
  signal.addEventListener(
    'abort',
    () => {
      for (const url of loaded.values()) urls.revoke(url);
      loaded.clear();
    },
    { once: true },
  );

  const load = (digest: Digest, entry: LibraryEntry): void => {
    const rendition = entry.renditions.thumbnail;
    if (rendition === undefined || loading.has(digest) || signal.aborted) return;
    loading.add(digest);
    void options.blobs.get(rendition.blob, { signal }).then((bytes) => {
      loading.delete(digest);
      if (!bytes.ok || signal.aborted) return;
      loaded.set(digest, urls.create(bytes.value, rendition.blob.mime));
      tick.set(tick.get() + 1);
    });
  };

  const importFiles = async (files: readonly IngestFile[]): Promise<Result<ImportSummary>> => {
    const imported: LibraryEntry[] = [];
    const deduplicated: LibraryEntry[] = [];
    const failed: { name: string; error: SfError }[] = [];
    for (const file of files) {
      if (signal.aborted) return err(AbortedError({ cause: signal.reason }));
      const result = await options.ingest.ingest(file, { signal });
      if (!result.ok) failed.push({ name: file.name, error: result.error });
      else (result.value.deduplicated ? deduplicated : imported).push(result.value.entry);
    }
    return ok({ imported, deduplicated, failed });
  };

  return {
    query: () => query.get(),
    setQuery: (patch) => query.set({ ...query.get(), ...patch }),
    rows: () => rows.get(),
    pending: () => options.ingest.pending(),
    entry: (asset) => library.entry(asset),
    importFiles,
    async pickAndImport() {
      const files = await options.host.pickFiles(signal);
      return files.ok ? importFiles(files.value) : files;
    },
    rename: (asset, title) => library.rename(asset, title),
    toggleFavorite(asset) {
      const entry = library.entry(asset);
      if (entry === undefined) return err(UnknownAssetError({ details: { asset } }));
      const set = library.setFavorite(asset, !entry.favorite);
      return set.ok ? ok(!entry.favorite) : set;
    },
    trash: (assets) => library.trash(assets),
    restore: (assets) => library.restore(assets),
    async place(asset) {
      const entry = library.entry(asset);
      if (entry === undefined) return err(UnknownAssetError({ details: { asset } }));
      return options.host.place(entry, signal);
    },
    thumbnail(asset) {
      tick.get();
      const entry = library.entry(asset);
      const digest = entry?.renditions.thumbnail?.blob.digest;
      if (entry === undefined || digest === undefined) return undefined;
      const url = loaded.get(digest);
      if (url === undefined) load(digest, entry);
      return url;
    },
  };
}

/** The `accept` list of the import picker (every importable media type). */
export const IMPORT_ACCEPT = /* @__PURE__ */ Object.keys(MEDIA_TYPES).join(',');

/**
 * Show the platform file picker (a transient `<input type="file" multiple>`; never laid out). Resolves
 * with the chosen files, or AbortedError when the person cancels or `signal` aborts.
 */
export function browserPickFiles(signal: AbortSignal, doc: Document = document): Promise<Result<readonly IngestFile[]>> {
  if (signal.aborted) return Promise.resolve(err(AbortedError({ cause: signal.reason })));
  const input = doc.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = IMPORT_ACCEPT;
  return new Promise((resolve) => {
    const done = new AbortController();
    const finish = (result: Result<readonly IngestFile[]>): void => {
      done.abort();
      resolve(result);
    };
    input.addEventListener('change', () => finish(ok([...(input.files ?? [])])), { signal: done.signal });
    input.addEventListener('cancel', () => finish(err(AbortedError({ details: { reason: 'cancelled' } }))), { signal: done.signal });
    signal.addEventListener('abort', () => finish(err(AbortedError({ cause: signal.reason }))), { signal: done.signal });
    input.click();
  });
}
