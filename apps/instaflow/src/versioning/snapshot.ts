/**
 * The frozen export snapshot (IF-5.10, D10): when an export starts, Latest is captured into
 * canonical, content-addressed parts plus a manifest. The export (C1) renders only from it, so edits
 * made while it runs never leak in. A snapshot is **not a milestone**: it writes no record, touches
 * no head and adds no list entry (plain exports leave nothing behind); its blobs dedupe with
 * milestones by digest and are collected by GC unless a Release keeps them.
 *
 * Publishing (later) creates a Release asset that keeps the snapshot (rendered outputs + snapshot +
 * "published from" label). `ReleasePort` is the hook for it; M1 ships no implementation.
 */
import { err, ok, type Result } from '@staticflux/core';
import type { BlobRef, ComponentRegistry, DocumentStore } from '@staticflux/document/v2';
import { MilestoneDataError, ReleaseUnavailableError } from './errors.js';
import type { PartCapture, PartSource } from './parts.js';
import { openReadOnlyDocument, type ReadOnlyDocument } from './readonly.js';
import { type AssetId, decodeSnapshotManifest, digestOfId, encodeRecord, SNAPSHOT_SCHEMA, type SnapshotId, snapshotIdOf, type SnapshotManifest } from './records.js';

/** A frozen snapshot: immutable by construction (content-addressed manifest over content-addressed parts). */
export interface FrozenSnapshot {
  readonly id: SnapshotId;
  /** The manifest blob (`id` is its digest). */
  readonly ref: BlobRef;
  readonly manifest: SnapshotManifest;
}

/** The source of a snapshot (structurally a `DocumentRepo` `OpenDocument`). */
export type SnapshotSource = PartSource;

export interface ExportSnapshotService {
  /** Capture Latest now (call at export start). */
  freeze(signal: AbortSignal): Promise<Result<FrozenSnapshot>>;
  /** A read-only view of a snapshot (what the exporter renders). */
  open(snapshot: FrozenSnapshot | { readonly id: SnapshotId; readonly ref: BlobRef }, signal: AbortSignal): Promise<Result<ReadOnlyDocument>>;
}

export interface ExportSnapshotServiceOptions {
  readonly doc: SnapshotSource;
  readonly store: DocumentStore;
  readonly capture: PartCapture;
  readonly registry?: ComponentRegistry;
  readonly treeSchema?: number;
}

export function createExportSnapshotService(options: ExportSnapshotServiceOptions): ExportSnapshotService {
  const asset = options.doc.asset as AssetId;
  const treeSchema = options.treeSchema ?? options.registry?.version ?? 1;
  return {
    async freeze(signal) {
      // Freeze what the person sees: every commit applied in memory is captured, durable or not.
      const captured = await options.capture.capture(options.doc, signal);
      if (!captured.ok) return captured;
      const manifest: SnapshotManifest = { schema: SNAPSHOT_SCHEMA, asset, treeSchema, parts: captured.value.parts };
      const bytes = encodeRecord(manifest);
      if (!bytes.ok) return bytes;
      const ref = await options.store.putBlob(bytes.value, signal);
      if (!ref.ok) return ref;
      return ok({ id: snapshotIdOf(ref.value.digest), ref: ref.value, manifest });
    },
    async open(snapshot, signal) {
      let manifest: SnapshotManifest;
      if ('manifest' in snapshot) manifest = snapshot.manifest;
      else {
        const digest = digestOfId(snapshot.id);
        if (snapshot.ref.digest !== digest) return err(MilestoneDataError({ message: 'Snapshot id and manifest ref disagree.', details: { snapshot: snapshot.id } }));
        const bytes = await options.store.getBlob(snapshot.ref, signal);
        if (!bytes.ok) return err(MilestoneDataError({ message: 'The snapshot manifest is missing from the store.', details: { digest }, cause: bytes.error }));
        const decoded = decodeSnapshotManifest(bytes.value, digest);
        if (!decoded.ok) return decoded;
        manifest = decoded.value;
      }
      return ok(
        openReadOnlyDocument({
          store: options.store,
          asset: manifest.asset,
          source: { kind: 'snapshot', id: snapshot.id },
          treeSchema: manifest.treeSchema,
          parts: manifest.parts,
          ...(options.registry === undefined ? {} : { registry: options.registry }),
        }),
      );
    },
  };
}

/** What a Release keeps (D10): the rendered outputs, the frozen snapshot and a "published from" label. */
export interface ReleaseRequest {
  readonly snapshot: FrozenSnapshot;
  readonly outputs: readonly BlobRef[];
  readonly format: string;
  readonly publishedFrom: { readonly asset: AssetId; readonly title: string };
}

export interface ReleaseRef {
  readonly asset: AssetId;
}

/** The Release hook (publish flow, after M1). Plain exports never call it. */
export interface ReleasePort {
  createRelease(request: ReleaseRequest, signal: AbortSignal): Promise<Result<ReleaseRef>>;
}

/** The M1 Release port: publishing is not available yet (IF-VER-009). */
export const unavailableReleasePort: ReleasePort = {
  createRelease: (request) => Promise.resolve(err(ReleaseUnavailableError({ details: { snapshot: request.snapshot.id } }))),
};
