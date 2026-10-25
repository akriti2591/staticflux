/**
 * Spatial index system (SF-Δ25, IF-7.8): an R-tree (`rbush`) over **ink bounds** — the
 * geometry box grown by everything that paints outside it (stroke, shadow, blur) — kept
 * in step with a `DocumentCRDTv2` part from its `PartChange`s. Hit tests and marquee
 * queries in the editor module ask it for candidates, then run their precise test
 * (kurbo in B3) on those only.
 *
 * - `createSpatialIndex()` — the plain index: keyed boxes, `search(box)`, `hit(x, y)`.
 * - `bindSpatialIndex({ part, bounds })` — the system: `rebuild()` bulk-loads the part
 *   (one explicit walk), `apply(change)` re-indexes only created / moved / updated nodes
 *   whose updated paths match `paths`, and drops deleted ones. The index is a
 *   materialized view: only the system writes it, always from CRDT state.
 *
 * Boxes are half-open on the max side for points (`x < maxX`), closed for box overlap
 * (rbush semantics); `inkBox(box, outset)` adds per-side outsets.
 *
 * @example
 * const spatial = bindSpatialIndex({ part, bounds: (node) => inkBox(boxOf(node), strokeOutset(node)), paths: ['spatial.', 'style.'] });
 * spatial.rebuild();
 * const committed = part.transact(meta, ops); if (committed.ok) spatial.apply(committed.value.change);
 * const candidates = spatial.index.hit(px, py);          // then the precise test
 */
import RBush from 'rbush';
import type { DocumentCRDTv2, NodeId, NodeRecord, PartChange } from './crdt-v2.js';

/** Axis-aligned box in document units. */
export interface Box {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** Per-side outset (stroke outside, shadow offset + blur…). A number grows every side. */
export type Outset = number | { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };

/** The ink box: `box` grown by `outset` (negative outsets are clamped to 0). */
export function inkBox(box: Box, outset: Outset = 0): Box {
  const o = typeof outset === 'number' ? { left: outset, top: outset, right: outset, bottom: outset } : outset;
  return {
    minX: box.minX - Math.max(0, o.left),
    minY: box.minY - Math.max(0, o.top),
    maxX: box.maxX + Math.max(0, o.right),
    maxY: box.maxY + Math.max(0, o.bottom),
  };
}

/** True for a finite, non-inverted box. */
export function isValidBox(box: Box): boolean {
  return (
    Number.isFinite(box.minX) && Number.isFinite(box.minY) && Number.isFinite(box.maxX) && Number.isFinite(box.maxY) && box.minX <= box.maxX && box.minY <= box.maxY
  );
}

interface Entry<K> {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  readonly key: K;
}

export interface SpatialIndex<K> {
  /** Entries in the index. */
  readonly size: number;
  /** Insert or move `key`. Invalid boxes (NaN, inverted) remove the key instead. */
  set(key: K, box: Box): void;
  delete(key: K): boolean;
  get(key: K): Box | undefined;
  has(key: K): boolean;
  /** Keys whose box overlaps `box` (edges touching count), in no particular order. */
  search(box: Box): K[];
  /** Keys whose box contains the point (`min ≤ p < max`), grown by `tolerance` on every side. */
  hit(x: number, y: number, tolerance?: number): K[];
  /** Replace the contents (bulk load, faster than repeated `set`). */
  load(entries: Iterable<readonly [K, Box]>): void;
  clear(): void;
}

/** An empty R-tree index (`maxEntries` per node, rbush default 9). */
export function createSpatialIndex<K>(options: { readonly maxEntries?: number } = {}): SpatialIndex<K> {
  const tree = new RBush<Entry<K>>(options.maxEntries ?? 9);
  const entries = new Map<K, Entry<K>>();
  const remove = (key: K): boolean => {
    const entry = entries.get(key);
    if (entry === undefined) return false;
    tree.remove(entry);
    entries.delete(key);
    return true;
  };
  return {
    get size() {
      return entries.size;
    },
    set(key, box) {
      remove(key);
      if (!isValidBox(box)) return;
      const entry: Entry<K> = { minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY, key };
      entries.set(key, entry);
      tree.insert(entry);
    },
    delete: remove,
    get(key) {
      const entry = entries.get(key);
      return entry === undefined ? undefined : { minX: entry.minX, minY: entry.minY, maxX: entry.maxX, maxY: entry.maxY };
    },
    has: (key) => entries.has(key),
    search(box) {
      return tree.search(box).map((entry) => entry.key);
    },
    hit(x, y, tolerance = 0) {
      const t = Math.max(0, tolerance);
      return tree
        .search({ minX: x - t, minY: y - t, maxX: x + t, maxY: y + t })
        .filter((e) => x >= e.minX - t && x < e.maxX + t && y >= e.minY - t && y < e.maxY + t)
        .map((entry) => entry.key);
    },
    load(list) {
      tree.clear();
      entries.clear();
      const batch: Entry<K>[] = [];
      for (const [key, box] of list) {
        if (!isValidBox(box) || entries.has(key)) continue;
        const entry: Entry<K> = { minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY, key };
        entries.set(key, entry);
        batch.push(entry);
      }
      tree.load(batch);
    },
    clear() {
      tree.clear();
      entries.clear();
    },
  };
}

export interface SpatialIndexSystemOptions {
  readonly part: DocumentCRDTv2;
  /** Ink bounds of a node, or undefined when the node is not spatial (not indexed). */
  readonly bounds: (node: NodeRecord) => Box | undefined;
  /** Path prefixes that can change bounds (default: every update re-indexes the node). */
  readonly paths?: readonly string[];
  readonly index?: SpatialIndex<NodeId>;
}

export interface SpatialIndexSystemStats {
  /** Nodes re-indexed by `apply` (created, moved or bounds paths updated). */
  readonly reindexed: number;
  readonly removed: number;
  readonly rebuilds: number;
}

export interface SpatialIndexSystem {
  readonly index: SpatialIndex<NodeId>;
  /** Re-read every node of the part (initial load, resnapshot). */
  rebuild(): void;
  /** Bring the index up to date with one change (local commit or remote import). */
  apply(change: PartChange): void;
  /** Follow the part's own change feed (`part.observe`) instead of calling `apply`. Returns unsubscribe. */
  follow(): () => void;
  readonly stats: SpatialIndexSystemStats;
}

/** The spatial index system over one part (see the module header). */
export function bindSpatialIndex(options: SpatialIndexSystemOptions): SpatialIndexSystem {
  const { part, bounds } = options;
  const index = options.index ?? createSpatialIndex<NodeId>();
  const prefixes = options.paths;
  const stats = { reindexed: 0, removed: 0, rebuilds: 0 };
  const relevant = (paths: readonly string[]): boolean => prefixes === undefined || paths.some((path) => prefixes.some((prefix) => path.startsWith(prefix)));
  const reindex = (node: NodeId): void => {
    const record = part.node(node);
    const box = record === undefined ? undefined : bounds(record);
    stats.reindexed += 1;
    if (box === undefined) index.delete(node);
    else index.set(node, box);
  };
  const apply = (change: PartChange): void => {
    for (const node of change.deleted) if (index.delete(node)) stats.removed += 1;
    const touched = new Set<NodeId>();
    for (const node of change.created) touched.add(node);
    for (const node of change.moved) touched.add(node);
    for (const [node, paths] of change.updated) if (relevant(paths)) touched.add(node);
    for (const node of touched) if (!change.deleted.includes(node)) reindex(node);
  };
  return {
    index,
    rebuild() {
      stats.rebuilds += 1;
      const entries: [NodeId, Box][] = [];
      part.forEachNode((record) => {
        const box = bounds(record);
        if (box !== undefined) entries.push([record.id, box]);
      });
      index.load(entries);
    },
    apply,
    follow: () => part.observe(apply),
    get stats() {
      return { ...stats };
    },
  };
}
