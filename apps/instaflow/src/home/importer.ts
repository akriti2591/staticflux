/**
 * Home's importer (B11c; HOME-FILES §3.1): stores one file's bytes in the workspace blob store (OPFS, content-addressed,
 * deduped by digest) and its immutable `instaflow.asset/1` record, the same two blobs Studio's ingest writes
 * (`../library/ingest.ts`). Listing the file is the journal's `import` op, which Studio applies to the library. Loaded on
 * the first import only (Home's boot never pays for it); no engine, no Wasm (D17).
 *
 * Images are probed for their size with the browser's decoders (`createImageBitmap`, an `<img>` for SVG); fonts are
 * stored as they are.
 */
import type { BlobRef, BlobStore } from '@staticflux/blob';
import { err, ok, type Result } from '@staticflux/core';
import { assetKindOf, type BlobAssetKind, mediaTypeOf, titleFromFileName } from '../library/kinds.js';
import { ASSET_RECORD_MIME, type BlobAssetRecord, BLOB_ASSET_SCHEMA, encodeBlobAssetRecord, type MediaInfo } from '../library/records.js';
import type { AssetId } from '../library/records.js';
import type { ActorJson } from '../versioning/records.js';
import { openWorkspaceBlobs } from '../workspace/blobs.js';
import { HomeImportError } from './errors.js';
import type { ImportedMedia } from './journal.js';
import type { HomeImporter } from './model.js';

/** Reads an image's pixel size (undefined when it cannot be decoded here). */
export type ImageProbe = (file: Blob, mime: string) => Promise<MediaInfo | undefined>;

/** The browser's probe: `createImageBitmap` for raster images, an `<img>` for SVG. */
export const browserImageProbe: ImageProbe = async (file, mime) => {
  try {
    if (mime === 'image/svg+xml') {
      const url = URL.createObjectURL(file);
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        return img.naturalWidth > 0 && img.naturalHeight > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : undefined;
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    const bitmap = await createImageBitmap(file);
    const info = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return info;
  } catch {
    return undefined;
  }
};

/** Which kinds Home probes for a size (data). */
const PROBED: ReadonlySet<BlobAssetKind> = new Set(['image', 'vector']);

export interface HomeImporterOptions {
  readonly blobs: Pick<BlobStore, 'put'>;
  /** Who imported (the guest in M1, D3). */
  readonly actor: ActorJson;
  readonly probe?: ImageProbe;
  readonly now?: () => number;
}

/** An importer over a blob store (see the module header). */
export function createHomeImporter(options: HomeImporterOptions): HomeImporter {
  const probe = options.probe ?? browserImageProbe;
  const importFile = async (file: File, asset: string, signal: AbortSignal): Promise<Result<Omit<ImportedMedia, 'folder'>>> => {
    const mime = mediaTypeOf(file.name, file.type);
    const kind = mime === undefined ? undefined : assetKindOf(mime);
    if (mime === undefined || kind === undefined) return err(HomeImportError({ details: { name: file.name, type: file.type } }));
    const stored = await options.blobs.put(file.stream(), { mime, signal });
    if (!stored.ok) return stored;
    const content: BlobRef = stored.value;
    const media = PROBED.has(kind) ? await probe(file, mime) : undefined;
    const createdAt = new Date((options.now ?? Date.now)()).toISOString();
    const record: BlobAssetRecord = {
      schema: BLOB_ASSET_SCHEMA,
      id: asset as AssetId,
      kind,
      createdAt,
      createdBy: options.actor,
      content,
      ...(media === undefined ? {} : { media }),
      provenance: { action: 'imported', actor: options.actor, ingredients: [] },
    };
    const encoded = encodeBlobAssetRecord(record);
    if (!encoded.ok) return encoded;
    const recordRef = await options.blobs.put(encoded.value, { mime: ASSET_RECORD_MIME, signal });
    if (!recordRef.ok) return recordRef;
    return ok({
      asset,
      kind,
      title: titleFromFileName(file.name),
      mime,
      size: content.size,
      content: { ...content },
      record: { ...recordRef.value },
      ...(media?.width !== undefined && media.height !== undefined ? { width: media.width, height: media.height } : {}),
    });
  };
  return { importFile };
}

/** The guest (D3: no accounts in M1; Studio's dev entry uses the same person). */
export const GUEST_ACTOR: ActorJson = Object.freeze({ kind: 'human', id: 'guest-local', displayName: 'You', via: 'direct' });

/** The importer over the local workspace's blobs (OPFS). */
export async function openBrowserImporter(): Promise<HomeImporter> {
  const { blobs } = await openWorkspaceBlobs();
  return createHomeImporter({ blobs, actor: GUEST_ACTOR });
}
