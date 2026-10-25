/**
 * Read-only documents (IF-5.11, DOCUMENT-FORMAT §6.1 "Open"): a milestone or a frozen snapshot read
 * straight from its canonical parts. No CRDT is involved, so nothing can be edited and nothing is
 * written. Parts load lazily (one blob read each, `parse → migrate` on read) and are cached.
 *
 * Opening costs one read per part that is actually viewed: O(size of what is shown), independent of
 * how many milestones or edits exist (IF-5.9).
 */
import { err, ok, type Result } from '@staticflux/core';
import {
  type BlobRef,
  type CanonicalNode,
  type CanonicalPart,
  type ComponentRegistry,
  type DocumentStore,
  migrateCanonicalPart,
  type NodeId,
  parseCanonicalPart,
  type PartId,
} from '@staticflux/document/v2';
import { MilestoneDataError } from './errors.js';
import type { AssetId, MilestoneId, SnapshotId } from './records.js';

export type ReadOnlySource =
  | { readonly kind: 'milestone'; readonly id: MilestoneId; readonly name: string; readonly createdAt: string }
  | { readonly kind: 'snapshot'; readonly id: SnapshotId };

export interface ReadOnlyPart {
  readonly id: PartId;
  readonly canonical: CanonicalPart;
  size(): number;
  node(id: NodeId): CanonicalNode | undefined;
  /** Ordered child ids; `null` = top-level nodes. */
  children(parent: NodeId | null): readonly NodeId[];
  /** Pre-order walk. Return false to stop. */
  forEachNode(visit: (node: CanonicalNode) => boolean | void): void;
}

export interface ReadOnlyDocument {
  readonly readOnly: true;
  readonly asset: AssetId;
  readonly source: ReadOnlySource;
  readonly treeSchema: number;
  partIds(): readonly PartId[];
  part(id: PartId, signal: AbortSignal): Promise<Result<ReadOnlyPart>>;
}

export interface ReadOnlyDocumentInit {
  readonly store: DocumentStore;
  readonly asset: AssetId;
  readonly source: ReadOnlySource;
  readonly treeSchema: number;
  readonly parts: Readonly<Record<PartId, BlobRef>>;
  /** Upgrade parts written with older component versions on read. */
  readonly registry?: ComponentRegistry;
}

/** Index one canonical part for per-node reads. */
export function indexCanonicalPart(id: PartId, canonical: CanonicalPart): ReadOnlyPart {
  const byId = new Map<NodeId, CanonicalNode>();
  const children = new Map<NodeId | null, CanonicalNode[]>();
  for (const node of canonical.nodes) byId.set(node.id, node);
  for (const node of canonical.nodes) {
    const parent = node.parent !== null && byId.has(node.parent) ? node.parent : null;
    const list = children.get(parent) ?? [];
    list.push(node);
    children.set(parent, list);
  }
  const ordered = new Map<NodeId | null, readonly NodeId[]>();
  for (const [parent, list] of children) {
    ordered.set(parent, [...list].sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : 1)).map((n) => n.id));
  }
  return {
    id,
    canonical,
    size: () => canonical.nodes.length,
    node: (node) => byId.get(node),
    children: (parent) => ordered.get(parent) ?? [],
    forEachNode(visit) {
      const walk = (parent: NodeId | null): boolean => {
        for (const childId of ordered.get(parent) ?? []) {
          if (visit(byId.get(childId) as CanonicalNode) === false) return false;
          if (!walk(childId)) return false;
        }
        return true;
      };
      walk(null);
    },
  };
}

/** Read and parse one canonical part blob (`parse → migrate`). */
export async function readCanonicalPart(store: DocumentStore, id: PartId, ref: BlobRef, signal: AbortSignal, registry?: ComponentRegistry): Promise<Result<CanonicalPart>> {
  const bytes = await store.getBlob(ref, signal);
  if (!bytes.ok) return err(MilestoneDataError({ message: `Canonical part "${id}" is missing from the store.`, details: { part: id, digest: ref.digest }, cause: bytes.error }));
  const parsed = parseCanonicalPart(bytes.value);
  if (!parsed.ok) return err(MilestoneDataError({ message: `Canonical part "${id}" is malformed.`, details: { part: id, digest: ref.digest }, cause: parsed.error }));
  if (registry === undefined) return parsed;
  return migrateCanonicalPart(parsed.value, registry);
}

export function openReadOnlyDocument(init: ReadOnlyDocumentInit): ReadOnlyDocument {
  const loading = new Map<PartId, Promise<Result<ReadOnlyPart>>>();
  const ids = Object.keys(init.parts).sort();
  return {
    readOnly: true,
    asset: init.asset,
    source: init.source,
    treeSchema: init.treeSchema,
    partIds: () => ids,
    part(id, signal) {
      const ref = init.parts[id];
      if (ref === undefined) return Promise.resolve(err(MilestoneDataError({ message: `This ${init.source.kind} has no part "${id}".`, details: { part: id } })));
      let pending = loading.get(id);
      if (pending === undefined) {
        pending = readCanonicalPart(init.store, id, ref, signal, init.registry).then((r) => (r.ok ? ok(indexCanonicalPart(id, r.value)) : r));
        loading.set(id, pending);
        // A failed or aborted read is retried by the next call.
        void pending.then((r) => {
          if (!r.ok) loading.delete(id);
        });
      }
      return pending;
    },
  };
}
