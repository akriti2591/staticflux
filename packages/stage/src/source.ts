/**
 * Stage sources: read-only, per-node views of one tree asset's content (its local layer), and the asset resolver that
 * maps references (`AssetRef`, IF-4.5) to them.
 *
 * - `createPartsDocument(asset)` — a `StageDocument` over the loaded `DocumentCRDTv2` parts of one asset (one per page,
 *   D14). Attach parts as they load and detach them on eviction; changes arrive through each part's `observe`.
 * - `StageAssets` — the resolver port: following references (`at: 'latest'`) resolve to the asset's Latest, pinned ones
 *   (`at: ms_…`) to a read-only milestone document (built by the versioning work, B5). Documents never hold physical
 *   locations; a resolver maps references to content.
 */
import type { DocumentCRDTv2, NodeId, NodeRecord } from '@staticflux/document/v2';

/** A reference from content to another asset (DOCUMENT-FORMAT §2). */
export type AssetRef =
  | { readonly asset: string }
  | { readonly asset: string; readonly at: 'latest' }
  | { readonly asset: string; readonly at: string };

/** Nodes whose record (props, parent, order, existence) changed. */
export interface StageDocumentChange {
  readonly nodes: readonly NodeId[];
}

export interface StageDocument {
  /** Unique per content version: `as_…` for Latest, `as_…@ms_…` for a milestone. */
  readonly key: string;
  node(id: NodeId): NodeRecord | undefined;
  /** Ordered children; `null` = top-level nodes. */
  children(parent: NodeId | null): readonly NodeId[];
  /** The asset's root node (its `composition`), if loaded. */
  root(): NodeId | undefined;
  subscribe(listener: (change: StageDocumentChange) => void): () => void;
}

export interface StageAssets {
  /** The document a reference resolves to, or undefined while it is not available (missing or not loaded yet). */
  resolve(ref: AssetRef): StageDocument | undefined;
  /** Called with a reference key (`refKey`) when what it resolves to changes (loaded, unloaded, re-pointed). */
  subscribe?(listener: (refKey: string) => void): () => void;
}

/** `as_…` (blob, or following) or `as_…@ms_…` (pinned). */
export function refKey(ref: AssetRef): string {
  return 'at' in ref && ref.at !== 'latest' ? `${ref.asset}@${ref.at}` : ref.asset;
}

/** True for `{ asset }` / `{ asset, at }` shapes. */
export function isAssetRef(value: unknown): value is AssetRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v['asset'] === 'string' && (v['at'] === undefined || typeof v['at'] === 'string');
}

/** True when the reference follows Latest (tree assets); pinned references name a milestone. */
export function isFollowing(ref: AssetRef): boolean {
  return 'at' in ref && ref.at === 'latest';
}

export interface PartsDocument extends StageDocument {
  /** Add a loaded part (the first attached part named `root` provides `root()`). Returns a detach function. */
  attach(part: DocumentCRDTv2, options?: { readonly id?: string }): () => void;
  /** Loaded parts, in attach order. */
  parts(): readonly DocumentCRDTv2[];
}

/** A `StageDocument` over the loaded parts of one asset. */
export function createPartsDocument(key: string): PartsDocument {
  const attached: { part: DocumentCRDTv2; id: string | undefined; stop: () => void }[] = [];
  const listeners = new Set<(change: StageDocumentChange) => void>();
  const emit = (nodes: readonly NodeId[]): void => {
    if (nodes.length === 0) return;
    for (const listener of [...listeners]) listener({ nodes });
  };
  const owner = (id: NodeId): DocumentCRDTv2 | undefined => attached.find((a) => !a.part.disposed && a.part.has(id))?.part;
  const topLevel = (): NodeId[] => attached.flatMap((a) => (a.part.disposed ? [] : a.part.children(null)));
  return {
    key,
    node: (id) => owner(id)?.node(id),
    children(parent) {
      if (parent === null) return topLevel();
      const out: NodeId[] = [];
      for (const a of attached) if (!a.part.disposed && a.part.has(parent)) out.push(...a.part.children(parent));
      return out;
    },
    root() {
      const named = attached.find((a) => a.id === 'root' && !a.part.disposed);
      return (named?.part.children(null) ?? topLevel())[0];
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    attach(part, options = {}) {
      // Node ids per part, so a detach after eviction (part already disposed) still names what disappeared.
      const ids = new Set<NodeId>();
      part.forEachNode((n) => {
        ids.add(n.id);
      });
      const stop = part.observe((change) => {
        for (const id of change.created) ids.add(id);
        for (const id of change.deleted) ids.delete(id);
        emit([...change.created, ...change.deleted, ...change.moved, ...change.updated.keys()]);
      });
      const entry = { part, id: options.id, stop };
      attached.push(entry);
      emit([...ids]);
      return () => {
        const index = attached.indexOf(entry);
        if (index < 0) return;
        attached.splice(index, 1);
        entry.stop();
        emit([...ids]);
      };
    },
    parts: () => attached.map((a) => a.part),
  };
}

/** A resolver over a fixed map of documents by reference key (tests, single-asset editors, pinned milestones). */
export function createStaticAssets(documents: Readonly<Record<string, StageDocument>> = {}): StageAssets & {
  set(key: string, document: StageDocument | undefined): void;
} {
  const map = new Map(Object.entries(documents));
  const listeners = new Set<(key: string) => void>();
  return {
    resolve: (ref) => map.get(refKey(ref)),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(key, document) {
      if (document === undefined) map.delete(key);
      else map.set(key, document);
      for (const listener of [...listeners]) listener(key);
    },
  };
}
