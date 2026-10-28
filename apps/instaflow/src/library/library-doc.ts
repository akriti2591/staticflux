/**
 * The workspace **library document** (DOCUMENT-FORMAT §4, IF-3.6): one CRDT document per workspace
 * (`heads/library.json`, asset name `library`) on `@staticflux/document/v2`. Each listed asset is one
 * top-level node (`kind: 'asset'`, id = the asset id) carrying the `library` component: the mutable
 * metadata (title, tags, folder, favourite, trash state and time), late-arriving renditions, and the
 * pointers to the immutable record and content. The live entries are the GC root list (IF-3.10).
 *
 * Reads are per node (never the whole document); writes are op batches validated against
 * `libraryRegistry` and committed through the open document (one commit per action).
 */
import type { BlobRef } from '@staticflux/blob';
import { err, ok, type Result } from '@staticflux/core';
import {
  createComponentRegistry,
  defineComponent,
  type DocumentCRDTv2,
  type DocumentRepo,
  field,
  type JsonValue,
  type OpenDocument,
  type PartOp,
} from '@staticflux/document/v2';
import { LibraryDataError } from './errors.js';
import { LIBRARY_ASSET_KINDS, type LibraryAssetKind } from './kinds.js';
import type { AssetId, MediaInfo } from './records.js';

/** The library document's asset name (its head is `heads/library.json`). */
export const LIBRARY_ASSET = 'library';
/** The library has a single part. */
export const LIBRARY_PART = 'root';
/** Node kind of a library entry. */
export const LIBRARY_ENTRY_KIND = 'asset';

/** Derived, regenerable blobs (IF-3.9). `cover`: a design's first page, rendered by Studio for Home's cards (#64). */
export const RENDITION_ROLES = ['thumbnail', 'poster', 'proxy', 'waveform', 'filmstrip', 'cover'] as const;
export type RenditionRole = (typeof RENDITION_ROLES)[number];

export const LibraryComponent = /* @__PURE__ */ defineComponent(
  'library',
  {
    kind: field.enum(LIBRARY_ASSET_KINDS),
    title: 'string',
    mime: 'string',
    size: 'f64',
    width: 'f64',
    height: 'f64',
    duration: 'f64',
    content: 'json',
    record: 'json',
    createdAt: 'string',
    folder: 'string',
    favorite: 'bool',
    trashedAt: 'string',
    tags: field.list('string'),
    renditions: field.map('json'),
  },
  { version: 1 },
);

export const libraryRegistry = /* @__PURE__ */ createComponentRegistry({ version: 1, components: [LibraryComponent], kinds: { [LIBRARY_ENTRY_KIND]: ['library'] } });

/** Property paths of the `library` component. */
export const LibraryPaths = Object.freeze({
  kind: 'library.kind',
  title: 'library.title',
  mime: 'library.mime',
  size: 'library.size',
  width: 'library.width',
  height: 'library.height',
  duration: 'library.duration',
  content: 'library.content',
  record: 'library.record',
  createdAt: 'library.createdAt',
  folder: 'library.folder',
  favorite: 'library.favorite',
  trashedAt: 'library.trashedAt',
  tags: 'library.tags',
  rendition: (role: RenditionRole): string => `library.renditions.${role}`,
});

/** A late-arriving rendition (stored in the library document, not in the immutable record). */
export interface Rendition {
  readonly blob: BlobRef;
  /** What produced it (renderer id, target edge, source digest): regenerating with the same params is idempotent. */
  readonly params: { readonly renderer: string; readonly edge: number; readonly source: string };
}

/** One listed asset (read model). */
export interface LibraryEntry {
  readonly asset: AssetId;
  readonly kind: LibraryAssetKind;
  readonly title: string;
  readonly createdAt: string;
  readonly folder: string;
  readonly favorite: boolean;
  readonly tags: readonly string[];
  /** ISO time it went to the trash; undefined when live. */
  readonly trashedAt?: string;
  readonly mime?: string;
  readonly size?: number;
  readonly media?: MediaInfo;
  /** Blob assets: the content and the immutable record. */
  readonly content?: BlobRef;
  readonly record?: BlobRef;
  readonly renditions: Readonly<Partial<Record<RenditionRole, Rendition>>>;
}

/** What `library.add` writes (the read model minus derived fields). */
export type NewLibraryEntry = Omit<LibraryEntry, 'tags' | 'renditions' | 'favorite' | 'folder' | 'trashedAt'> & {
  readonly tags?: readonly string[];
  readonly folder?: string;
};

/** The reads the library needs from its part (structurally `DocumentCRDTv2`). */
export type LibraryPartReader = Pick<DocumentCRDTv2, 'children' | 'node' | 'prop' | 'list'>;

const isRef = (value: JsonValue | undefined): value is JsonValue & BlobRef =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as { digest?: unknown }).digest === 'string';

const num = (value: JsonValue | undefined): number | undefined => (typeof value === 'number' ? value : undefined);

/** Read one entry (undefined when the node is not a library entry or lacks its kind/title). */
export function readLibraryEntry(part: LibraryPartReader, asset: string): LibraryEntry | undefined {
  const node = part.node(asset);
  if (node === undefined || node.kind !== LIBRARY_ENTRY_KIND) return undefined;
  const kind = part.prop(asset, LibraryPaths.kind);
  const title = part.prop(asset, LibraryPaths.title);
  if (typeof kind !== 'string' || typeof title !== 'string') return undefined;
  const renditions: Partial<Record<RenditionRole, Rendition>> = {};
  for (const role of RENDITION_ROLES) {
    const value = part.prop(asset, LibraryPaths.rendition(role)) as unknown as Rendition | undefined;
    if (value !== undefined && value !== null && isRef(value.blob as unknown as JsonValue)) renditions[role] = value;
  }
  const width = num(part.prop(asset, LibraryPaths.width));
  const height = num(part.prop(asset, LibraryPaths.height));
  const duration = num(part.prop(asset, LibraryPaths.duration));
  const media: MediaInfo = { ...(width === undefined ? {} : { width }), ...(height === undefined ? {} : { height }), ...(duration === undefined ? {} : { duration }) };
  const mime = part.prop(asset, LibraryPaths.mime);
  const size = num(part.prop(asset, LibraryPaths.size));
  const content = part.prop(asset, LibraryPaths.content);
  const record = part.prop(asset, LibraryPaths.record);
  const trashedAt = part.prop(asset, LibraryPaths.trashedAt);
  const createdAt = part.prop(asset, LibraryPaths.createdAt);
  const folder = part.prop(asset, LibraryPaths.folder);
  const tags = [...new Set((part.list(asset, LibraryPaths.tags) ?? []).filter((t): t is string => typeof t === 'string'))];
  return {
    asset: asset as AssetId,
    kind: kind as LibraryAssetKind,
    title,
    createdAt: typeof createdAt === 'string' ? createdAt : '',
    folder: typeof folder === 'string' ? folder : '',
    favorite: part.prop(asset, LibraryPaths.favorite) === true,
    tags,
    ...(typeof trashedAt === 'string' ? { trashedAt } : {}),
    ...(typeof mime === 'string' ? { mime } : {}),
    ...(size === undefined ? {} : { size }),
    ...(Object.keys(media).length === 0 ? {} : { media }),
    ...(isRef(content) ? { content } : {}),
    ...(isRef(record) ? { record } : {}),
    renditions,
  };
}

/** Every entry in document order (O(entries); the library holds one node per asset). */
export function readLibraryEntries(part: LibraryPartReader): LibraryEntry[] {
  return part.children(null).flatMap((id) => readLibraryEntry(part, id) ?? []);
}

/** The ops that list a new entry. */
export function entryCreateOps(entry: NewLibraryEntry): PartOp[] {
  const props: Record<string, JsonValue> = {
    [LibraryPaths.kind]: entry.kind,
    [LibraryPaths.title]: entry.title,
    [LibraryPaths.createdAt]: entry.createdAt,
    [LibraryPaths.folder]: entry.folder ?? '',
    [LibraryPaths.favorite]: false,
  };
  if (entry.mime !== undefined) props[LibraryPaths.mime] = entry.mime;
  if (entry.size !== undefined) props[LibraryPaths.size] = entry.size;
  if (entry.media?.width !== undefined) props[LibraryPaths.width] = entry.media.width;
  if (entry.media?.height !== undefined) props[LibraryPaths.height] = entry.media.height;
  if (entry.media?.duration !== undefined) props[LibraryPaths.duration] = entry.media.duration;
  if (entry.content !== undefined) props[LibraryPaths.content] = entry.content as unknown as JsonValue;
  if (entry.record !== undefined) props[LibraryPaths.record] = entry.record as unknown as JsonValue;
  return [{ op: 'create', node: entry.asset, kind: LIBRARY_ENTRY_KIND, parent: null, props, lists: { [LibraryPaths.tags]: [...new Set(entry.tags ?? [])] } }];
}

/** The library document and its loaded part. */
export interface LibraryDocument {
  readonly doc: OpenDocument;
  readonly part: DocumentCRDTv2;
}

/** Open the workspace's library document, creating it on first use. */
export async function openLibraryDocument(repo: Pick<DocumentRepo, 'open' | 'create'>, signal: AbortSignal): Promise<Result<LibraryDocument>> {
  let opened = await repo.open(LIBRARY_ASSET, signal);
  if (!opened.ok && opened.error.code === 'SF-DOC-013') opened = await repo.create(LIBRARY_ASSET, { treeSchema: libraryRegistry.version, parts: [LIBRARY_PART] }, signal);
  if (!opened.ok) return opened;
  const part = await opened.value.part(LIBRARY_PART, signal);
  if (!part.ok) return err(LibraryDataError({ message: 'The library document has no readable part.', details: { asset: LIBRARY_ASSET }, cause: part.error }));
  return ok({ doc: opened.value, part: part.value });
}
