/**
 * Media previews on Home's cards and rows (B11c): an imported image shows itself instead of a placeholder. The bytes are
 * read from the workspace blob store (OPFS) by digest, the first time a card asks, and shown through an object URL;
 * the store module loads on the first request only. A design or template shows its cover (#64: the first page Studio
 * rendered in the export worker, `HomeEntry.cover`); without one it keeps its page-shaped placeholder (HOME-FILES §1).
 * URLs are revoked when Home goes.
 */
import type { BlobStore } from '@staticflux/blob';
import type { Digest } from '@staticflux/blob';
import { DESIGN_COVER_MIME, type HomeEntry } from './index-record.js';

/** Larger images are not previewed (they are chunked in the store and would cost a full read per card). */
export const PREVIEW_MAX_BYTES = 8 * 1024 * 1024;

export interface PreviewSourceOptions {
  /** The blob store, opened on first use. */
  readonly open: () => Promise<Pick<BlobStore, 'get'>>;
  readonly urls?: { create(blob: Blob): string; revoke(url: string): void };
  readonly signal: AbortSignal;
}

/** What an entry previews as: its cover, or its own bytes when it is a small image (undefined: nothing to show). */
export function previewBlob(entry: HomeEntry): { readonly digest: string; readonly mime: string } | undefined {
  if (entry.cover !== undefined) return { digest: entry.cover, mime: DESIGN_COVER_MIME };
  if (entry.digest === undefined || entry.mime?.startsWith('image/') !== true || (entry.size ?? 0) > PREVIEW_MAX_BYTES) return undefined;
  return { digest: entry.digest, mime: entry.mime };
}

/** An entry → object URL source (undefined: nothing to preview, or unreadable). */
export function createPreviewSource(options: PreviewSourceOptions): (entry: HomeEntry) => Promise<string | undefined> {
  const urls = options.urls ?? { create: (b: Blob) => URL.createObjectURL(b), revoke: (u: string) => URL.revokeObjectURL(u) };
  const made = new Map<string, Promise<string | undefined>>();
  let store: Promise<Pick<BlobStore, 'get'>> | undefined;
  options.signal.addEventListener('abort', () => {
    for (const url of made.values()) void url.then((u) => (u === undefined ? undefined : urls.revoke(u)));
    made.clear();
  });
  return (entry) => {
    const blob = previewBlob(entry);
    if (blob === undefined || options.signal.aborted) return Promise.resolve(undefined);
    const { digest, mime } = blob;
    const known = made.get(digest);
    if (known !== undefined) return known;
    const url = (async () => {
      store ??= options.open();
      const bytes = await (await store).get(digest as Digest, { signal: options.signal });
      if (!bytes.ok) return undefined;
      return urls.create(new Blob([bytes.value as BlobPart], { type: mime }));
    })().catch(() => undefined);
    made.set(digest, url);
    return url;
  };
}
