/**
 * Part capture: Latest → canonical, content-addressed parts (DOCUMENT-FORMAT §6.1–6.2). Shared by
 * milestones and the frozen export snapshot, so both dedupe against each other by digest.
 *
 * - Each part is encoded on its own (`encodeCanonicalPart`, RFC 8785): O(part size), never the
 *   whole document at once. `comments` is never captured.
 * - **Only changed parts are encoded and written.** A per-part cache keyed by the CRDT frontier
 *   skips canonicalization of a part that did not change since the last capture (S6 recommendation 4:
 *   canonicalizing is half of a milestone's time); a digest that is already known (an earlier
 *   milestone or snapshot) is never written again.
 * - Parts that are not loaded are loaded for the capture and evicted again afterwards.
 */
import { ok, type Result } from '@staticflux/core';
import {
  type BlobRef,
  type ComponentRegistry,
  type DocumentCRDTv2,
  type DocumentStore,
  type Digest,
  encodeCanonicalPart,
  type Frontier,
  type PartId,
  type PartState,
  sha256Digest,
} from '@staticflux/document/v2';
import { type AssetReference, collectReferences, PART_SCHEMA } from './records.js';

/** The parts of an open document that capture reads (structurally a `DocumentRepo` `OpenDocument`). */
export interface PartSource {
  readonly asset: string;
  partIds(): readonly PartId[];
  partState(id: PartId): PartState;
  loadedPart(id: PartId): DocumentCRDTv2 | undefined;
  part(id: PartId, signal: AbortSignal): Promise<Result<DocumentCRDTv2>>;
  evict(id: PartId): Result<void>;
}

/** Parts never captured into milestones or snapshots (IF-18.2). */
export const UNCAPTURED_PARTS: readonly PartId[] = ['comments'];

export interface CapturedParts {
  readonly parts: Readonly<Record<PartId, BlobRef>>;
  /** Where-used references across all parts (merged, sorted). */
  readonly references: readonly AssetReference[];
  /** Parts canonicalized by this capture (the others were unchanged since the last one). */
  readonly encoded: readonly PartId[];
  /** Parts whose canonical bytes were new and therefore written. */
  readonly written: readonly PartId[];
  readonly bytesWritten: number;
}

export interface CaptureOptions {
  /** Digests already in the store (e.g. the newest milestone's parts): never written again. */
  readonly known?: ReadonlySet<Digest>;
}

export interface PartCapture {
  capture(doc: PartSource, signal: AbortSignal, options?: CaptureOptions): Promise<Result<CapturedParts>>;
  /** Drop the cache for an asset (on close). */
  forget(asset: string): void;
}

export interface PartCaptureOptions {
  readonly store: DocumentStore;
  readonly registry?: ComponentRegistry;
  /** Default: the registry version, else 1. */
  readonly treeSchema?: number;
}

interface CacheEntry {
  readonly frontier: Frontier;
  readonly ref: BlobRef;
  readonly references: readonly AssetReference[];
}

function mergeReferences(lists: readonly (readonly AssetReference[])[]): AssetReference[] {
  const merged = new Map<string, { ref: AssetReference['ref']; where: number }>();
  for (const list of lists) {
    for (const entry of list) {
      const key = `${String(entry.ref['asset'])}@${String(entry.ref['at'] ?? '')}`;
      const found = merged.get(key);
      if (found === undefined) merged.set(key, { ref: entry.ref, where: entry.where });
      else found.where += entry.where;
    }
  }
  return [...merged.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, e]) => e);
}

export function createPartCapture(options: PartCaptureOptions): PartCapture {
  const cache = new Map<string, CacheEntry>();
  const keyOf = (asset: string, part: PartId): string => `${asset}\u0000${part}`;
  const treeSchema = options.treeSchema ?? options.registry?.version ?? 1;

  return {
    async capture(doc, signal, captureOptions = {}) {
      const known = new Set(captureOptions.known ?? []);
      const parts: Record<PartId, BlobRef> = {};
      const references: (readonly AssetReference[])[] = [];
      const encoded: PartId[] = [];
      const written: PartId[] = [];
      let bytesWritten = 0;
      for (const id of doc.partIds()) {
        if (UNCAPTURED_PARTS.includes(id)) continue;
        const wasLoaded = doc.partState(id) === 'loaded';
        const loaded = wasLoaded ? doc.loadedPart(id) : undefined;
        let crdt: DocumentCRDTv2;
        if (loaded !== undefined) crdt = loaded;
        else {
          const read = await doc.part(id, signal);
          if (!read.ok) return read;
          crdt = read.value;
        }
        try {
          const key = keyOf(doc.asset, id);
          const frontier = crdt.frontier();
          const cached = cache.get(key);
          if (cached !== undefined && cached.frontier === frontier) {
            parts[id] = cached.ref;
            references.push(cached.references);
            continue;
          }
          const part = encodeCanonicalPart(crdt, { part: id, schema: PART_SCHEMA, treeSchema, ...(options.registry === undefined ? {} : { registry: options.registry }) });
          if (!part.ok) return part;
          encoded.push(id);
          const digest = await sha256Digest(part.value.bytes);
          let ref: BlobRef = { digest, size: part.value.bytes.byteLength };
          if (!known.has(digest) && cached?.ref.digest !== digest) {
            const put = await options.store.putBlob(part.value.bytes, signal);
            if (!put.ok) return put;
            ref = put.value;
            written.push(id);
            bytesWritten += ref.size;
            known.add(digest);
          }
          const refs = collectReferences([part.value.part]);
          cache.set(key, { frontier, ref, references: refs });
          parts[id] = ref;
          references.push(refs);
        } finally {
          if (!wasLoaded) doc.evict(id);
        }
      }
      return ok({ parts, references: mergeReferences(references), encoded, written, bytesWritten });
    },
    forget(asset) {
      for (const key of [...cache.keys()]) if (key.startsWith(`${asset}\u0000`)) cache.delete(key);
    },
  };
}
