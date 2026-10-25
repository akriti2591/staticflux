/**
 * Loro adapter for `DocumentCRDTv2` (SF-Δ5, D14). THE ONLY FILE THAT IMPORTS `loro-crdt`.
 *
 * Layout of one part (one Loro doc):
 * - root tree `nodes` (movable tree, native fractional index): one tree node per document node;
 *   its data map holds `id`, `kind`, every property path as a last-writer-wins key,
 *   `@text:<path>` mergeable rich texts and `@list:<path>` mergeable movable lists.
 * - root map `ids`: NodeId → TreeID, so lookups never scan the tree (S4: the first
 *   `getNodeByID` scan costs 0.3–1 s on 50k nodes). A tree node whose TreeID is not the one
 *   `ids` names is an orphan (e.g. two peers concurrently re-created the same node) and is hidden.
 *
 * Adapter rules (D14, S4 lessons):
 * - Never materialize a whole doc (`toJSON` on 50k nodes: 3–12.5 s). Reads are per node.
 * - Change detection uses `findIdSpansBetween` + `exportJsonInIdSpan` (11–125 ms), never `doc.diff` (6–9 s).
 * - Free every handle (`Lease` / `finally`). One unfreed handle kept ~28 MB alive and degraded merges
 *   to 48–150 s. Handles are counted; `loroEngine.liveHandles()` must return to 0 after dispose.
 * - One commit per `transact` (= per gesture). Each commit message carries the transaction meta.
 * - Each peer (tab, store worker, agent session) is its own Loro peer.
 */
import { err, ok, type Result, toSfError } from '@staticflux/core';
import {
  Cursor,
  type Delta,
  decodeFrontiers,
  encodeFrontiers,
  isContainer,
  LoroDoc,
  type LoroEventBatch,
  type LoroMap,
  type LoroMovableList,
  type LoroText,
  type LoroTree,
  type LoroTreeNode,
  type OpId,
  type TreeID,
  VersionVector,
} from 'loro-crdt';
import * as LoroModule from 'loro-crdt';
import type {
  ChangeScope,
  ChangeSummary,
  CommitInfo,
  CrdtEngine,
  DocumentCRDTv2,
  Frontier,
  ImportReport,
  MarkSpan,
  NodeChange,
  NodeId,
  NodeRecord,
  NodeSnapshot,
  PartChange,
  PartOp,
  PeerId,
  Position,
  PropertyPath,
  RichTextValue,
  TextAnchor,
  TextPos,
  TransactionMeta,
} from './crdt-v2.js';
import { isWritablePath } from './crdt-v2.js';
import {
  DocumentClosedError,
  InvalidFieldError,
  InvalidUpdateError,
  MoveCycleError,
  NodeExistsError,
  TextRangeError,
  UnknownNodeError,
  VersionUnavailableError,
} from './errors.js';
import { isJsonValue, type JsonValue } from './json.js';

const TREE = 'nodes';
const IDS = 'ids';
const TEXT = '@text:';
const LIST = '@list:';
const ENGINE_ID = 'loro/1';

// ---------------------------------------------------------------- handle accounting

interface Freeable {
  free(): void;
}

let liveHandleCount = 0;

/** Collects handles taken during one operation and frees them all (LIFO) in `release()`. */
class Lease {
  private readonly items: Freeable[] = [];
  use<T extends Freeable | undefined>(handle: T): T {
    if (handle !== undefined && handle !== null) {
      this.items.push(handle);
      liveHandleCount += 1;
    }
    return handle;
  }
  useAll<T extends Freeable>(handles: readonly T[] | undefined): readonly T[] {
    for (const h of handles ?? []) this.use(h);
    return handles ?? [];
  }
  release(): void {
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      (this.items[i] as Freeable).free();
      liveHandleCount -= 1;
    }
    this.items.length = 0;
  }
}

function leased<R>(fn: (lease: Lease) => R): R {
  const lease = new Lease();
  try {
    return fn(lease);
  } finally {
    lease.release();
  }
}

/** Free any container handles that arrive inside event payloads. */
function freeIfContainer(value: unknown): void {
  if (value !== null && typeof value === 'object' && isContainer(value)) (value as Freeable).free();
}

// ---------------------------------------------------------------- encodings

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}

const encodeFrontier = (frontiers: readonly OpId[]): Frontier => toBase64(encodeFrontiers([...frontiers])) as Frontier;

function decodeFrontier(frontier: Frontier): OpId[] | undefined {
  try {
    return decodeFrontiers(fromBase64(frontier));
  } catch {
    return undefined;
  }
}

interface StoredMessage {
  readonly m: TransactionMeta;
  /** Local commit sequence: keeps Loro from merging two commits that carry identical meta. */
  readonly s: number;
}

function parseMessage(message: string | null | undefined): TransactionMeta | undefined {
  if (typeof message !== 'string') return undefined;
  try {
    const parsed = JSON.parse(message) as Partial<StoredMessage>;
    return typeof parsed.m === 'object' && parsed.m !== null ? parsed.m : undefined;
  } catch {
    return undefined;
  }
}

// Anchors: `s` = start of text; `b.<cursor>` sticks to the char at offset; `a.<cursor>` sticks to the char before.
function encodeAnchor(bias: 'a' | 'b', cursor: Cursor): TextAnchor {
  return `${bias}.${toBase64(cursor.encode())}` as TextAnchor;
}
const START_ANCHOR = 's' as TextAnchor;

const isTreeId = (value: unknown): value is TreeID => typeof value === 'string' && /^\d+@\d+$/.test(value);

// ---------------------------------------------------------------- options

export type MarkExpand = 'before' | 'after' | 'none' | 'both';

export interface LoroEngineOptions {
  /**
   * How each mark key grows when text is typed at its edge. Every peer must use the same table.
   * Keys not listed expand `after` (like bold).
   */
  readonly marks?: Readonly<Record<string, MarkExpand>>;
}

const DEFAULT_MARKS: Readonly<Record<string, MarkExpand>> = {
  bold: 'after',
  italic: 'after',
  underline: 'after',
  strike: 'after',
  link: 'none',
  comment: 'none',
};

// ---------------------------------------------------------------- the adapter

interface ApplyState {
  readonly inverse: PartOp[][];
}

class LoroPart implements DocumentCRDTv2 {
  readonly engine = ENGINE_ID;
  readonly peer: PeerId;
  private readonly doc: LoroDoc;
  private readonly tree: LoroTree;
  private readonly ids: LoroMap;
  private readonly unsubscribe: () => void;
  private readonly observers = new Set<(change: PartChange) => void>();
  private readonly treeOf = new Map<NodeId, TreeID>();
  private readonly nodeOf = new Map<TreeID, NodeId>();
  private readonly pathOfContainer = new Map<string, { tree: TreeID; key: string } | null>();
  private pendingChange: PartChange | undefined;
  private commitSeq = 0;
  private isDisposed = false;
  /** Enabled on first write: querying or enabling it materializes the lazily imported tree (~8 ms per 1k-node part). */
  private fractionalIndex = false;

  constructor(
    doc: LoroDoc,
    peer: PeerId,
    private readonly options: LoroEngineOptions,
  ) {
    this.peer = peer;
    this.doc = doc;
    liveHandleCount += 1; // the doc itself
    doc.setPeerId(peer);
    doc.configTextStyle(Object.fromEntries(Object.entries({ ...DEFAULT_MARKS, ...options.marks }).map(([k, expand]) => [k, { expand }])));
    doc.configDefaultTextStyle({ expand: 'after' });
    this.tree = doc.getTree(TREE);
    liveHandleCount += 1;
    this.ids = doc.getMap(IDS);
    liveHandleCount += 1;
    this.unsubscribe = doc.subscribe((batch) => this.onEvents(batch));
  }

  get disposed(): boolean {
    return this.isDisposed;
  }

  // ------------------------------------------------------------ id index

  private treeIdOf(node: NodeId): TreeID | undefined {
    const cached = this.treeOf.get(node);
    if (cached !== undefined) return cached;
    const value = this.ids.get(node);
    if (!isTreeId(value)) return undefined;
    this.treeOf.set(node, value);
    this.nodeOf.set(value, node);
    return value;
  }

  private nodeIdOf(tree: TreeID): NodeId | undefined {
    const cached = this.nodeOf.get(tree);
    if (cached !== undefined) return cached;
    const id = leased((lease) => {
      const map = lease.use(this.doc.getMap(`cid:${tree}:Map`));
      return map.get('id');
    });
    if (typeof id !== 'string') return undefined;
    this.nodeOf.set(tree, id);
    return id;
  }

  /** Live, non-orphan tree id for a node. */
  private live(node: NodeId): TreeID | undefined {
    const tid = this.treeIdOf(node);
    if (tid === undefined || !this.tree.has(tid) || this.tree.isNodeDeleted(tid)) return undefined;
    return tid;
  }

  private isCanonical(tid: TreeID): boolean {
    const node = this.nodeIdOf(tid);
    return node !== undefined && this.treeIdOf(node) === tid;
  }

  // ------------------------------------------------------------ reads

  private assertOpen(): Result<void> {
    return this.isDisposed ? err(DocumentClosedError({ message: 'The CRDT part was disposed.' })) : ok();
  }

  has(node: NodeId): boolean {
    return !this.isDisposed && this.live(node) !== undefined;
  }

  private readData(tid: TreeID): Record<string, unknown> {
    return leased((lease) => lease.use(this.doc.getMap(`cid:${tid}:Map`)).toJSON() as Record<string, unknown>);
  }

  private parentOf(tid: TreeID): NodeId | null {
    return leased((lease) => {
      const node = lease.use(this.tree.getNodeByID(tid));
      const parent = lease.use(node?.parent());
      return parent === undefined ? null : (this.nodeIdOf(parent.id) ?? null);
    });
  }

  private record(tid: TreeID, parent: NodeId | null, order: string, data: Record<string, unknown>): NodeRecord | undefined {
    const id = data['id'];
    if (typeof id !== 'string') return undefined;
    const props: Record<string, JsonValue> = {};
    const texts: string[] = [];
    const lists: string[] = [];
    for (const [key, value] of Object.entries(data)) {
      if (key === 'id' || key === 'kind') continue;
      if (key.startsWith(TEXT)) texts.push(key.slice(TEXT.length));
      else if (key.startsWith(LIST)) lists.push(key.slice(LIST.length));
      else props[key] = value as JsonValue;
    }
    return { id, kind: String(data['kind'] ?? ''), parent, order, props, texts: texts.sort(), lists: lists.sort() };
  }

  node(node: NodeId): NodeRecord | undefined {
    if (this.isDisposed) return undefined;
    const tid = this.live(node);
    if (tid === undefined) return undefined;
    const order = leased((lease) => lease.use(this.tree.getNodeByID(tid))?.fractionalIndex() ?? '');
    return this.record(tid, this.parentOf(tid), order, this.readData(tid));
  }

  prop(node: NodeId, path: PropertyPath): JsonValue | undefined {
    const tid = this.isDisposed ? undefined : this.live(node);
    if (tid === undefined) return undefined;
    return leased((lease) => {
      const value = lease.use(this.doc.getMap(`cid:${tid}:Map`)).get(path) as unknown;
      if (isContainer(value)) {
        lease.use(value as Freeable);
        return undefined;
      }
      return value as JsonValue | undefined;
    });
  }

  private childTreeIds(parent: NodeId | null): readonly TreeID[] | undefined {
    return leased((lease) => {
      if (parent === null) {
        return lease
          .useAll(this.tree.roots())
          .map((n) => n.id)
          .filter((t) => this.isCanonical(t));
      }
      const tid = this.live(parent);
      if (tid === undefined) return undefined;
      const node = lease.use(this.tree.getNodeByID(tid));
      return lease
        .useAll(node?.children() ?? [])
        .map((n) => n.id)
        .filter((t) => this.isCanonical(t));
    });
  }

  children(parent: NodeId | null): readonly NodeId[] {
    if (this.isDisposed) return [];
    return (this.childTreeIds(parent) ?? []).map((t) => this.nodeIdOf(t) as NodeId);
  }

  private withText<R>(tid: TreeID, path: PropertyPath, fn: (text: LoroText | undefined, lease: Lease) => R): R {
    return leased((lease) => {
      const data = lease.use(this.doc.getMap(`cid:${tid}:Map`));
      const value = data.get(TEXT + path) as unknown;
      const text = isContainer(value) ? lease.use(value as unknown as LoroText) : undefined;
      return fn(text, lease);
    });
  }

  private withList<R>(tid: TreeID, path: PropertyPath, fn: (list: LoroMovableList | undefined, lease: Lease) => R): R {
    return leased((lease) => {
      const data = lease.use(this.doc.getMap(`cid:${tid}:Map`));
      const value = data.get(LIST + path) as unknown;
      const list = isContainer(value) ? lease.use(value as unknown as LoroMovableList) : undefined;
      return fn(list, lease);
    });
  }

  text(node: NodeId, path: PropertyPath): RichTextValue | undefined {
    const tid = this.isDisposed ? undefined : this.live(node);
    if (tid === undefined) return undefined;
    return this.withText(tid, path, (text) => (text === undefined ? undefined : deltaToRichText(text.toDelta())));
  }

  list(node: NodeId, path: PropertyPath): readonly JsonValue[] | undefined {
    const tid = this.isDisposed ? undefined : this.live(node);
    if (tid === undefined) return undefined;
    return this.withList(tid, path, (list) => (list === undefined ? undefined : (list.toJSON() as JsonValue[])));
  }

  private snapshotOf(record: NodeRecord, tid: TreeID): NodeSnapshot {
    const texts: Record<string, RichTextValue> = {};
    const lists: Record<string, readonly JsonValue[]> = {};
    for (const path of record.texts) {
      const value = this.withText(tid, path, (t) => (t === undefined ? undefined : deltaToRichText(t.toDelta())));
      if (value !== undefined) texts[path] = value;
    }
    for (const path of record.lists) {
      const value = this.withList(tid, path, (l) => (l === undefined ? undefined : (l.toJSON() as JsonValue[])));
      if (value !== undefined) lists[path] = value;
    }
    const { texts: _t, lists: _l, ...rest } = record;
    return { ...rest, texts, lists };
  }

  subtree(node: NodeId): readonly NodeSnapshot[] | undefined {
    if (this.isDisposed) return undefined;
    const rootRecord = this.node(node);
    if (rootRecord === undefined) return undefined;
    const out: NodeSnapshot[] = [];
    const visit = (record: NodeRecord): void => {
      const tid = this.treeIdOf(record.id) as TreeID;
      out.push(this.snapshotOf(record, tid));
      for (const child of this.childTreeIds(record.id) ?? []) {
        const order = leased((lease) => lease.use(this.tree.getNodeByID(child))?.fractionalIndex() ?? '');
        const childRecord = this.record(child, record.id, order, this.readData(child));
        if (childRecord !== undefined) visit(childRecord);
      }
    };
    visit(rootRecord);
    return out;
  }

  forEachNode(visit: (node: NodeRecord) => boolean | void): void {
    if (this.isDisposed) return;
    // One boundary crossing for the shape (ids and container ids only), then one per node.
    const shape = this.tree.getShallowValue();
    const walk = (list: readonly { id: TreeID; fractional_index?: string; fractionalIndex?: string; children: unknown[] }[], parent: NodeId | null): boolean => {
      for (const entry of list) {
        if (!this.isCanonical(entry.id)) continue;
        const record = this.record(entry.id, parent, entry.fractional_index ?? entry.fractionalIndex ?? '', this.readData(entry.id));
        if (record === undefined) continue;
        if (visit(record) === false) return false;
        if (!walk(entry.children as never, record.id)) return false;
      }
      return true;
    };
    walk(shape as never, null);
  }

  size(): number {
    let n = 0;
    this.forEachNodeShape(() => {
      n += 1;
    });
    return n;
  }

  private forEachNodeShape(visit: (tid: TreeID) => void): void {
    if (this.isDisposed) return;
    const walk = (list: readonly { id: TreeID; children: unknown[] }[]): void => {
      for (const entry of list) {
        if (!this.isCanonical(entry.id)) continue;
        visit(entry.id);
        walk(entry.children as never);
      }
    };
    walk(this.tree.getShallowValue() as never);
  }

  // ------------------------------------------------------------ anchors

  anchor(node: NodeId, path: PropertyPath, offset: number, bias: 'before' | 'after' = 'before'): TextAnchor | undefined {
    const tid = this.isDisposed ? undefined : this.live(node);
    if (tid === undefined) return undefined;
    return this.withText(tid, path, (text, lease) => {
      if (text === undefined) return undefined;
      const length = text.length;
      if (!Number.isInteger(offset) || offset < 0 || offset > length) return undefined;
      if (bias === 'after') {
        if (offset === 0) return START_ANCHOR;
        const cursor = lease.use(text.getCursor(offset - 1, 0));
        return cursor === undefined ? undefined : encodeAnchor('a', cursor);
      }
      if (length === 0) return START_ANCHOR;
      const cursor = lease.use(text.getCursor(offset, 0));
      return cursor === undefined ? undefined : encodeAnchor('b', cursor);
    });
  }

  resolve(anchor: TextAnchor): number | undefined {
    if (this.isDisposed) return undefined;
    if (anchor === START_ANCHOR) return 0;
    const bias = anchor.slice(0, 2);
    if (bias !== 'a.' && bias !== 'b.') return undefined;
    return leased((lease) => {
      try {
        const cursor = lease.use(Cursor.decode(fromBase64(anchor.slice(2))));
        const pos = this.doc.getCursorPos(cursor);
        if (pos === undefined) return undefined;
        if (pos.update !== undefined) lease.use(pos.update);
        return bias === 'a.' ? pos.offset + 1 : pos.offset;
      } catch {
        return undefined;
      }
    });
  }

  // ------------------------------------------------------------ validation

  check(ops: readonly PartOp[]): Result<void> {
    const open = this.assertOpen();
    if (!open.ok) return open;
    return new Simulation(this).run(ops);
  }

  /** @internal Simulation reads. */
  textLength(node: NodeId, path: PropertyPath): number {
    const tid = this.live(node);
    if (tid === undefined) return 0;
    return this.withText(tid, path, (t) => t?.length ?? 0);
  }

  /** @internal */
  listLength(node: NodeId, path: PropertyPath): number {
    const tid = this.live(node);
    if (tid === undefined) return 0;
    return this.withList(tid, path, (l) => l?.length ?? 0);
  }

  /** @internal */
  parentNode(node: NodeId): NodeId | null | undefined {
    const tid = this.live(node);
    return tid === undefined ? undefined : this.parentOf(tid);
  }

  // ------------------------------------------------------------ writes

  transact(meta: TransactionMeta, ops: readonly PartOp[]): Result<CommitInfo> {
    const checked = this.check(ops);
    if (!checked.ok) return checked;
    if (!this.fractionalIndex) {
      this.tree.enableFractionalIndex(0);
      this.fractionalIndex = true;
    }
    const before = this.doc.oplogFrontiers();
    const vvBefore = this.doc.oplogVersion();
    liveHandleCount += 1;
    const state: ApplyState = { inverse: [] };
    try {
      for (const op of ops) state.inverse.push(this.apply(op));
    } catch (error) {
      // Unexpected engine failure after validation: revert what was applied, keep the doc consistent.
      for (let i = state.inverse.length - 1; i >= 0; i -= 1) for (const inv of state.inverse[i] as PartOp[]) this.tryApply(inv);
      this.commitWith({ ...meta, label: `${meta.label} (rolled back)` });
      vvBefore.free();
      liveHandleCount -= 1;
      return err(toSfError(error));
    }
    this.pendingChange = undefined;
    this.commitWith(meta);
    const change = this.pendingChange ?? emptyChange('local');
    this.pendingChange = undefined;
    let update: Uint8Array;
    try {
      update = this.doc.export({ mode: 'update', from: vvBefore });
    } finally {
      vvBefore.free();
      liveHandleCount -= 1;
    }
    const inverse: PartOp[] = [];
    for (let i = state.inverse.length - 1; i >= 0; i -= 1) inverse.push(...(state.inverse[i] as PartOp[]));
    const info: CommitInfo = {
      peer: this.peer,
      meta,
      before: encodeFrontier(before),
      after: encodeFrontier(this.doc.oplogFrontiers()),
      update,
      inverse,
      change: { ...change, meta },
    };
    this.notify({ ...change, meta });
    return ok(info);
  }

  private commitWith(meta: TransactionMeta): void {
    this.commitSeq += 1;
    const message: StoredMessage = { m: meta, s: this.commitSeq };
    this.doc.commit({ message: JSON.stringify(message), origin: meta.actor.id });
  }

  private tryApply(op: PartOp): void {
    try {
      this.apply(op);
    } catch {
      // best effort during rollback
    }
  }

  private positionIndex(parent: NodeId | null, position: Position | undefined, exclude?: NodeId): number | undefined {
    if (position === undefined) return undefined;
    const siblings = this.children(parent).filter((s) => s !== exclude);
    if ('index' in position) return Math.max(0, Math.min(position.index, siblings.length));
    if ('before' in position) return Math.max(0, siblings.indexOf(position.before));
    if (position.after === null) return 0;
    return siblings.indexOf(position.after) + 1;
  }

  private siblingBefore(tid: TreeID): NodeId | null {
    return leased((lease) => {
      const node = lease.use(this.tree.getNodeByID(tid));
      const parent = lease.use(node?.parent());
      const siblings = parent === undefined ? lease.useAll(this.tree.roots()) : lease.useAll(parent.children() ?? []);
      const ids = siblings.map((s) => s.id).filter((s) => this.isCanonical(s));
      const index = ids.indexOf(tid);
      return index <= 0 ? null : (this.nodeIdOf(ids[index - 1] as TreeID) ?? null);
    });
  }

  private resolvePos(pos: TextPos): number {
    return typeof pos === 'number' ? pos : (this.resolve(pos) as number);
  }

  /** Apply one validated op; returns its inverse ops (in apply order). */
  private apply(op: PartOp): PartOp[] {
    switch (op.op) {
      case 'create':
        return this.applyCreate(op);
      case 'delete': {
        const tid = this.live(op.node) as TreeID;
        const snapshot = this.subtree(op.node) ?? [];
        const parent = this.parentOf(tid);
        const after = this.siblingBefore(tid);
        this.tree.delete(tid);
        return snapshotToCreates(snapshot, parent, { after });
      }
      case 'move': {
        const tid = this.live(op.node) as TreeID;
        const oldParent = this.parentOf(tid);
        const oldAfter = this.siblingBefore(tid);
        const parentTid = op.parent === null ? undefined : (this.live(op.parent) as TreeID);
        const position = op.position;
        if (position !== undefined && !('index' in position) && !('after' in position && position.after === null)) {
          const target = 'after' in position ? (position.after as NodeId) : position.before;
          leased((lease) => {
            const self = lease.use(this.tree.getNodeByID(tid)) as LoroTreeNode;
            const other = lease.use(this.tree.getNodeByID(this.live(target) as TreeID)) as LoroTreeNode;
            if ('after' in position) self.moveAfter(other);
            else self.moveBefore(other);
          });
        } else {
          // No index = append (Loro picks the key after the last sibling; no sibling scan needed).
          const index = this.positionIndex(op.parent, position, op.node);
          if (index === undefined) this.tree.move(tid, parentTid);
          else this.tree.move(tid, parentTid, index);
        }
        return [{ op: 'move', node: op.node, parent: oldParent, position: { after: oldAfter } }];
      }
      case 'set': {
        const tid = this.live(op.node) as TreeID;
        return leased((lease) => {
          const data = lease.use(this.doc.getMap(`cid:${tid}:Map`));
          const previous = data.get(op.path) as unknown;
          if (isContainer(previous)) lease.use(previous as Freeable);
          if (op.value === null) data.delete(op.path);
          else data.set(op.path, op.value as never);
          const prior = previous === undefined || isContainer(previous) ? null : (previous as JsonValue);
          return [{ op: 'set', node: op.node, path: op.path, value: prior }];
        });
      }
      case 'text.insert': {
        const tid = this.live(op.node) as TreeID;
        const at = this.resolvePos(op.at);
        leased((lease) => {
          const data = lease.use(this.doc.getMap(`cid:${tid}:Map`));
          const text = lease.use(data.ensureMergeableText(TEXT + op.path));
          text.insert(at, op.text);
          if (op.marks !== undefined && op.text.length > 0) {
            // Explicit marks are exact: drop marks inherited from the neighbour (expand rules), then apply.
            const range = { start: at, end: at + op.text.length };
            const inherited = new Set<string>();
            for (const item of text.sliceDelta(range.start, range.end)) for (const key of Object.keys(item.attributes ?? {})) inherited.add(key);
            for (const key of inherited) if (!(key in op.marks)) text.unmark(range, key);
            for (const [key, value] of Object.entries(op.marks)) text.mark(range, key, value);
          }
        });
        if (op.text.length === 0) return [];
        const from = this.anchor(op.node, op.path, at, 'before') as TextAnchor;
        const to = this.anchor(op.node, op.path, at + op.text.length, 'after') as TextAnchor;
        return [{ op: 'text.delete', node: op.node, path: op.path, from, to }];
      }
      case 'text.delete': {
        const tid = this.live(op.node) as TreeID;
        const from = this.resolvePos(op.from);
        const to = this.resolvePos(op.to);
        if (to <= from) return [];
        const removed = this.withText(tid, op.path, (text) => {
          const delta = deltaToRichText((text as LoroText).sliceDelta(from, to));
          (text as LoroText).delete(from, to - from);
          return delta;
        });
        return this.reinsert(op.node, op.path, from, removed);
      }
      case 'text.mark': {
        const tid = this.live(op.node) as TreeID;
        const from = this.resolvePos(op.from);
        const to = this.resolvePos(op.to);
        if (to <= from) return [];
        const previous = leased((lease) => {
          const data = lease.use(this.doc.getMap(`cid:${tid}:Map`));
          const text = lease.use(data.ensureMergeableText(TEXT + op.path));
          const slice = deltaToSegments(text.sliceDelta(from, to));
          if (op.value === null) text.unmark({ start: from, end: to }, op.key);
          else text.mark({ start: from, end: to }, op.key, op.value);
          return slice;
        });
        const inverse: PartOp[] = [];
        for (const segment of previous) {
          const a = this.anchor(op.node, op.path, from + segment.start, 'before') as TextAnchor;
          const b = this.anchor(op.node, op.path, from + segment.end, 'after') as TextAnchor;
          inverse.push({ op: 'text.mark', node: op.node, path: op.path, from: a, to: b, key: op.key, value: segment.marks[op.key] ?? null });
        }
        return inverse;
      }
      case 'list.insert':
      case 'list.delete':
      case 'list.move':
      case 'list.set':
        return this.applyList(op);
    }
  }

  private reinsert(node: NodeId, path: PropertyPath, at: number, removed: RichTextValue): PartOp[] {
    if (removed.text.length === 0) return [];
    // Anchor to the character before the gap and insert segments last-to-first, so each lands right after it.
    const anchor: TextPos = at === 0 ? 0 : ((this.anchor(node, path, at, 'after') as TextAnchor | undefined) ?? at);
    const segments = segmentsOf(removed);
    const ops: PartOp[] = [];
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      const segment = segments[i] as { text: string; marks: Readonly<Record<string, JsonValue>> };
      ops.push({ op: 'text.insert', node, path, at: anchor, text: segment.text, marks: segment.marks });
    }
    return ops;
  }

  private applyCreate(op: Extract<PartOp, { op: 'create' }>): PartOp[] {
    const parentTid = op.parent === null ? undefined : (this.live(op.parent) as TreeID);
    const index = this.positionIndex(op.parent, op.position);
    leased((lease) => {
      const node = lease.use(this.tree.createNode(parentTid, index ?? undefined));
      const data = lease.use(this.doc.getMap(`cid:${node.id}:Map`));
      data.set('id', op.node);
      data.set('kind', op.kind);
      for (const [path, value] of Object.entries(op.props ?? {})) if (value !== null) data.set(path, value as never);
      for (const [path, value] of Object.entries(op.texts ?? {})) {
        const text = lease.use(data.ensureMergeableText(TEXT + path));
        text.insert(0, value.text);
        for (const span of value.spans) {
          for (const [key, mark] of Object.entries(span.marks)) text.mark({ start: span.start, end: span.end }, key, mark);
        }
      }
      for (const [path, values] of Object.entries(op.lists ?? {})) {
        const list = lease.use(data.ensureMergeableMovableList(LIST + path));
        for (const value of values) list.push(value as never);
      }
      this.ids.set(op.node, node.id);
      this.treeOf.set(op.node, node.id);
      this.nodeOf.set(node.id, op.node);
    });
    return [{ op: 'delete', node: op.node }];
  }

  private applyList(op: Extract<PartOp, { op: 'list.insert' | 'list.delete' | 'list.move' | 'list.set' }>): PartOp[] {
    const tid = this.live(op.node) as TreeID;
    return leased((lease) => {
      const data = lease.use(this.doc.getMap(`cid:${tid}:Map`));
      const list = lease.use(data.ensureMergeableMovableList(LIST + op.path));
      switch (op.op) {
        case 'list.insert':
          list.insert(op.at, op.value as never);
          return [{ op: 'list.delete', node: op.node, path: op.path, at: op.at, count: 1 }];
        case 'list.delete': {
          const removed = (list.toJSON() as JsonValue[]).slice(op.at, op.at + op.count);
          list.delete(op.at, op.count);
          return removed.map((value, i): PartOp => ({ op: 'list.insert', node: op.node, path: op.path, at: op.at + i, value }));
        }
        case 'list.move':
          list.move(op.from, op.to);
          return [{ op: 'list.move', node: op.node, path: op.path, from: op.to, to: op.from }];
        case 'list.set': {
          const previous = list.get(op.at) as unknown;
          list.set(op.at, op.value as never);
          return [{ op: 'list.set', node: op.node, path: op.path, at: op.at, value: (previous ?? null) as JsonValue }];
        }
      }
    });
  }

  import(bytes: Uint8Array): Result<ImportReport> {
    const open = this.assertOpen();
    if (!open.ok) return open;
    this.pendingChange = undefined;
    try {
      const status = this.doc.import(bytes);
      const change = this.pendingChange ?? emptyChange('remote');
      this.pendingChange = undefined;
      this.notify(change);
      return ok({ complete: status.pending === null || status.pending === undefined || status.pending.size === 0, change });
    } catch (error) {
      this.pendingChange = undefined;
      return err(InvalidUpdateError({ cause: toSfError(error) }));
    }
  }

  // ------------------------------------------------------------ events

  private containerPath(cid: string): { tree: TreeID; key: string } | null {
    if (this.pathOfContainer.has(cid)) return this.pathOfContainer.get(cid) ?? null;
    let found: { tree: TreeID; key: string } | null = null;
    try {
      const path = this.doc.getPathToContainer(cid as never);
      if (path !== undefined && path[0] === TREE && isTreeId(path[1]) && typeof path[2] === 'string') found = { tree: path[1], key: path[2] };
    } catch {
      found = null;
    }
    this.pathOfContainer.set(cid, found);
    return found;
  }

  private onEvents(batch: LoroEventBatch): void {
    if (batch.by === 'checkout') return;
    const created = new Set<NodeId>();
    const deleted = new Set<NodeId>();
    const moved = new Set<NodeId>();
    const updated = new Map<NodeId, Set<string>>();
    const touch = (node: NodeId | undefined, path: string): void => {
      if (node === undefined) return;
      let set = updated.get(node);
      if (set === undefined) updated.set(node, (set = new Set()));
      set.add(path);
    };
    // Pass 1: the id index (so tree events can name new nodes).
    for (const event of batch.events) {
      if (event.diff.type !== 'map' || event.path.length !== 1 || event.path[0] !== IDS) continue;
      for (const [node, value] of Object.entries(event.diff.updated)) {
        freeIfContainer(value);
        if (isTreeId(value)) {
          this.treeOf.set(node, value);
          this.nodeOf.set(value, node);
        }
      }
    }
    for (const event of batch.events) {
      const diff = event.diff;
      if (diff.type === 'tree') {
        for (const item of diff.diff) {
          const node = this.nodeIdOf(item.target);
          if (node === undefined) continue;
          if (item.action === 'create') created.add(node);
          else if (item.action === 'delete') deleted.add(node);
          else moved.add(node);
        }
      } else if (diff.type === 'map') {
        if (event.path.length === 1 && event.path[0] === IDS) continue;
        const tid = event.path[1];
        for (const [key, value] of Object.entries(diff.updated)) {
          freeIfContainer(value);
          if (!isTreeId(tid) || key === 'id' || key === 'kind') continue;
          touch(this.nodeIdOf(tid), key.startsWith(TEXT) ? key.slice(TEXT.length) : key.startsWith(LIST) ? key.slice(LIST.length) : key);
        }
      } else if (diff.type === 'text' || diff.type === 'list') {
        if (diff.type === 'list') for (const d of diff.diff) for (const v of (d as { insert?: unknown[] }).insert ?? []) freeIfContainer(v);
        const tid = event.path[1];
        const key = event.path[2];
        if (!isTreeId(tid) || typeof key !== 'string') continue;
        touch(this.nodeIdOf(tid), key.startsWith(TEXT) ? key.slice(TEXT.length) : key.slice(LIST.length));
      }
    }
    const origin = batch.by === 'local' ? 'local' : 'remote';
    this.pendingChange = {
      origin,
      created: [...created],
      deleted: [...deleted],
      moved: [...moved].filter((n) => !created.has(n)),
      updated: new Map([...updated].map(([k, v]) => [k, [...v].sort()])),
    };
  }

  private notify(change: PartChange): void {
    for (const listener of [...this.observers]) listener(change);
  }

  observe(listener: (change: PartChange) => void): () => void {
    this.observers.add(listener);
    return () => {
      this.observers.delete(listener);
    };
  }

  // ------------------------------------------------------------ versions

  frontier(): Frontier {
    return encodeFrontier(this.doc.oplogFrontiers());
  }

  version(): Uint8Array {
    return leased((lease) => lease.use(this.doc.oplogVersion()).encode());
  }

  compare(a: Frontier, b: Frontier): -1 | 0 | 1 | undefined {
    const fa = decodeFrontier(a);
    const fb = decodeFrontier(b);
    if (fa === undefined || fb === undefined) return undefined;
    try {
      return this.doc.cmpFrontiers(fa, fb);
    } catch {
      return undefined;
    }
  }

  changedSince(base: Frontier, scope: ChangeScope = {}): Result<ChangeSummary> {
    const open = this.assertOpen();
    if (!open.ok) return open;
    const from = decodeFrontier(base);
    if (from === undefined) return err(VersionUnavailableError({ message: 'Malformed frontier.' }));
    if (this.doc.isShallow()) {
      const root = this.doc.shallowSinceFrontiers();
      const cmp = this.compareRaw(from, root);
      if (cmp === undefined || cmp < 0) return err(VersionUnavailableError({ details: { reason: 'trimmed' } }));
    }
    const now = this.doc.oplogFrontiers();
    let spans: ReturnType<LoroDoc['findIdSpansBetween']>;
    try {
      spans = this.doc.findIdSpansBetween(from, now);
    } catch (error) {
      return err(VersionUnavailableError({ cause: toSfError(error), details: { reason: 'unknown' } }));
    }
    if (spans.retreat.length > 0) return err(VersionUnavailableError({ details: { reason: 'ahead-or-concurrent' } }));
    const nodes = new Map<NodeId, { created: boolean; deleted: boolean; moved: boolean; paths: Set<string>; actors: Set<string> }>();
    const entry = (node: NodeId) => {
      let e = nodes.get(node);
      if (e === undefined) nodes.set(node, (e = { created: false, deleted: false, moved: false, paths: new Set(), actors: new Set() }));
      return e;
    };
    const commits: { peer: PeerId; meta: TransactionMeta | undefined; ops: number }[] = [];
    for (const span of spans.forward) {
      for (const change of this.doc.exportJsonInIdSpan(span)) {
        const meta = parseMessage(change.msg);
        const actor = meta?.actor.id;
        commits.push({ peer: change.id.split('@')[1] as PeerId, meta, ops: change.ops.length });
        for (const op of change.ops) {
          const content = op.content as { type: string; key?: string; target?: TreeID };
          const cid = op.container as string;
          let node: NodeId | undefined;
          let path: string | undefined;
          if (cid.endsWith(':Tree')) {
            if (content.target === undefined) continue;
            node = this.nodeIdOf(content.target);
            if (node === undefined) continue;
            const e = entry(node);
            if (content.type === 'create') e.created = true;
            else if (content.type === 'delete') e.deleted = true;
            else e.moved = true;
            if (actor !== undefined) e.actors.add(actor);
            continue;
          }
          const mapMatch = /^cid:(\d+@\d+):Map$/.exec(cid);
          if (mapMatch !== null) {
            node = this.nodeIdOf(mapMatch[1] as TreeID);
            path = content.key;
          } else {
            const where = this.containerPath(cid);
            if (where === null) continue;
            node = this.nodeIdOf(where.tree);
            path = where.key;
          }
          if (node === undefined || path === undefined || path === 'id' || path === 'kind') continue;
          const e = entry(node);
          e.paths.add(path.startsWith(TEXT) ? path.slice(TEXT.length) : path.startsWith(LIST) ? path.slice(LIST.length) : path);
          if (actor !== undefined) e.actors.add(actor);
        }
      }
    }
    const result = new Map<NodeId, NodeChange>();
    const subtreeRoot = scope.subtree;
    for (const [node, e] of nodes) {
      if (e.created && e.moved) e.moved = false;
      if (scope.nodes !== undefined && !scope.nodes.includes(node)) continue;
      if (subtreeRoot !== undefined && !e.deleted && !this.isWithin(node, subtreeRoot)) continue;
      let paths = [...e.paths].sort();
      if (scope.paths !== undefined) {
        const prefixes = scope.paths;
        paths = paths.filter((p) => prefixes.some((prefix) => p === prefix || p.startsWith(prefix)));
        if (paths.length === 0 && !e.created && !e.deleted && !e.moved) continue;
      }
      result.set(node, { created: e.created, deleted: e.deleted, moved: e.moved, paths, actors: [...e.actors].sort() });
    }
    return ok({ from: base, to: encodeFrontier(now), commits, nodes: result });
  }

  private compareRaw(a: OpId[], b: OpId[]): number | undefined {
    try {
      return this.doc.cmpFrontiers(a, b);
    } catch {
      return undefined;
    }
  }

  private isWithin(node: NodeId, root: NodeId): boolean {
    let current: NodeId | null | undefined = node;
    for (let guard = 0; guard < 10_000 && current !== null && current !== undefined; guard += 1) {
      if (current === root) return true;
      current = this.parentNode(current);
    }
    return false;
  }

  // ------------------------------------------------------------ export / fork

  exportUpdates(since?: Uint8Array): Uint8Array {
    if (since === undefined) return this.doc.export({ mode: 'update' });
    return leased((lease) => {
      const vv = lease.use(VersionVector.decode(since));
      return this.doc.export({ mode: 'update', from: vv });
    });
  }

  exportSnapshot(): Uint8Array {
    return this.doc.export({ mode: 'snapshot' });
  }

  exportShallowSnapshot(): Uint8Array {
    return this.doc.export({ mode: 'shallow-snapshot', frontiers: this.doc.oplogFrontiers() });
  }

  fork(peer: PeerId, at?: Frontier): Result<DocumentCRDTv2> {
    const open = this.assertOpen();
    if (!open.ok) return open;
    try {
      if (at === undefined) return ok(new LoroPart(this.doc.fork(), peer, this.options));
      const frontiers = decodeFrontier(at);
      if (frontiers === undefined) return err(VersionUnavailableError({ message: 'Malformed frontier.' }));
      return ok(new LoroPart(this.doc.forkAt(frontiers), peer, this.options));
    } catch (error) {
      return err(VersionUnavailableError({ cause: toSfError(error) }));
    }
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.unsubscribe();
    this.observers.clear();
    this.ids.free();
    this.tree.free();
    this.doc.free();
    liveHandleCount -= 3;
    this.treeOf.clear();
    this.nodeOf.clear();
    this.pathOfContainer.clear();
  }
}

// ---------------------------------------------------------------- validation by simulation

/** Checks a batch of ops against current state plus the effects of earlier ops in the batch. */
class Simulation {
  private readonly exists = new Map<NodeId, boolean>();
  private readonly parents = new Map<NodeId, NodeId | null>();
  private readonly textLengths = new Map<string, number>();
  private readonly listLengths = new Map<string, number>();

  constructor(private readonly part: LoroPart) {}

  private parent(node: NodeId): NodeId | null | undefined {
    return this.parents.has(node) ? this.parents.get(node) : this.part.parentNode(node);
  }

  private alive(node: NodeId): boolean {
    let current: NodeId | null | undefined = node;
    for (let guard = 0; guard < 10_000 && current !== null && current !== undefined; guard += 1) {
      const flag = this.exists.get(current);
      if (flag === false) return false;
      if (flag === undefined && !this.part.has(current)) return false;
      current = this.parent(current);
    }
    return true;
  }

  private nodeError(node: NodeId, index: number): Result<never> {
    return err(UnknownNodeError({ message: `Op ${index}: node "${node}" does not exist in this part.`, details: { node, op: index } }));
  }

  private textLength(node: NodeId, path: string): number {
    const key = `${node}\u0001${path}`;
    return this.textLengths.get(key) ?? this.part.textLength(node, path);
  }

  private listLength(node: NodeId, path: string): number {
    const key = `${node}\u0001${path}`;
    return this.listLengths.get(key) ?? this.part.listLength(node, path);
  }

  private pos(pos: TextPos): number | undefined {
    return typeof pos === 'number' ? pos : this.part.resolve(pos);
  }

  private checkPath(path: string, index: number): Result<void> {
    return isWritablePath(path) ? ok() : err(InvalidFieldError({ message: `Op ${index}: "${path}" is not a writable property path.`, details: { path, op: index } }));
  }

  private checkPosition(parent: NodeId | null, position: Position | undefined, index: number): Result<void> {
    if (position === undefined || 'index' in position) {
      if (position !== undefined && (!Number.isInteger(position.index) || position.index < 0)) {
        return err(InvalidFieldError({ message: `Op ${index}: position index must be a non-negative integer.` }));
      }
      return ok();
    }
    const sibling = 'before' in position ? position.before : position.after;
    if (sibling === null) return ok();
    if (!this.alive(sibling)) return this.nodeError(sibling, index);
    if (this.parent(sibling) !== parent) {
      return err(UnknownNodeError({ message: `Op ${index}: position sibling "${sibling}" is not a child of the target parent.`, details: { sibling, op: index } }));
    }
    return ok();
  }

  run(ops: readonly PartOp[]): Result<void> {
    for (let i = 0; i < ops.length; i += 1) {
      const r = this.step(ops[i] as PartOp, i);
      if (!r.ok) return r;
    }
    return ok();
  }

  private step(op: PartOp, i: number): Result<void> {
    switch (op.op) {
      case 'create': {
        if (typeof op.node !== 'string' || op.node.length === 0 || typeof op.kind !== 'string' || op.kind.length === 0) {
          return err(InvalidFieldError({ message: `Op ${i}: create needs a node id and a kind.` }));
        }
        if (this.alive(op.node) && (this.exists.get(op.node) === true || this.part.has(op.node))) {
          return err(NodeExistsError({ message: `Op ${i}: node "${op.node}" already exists.`, details: { node: op.node, op: i } }));
        }
        if (op.parent !== null && !this.alive(op.parent)) return this.nodeError(op.parent, i);
        const p = this.checkPosition(op.parent, op.position, i);
        if (!p.ok) return p;
        for (const [path, value] of Object.entries(op.props ?? {})) {
          const c = this.checkPath(path, i);
          if (!c.ok) return c;
          if (!isJsonValue(value)) return err(InvalidFieldError({ message: `Op ${i}: "${path}" is not JSON data.`, details: { path } }));
        }
        for (const [path, value] of Object.entries(op.texts ?? {})) {
          const c = this.checkPath(path, i);
          if (!c.ok) return c;
          if (typeof value?.text !== 'string') return err(InvalidFieldError({ message: `Op ${i}: text "${path}" needs a string.` }));
          for (const span of value.spans ?? []) {
            if (!(span.start >= 0 && span.end >= span.start && span.end <= value.text.length)) return err(TextRangeError({ message: `Op ${i}: span out of range in "${path}".` }));
          }
          this.textLengths.set(`${op.node}\u0001${path}`, value.text.length);
        }
        for (const [path, values] of Object.entries(op.lists ?? {})) {
          const c = this.checkPath(path, i);
          if (!c.ok) return c;
          if (!Array.isArray(values) || !values.every(isJsonValue)) return err(InvalidFieldError({ message: `Op ${i}: list "${path}" must hold JSON values.` }));
          this.listLengths.set(`${op.node}\u0001${path}`, values.length);
        }
        this.exists.set(op.node, true);
        this.parents.set(op.node, op.parent);
        return ok();
      }
      case 'delete':
        if (!this.alive(op.node)) return this.nodeError(op.node, i);
        this.exists.set(op.node, false);
        return ok();
      case 'move': {
        if (!this.alive(op.node)) return this.nodeError(op.node, i);
        if (op.parent !== null) {
          if (!this.alive(op.parent)) return this.nodeError(op.parent, i);
          let current: NodeId | null | undefined = op.parent;
          for (let guard = 0; guard < 10_000 && current !== null && current !== undefined; guard += 1) {
            if (current === op.node) {
              return err(MoveCycleError({ message: `Op ${i}: moving "${op.node}" under "${op.parent}" creates a cycle.`, details: { node: op.node, parent: op.parent } }));
            }
            current = this.parent(current);
          }
        }
        const p = this.checkPosition(op.parent, op.position, i);
        if (!p.ok) return p;
        if (op.position !== undefined && 'after' in op.position && op.position.after === op.node) return err(MoveCycleError({ message: `Op ${i}: a node cannot be placed after itself.` }));
        if (op.position !== undefined && 'before' in op.position && op.position.before === op.node) return err(MoveCycleError({ message: `Op ${i}: a node cannot be placed before itself.` }));
        this.parents.set(op.node, op.parent);
        return ok();
      }
      case 'set': {
        if (!this.alive(op.node)) return this.nodeError(op.node, i);
        const c = this.checkPath(op.path, i);
        if (!c.ok) return c;
        if (!isJsonValue(op.value)) return err(InvalidFieldError({ message: `Op ${i}: "${op.path}" is not JSON data.`, details: { path: op.path } }));
        return ok();
      }
      case 'text.insert':
      case 'text.delete':
      case 'text.mark': {
        if (!this.alive(op.node)) return this.nodeError(op.node, i);
        const c = this.checkPath(op.path, i);
        if (!c.ok) return c;
        const length = this.textLength(op.node, op.path);
        if (op.op === 'text.insert') {
          const at = this.pos(op.at);
          if (typeof op.text !== 'string' || at === undefined || !Number.isInteger(at) || at < 0 || at > length) {
            return err(TextRangeError({ message: `Op ${i}: insert position out of range (length ${length}).`, details: { op: i, length } }));
          }
          this.textLengths.set(`${op.node}\u0001${op.path}`, length + op.text.length);
          return ok();
        }
        const from = this.pos(op.from);
        const to = this.pos(op.to);
        if (from === undefined || to === undefined || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > length || from > to) {
          return err(TextRangeError({ message: `Op ${i}: range out of bounds (length ${length}).`, details: { op: i, length } }));
        }
        if (op.op === 'text.mark') {
          if (typeof op.key !== 'string' || op.key.length === 0 || !isJsonValue(op.value)) return err(InvalidFieldError({ message: `Op ${i}: a mark needs a key and a JSON value.` }));
        } else this.textLengths.set(`${op.node}\u0001${op.path}`, length - (to - from));
        return ok();
      }
      case 'list.insert':
      case 'list.delete':
      case 'list.move':
      case 'list.set': {
        if (!this.alive(op.node)) return this.nodeError(op.node, i);
        const c = this.checkPath(op.path, i);
        if (!c.ok) return c;
        const length = this.listLength(op.node, op.path);
        const key = `${op.node}\u0001${op.path}`;
        const bad = (): Result<never> => err(InvalidFieldError({ message: `Op ${i}: list index out of range (length ${length}).`, details: { op: i, length } }));
        const isIndex = (n: number, max: number): boolean => Number.isInteger(n) && n >= 0 && n <= max;
        switch (op.op) {
          case 'list.insert':
            if (!isIndex(op.at, length) || !isJsonValue(op.value)) return bad();
            this.listLengths.set(key, length + 1);
            return ok();
          case 'list.delete':
            if (!isIndex(op.at, length) || !Number.isInteger(op.count) || op.count < 0 || op.at + op.count > length) return bad();
            this.listLengths.set(key, length - op.count);
            return ok();
          case 'list.move':
            return isIndex(op.from, length - 1) && isIndex(op.to, length - 1) ? ok() : bad();
          case 'list.set':
            return isIndex(op.at, length - 1) && isJsonValue(op.value) ? ok() : bad();
        }
      }
    }
    return err(InvalidFieldError({ message: `Op ${i}: unknown op "${(op as { op: string }).op}".` }));
  }
}

// ---------------------------------------------------------------- rich text helpers

type DeltaItem = Delta<string>;

function deltaToSegments(delta: readonly DeltaItem[]): { start: number; end: number; text: string; marks: Readonly<Record<string, JsonValue>> }[] {
  const out: { start: number; end: number; text: string; marks: Readonly<Record<string, JsonValue>> }[] = [];
  let offset = 0;
  for (const item of delta) {
    if (typeof item.insert !== 'string') continue;
    const end = offset + item.insert.length;
    out.push({ start: offset, end, text: item.insert, marks: (item.attributes ?? {}) as Record<string, JsonValue> });
    offset = end;
  }
  return out;
}

function deltaToRichText(delta: readonly DeltaItem[]): RichTextValue {
  const segments = deltaToSegments(delta);
  const spans: MarkSpan[] = segments.filter((s) => Object.keys(s.marks).length > 0).map((s) => ({ start: s.start, end: s.end, marks: s.marks }));
  return { text: segments.map((s) => s.text).join(''), spans };
}

/** Split rich text into maximal runs with identical marks. */
function segmentsOf(value: RichTextValue): { text: string; marks: Readonly<Record<string, JsonValue>> }[] {
  const cuts = new Set<number>([0, value.text.length]);
  for (const span of value.spans) {
    cuts.add(span.start);
    cuts.add(span.end);
  }
  const points = [...cuts].sort((a, b) => a - b);
  const out: { text: string; marks: Record<string, JsonValue> }[] = [];
  for (let i = 0; i + 1 < points.length; i += 1) {
    const start = points[i] as number;
    const end = points[i + 1] as number;
    if (end <= start) continue;
    const marks: Record<string, JsonValue> = {};
    for (const span of value.spans) if (span.start <= start && span.end >= end) Object.assign(marks, span.marks);
    out.push({ text: value.text.slice(start, end), marks });
  }
  return out;
}

function snapshotToCreates(snapshot: readonly NodeSnapshot[], parent: NodeId | null, position: Position): PartOp[] {
  return snapshot.map((node, i): PartOp => ({
    op: 'create',
    node: node.id,
    kind: node.kind,
    parent: i === 0 ? parent : node.parent,
    ...(i === 0 ? { position } : {}),
    props: node.props,
    texts: node.texts,
    lists: node.lists,
  }));
}

function emptyChange(origin: 'local' | 'remote'): PartChange {
  return { origin, created: [], deleted: [], moved: [], updated: new Map() };
}

// ---------------------------------------------------------------- engine

/** A Loro engine for `DocumentRepo`, forks and contract suites. */
export function createLoroEngine(options: LoroEngineOptions = {}): CrdtEngine {
  return {
    id: ENGINE_ID,
    create: ({ peer }) => new LoroPart(new LoroDoc(), peer, options),
    load(bytes, { peer }) {
      const doc = new LoroDoc();
      try {
        doc.import(bytes);
      } catch (error) {
        doc.free();
        return err(InvalidUpdateError({ message: 'Not a loadable Loro snapshot.', cause: toSfError(error) }));
      }
      return ok(new LoroPart(doc, peer, options));
    },
    liveHandles: () => liveHandleCount,
  };
}

/** Process-wide count of live Loro handles taken by this adapter (dev-mode accounting; 0 when idle). */
export function loroLiveHandles(): number {
  return liveHandleCount;
}

/** Bytes of Loro Wasm linear memory, where the build exposes it (Node), for leak tests: must stay flat over open/close cycles. */
export function loroWasmMemoryBytes(): number | undefined {
  const wasm = Reflect.get(LoroModule, '__wasm') as { memory?: WebAssembly.Memory } | undefined;
  return wasm?.memory?.buffer.byteLength;
}
