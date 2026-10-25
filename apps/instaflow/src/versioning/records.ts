/**
 * Immutable versioning records (DOCUMENT-FORMAT §4, §6): milestones, asset records and frozen
 * snapshot manifests. Each is canonical JSON (RFC 8785) stored as a content-addressed blob, so its
 * id is its digest: `ms_<hex>` for a milestone ("sha256 of the canonical milestone record", the
 * record itself carries no `id`), `sn_<hex>` for a snapshot manifest.
 */
import { err, ok, type Result } from '@staticflux/core';
import { type BlobRef, type CanonicalPart, canonicalJsonBytes, type Digest, type JsonObject, type JsonValue, type PartId } from '@staticflux/document/v2';
import { MilestoneDataError } from './errors.js';

export type AssetId = `as_${string}`;
export type MilestoneId = `ms_${string}`;
export type SnapshotId = `sn_${string}`;

/** Record schema strings (format §8: never renamed; additive changes only). */
export const MILESTONE_SCHEMA = 'instaflow.milestone/1';
export const ASSET_SCHEMA = 'instaflow.asset/1';
export const SNAPSHOT_SCHEMA = 'instaflow.snapshot/1';
export const PART_SCHEMA = 'instaflow.part/1';

/** `kind: 'auto'` is reserved for a later release (IF-5.6); V1 only writes `named`. */
export type MilestoneKind = 'named';

/** Who made it, as stored (a stage `actorRecord(actor)`). */
export type ActorJson = JsonObject & { readonly kind: string; readonly id: string };

export interface AssetReference {
  /** `{ asset }` (blob or following) or `{ asset, at }` (`latest` or a milestone id). */
  readonly ref: JsonObject;
  /** Use count in the parts (where-used, GC). */
  readonly where: number;
}

/** A milestone (records/ms/…): a full snapshot of canonical parts, shared with other milestones by digest. */
export interface MilestoneRecord {
  readonly schema: typeof MILESTONE_SCHEMA;
  readonly asset: AssetId;
  readonly kind: MilestoneKind;
  readonly name: string;
  readonly note?: string;
  readonly createdAt: string;
  readonly createdBy: ActorJson;
  /** Previous milestone of the same asset (informational; never resolved for content). */
  readonly parent?: MilestoneId;
  readonly treeSchema: number;
  /** Canonical parts (`comments` is never here). Unchanged parts share digests with earlier milestones. */
  readonly parts: Readonly<Record<PartId, BlobRef>>;
  readonly references: readonly AssetReference[];
}

export type AssetKind = 'composition' | 'template';

/** Label only: never resolved, so deleting the source never affects the copy (IF-5.7). */
export interface CreatedFrom {
  readonly asset: AssetId;
  readonly milestone: MilestoneId;
  readonly title: string;
}

/** The new document's asset record (records/as/…), written once. */
export interface AssetRecord {
  readonly schema: typeof ASSET_SCHEMA;
  readonly id: AssetId;
  readonly kind: AssetKind;
  readonly createdAt: string;
  readonly createdBy: ActorJson;
  readonly provenance: { readonly action: 'created' | 'derived'; readonly actor: ActorJson; readonly ingredients: readonly [] };
  readonly createdFrom?: CreatedFrom;
}

/** A frozen, content-addressed snapshot of Latest (IF-5.10, D10): the parts an export renders from. */
export interface SnapshotManifest {
  readonly schema: typeof SNAPSHOT_SCHEMA;
  readonly asset: AssetId;
  readonly treeSchema: number;
  readonly parts: Readonly<Record<PartId, BlobRef>>;
}

const HEX = /^[0-9a-f]{64}$/;

export function milestoneIdOf(digest: Digest): MilestoneId {
  return `ms_${digest.slice('sha256:'.length)}`;
}

export function snapshotIdOf(digest: Digest): SnapshotId {
  return `sn_${digest.slice('sha256:'.length)}`;
}

/** The blob digest behind a milestone or snapshot id. */
export function digestOfId(id: MilestoneId | SnapshotId): Digest {
  return `sha256:${id.slice(3)}`;
}

export function isMilestoneId(value: unknown): value is MilestoneId {
  return typeof value === 'string' && value.startsWith('ms_') && HEX.test(value.slice(3));
}

export function isAssetId(value: unknown): value is AssetId {
  return typeof value === 'string' && value.length > 3 && value.startsWith('as_');
}

/** RFC 8785 bytes of a record (the blob that is stored and hashed). */
export function encodeRecord(record: MilestoneRecord | AssetRecord | SnapshotManifest): Result<Uint8Array> {
  return canonicalJsonBytes(record as unknown as JsonValue);
}

const decoder = /* @__PURE__ */ new TextDecoder();

function parseJson(bytes: Uint8Array, digest: Digest): Result<JsonObject> {
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return ok(value as JsonObject);
  } catch (cause) {
    return err(MilestoneDataError({ message: 'A versioning record is not valid JSON.', details: { digest }, cause }));
  }
  return err(MilestoneDataError({ message: 'A versioning record is not a JSON object.', details: { digest } }));
}

function isPartMap(value: unknown): value is Record<PartId, BlobRef> {
  if (typeof value !== 'object' || value === null) return false;
  return Object.values(value).every((ref) => typeof (ref as BlobRef)?.digest === 'string' && typeof (ref as BlobRef).size === 'number');
}

export function decodeMilestoneRecord(bytes: Uint8Array, digest: Digest): Result<MilestoneRecord> {
  const json = parseJson(bytes, digest);
  if (!json.ok) return json;
  const v = json.value as Partial<MilestoneRecord>;
  if (v.schema !== MILESTONE_SCHEMA || typeof v.name !== 'string' || typeof v.asset !== 'string' || typeof v.treeSchema !== 'number' || !isPartMap(v.parts)) {
    return err(MilestoneDataError({ message: 'Not an instaflow.milestone/1 record.', details: { digest } }));
  }
  return ok(v as MilestoneRecord);
}

export function decodeSnapshotManifest(bytes: Uint8Array, digest: Digest): Result<SnapshotManifest> {
  const json = parseJson(bytes, digest);
  if (!json.ok) return json;
  const v = json.value as Partial<SnapshotManifest>;
  if (v.schema !== SNAPSHOT_SCHEMA || typeof v.asset !== 'string' || typeof v.treeSchema !== 'number' || !isPartMap(v.parts)) {
    return err(MilestoneDataError({ message: 'Not an instaflow.snapshot/1 manifest.', details: { digest } }));
  }
  return ok(v as SnapshotManifest);
}

export function decodeAssetRecord(bytes: Uint8Array, digest: Digest): Result<AssetRecord> {
  const json = parseJson(bytes, digest);
  if (!json.ok) return json;
  const v = json.value as Partial<AssetRecord>;
  if (v.schema !== ASSET_SCHEMA || !isAssetId(v.id) || typeof v.kind !== 'string') {
    return err(MilestoneDataError({ message: 'Not an instaflow.asset/1 record.', details: { digest } }));
  }
  return ok(v as AssetRecord);
}

/**
 * Where-used references in canonical parts: every JSON object with an `asset: 'as_…'` field
 * (media sources, paint images, instances, brand kits), keyed by `asset` + `at`, sorted.
 */
export function collectReferences(parts: readonly CanonicalPart[]): AssetReference[] {
  const counts = new Map<string, { ref: JsonObject; where: number }>();
  const visit = (value: JsonValue): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const object = value as JsonObject;
    const asset = object['asset'];
    if (isAssetId(asset)) {
      const at = object['at'];
      const ref: JsonObject = typeof at === 'string' ? { asset, at } : { asset };
      const key = typeof at === 'string' ? `${asset}@${at}` : asset;
      const entry = counts.get(key);
      if (entry === undefined) counts.set(key, { ref, where: 1 });
      else entry.where += 1;
    }
    for (const child of Object.values(object)) visit(child as JsonValue);
  };
  for (const part of parts) for (const node of part.nodes) visit(node.props as JsonObject);
  return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, entry]) => entry);
}
