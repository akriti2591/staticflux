/**
 * Blob asset records (DOCUMENT-FORMAT §4, `records/as/…`): immutable, canonical JSON (RFC 8785),
 * written once at import and stored as a content-addressed blob. Mutable metadata (title, tags,
 * folder, favourite, trash, late renditions) lives in the library document, never here (IF-3.6).
 */
import type { BlobRef, Digest } from '@staticflux/blob';
import { err, ok, type Result } from '@staticflux/core';
import { canonicalJsonBytes, type JsonValue } from '@staticflux/document/v2';
import type { ActorJson, AssetId } from '../versioning/records.js';
import { LibraryDataError } from './errors.js';
import { BLOB_ASSET_KINDS, type BlobAssetKind } from './kinds.js';

export type { AssetId } from '../versioning/records.js';

export const BLOB_ASSET_SCHEMA = 'instaflow.asset/1';
/** Media type of stored asset records. */
export const ASSET_RECORD_MIME = 'application/vnd.instaflow.asset+json';

/** Probed media facts (only what the probe for the kind knows). */
export interface MediaInfo {
  readonly width?: number;
  readonly height?: number;
  /** Seconds (video, audio). */
  readonly duration?: number;
  readonly alpha?: boolean;
}

export interface BlobAssetRecord {
  readonly schema: typeof BLOB_ASSET_SCHEMA;
  readonly id: AssetId;
  readonly kind: BlobAssetKind;
  readonly createdAt: string;
  readonly createdBy: ActorJson;
  readonly content: BlobRef;
  readonly media?: MediaInfo;
  /** C2PA-aligned (IF-3.8); imports have no ingredients. */
  readonly provenance: { readonly action: 'imported'; readonly actor: ActorJson; readonly ingredients: readonly [] };
}

/** RFC 8785 bytes of a record (what is stored and hashed). */
export function encodeBlobAssetRecord(record: BlobAssetRecord): Result<Uint8Array> {
  return canonicalJsonBytes(record as unknown as JsonValue);
}

const decoder = /* @__PURE__ */ new TextDecoder();
const kinds: ReadonlySet<string> = /* @__PURE__ */ new Set(BLOB_ASSET_KINDS);

function isBlobRef(value: unknown): value is BlobRef {
  const ref = value as Partial<BlobRef> | null;
  return typeof ref === 'object' && ref !== null && typeof ref.digest === 'string' && ref.digest.startsWith('sha256:') && typeof ref.size === 'number' && typeof ref.mime === 'string';
}

/** Parse a stored record; anything else is IF-LIB-004 naming `digest`. */
export function decodeBlobAssetRecord(bytes: Uint8Array, digest: Digest): Result<BlobAssetRecord> {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch (cause) {
    return err(LibraryDataError({ message: 'An asset record is not valid JSON.', details: { digest }, cause }));
  }
  const v = value as Partial<BlobAssetRecord> | null;
  if (typeof v !== 'object' || v === null || v.schema !== BLOB_ASSET_SCHEMA || typeof v.id !== 'string' || !v.id.startsWith('as_') || !kinds.has(v.kind ?? '') || !isBlobRef(v.content)) {
    return err(LibraryDataError({ message: 'Not an instaflow.asset/1 blob asset record.', details: { digest } }));
  }
  return ok(v as BlobAssetRecord);
}
