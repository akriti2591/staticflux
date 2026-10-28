/**
 * Library images on the canvas (B8: the asset "Place" host hook, B4 → B1/B3). Placing an asset decodes its blob
 * once, uploads the pixels to the render scene (the pipeline's asset section, ahead of the projection that
 * references them) and then creates an image element with an image fill, as one undo step, centred in the view.
 *
 * Uploads are per asset key (`as_…`, or `as_…@ms_…` pinned); a snapshot re-sends every upload. B1's encoder asks
 * `images(asset)` for the scene image id and draws nothing until it is known.
 *
 * #43: a page opened from the store names images nobody added in this editor; `imageAssetKeys` lists them and
 * `uploadImageKeys` uploads them before the page's first snapshot (the editor's `open`).
 */
import { err, ok, type Result, type SfError } from '@staticflux/core';
import type { BlobStore } from '@staticflux/blob';
import type { DocumentCRDTv2, JsonValue, NodeId, PartOp } from '@staticflux/document/v2';
import { P } from '../elements/components.js';
import type { LibraryEntry } from '../library/library-doc.js';
import type { ImageDecoder } from '../library/renditions.js';
import { createSceneWriter } from '../render/scene-ir.js';
import { lumaToAlpha } from '../elements/scene.js';
import type { ImageBinding } from './canvas-pipeline.js';
import { NoOpenPageError } from './errors.js';

export interface ImageUploads {
  /** Scene image id of an uploaded asset (B1 encoder `images`). */
  images(asset: string, variant: 'rgba' | 'luma'): number | undefined;
  /** Decode and queue an asset's pixels (idempotent). */
  upload(entry: LibraryEntry, signal: AbortSignal): Promise<Result<{ readonly width: number; readonly height: number }>>;
  /** B11c: the pixel size of an uploaded asset (undefined: not uploaded in this editor). */
  size(asset: string): { readonly width: number; readonly height: number } | undefined;
  /** The pipeline's asset section and the image table (`SceneIrSource`). */
  changes(full: boolean): { readonly assets?: Uint8Array; readonly images?: readonly ImageBinding[] } | undefined;
}

export function createImageUploads(options: { readonly blobs: Pick<BlobStore, 'get'>; readonly decoder: ImageDecoder }): ImageUploads {
  const uploaded = new Map<string, { readonly id: number; readonly luma: number; readonly width: number; readonly height: number; readonly rgba: Uint8Array }>();
  let fresh: string[] = [];
  let next = 1;
  const write = (keys: readonly string[]): Uint8Array | undefined => {
    if (keys.length === 0) return undefined;
    const w = createSceneWriter();
    for (const key of keys) {
      const u = uploaded.get(key);
      if (u === undefined) continue;
      w.image(u.id, u.width, u.height, u.rgba);
      w.image(u.luma, u.width, u.height, lumaToAlpha(u.rgba));
    }
    return w.finish();
  };
  return {
    size(asset) {
      const u = uploaded.get(asset);
      return u === undefined ? undefined : { width: u.width, height: u.height };
    },
    images(asset, variant) {
      const u = uploaded.get(asset);
      return u === undefined ? undefined : variant === 'luma' ? u.luma : u.id;
    },
    async upload(entry, signal) {
      const known = uploaded.get(entry.asset);
      if (known !== undefined) return ok({ width: known.width, height: known.height });
      if (entry.content === undefined) return err(NoOpenPageError({ message: `"${entry.title}" has no image content to place.`, details: { asset: entry.asset } }));
      const bytes = await options.blobs.get(entry.content, { signal });
      if (!bytes.ok) return bytes;
      const decoded = await options.decoder.decode(bytes.value, entry.mime ?? entry.content.mime, signal);
      if (!decoded.ok) return decoded;
      const id = next++;
      const luma = next++;
      uploaded.set(entry.asset, { id, luma, width: decoded.value.width, height: decoded.value.height, rgba: decoded.value.data });
      fresh.push(entry.asset);
      return ok({ width: decoded.value.width, height: decoded.value.height });
    },
    changes(full) {
      const keys = full ? [...uploaded.keys()] : fresh;
      fresh = [];
      const assets = write(keys);
      const images = keys.flatMap((asset) => {
        const u = uploaded.get(asset);
        return u === undefined ? [] : [{ asset, rgba: u.id, luma: u.luma }];
      });
      return assets === undefined ? undefined : { assets, images };
    },
  };
}

/** An image asset reference's upload key (`as_…`, or `as_…@ms_…` pinned; B1's `readPaint` makes the same key). */
const refKey = (ref: JsonValue | undefined): string | undefined => {
  if (typeof ref !== 'object' || ref === null || Array.isArray(ref)) return undefined;
  const { asset, at } = ref as Readonly<Record<string, JsonValue>>;
  if (typeof asset !== 'string') return undefined;
  return typeof at === 'string' && at !== 'latest' ? `${asset}@${at}` : asset;
};

/**
 * #43: the image assets a page part names (image paints in fills and strokes, mask mattes), as upload keys. What an
 * opened document needs uploaded before its page is drawn: uploads are otherwise made only when an image is added.
 */
export function imageAssetKeys(part: Pick<DocumentCRDTv2, 'forEachNode' | 'prop'>): string[] {
  const keys = new Set<string>();
  part.forEachNode((node) => {
    for (const path of [P.fills, P.strokes]) {
      const list = part.prop(node.id, path);
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const paint = typeof item === 'object' && item !== null && !Array.isArray(item) ? item['paint'] : undefined;
        if (typeof paint !== 'object' || paint === null || Array.isArray(paint) || paint['kind'] !== 'image') continue;
        const key = refKey(paint['asset']);
        if (key !== undefined) keys.add(key);
      }
    }
    const matte = refKey(part.prop(node.id, P.maskAsset));
    if (matte !== undefined) keys.add(matte);
  });
  return [...keys];
}

/**
 * #43: upload every key whose library entry is known (a pinned key `as_…@ms_…` falls back to its asset's entry, as
 * export does). Keys without an entry are skipped; each failed upload is returned (errors are values), none stops the rest.
 */
export async function uploadImageKeys(uploads: Pick<ImageUploads, 'upload'>, keys: readonly string[], entry: (asset: string) => LibraryEntry | undefined, signal: AbortSignal): Promise<readonly SfError[]> {
  const results = await Promise.all(
    keys.map((key) => {
      const found = entry(key) ?? entry(key.split('@')[0] as string);
      return found === undefined ? undefined : uploads.upload({ ...found, asset: key as LibraryEntry['asset'] }, signal);
    }),
  );
  return results.flatMap((r) => (r === undefined || r.ok ? [] : [r.error]));
}

/** The create op of a placed image: fitted into `max` (page units), centred on `center`. */
export function placeImageOps(node: NodeId, parent: NodeId, entry: LibraryEntry, size: { readonly width: number; readonly height: number }, center: readonly [number, number], max: number): PartOp[] {
  const scale = Math.min(1, max / Math.max(size.width, size.height, 1));
  const w = Math.max(1, Math.round(size.width * scale));
  const h = Math.max(1, Math.round(size.height * scale));
  const fills = [{ paint: { kind: 'image', asset: { asset: entry.asset }, fit: 'cover' } }] as unknown as JsonValue;
  return [{ op: 'create', node, kind: 'image', parent, props: { name: entry.title, [P.x]: Math.round(center[0] - w / 2), [P.y]: Math.round(center[1] - h / 2), [P.w]: w, [P.h]: h, [P.fills]: fills } }];
}
