/**
 * `DocumentRepo` (SF-Δ3): many tree assets per repo, each split into parts
 * (one CRDT document per page plus a document-level part, D14), persisted as
 * part snapshots + an append-only commit log through a `DocumentStore` port.
 *
 * - **Lazy parts.** `open()` reads the head and the live log only; a part's CRDT
 *   is built (snapshot + its log records) on first `part(id)`.
 * - **Commits.** `commit(meta, { [part]: ops })` applies synchronously to every
 *   touched part as ONE logical transaction (shared `meta.txn`; all-or-nothing
 *   validation across parts) and appends ONE commit record. `durable` resolves
 *   when the log acknowledged it; appends are serialized in commit order.
 * - **Compaction.** Folds the log into new part snapshots, keeps the newest
 *   `undoHorizon` inverse steps per actor in an undo blob, swaps the head by CAS
 *   on `generation` (retrying on conflict) and truncates the log.
 * - **Eviction.** `evict(part)` frees a clean part's CRDT (the resource manager
 *   decides when, from `stats()`); hooks report loads, evictions, compactions.
 *
 * Lifecycles (docs/LIFECYCLES.md): `document/repo-document` (open ⇄ compacting
 * → closing → closed) and `document/part` (unloaded → loading → loaded →
 * unloaded on eviction; loading → failed).
 */
import { AbortedError, createMachine, createSingleFlight, defineMachine, err, ok, type Result, type SfError } from '@staticflux/core';
import { type CommitRecord, commitRecordSize, decodeCommitRecord, encodeCommitRecord } from './commit-record.js';
import { type CrdtEngine, type DocumentCRDTv2, type PartChange, type PartOp, type PeerId, randomPeerId, type TransactionMeta } from './crdt-v2.js';
import { DocumentClosedError, HeadConflictError, InvalidUpdateError, PartBusyError, UnknownPartError } from './errors.js';
import { createGesture, type Gesture } from './gesture.js';
import type { JsonObject } from './json.js';
import type { BlobRef, DocumentHead, DocumentStore, PartId } from './store.js';

export const ROOT_PART: PartId = 'root';
export const DEFAULT_UNDO_HORIZON = 200;
export const DEFAULT_COMPACT_AFTER_BYTES = 2 * 1024 * 1024;

export const RepoDocumentMachine = /* @__PURE__ */ defineMachine({
  id: 'document/repo-document',
  initial: 'open',
  states: ['open', 'compacting', 'closing', 'closed'],
  transitions: {
    open: { compact: 'compacting', close: 'closing' },
    compacting: { compacted: 'open' },
    closing: { closed: 'closed' },
  },
  terminal: ['closed'],
});

export type RepoDocumentState = (typeof RepoDocumentMachine.states)[number];
export type PartState = 'unloaded' | 'loading' | 'loaded' | 'failed';

/** One inverse step, newest first in `undoHistory()`. */
export interface UndoEntry {
  readonly seq?: number;
  readonly peer: PeerId;
  readonly meta: TransactionMeta;
  readonly inverse: Readonly<Record<PartId, readonly PartOp[]>>;
}

export interface Committed {
  /** The record as broadcast (no `seq` yet). */
  readonly record: CommitRecord;
  /** Resolves when the log acknowledged the record (with its `seq`). */
  readonly durable: Promise<Result<CommitRecord>>;
  /** Per-part change (for projections). */
  readonly changes: Readonly<Record<PartId, PartChange>>;
}

export interface PartInfo {
  readonly id: PartId;
  readonly state: PartState;
  readonly lastUsedAt: number;
  /** Local commits touching the part that are not durable yet (eviction waits for them). */
  readonly pending: number;
}

export interface DocumentStats {
  readonly parts: readonly PartInfo[];
  /** Bytes of live log records known to this document. */
  readonly logBytes: number;
  readonly logRecords: number;
}

export interface CompactOptions {
  /** `keep` (default): full snapshots. `shallow`: drop history before now (bases older than it become unavailable). */
  readonly history?: 'keep' | 'shallow';
}

export interface OpenDocument {
  readonly asset: string;
  /** This document's peer (fresh per open: each session is its own peer). */
  readonly peer: PeerId;
  readonly state: RepoDocumentState;
  head(): DocumentHead;
  /** Parts named by the head, the log, or created in this session. */
  partIds(): readonly PartId[];
  partState(id: PartId): PartState;
  /** Load (once) and return a part. */
  part(id: PartId, signal: AbortSignal): Promise<Result<DocumentCRDTv2>>;
  /** A part if it is loaded. */
  loadedPart(id: PartId): DocumentCRDTv2 | undefined;
  /** Create an empty part (e.g. a new page). */
  createPart(id: PartId): Result<DocumentCRDTv2>;
  /**
   * Apply ops to one or more LOADED parts as one logical transaction and append one commit record.
   * Write only through this (or `gesture`), never through a part's own `transact`, or the edit is not persisted.
   */
  commit(meta: TransactionMeta, changes: Readonly<Record<PartId, readonly PartOp[]>>): Result<Committed>;
  /** `commit` and wait until durable. */
  transact(meta: TransactionMeta, changes: Readonly<Record<PartId, readonly PartOp[]>>, signal: AbortSignal): Promise<Result<CommitRecord>>;
  /** Move a node (with its subtree) from one loaded part to another, as one commit touching both. */
  moveAcross(meta: TransactionMeta, move: CrossPartMove): Result<Committed>;
  /** A gesture on one part that commits through `commit` (one record per gesture). */
  gesture(meta: TransactionMeta, part: PartId): Result<Gesture<Committed>>;
  /** Merge a commit record from another peer (another tab via the store worker, a relay later). */
  applyRemote(record: CommitRecord): Result<Readonly<Record<PartId, PartChange>>>;
  /** Local commit records to broadcast. */
  onCommit(listener: (record: CommitRecord) => void): () => void;
  /** Wait for every pending append. */
  flush(signal: AbortSignal): Promise<Result<void>>;
  /** Newest-first inverse steps within the undo horizon (optionally for one actor id). */
  undoHistory(actor?: string): readonly UndoEntry[];
  compact(signal: AbortSignal, options?: CompactOptions): Promise<Result<DocumentHead>>;
  /** Free a clean part's CRDT; it reloads on the next `part(id)`. */
  evict(id: PartId): Result<void>;
  stats(): DocumentStats;
  /** Flush, optionally compact (default: when the log is non-empty), free every part. */
  close(signal: AbortSignal, options?: { readonly compact?: boolean }): Promise<Result<void>>;
}

export interface CrossPartMove {
  readonly node: string;
  readonly from: PartId;
  readonly to: PartId;
  readonly parent: string | null;
  readonly position?: Extract<PartOp, { op: 'move' }>['position'];
}

export interface DocumentRepoHooks {
  readonly onPartLoaded?: (asset: string, part: PartId) => void;
  readonly onPartEvicted?: (asset: string, part: PartId) => void;
  readonly onCompacted?: (asset: string, head: DocumentHead) => void;
  /** A durable append failed (the commit stays applied in memory and is retried on the next flush). */
  readonly onPersistError?: (asset: string, error: SfError) => void;
}

export interface CreateDocumentOptions {
  readonly treeSchema: number;
  /** Initial empty parts (default `['root']`). */
  readonly parts?: readonly PartId[];
  readonly app?: JsonObject;
}

export interface DocumentRepoOptions {
  readonly store: DocumentStore;
  readonly engine: CrdtEngine;
  /** Peer for each opened document (default: a fresh random peer per open). */
  readonly peer?: (asset: string) => PeerId;
  /** Undo steps kept per actor at compaction (default 200, IF-5.3). */
  readonly undoHorizon?: number;
  /** Compact automatically once the live log reaches this many bytes (default 2 MiB; `Infinity` disables). */
  readonly compactAfterBytes?: number;
  readonly hooks?: DocumentRepoHooks;
  readonly now?: () => number;
}

export interface DocumentRepo {
  create(asset: string, options: CreateDocumentOptions, signal: AbortSignal): Promise<Result<OpenDocument>>;
  /** Open (once per asset: concurrent calls share the same document). */
  open(asset: string, signal: AbortSignal): Promise<Result<OpenDocument>>;
  get(asset: string): OpenDocument | undefined;
  openAssets(): readonly string[];
  /** Close every open document (flush, no compaction). */
  dispose(signal: AbortSignal): Promise<void>;
}

// ---------------------------------------------------------------- implementation

interface PartSlot {
  state: PartState;
  crdt: DocumentCRDTv2 | undefined;
  lastUsedAt: number;
  pending: number;
}

interface LiveRecord {
  readonly record: CommitRecord;
  readonly size: number;
}

interface PendingAppend {
  readonly record: CommitRecord;
  readonly ids: readonly PartId[];
  readonly bytes: Uint8Array;
  durable: CommitRecord | undefined;
}

interface UndoBlob {
  readonly schema: 'sf.undo/1';
  readonly entries: readonly UndoEntry[];
}

const encoder = /* @__PURE__ */ new TextEncoder();
const decoder = /* @__PURE__ */ new TextDecoder();

let txnCounter = 0;
const nextTxn = (peer: PeerId): string => {
  txnCounter += 1;
  return `${peer}-${txnCounter.toString(36)}`;
};

function toUndoEntry(record: CommitRecord): UndoEntry {
  return { ...(record.seq === undefined ? {} : { seq: record.seq }), peer: record.peer, meta: record.meta, inverse: record.inverse };
}

function trimUndo(entries: readonly UndoEntry[], horizon: number): UndoEntry[] {
  // entries newest first; keep `horizon` per actor id
  const counts = new Map<string, number>();
  const out: UndoEntry[] = [];
  for (const entry of entries) {
    const actor = entry.meta.actor.id;
    const n = counts.get(actor) ?? 0;
    if (n >= horizon) continue;
    counts.set(actor, n + 1);
    out.push(entry);
  }
  return out;
}

class RepoDocument implements OpenDocument {
  readonly peer: PeerId;
  private readonly machine = createMachine(RepoDocumentMachine);
  private readonly slots = new Map<PartId, PartSlot>();
  private readonly loads = createSingleFlight<PartId, DocumentCRDTv2>();
  private readonly listeners = new Set<(record: CommitRecord) => void>();
  private records: LiveRecord[];
  private undoEntries: UndoEntry[];
  private appendChain: Promise<unknown> = Promise.resolve();
  /** Commits applied in memory, not yet acknowledged by the log (appended strictly in order). */
  private unacked: PendingAppend[] = [];
  private lastPersistError: SfError | undefined;
  private compacting: Promise<Result<DocumentHead>> | undefined;

  constructor(
    readonly asset: string,
    private currentHead: DocumentHead,
    records: readonly CommitRecord[],
    undoEntries: readonly UndoEntry[],
    private readonly options: Required<Pick<DocumentRepoOptions, 'store' | 'engine' | 'undoHorizon' | 'compactAfterBytes' | 'now'>> & { hooks: DocumentRepoHooks },
    peer: PeerId,
    private readonly onClosed: () => void,
  ) {
    this.peer = peer;
    this.records = records.map((record) => ({ record, size: commitRecordSize(record) }));
    this.undoEntries = [...undoEntries];
    for (const id of Object.keys(currentHead.parts)) this.slot(id);
    for (const { record } of this.records) for (const id of Object.keys(record.updates)) this.slot(id);
  }

  get state(): RepoDocumentState {
    return this.machine.state;
  }

  head(): DocumentHead {
    return this.currentHead;
  }

  private slot(id: PartId): PartSlot {
    let slot = this.slots.get(id);
    if (slot === undefined) this.slots.set(id, (slot = { state: 'unloaded', crdt: undefined, lastUsedAt: 0, pending: 0 }));
    return slot;
  }

  private closedError(): Result<never> {
    return err(DocumentClosedError({ message: `Document "${this.asset}" is ${this.machine.state}.`, details: { asset: this.asset } }));
  }

  private get usable(): boolean {
    return this.machine.is('open', 'compacting');
  }

  partIds(): readonly PartId[] {
    return [...this.slots.keys()].sort();
  }

  partState(id: PartId): PartState {
    return this.slots.get(id)?.state ?? 'unloaded';
  }

  loadedPart(id: PartId): DocumentCRDTv2 | undefined {
    const slot = this.slots.get(id);
    if (slot?.crdt === undefined) return undefined;
    slot.lastUsedAt = this.options.now();
    return slot.crdt;
  }

  async part(id: PartId, signal: AbortSignal): Promise<Result<DocumentCRDTv2>> {
    if (!this.usable) return this.closedError();
    const loaded = this.loadedPart(id);
    if (loaded !== undefined) return ok(loaded);
    if (!this.slots.has(id)) return err(UnknownPartError({ details: { asset: this.asset, part: id } }));
    return this.loads.run(id, (inner) => this.load(id, inner), signal);
  }

  private async load(id: PartId, signal: AbortSignal): Promise<Result<DocumentCRDTv2>> {
    const slot = this.slot(id);
    slot.state = 'loading';
    const crdt = await this.build(id, signal);
    if (!crdt.ok) {
      slot.state = 'failed';
      return crdt;
    }
    if (!this.usable) {
      crdt.value.dispose();
      return this.closedError();
    }
    slot.crdt = crdt.value;
    slot.state = 'loaded';
    slot.lastUsedAt = this.options.now();
    this.options.hooks.onPartLoaded?.(this.asset, id);
    return ok(crdt.value);
  }

  /** Snapshot (if any) plus every live record touching the part. */
  private async build(id: PartId, signal: AbortSignal): Promise<Result<DocumentCRDTv2>> {
    const ref = this.currentHead.parts[id];
    let crdt: DocumentCRDTv2;
    if (ref === undefined) crdt = this.options.engine.create({ peer: this.peer });
    else {
      const bytes = await this.options.store.getBlob(ref, signal);
      if (!bytes.ok) return bytes;
      const loaded = this.options.engine.load(bytes.value, { peer: this.peer });
      if (!loaded.ok) return loaded;
      crdt = loaded.value;
    }
    for (const { record } of this.records) {
      const update = record.updates[id];
      if (update === undefined) continue;
      const r = crdt.import(update);
      if (!r.ok) {
        crdt.dispose();
        return r;
      }
    }
    return ok(crdt);
  }

  createPart(id: PartId): Result<DocumentCRDTv2> {
    if (!this.usable) return this.closedError();
    const existing = this.slots.get(id);
    if (existing?.crdt !== undefined) return ok(existing.crdt);
    if (existing !== undefined) return err(UnknownPartError({ message: `Part "${id}" exists but is not loaded; await doc.part(id, signal).`, details: { part: id } }));
    const slot = this.slot(id);
    slot.crdt = this.options.engine.create({ peer: this.peer });
    slot.state = 'loaded';
    slot.lastUsedAt = this.options.now();
    this.options.hooks.onPartLoaded?.(this.asset, id);
    return ok(slot.crdt);
  }

  private recordsTouch(id: PartId): boolean {
    return this.records.some(({ record }) => record.updates[id] !== undefined);
  }

  commit(meta: TransactionMeta, changes: Readonly<Record<PartId, readonly PartOp[]>>): Result<Committed> {
    if (!this.usable) return this.closedError();
    const ids = Object.keys(changes).filter((id) => (changes[id] as readonly PartOp[]).length > 0);
    const parts: [PartId, DocumentCRDTv2][] = [];
    for (const id of ids) {
      const crdt = this.loadedPart(id);
      if (crdt === undefined) return err(UnknownPartError({ details: { asset: this.asset, part: id } }));
      parts.push([id, crdt]);
    }
    for (const [id, crdt] of parts) {
      const checked = crdt.check(changes[id] as readonly PartOp[]);
      if (!checked.ok) return err(checked.error);
    }
    const txMeta: TransactionMeta = parts.length > 1 && meta.txn === undefined ? { ...meta, txn: nextTxn(this.peer) } : meta;
    const updates: Record<PartId, Uint8Array> = {};
    const inverse: Record<PartId, readonly PartOp[]> = {};
    const partChanges: Record<PartId, PartChange> = {};
    const applied: [DocumentCRDTv2, readonly PartOp[]][] = [];
    for (const [id, crdt] of parts) {
      const info = crdt.transact(txMeta, changes[id] as readonly PartOp[]);
      if (!info.ok) {
        // Validation passed, so this is an engine failure: compensate the parts already applied.
        for (const [done, inv] of applied.reverse()) done.transact({ ...txMeta, label: `${txMeta.label} (rolled back)` }, inv);
        return err(info.error);
      }
      applied.push([crdt, info.value.inverse]);
      updates[id] = info.value.update;
      inverse[id] = info.value.inverse;
      partChanges[id] = info.value.change;
    }
    const record: CommitRecord = { peer: this.peer, meta: txMeta, updates, inverse };
    for (const id of ids) this.slot(id).pending += 1;
    for (const listener of [...this.listeners]) listener(record);
    const durable = this.enqueue(record, ids);
    return ok({ record, durable, changes: partChanges });
  }

  private enqueue(record: CommitRecord, ids: readonly PartId[]): Promise<Result<CommitRecord>> {
    const entry: PendingAppend = { record, ids, bytes: encodeCommitRecord(record), durable: undefined };
    this.unacked.push(entry);
    const done = this.appendChain.then(async (): Promise<Result<CommitRecord>> => {
      const drained = await this.drain();
      if (entry.durable !== undefined) return ok(entry.durable);
      return drained.ok ? err(this.lastPersistError ?? DocumentClosedError()) : drained;
    });
    this.appendChain = done.then(() => this.maybeAutoCompact());
    return done;
  }

  /** Append every unacknowledged record in order; stops at the first failure (retried by the next commit or flush). */
  private async drain(): Promise<Result<void>> {
    while (this.unacked.length > 0) {
      const entry = this.unacked[0] as PendingAppend;
      const appended = await this.options.store.appendLog(this.asset, entry.bytes, new AbortController().signal);
      if (!appended.ok) {
        this.lastPersistError = appended.error;
        this.options.hooks.onPersistError?.(this.asset, appended.error);
        return appended;
      }
      this.unacked.shift();
      entry.durable = { ...entry.record, seq: appended.value };
      for (const id of entry.ids) this.slot(id).pending -= 1;
      this.records.push({ record: entry.durable, size: entry.bytes.byteLength });
    }
    return ok();
  }

  private maybeAutoCompact(): void {
    if (this.logBytes() >= this.options.compactAfterBytes && this.machine.is('open')) void this.compact(new AbortController().signal);
  }

  async transact(meta: TransactionMeta, changes: Readonly<Record<PartId, readonly PartOp[]>>, signal: AbortSignal): Promise<Result<CommitRecord>> {
    const committed = this.commit(meta, changes);
    if (!committed.ok) return committed;
    if (signal.aborted) return err(AbortedError({ cause: signal.reason }));
    return committed.value.durable;
  }

  moveAcross(meta: TransactionMeta, move: CrossPartMove): Result<Committed> {
    if (!this.usable) return this.closedError();
    const source = this.loadedPart(move.from);
    const target = this.loadedPart(move.to);
    if (source === undefined) return err(UnknownPartError({ details: { part: move.from } }));
    if (target === undefined) return err(UnknownPartError({ details: { part: move.to } }));
    if (move.from === move.to) return this.commit(meta, { [move.from]: [{ op: 'move', node: move.node, parent: move.parent, ...(move.position === undefined ? {} : { position: move.position }) }] });
    const subtree = source.subtree(move.node);
    if (subtree === undefined) return err(UnknownPartError({ message: `Node "${move.node}" is not in part "${move.from}".`, details: { node: move.node } }));
    const creates: PartOp[] = subtree.map((node, i) => ({
      op: 'create',
      node: node.id,
      kind: node.kind,
      parent: i === 0 ? move.parent : node.parent,
      ...(i === 0 && move.position !== undefined ? { position: move.position } : {}),
      props: node.props,
      texts: node.texts,
      lists: node.lists,
    }));
    return this.commit(meta, { [move.from]: [{ op: 'delete', node: move.node }], [move.to]: creates });
  }

  gesture(meta: TransactionMeta, part: PartId): Result<Gesture<Committed>> {
    if (!this.usable) return this.closedError();
    if (this.loadedPart(part) === undefined) return err(UnknownPartError({ details: { part } }));
    return ok(createGesture<Committed>({ transact: (m, ops) => this.commit(m, { [part]: ops }) }, meta));
  }

  applyRemote(record: CommitRecord): Result<Readonly<Record<PartId, PartChange>>> {
    if (!this.usable) return this.closedError();
    const out: Record<PartId, PartChange> = {};
    for (const [id, update] of Object.entries(record.updates)) {
      const slot = this.slot(id);
      if (slot.crdt === undefined) continue; // folded in when the part loads (the record is kept below)
      const r = slot.crdt.import(update);
      if (!r.ok) return err(InvalidUpdateError({ message: `Remote record for part "${id}" could not be applied.`, cause: r.error }));
      out[id] = r.value.change;
    }
    this.records.push({ record, size: commitRecordSize(record) });
    return ok(out);
  }

  onCommit(listener: (record: CommitRecord) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async flush(signal: AbortSignal): Promise<Result<void>> {
    const done = this.appendChain.then(() => this.drain());
    this.appendChain = done.then(() => undefined);
    const result = await done;
    if (!result.ok) return result;
    if (signal.aborted) return err(AbortedError({ cause: signal.reason }));
    return ok();
  }

  undoHistory(actor?: string): readonly UndoEntry[] {
    const all = trimUndo([...this.records.map(({ record }) => toUndoEntry(record)).reverse(), ...this.undoEntries], this.currentHead.undoHorizon);
    return actor === undefined ? all : all.filter((e) => e.meta.actor.id === actor);
  }

  logBytes(): number {
    return this.records.reduce((n, r) => n + r.size, 0);
  }

  stats(): DocumentStats {
    return {
      parts: this.partIds().map((id) => {
        const slot = this.slot(id);
        return { id, state: slot.state, lastUsedAt: slot.lastUsedAt, pending: slot.pending };
      }),
      logBytes: this.logBytes(),
      logRecords: this.records.length,
    };
  }

  evict(id: PartId): Result<void> {
    const slot = this.slots.get(id);
    if (slot?.crdt === undefined) return ok();
    if (slot.pending > 0) return err(PartBusyError({ details: { part: id, pending: slot.pending } }));
    slot.crdt.dispose();
    slot.crdt = undefined;
    slot.state = 'unloaded';
    this.options.hooks.onPartEvicted?.(this.asset, id);
    return ok();
  }

  compact(signal: AbortSignal, options: CompactOptions = {}): Promise<Result<DocumentHead>> {
    if (this.compacting !== undefined) return this.compacting;
    if (!this.machine.is('open', 'closing')) return Promise.resolve(this.closedError());
    const wasClosing = this.machine.is('closing');
    if (!wasClosing) this.machine.send('compact');
    this.compacting = this.runCompaction(signal, options).finally(() => {
      this.compacting = undefined;
      if (!wasClosing) this.machine.send('compacted');
    });
    return this.compacting;
  }

  private async runCompaction(signal: AbortSignal, options: CompactOptions): Promise<Result<DocumentHead>> {
    const flushed = await this.flush(signal);
    if (!flushed.ok) return flushed;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const folded = this.records;
      const maxSeq = folded.reduce((m, { record }) => Math.max(m, record.seq ?? 0), this.currentHead.logFrom - 1);
      const parts: Record<PartId, BlobRef> = { ...this.currentHead.parts };
      for (const id of this.partIds()) {
        const slot = this.slot(id);
        const touched = folded.some(({ record }) => record.updates[id] !== undefined);
        if (slot.crdt === undefined && !touched && parts[id] !== undefined) continue;
        let crdt = slot.crdt;
        let temporary = false;
        if (crdt === undefined) {
          const built = await this.build(id, signal);
          if (!built.ok) return built;
          crdt = built.value;
          temporary = true;
        }
        const bytes = options.history === 'shallow' ? crdt.exportShallowSnapshot() : crdt.exportSnapshot();
        if (temporary) crdt.dispose();
        const ref = await this.options.store.putBlob(bytes, signal);
        if (!ref.ok) return ref;
        parts[id] = ref.value;
      }
      const undo = trimUndo([...folded.map(({ record }) => toUndoEntry(record)).reverse(), ...this.undoEntries], this.currentHead.undoHorizon);
      let undoRef: BlobRef | undefined;
      if (undo.length > 0) {
        const blob: UndoBlob = { schema: 'sf.undo/1', entries: undo };
        const ref = await this.options.store.putBlob(encoder.encode(JSON.stringify(blob)), signal);
        if (!ref.ok) return ref;
        undoRef = ref.value;
      }
      const { undo: _previous, ...base } = this.currentHead;
      const next: DocumentHead = { ...base, generation: this.currentHead.generation + 1, parts, logFrom: maxSeq + 1, ...(undoRef === undefined ? {} : { undo: undoRef }) };
      const written = await this.options.store.writeHead(this.asset, next, this.currentHead.generation, signal);
      if (!written.ok) {
        if (written.error.code !== HeadConflictError.code) return written;
        const merged = await this.adoptNewerHead(signal);
        if (!merged.ok) return merged;
        continue;
      }
      this.currentHead = next;
      this.undoEntries = undo;
      const foldedSet = new Set(folded);
      this.records = this.records.filter((r) => !foldedSet.has(r));
      const truncated = await this.options.store.truncateLog(this.asset, next.logFrom, signal);
      if (!truncated.ok) return truncated;
      this.options.hooks.onCompacted?.(this.asset, next);
      return ok(next);
    }
    return err(HeadConflictError({ message: `Compaction of "${this.asset}" lost the head race 4 times.`, details: { asset: this.asset } }));
  }

  /** Another writer compacted first: merge its snapshots into loaded parts and adopt its head. */
  private async adoptNewerHead(signal: AbortSignal): Promise<Result<void>> {
    const head = await this.options.store.readHead(this.asset, signal);
    if (!head.ok) return head;
    if (head.value === undefined) return err(HeadConflictError({ message: 'The head disappeared during compaction.' }));
    for (const [id, ref] of Object.entries(head.value.parts)) {
      const slot = this.slot(id);
      if (slot.crdt === undefined || this.currentHead.parts[id]?.digest === ref.digest) continue;
      const bytes = await this.options.store.getBlob(ref, signal);
      if (!bytes.ok) return bytes;
      const merged = slot.crdt.import(bytes.value);
      if (!merged.ok) return merged;
    }
    // Their snapshot folded log entries below their logFrom; ours are still applied in memory (imports are idempotent).
    const log = await this.options.store.readLog(this.asset, head.value.logFrom, signal);
    if (!log.ok) return log;
    const seen = new Set(this.records.map((r) => r.record.seq).filter((s) => s !== undefined));
    for (const entry of log.value) {
      if (seen.has(entry.seq)) continue;
      const record = decodeCommitRecord(entry.bytes, entry.seq);
      if (!record.ok) return record;
      this.applyRemote(record.value);
    }
    const newer = head.value;
    this.records = this.records.filter((r) => r.record.seq === undefined || r.record.seq >= newer.logFrom);
    if (newer.undo !== undefined) {
      const theirs = await readUndo(this.options.store, newer.undo, signal);
      if (!theirs.ok) return theirs;
      const key = (e: UndoEntry): string => `${e.peer}:${e.seq ?? JSON.stringify(e.meta)}`;
      const seenKeys = new Set(this.undoEntries.map(key));
      this.undoEntries = [...this.undoEntries, ...theirs.value.filter((e) => !seenKeys.has(key(e)))].sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0));
    }
    this.currentHead = newer;
    return ok();
  }

  async close(signal: AbortSignal, options: { readonly compact?: boolean } = {}): Promise<Result<void>> {
    if (this.machine.is('closed')) return ok();
    if (this.compacting !== undefined) await this.compacting;
    if (!this.machine.can('close')) return this.closedError();
    this.machine.send('close');
    let result: Result<void> = await this.flush(signal);
    if (result.ok && (options.compact ?? this.records.length > 0)) {
      const compacted = await this.compact(signal);
      if (!compacted.ok) result = compacted;
    }
    for (const slot of this.slots.values()) {
      slot.crdt?.dispose();
      slot.crdt = undefined;
      slot.state = 'unloaded';
    }
    this.listeners.clear();
    this.machine.send('closed');
    this.onClosed();
    return result;
  }
}

async function readUndo(store: DocumentStore, ref: BlobRef, signal: AbortSignal): Promise<Result<UndoEntry[]>> {
  const bytes = await store.getBlob(ref, signal);
  if (!bytes.ok) return bytes;
  try {
    return ok([...(JSON.parse(decoder.decode(bytes.value)) as UndoBlob).entries]);
  } catch (cause) {
    return err(InvalidUpdateError({ message: 'Malformed undo history blob.', cause }));
  }
}

async function readDocument(
  store: DocumentStore,
  asset: string,
  signal: AbortSignal,
): Promise<Result<{ head: DocumentHead; records: CommitRecord[]; undo: UndoEntry[] } | undefined>> {
  const head = await store.readHead(asset, signal);
  if (!head.ok) return head;
  if (head.value === undefined) return ok(undefined);
  const log = await store.readLog(asset, head.value.logFrom, signal);
  if (!log.ok) return log;
  const records: CommitRecord[] = [];
  for (const entry of log.value) {
    const record = decodeCommitRecord(entry.bytes, entry.seq);
    if (!record.ok) return record;
    records.push(record.value);
  }
  let undo: UndoEntry[] = [];
  if (head.value.undo !== undefined) {
    const read = await readUndo(store, head.value.undo, signal);
    if (!read.ok) return read;
    undo = read.value;
  }
  return ok({ head: head.value, records, undo });
}

export function createDocumentRepo(options: DocumentRepoOptions): DocumentRepo {
  const resolved = {
    store: options.store,
    engine: options.engine,
    undoHorizon: options.undoHorizon ?? DEFAULT_UNDO_HORIZON,
    compactAfterBytes: options.compactAfterBytes ?? DEFAULT_COMPACT_AFTER_BYTES,
    now: options.now ?? Date.now,
    hooks: options.hooks ?? {},
  };
  const peerFor = options.peer ?? (() => randomPeerId());
  const open = new Map<string, RepoDocument>();
  const opening = createSingleFlight<string, OpenDocument>();

  const instantiate = (asset: string, head: DocumentHead, records: readonly CommitRecord[], undo: readonly UndoEntry[]): RepoDocument => {
    const doc: RepoDocument = new RepoDocument(asset, head, records, undo, resolved, peerFor(asset), () => {
      if (open.get(asset) === doc) open.delete(asset);
    });
    open.set(asset, doc);
    return doc;
  };

  return {
    async create(asset, createOptions, signal) {
      if (open.has(asset)) return err(HeadConflictError({ message: `Asset "${asset}" is already open.`, details: { asset } }));
      const engine = resolved.engine;
      const parts: Record<PartId, BlobRef> = {};
      for (const id of createOptions.parts ?? [ROOT_PART]) {
        const empty = engine.create({ peer: peerFor(asset) });
        const bytes = empty.exportSnapshot();
        empty.dispose();
        const ref = await resolved.store.putBlob(bytes, signal);
        if (!ref.ok) return ref;
        parts[id] = ref.value;
      }
      const head: DocumentHead = {
        asset,
        generation: 1,
        engine: engine.id,
        treeSchema: createOptions.treeSchema,
        parts,
        logFrom: 1,
        undoHorizon: resolved.undoHorizon,
        ...(createOptions.app === undefined ? {} : { app: createOptions.app }),
      };
      const written = await resolved.store.writeHead(asset, head, null, signal);
      if (!written.ok) return written;
      return ok(instantiate(asset, head, [], []));
    },
    open(asset, signal) {
      const existing = open.get(asset);
      if (existing !== undefined) return Promise.resolve(ok(existing));
      return opening.run(asset, async (inner): Promise<Result<OpenDocument>> => {
        const already = open.get(asset);
        if (already !== undefined) return ok(already);
        const read = await readDocument(resolved.store, asset, inner);
        if (!read.ok) return read;
        if (read.value === undefined) return err(UnknownPartError({ message: `Asset "${asset}" has no head in the store.`, details: { asset } }));
        if (read.value.head.engine !== resolved.engine.id) {
          return err(InvalidUpdateError({ message: `Asset "${asset}" uses engine "${read.value.head.engine}", not "${resolved.engine.id}".`, details: { asset } }));
        }
        return ok(instantiate(asset, read.value.head, read.value.records, read.value.undo));
      }, signal);
    },
    get: (asset) => open.get(asset),
    openAssets: () => [...open.keys()].sort(),
    async dispose(signal) {
      await Promise.all([...open.values()].map((doc) => doc.close(signal, { compact: false })));
    },
  };
}
