/**
 * The `BlobStore` port (SF-Δ1, DOCUMENT-FORMAT §2 and §5.1). A blob is immutable
 * bytes addressed by the SHA-256 of its decoded content. Blobs up to 8 MiB are
 * one object; larger blobs are stored as 4 MiB chunk objects plus a chunk
 * manifest object, whose digest is the blob digest (IF-3.5).
 *
 * Two levels of addressing:
 * - a `Digest` names one stored **object** (raw stored bytes, as on disk);
 * - a `BlobRef` names a logical **blob**: it says whether the digest is a
 *   chunk manifest and how the object is encoded, so `get(ref)` returns the
 *   decoded content.
 */
import type { Result } from '@staticflux/core';

export type Digest = `sha256:${string}`;

/** Blobs up to this size are hashed and stored whole. */
export const WHOLE_BLOB_LIMIT = 8 * 1024 * 1024;
/** Chunk size of chunked blobs. */
export const CHUNK_SIZE = 4 * 1024 * 1024;
export const CHUNK_MANIFEST_SCHEMA = 'instaflow.chunks/1';
export const CHUNK_MANIFEST_MIME = 'application/vnd.staticflux.chunks+json';

export type BlobEncoding = 'deflate-raw';

export interface BlobRef {
  /** Digest of the decoded content; for chunked blobs, of the chunk manifest. */
  readonly digest: Digest;
  /** Decoded content size in bytes. */
  readonly size: number;
  readonly mime: string;
  /** More than 8 MiB: `digest` names a `ChunkManifest`. */
  readonly chunked?: true;
  /** Storage encoding only (Compression Streams). Never set on chunked blobs. */
  readonly encoding?: BlobEncoding;
}

export interface ChunkManifest {
  readonly schema: typeof CHUNK_MANIFEST_SCHEMA;
  readonly size: number;
  readonly mime: string;
  readonly chunkSize: typeof CHUNK_SIZE;
  readonly chunks: readonly Digest[];
}

/** Half-open byte range `[start, end)` over the decoded content. */
export interface BlobRange {
  readonly start: number;
  readonly end: number;
}

export interface PutProgress {
  /** Bytes read from the input so far. */
  readonly bytesRead: number;
  /** Chunk objects written so far (0 for whole blobs). */
  readonly chunksWritten: number;
}

export interface PutOptions {
  readonly signal?: AbortSignal;
  /** Defaults to `application/octet-stream`. */
  readonly mime?: string;
  /** Store the object deflate-raw encoded (whole blobs only; ignored above 8 MiB). */
  readonly encoding?: BlobEncoding;
  readonly onProgress?: (progress: PutProgress) => void;
}

export interface GetOptions {
  readonly signal?: AbortSignal;
  readonly range?: BlobRange;
}

export interface BlobStat {
  readonly digest: Digest;
  /** Size of the stored object in bytes (encoded size; the manifest size for chunked blobs). */
  readonly storedSize: number;
  /** Last write time of the object in ms since the epoch (used by the GC grace period). */
  readonly modifiedAt: number;
}

export interface VerifyResult {
  readonly digest: Digest;
  /** Objects checked (1, or 1 + chunk count for chunked blobs). */
  readonly objects: number;
}

export interface BlobStoreCapabilities {
  /** Survives a reload (OPFS, folder) or not (memory). */
  readonly persistent: boolean;
  /** Reads of a range touch only that range of the object (no full read). */
  readonly rangeReads: boolean;
}

/**
 * Change notifications from writers (directory objects, heads, journal). The
 * folder mirror subscribes to them; nothing else depends on them.
 */
export type StoreChange =
  | { readonly kind: 'object'; readonly path: readonly string[]; readonly name: string }
  | { readonly kind: 'head'; readonly name: string }
  | { readonly kind: 'log'; readonly path: readonly string[]; readonly name: string }
  | { readonly kind: 'delete'; readonly path: readonly string[]; readonly name: string };

export type StoreObserver = (change: StoreChange) => void;

export interface BlobStore {
  readonly id: string;
  readonly capabilities: BlobStoreCapabilities;
  /** Hash and store a stream. Dedupes by digest: an existing object is never rewritten. */
  put(input: ReadableStream<Uint8Array> | Uint8Array, options?: PutOptions): Promise<Result<BlobRef>>;
  /**
   * Adopt already-encoded bytes (a deflate-raw zip entry) without re-encoding:
   * the decoded content is hashed and must equal `ref.digest` (`SF-BLOB-002`
   * otherwise), then the stored bytes are written as they are.
   */
  putEncoded(stored: Uint8Array, ref: BlobRef, options?: { readonly signal?: AbortSignal }): Promise<Result<BlobRef>>;
  /** A `Digest` returns the stored object bytes; a `BlobRef` returns the decoded content. */
  get(target: Digest | BlobRef, options?: GetOptions): Promise<Result<Uint8Array>>;
  /** Decoded content as a stream (chunks are read one at a time). */
  stream(ref: BlobRef, options?: { readonly signal?: AbortSignal }): Result<ReadableStream<Uint8Array>>;
  has(digest: Digest, options?: { readonly signal?: AbortSignal }): Promise<Result<boolean>>;
  stat(digest: Digest, options?: { readonly signal?: AbortSignal }): Promise<Result<BlobStat>>;
  /**
   * Re-hash the object (and every chunk). A mismatch quarantines the object and
   * returns `SF-BLOB-002`. With a bare digest, a deflate-raw object is also accepted.
   */
  verify(target: Digest | BlobRef, options?: { readonly signal?: AbortSignal }): Promise<Result<VerifyResult>>;
  /** Remove one object. For the garbage collector only: content code never deletes. */
  delete(digest: Digest, options?: { readonly signal?: AbortSignal }): Promise<Result<void>>;
  /** Every stored object digest (for rebuilding the catalog only; GC sweeps from the catalog). */
  list(options?: { readonly signal?: AbortSignal }): AsyncIterable<Result<Digest>>;
  dispose(): void;
}

/**
 * The low-level object layer a `BlobStore` is built on: raw objects by digest.
 * Backends implement this; `createBlobStore` adds hashing, chunking, encoding,
 * ranges and verification on top, identically for every backend.
 */
export interface ObjectStore {
  readonly id: string;
  readonly capabilities: BlobStoreCapabilities;
  hasObject(digest: Digest, signal?: AbortSignal): Promise<Result<boolean>>;
  /** Publish atomically (temp + move or equivalent). Writing an existing digest is a no-op. */
  writeObject(digest: Digest, bytes: Uint8Array, signal?: AbortSignal): Promise<Result<void>>;
  readObject(digest: Digest, range?: BlobRange, signal?: AbortSignal): Promise<Result<Uint8Array>>;
  statObject(digest: Digest, signal?: AbortSignal): Promise<Result<BlobStat>>;
  deleteObject(digest: Digest, signal?: AbortSignal): Promise<Result<void>>;
  /** Move the object out of the served set (`SF-BLOB-002`); returns where it went. */
  quarantineObject(digest: Digest, signal?: AbortSignal): Promise<Result<string>>;
  listObjects(signal?: AbortSignal): AsyncIterable<Result<Digest>>;
  dispose(): void;
}
