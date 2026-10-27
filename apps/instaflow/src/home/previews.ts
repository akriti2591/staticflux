/**
 * Media previews on Home's cards and rows (B11c): an imported image shows itself instead of a placeholder. The bytes are
 * read from the workspace blob store (OPFS) by digest, the first time a card asks, and shown through an object URL;
 * the store module loads on the first request only. Designs keep their page-shaped placeholder until covers land
 * (A6 projection covers, HOME-FILES §5). URLs are revoked when Home goes.
 */
import type { BlobStore } from '@staticflux/blob';
import type { Digest } from '@staticflux/blob';
import type { HomeEntry } from './index-record.js';

/** Larger images are not previewed (they are chunked in the store and would cost a full read per card). */
export const PREVIEW_MAX_BYTES = 8 * 1024 * 1024;

export interface PreviewSourceOptions {
  /** The blob store, opened on first use. */
  readonly open: () => Promise<Pick<BlobStore, 'get'>>;
  readonly urls?: { create(blob: Blob): string; revoke(url: string): void };
  readonly signal: AbortSignal;
}

/** An entry → object URL source (undefined: not an image, too large, or unreadable). */
export function createPreviewSource(options: PreviewSourceOptions): (entry: HomeEntry) => Promise<string | undefined> {
  const urls = options.urls ?? { create: (b: Blob) => URL.createObjectURL(b), revoke: (u: string) => URL.revokeObjectURL(u) };
  const made = new Map<string, Promise<string | undefined>>();
  let store: Promise<Pick<BlobStore, 'get'>> | undefined;
  options.signal.addEventListener('abort', () => {
    for (const url of made.values()) void url.then((u) => (u === undefined ? undefined : urls.revoke(u)));
    made.clear();
  });
  return (entry) => {
    const digest = entry.digest;
    if (digest === undefined || entry.mime?.startsWith('image/') !== true || (entry.size ?? 0) > PREVIEW_MAX_BYTES || options.signal.aborted) return Promise.resolve(undefined);
    const known = made.get(digest);
    if (known !== undefined) return known;
    const url = (async () => {
      store ??= options.open();
      const bytes = await (await store).get(digest as Digest, { signal: options.signal });
      if (!bytes.ok) return undefined;
      return urls.create(new Blob([bytes.value as BlobPart], { type: entry.mime ?? '' }));
    })().catch(() => undefined);
    made.set(digest, url);
    return url;
  };
}
