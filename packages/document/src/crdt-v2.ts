/**
 * `DocumentCRDT` v2 (SF-Δ4): the engine-independent port for ONE CRDT document
 * (one part of a tree asset: the document-level part or one page, D14).
 *
 * - A **movable tree** of nodes with stable `NodeId`s (asset-local, survive
 *   forks and "new document from milestone"), cycle-safe moves and fractional
 *   sibling order.
 * - **Properties**: one last-writer-wins register per property path
 *   (`spatial.x`, `name`, `role`, …).
 * - **Rich text** per property path, with marks and stable **anchors** (cursors).
 * - **Movable lists** per property path.
 * - Every commit carries **`meta`** (actor record, label, logical transaction).
 * - Versions: `frontier()` (opaque, engine-encoded), `version()` (state vector),
 *   `changedSince(base, scope)` without materializing the document.
 * - `fork`, full and **shallow** snapshots, and **inverse ops** for undo.
 *
 * Reads are per node; there is deliberately no "whole document to JS" call
 * (S4: `toJSON` on 50k nodes took 3–12.5 s). Walk with `children()` /
 * `forEachNode()` when an O(size) pass is really needed (compaction, milestones).
 *
 * Engines: the Loro adapter (`@staticflux/document/loro-crdt`). Feature code
 * never sees engine types.
 */
import type { Result } from '@staticflux/core';
import type { JsonValue } from './json.js';

/** Asset-local node id (`<peer36>-<n36>` from `createIdGenerator`, or a change-set derived id). */
export type NodeId = string;
/** `component.field[.key]`, or a first-class node field (`name`, `role`). */
export type PropertyPath = string;
/** One CRDT peer (tab editor worker, store worker, each agent session): a decimal uint64 string. */
export type PeerId = `${number}`;
/** Opaque, engine-encoded version (a frontier). Comparable only through the CRDT that produced it. */
export type Frontier = string & { readonly __brand: 'Frontier' };
/** Opaque stable text position: survives concurrent inserts and deletes around it. */
export type TextAnchor = string & { readonly __brand: 'TextAnchor' };

/** Node fields that are not property paths. */
export const RESERVED_NODE_FIELDS = ['id', 'kind'] as const;
/** First-class node fields (IF-4.1): every node may carry a semantic `role` and a `name`. */
export const FIRST_CLASS_FIELDS = ['name', 'role'] as const;

/** Who made a commit (IF-4.12). Carried verbatim; attribution and undo services interpret it (SF-Δ9, Δ10). */
export interface ActorRecord {
  readonly kind: string;
  readonly id: string;
  readonly [field: string]: JsonValue;
}

/** Per-transaction metadata, stored with the commit. */
export interface TransactionMeta {
  readonly actor: ActorRecord;
  /** Readable undo label ("Move 3 elements"). */
  readonly label: string;
  /** Logical transaction id shared by every part a cross-part commit touches. */
  readonly txn?: string;
  readonly via?: string;
  readonly invocation?: string;
  readonly changeSet?: string;
}

/** Where a node goes among its new siblings. Omitted = append at the end. */
export type Position =
  | { readonly after: NodeId | null } // null = first
  | { readonly before: NodeId }
  | { readonly index: number };

/** A text offset (UTF-16 code units) or an anchor taken earlier with `crdt.anchor()`. */
export type TextPos = number | TextAnchor;

export interface MarkSpan {
  readonly start: number;
  readonly end: number;
  readonly marks: Readonly<Record<string, JsonValue>>;
}

/** Rich text as plain data (canonical form: text plus marked spans, UTF-16 offsets). */
export interface RichTextValue {
  readonly text: string;
  readonly spans: readonly MarkSpan[];
}

export type PartOp =
  | {
      readonly op: 'create';
      readonly node: NodeId;
      readonly kind: string;
      readonly parent: NodeId | null;
      readonly position?: Position;
      readonly props?: Readonly<Record<PropertyPath, JsonValue>>;
      readonly texts?: Readonly<Record<PropertyPath, RichTextValue>>;
      readonly lists?: Readonly<Record<PropertyPath, readonly JsonValue[]>>;
    }
  | { readonly op: 'move'; readonly node: NodeId; readonly parent: NodeId | null; readonly position?: Position }
  | { readonly op: 'delete'; readonly node: NodeId }
  /** `value: null` removes the local opinion (the property becomes absent). */
  | { readonly op: 'set'; readonly node: NodeId; readonly path: PropertyPath; readonly value: JsonValue }
  | {
      readonly op: 'text.insert';
      readonly node: NodeId;
      readonly path: PropertyPath;
      readonly at: TextPos;
      readonly text: string;
      /** Omitted: the text takes the marks typing would give it (expand rules). Given: exactly these marks. */
      readonly marks?: Readonly<Record<string, JsonValue>>;
    }
  /** Deletes `[from, to)`. */
  | { readonly op: 'text.delete'; readonly node: NodeId; readonly path: PropertyPath; readonly from: TextPos; readonly to: TextPos }
  /** Marks `[from, to)` with `key = value`; `value: null` removes the mark. */
  | {
      readonly op: 'text.mark';
      readonly node: NodeId;
      readonly path: PropertyPath;
      readonly from: TextPos;
      readonly to: TextPos;
      readonly key: string;
      readonly value: JsonValue;
    }
  | { readonly op: 'list.insert'; readonly node: NodeId; readonly path: PropertyPath; readonly at: number; readonly value: JsonValue }
  | { readonly op: 'list.delete'; readonly node: NodeId; readonly path: PropertyPath; readonly at: number; readonly count: number }
  | { readonly op: 'list.move'; readonly node: NodeId; readonly path: PropertyPath; readonly from: number; readonly to: number }
  | { readonly op: 'list.set'; readonly node: NodeId; readonly path: PropertyPath; readonly at: number; readonly value: JsonValue };

/** One node as plain data (one read across the engine boundary). */
export interface NodeRecord {
  readonly id: NodeId;
  readonly kind: string;
  readonly parent: NodeId | null;
  /** Fractional sibling key (engine-encoded; compare with `<`, never parse). */
  readonly order: string;
  readonly props: Readonly<Record<PropertyPath, JsonValue>>;
  /** Paths holding rich text (read with `text()`). */
  readonly texts: readonly PropertyPath[];
  /** Paths holding movable lists (read with `list()`). */
  readonly lists: readonly PropertyPath[];
}

/** A node with its rich content, for subtree copies (cross-part moves, canonical parts). */
export interface NodeSnapshot extends Omit<NodeRecord, 'texts' | 'lists'> {
  readonly texts: Readonly<Record<PropertyPath, RichTextValue>>;
  readonly lists: Readonly<Record<PropertyPath, readonly JsonValue[]>>;
}

export type CrdtOriginV2 = 'local' | 'remote';

/** What one commit or import changed, by node (emitted to `observe` listeners). */
export interface PartChange {
  readonly origin: CrdtOriginV2;
  readonly created: readonly NodeId[];
  readonly deleted: readonly NodeId[];
  readonly moved: readonly NodeId[];
  /** Property, text and list paths written, per node. */
  readonly updated: ReadonlyMap<NodeId, readonly PropertyPath[]>;
  /** Present for local commits. */
  readonly meta?: TransactionMeta;
}

export interface CommitInfo {
  readonly peer: PeerId;
  readonly meta: TransactionMeta;
  readonly before: Frontier;
  readonly after: Frontier;
  /** The engine update carrying exactly this commit (append it to the log / send it to peers). */
  readonly update: Uint8Array;
  /** Ops that revert this commit (apply them in order, as one commit, to undo). Anchored, so concurrent edits survive. */
  readonly inverse: readonly PartOp[];
  readonly change: PartChange;
}

export interface NodeChange {
  readonly created: boolean;
  readonly deleted: boolean;
  readonly moved: boolean;
  readonly paths: readonly PropertyPath[];
  /** Actor ids (from commit meta) that touched the node. */
  readonly actors: readonly string[];
}

export interface ChangeScope {
  /** Only these nodes. */
  readonly nodes?: readonly NodeId[];
  /** Only nodes currently inside this subtree (the root included). Deleted nodes match if they were in it at deletion. */
  readonly subtree?: NodeId;
  /** Only paths with one of these prefixes (`spatial.` or exact `name`). Structure changes always match. */
  readonly paths?: readonly string[];
}

export interface ChangeSummary {
  readonly from: Frontier;
  readonly to: Frontier;
  readonly commits: readonly { readonly peer: PeerId; readonly meta: TransactionMeta | undefined; readonly ops: number }[];
  readonly nodes: ReadonlyMap<NodeId, NodeChange>;
}

export interface ImportReport {
  /** True when every dependency was present (nothing pending). */
  readonly complete: boolean;
  readonly change: PartChange;
}

export interface DocumentCRDTv2 {
  readonly engine: string;
  readonly peer: PeerId;

  // ------------------------------------------------------------ writes
  /** Validate ops against the current state without applying them. */
  check(ops: readonly PartOp[]): Result<void>;
  /** Apply ops as ONE commit (one gesture, one undo step). All-or-nothing: invalid ops apply nothing. */
  transact(meta: TransactionMeta, ops: readonly PartOp[]): Result<CommitInfo>;
  /** Merge an update or snapshot from another peer. Idempotent and commutative. */
  import(bytes: Uint8Array): Result<ImportReport>;

  // ------------------------------------------------------------ reads (per node; never the whole doc)
  has(node: NodeId): boolean;
  node(node: NodeId): NodeRecord | undefined;
  prop(node: NodeId, path: PropertyPath): JsonValue | undefined;
  /** Ordered child ids; `null` = top-level nodes. */
  children(parent: NodeId | null): readonly NodeId[];
  text(node: NodeId, path: PropertyPath): RichTextValue | undefined;
  list(node: NodeId, path: PropertyPath): readonly JsonValue[] | undefined;
  /** The node and its descendants in pre-order, with rich content. */
  subtree(node: NodeId): readonly NodeSnapshot[] | undefined;
  /** Pre-order walk of every live node (O(size); compaction and canonical encoding only). Return false to stop. */
  forEachNode(visit: (node: NodeRecord) => boolean | void): void;
  /** Number of live nodes. */
  size(): number;

  // ------------------------------------------------------------ text anchors
  /** `before`: sticks to the character at `offset`. `after`: sticks to the character before `offset` (resolves just after it). */
  anchor(node: NodeId, path: PropertyPath, offset: number, bias?: 'before' | 'after'): TextAnchor | undefined;
  /** Current UTF-16 offset of an anchor, or undefined if its text is gone. */
  resolve(anchor: TextAnchor): number | undefined;

  // ------------------------------------------------------------ versions
  frontier(): Frontier;
  /** State vector: give it to a peer so it can `exportUpdates(since)`. */
  version(): Uint8Array;
  /** -1 a < b, 0 equal, 1 a > b, undefined concurrent. */
  compare(a: Frontier, b: Frontier): -1 | 0 | 1 | undefined;
  /** Nodes and paths changed between `base` and now (op-id spans; cost ∝ ops since base, not document size). */
  changedSince(base: Frontier, scope?: ChangeScope): Result<ChangeSummary>;

  // ------------------------------------------------------------ export / fork
  exportUpdates(since?: Uint8Array): Uint8Array;
  exportSnapshot(): Uint8Array;
  /** Snapshot without history before now (costs scale with size, not age). Bases older than it become unavailable. */
  exportShallowSnapshot(): Uint8Array;
  /** An independent copy (own peer) at the current version, or at `at`. */
  fork(peer: PeerId, at?: Frontier): Result<DocumentCRDTv2>;

  observe(listener: (change: PartChange) => void): () => void;
  /** Free engine resources. The CRDT is unusable afterwards. */
  dispose(): void;
  readonly disposed: boolean;
}

/** Creates and loads parts for one engine (for the repo, forks and contract suites). */
export interface CrdtEngine {
  /** Persisted in heads (`engine`), e.g. `loro/1`. */
  readonly id: string;
  create(options: { readonly peer: PeerId }): DocumentCRDTv2;
  /** From a snapshot (full or shallow). */
  load(bytes: Uint8Array, options: { readonly peer: PeerId }): Result<DocumentCRDTv2>;
  /** Dev-mode handle accounting: engine handles currently alive (0 when every part is disposed). */
  liveHandles(): number;
}

/** A random peer id (53 bits, so it round-trips through JSON numbers too). */
export function randomPeerId(): PeerId {
  const words = crypto.getRandomValues(new Uint32Array(2));
  const high = (words[0] as number) & 0x1fffff;
  const value = high * 0x1_0000_0000 + (words[1] as number);
  return `${value === 0 ? 1 : value}` as PeerId;
}

/** Validates a property path for writes (not reserved, not empty, no engine-internal prefix). */
export function isWritablePath(path: string): boolean {
  if (path.length === 0 || path.startsWith('@') || path.startsWith('.') || path.endsWith('.')) return false;
  return !(RESERVED_NODE_FIELDS as readonly string[]).includes(path);
}
