/**
 * Undo service (SF-Δ9, IF-4.13, D9, D14): per-actor, transaction-grouped, inverse-op based undo and redo over a
 * `DocumentRepo` open document.
 *
 * - **Per actor.** Stacks are keyed by `meta.actor.id`. "Undo" never reverts another actor's edit: it applies the
 *   step's anchored inverse ops (from the commit records) as ONE new commit by the same actor, so concurrent edits by
 *   others survive and every peer converges.
 * - **Steps.** One commit = one step (one gesture, one accepted change set, one cross-page move). Consecutive commits of
 *   one actor with the same `meta.invocation` (one capability invocation) or `meta.changeSet` group into one step.
 * - **Limit.** 200 steps per actor (D9; `limit`). Commits must carry a `txn` (`transactionMeta`, `undo.commit`,
 *   `undo.gesture` do); commits without one are not undoable.
 * - **Persisted.** Undo and redo commits carry `undoOf` / `redoOf` in their meta. The stacks are a pure function of
 *   the actor's history, so on open they are rebuilt from `doc.undoHistory()` — the log plus the undo blob that
 *   compaction keeps up to the document's undo horizon (`DocumentRepo` `undoHorizon`, default 200 records per actor;
 *   undo and redo commits count toward it).
 * - **Conflicts are flagged, never silently applied or skipped (D14).** Loro's own undo restores an old value even
 *   after another actor overwrote it (S4). Before applying, the service compares each target with the state right
 *   after the step (`changedSince(after)`, then a fork at `after` for the values); a target changed since by anyone
 *   is a conflict and the default `onConflict: 'flag'` returns `{ kind: 'conflict', conflicts }` without writing.
 *   The UI then retries with `'overwrite'` (restore mine) or `'keep-theirs'` (restore only what nobody touched).
 *
 * Lifecycle `stage/undo-step` (docs/LIFECYCLES.md §18): done ⇄ undone; done → dropped (beyond the limit, or a new
 * edit clears redo).
 */
import { AbortedError, err, ok, type Result } from '@staticflux/core';
import {
  type CommitRecord,
  type Committed,
  createGesture,
  type DocumentCRDTv2,
  type Frontier,
  type Gesture,
  type JsonValue,
  type NodeId,
  type OpenDocument,
  type PartChange,
  type PartId,
  type PartOp,
  type PropertyPath,
  randomPeerId,
  type TransactionMeta,
  type UndoEntry,
} from '@staticflux/document/v2';
import { type Actor, type TransactionMetaOptions, transactionMeta } from './actor.js';
import { StageDisposedError, UndoUnavailableError } from './errors.js';

export const DEFAULT_UNDO_LIMIT = 200;

/** Meta of an undo or redo commit. */
export interface UndoMeta extends TransactionMeta {
  /** Step key this commit undoes. */
  readonly undoOf?: string;
  /** Redo-step key (the undo commit's txn) this commit redoes. */
  readonly redoOf?: string;
}

export type UndoDirection = 'undo' | 'redo';

export interface UndoStepInfo {
  /** Stable key: the txn of the step's first commit (edit steps) or of the undo commit (redo steps). */
  readonly key: string;
  readonly actor: string;
  /** Readable label of the original edit ("Move 3 elements"). */
  readonly label: string;
  /** Commits in the step. */
  readonly commits: number;
  readonly parts: readonly PartId[];
  readonly invocation?: string;
  readonly changeSet?: string;
}

export type UndoConflictKind =
  /** A value or list was changed after the step. */
  | 'overwritten'
  /** The node was moved after the step. */
  | 'moved'
  /** The node (created by the step) was edited after it; undoing would delete those edits. */
  | 'edited'
  /** The node is gone. */
  | 'deleted'
  /** The inverse op no longer validates (e.g. its sibling or parent is gone). */
  | 'invalid'
  /** The history needed to check is gone (shallow compaction, or a record without frontiers). */
  | 'history-unavailable';

export interface UndoConflict {
  readonly kind: UndoConflictKind;
  readonly part: PartId;
  readonly node: NodeId;
  readonly path?: PropertyPath;
  /** What the step left (what undo assumes is still there). */
  readonly expected?: JsonValue;
  /** What is there now. */
  readonly current?: JsonValue;
  /** What undo would write. */
  readonly restore?: JsonValue;
  /** Actor ids that changed the node after the step (node-level, best effort). */
  readonly by: readonly string[];
  /** Indices of the affected ops in the step's inverse for this part. */
  readonly ops: readonly number[];
  /** Validation error code, for `invalid`. */
  readonly code?: string;
}

export type UndoOutcome =
  | { readonly kind: 'empty'; readonly direction: UndoDirection }
  | { readonly kind: 'conflict'; readonly direction: UndoDirection; readonly step: UndoStepInfo; readonly conflicts: readonly UndoConflict[] }
  | {
      readonly kind: 'applied';
      readonly direction: UndoDirection;
      readonly step: UndoStepInfo;
      readonly record: CommitRecord;
      /** Conflicts resolved by the chosen policy (kept theirs, overwrote, or repaired/dropped invalid ops). */
      readonly resolved: readonly UndoConflict[];
    };

export type ConflictPolicy = 'flag' | 'overwrite' | 'keep-theirs';

export interface UndoOptions {
  /** Default `flag`: never write when anything conflicts. */
  readonly onConflict?: ConflictPolicy;
}

/** Writes through the service are checked by the guard first (e.g. `stage.checkWrite` for locks). */
export type WriteGuard = (changes: Readonly<Record<PartId, readonly PartOp[]>>, actor: Actor) => Result<void>;

/** What the service needs from an open document (a `DocumentRepo` `OpenDocument` satisfies it). */
export type UndoTarget = Pick<OpenDocument, 'commit' | 'part' | 'undoHistory' | 'onCommit' | 'applyRemote'>;

export interface UndoServiceOptions {
  readonly doc: UndoTarget;
  /** Steps per actor (default 200, D9). */
  readonly limit?: number;
  readonly guard?: WriteGuard;
}

/** The undo service port (contract suite: `runUndoServiceContract` in testkit). */
export interface UndoService {
  /** Commit as `actor` (one step). */
  commit(actor: Actor, label: string, changes: Readonly<Record<PartId, readonly PartOp[]>>, options?: TransactionMetaOptions): Result<Committed>;
  /** A gesture on one loaded part: frames staged, one commit, one step. */
  gesture(actor: Actor, label: string, part: PartId, options?: TransactionMetaOptions): Result<Gesture<Committed>>;
  /** Merge a record from another peer and add it to its actor's stacks. */
  applyRemote(record: CommitRecord): Result<Readonly<Record<PartId, PartChange>>>;
  /** Add a record already applied elsewhere (idempotent). */
  ingest(record: CommitRecord | UndoEntry): void;
  canUndo(actor: string): boolean;
  canRedo(actor: string): boolean;
  /** Next step in a direction, newest first in `history`. */
  peek(actor: string, direction: UndoDirection): UndoStepInfo | undefined;
  history(actor: string): { readonly undo: readonly UndoStepInfo[]; readonly redo: readonly UndoStepInfo[] };
  /** Actors with any step. */
  actors(): readonly string[];
  undo(actor: Actor, signal: AbortSignal, options?: UndoOptions): Promise<Result<UndoOutcome>>;
  redo(actor: Actor, signal: AbortSignal, options?: UndoOptions): Promise<Result<UndoOutcome>>;
  dispose(): void;
  readonly disposed: boolean;
}

// ---------------------------------------------------------------- implementation

interface Step {
  key: string;
  label: string;
  /** Newest first. */
  entries: UndoEntry[];
  group: string | undefined;
}

interface Stacks {
  undo: Step[];
  redo: Step[];
}

const txnOf = (meta: TransactionMeta): string | undefined => (typeof meta.txn === 'string' && meta.txn.length > 0 ? meta.txn : undefined);
const linkOf = (meta: TransactionMeta): { undoOf?: string; redoOf?: string } => {
  const m = meta as UndoMeta;
  return { ...(typeof m.undoOf === 'string' ? { undoOf: m.undoOf } : {}), ...(typeof m.redoOf === 'string' ? { redoOf: m.redoOf } : {}) };
};
const groupOf = (meta: TransactionMeta): string | undefined => meta.invocation ?? meta.changeSet;
const hasOps = (entry: UndoEntry): boolean => Object.values(entry.inverse).some((ops) => ops.length > 0);

function toEntry(record: CommitRecord | UndoEntry): UndoEntry {
  return {
    ...(record.seq === undefined ? {} : { seq: record.seq }),
    peer: record.peer,
    meta: record.meta,
    inverse: record.inverse,
    ...(record.after === undefined ? {} : { after: record.after }),
  };
}

function infoOf(step: Step): UndoStepInfo {
  const newest = step.entries[0] as UndoEntry;
  const parts = new Set<PartId>();
  for (const entry of step.entries) for (const [id, ops] of Object.entries(entry.inverse)) if (ops.length > 0) parts.add(id);
  return {
    key: step.key,
    actor: newest.meta.actor.id,
    label: step.label,
    commits: step.entries.length,
    parts: [...parts].sort(),
    ...(newest.meta.invocation === undefined ? {} : { invocation: newest.meta.invocation }),
    ...(newest.meta.changeSet === undefined ? {} : { changeSet: newest.meta.changeSet }),
  };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

type Target =
  | { readonly type: 'prop'; readonly node: NodeId; readonly path: PropertyPath }
  | { readonly type: 'list'; readonly node: NodeId; readonly path: PropertyPath }
  | { readonly type: 'text'; readonly node: NodeId; readonly path: PropertyPath }
  | { readonly type: 'move'; readonly node: NodeId }
  | { readonly type: 'remove'; readonly node: NodeId }
  | { readonly type: 'recreate'; readonly node: NodeId };

function targetOf(op: PartOp): Target {
  switch (op.op) {
    case 'set':
      return { type: 'prop', node: op.node, path: op.path };
    case 'list.insert':
    case 'list.delete':
    case 'list.move':
    case 'list.set':
      return { type: 'list', node: op.node, path: op.path };
    case 'text.insert':
    case 'text.delete':
    case 'text.mark':
      return { type: 'text', node: op.node, path: op.path };
    case 'move':
      return { type: 'move', node: op.node };
    case 'delete':
      return { type: 'remove', node: op.node };
    case 'create':
      return { type: 'recreate', node: op.node };
  }
}

const targetKey = (t: Target): string => `${t.type}\u0001${t.node}\u0001${'path' in t ? t.path : ''}`;

interface PlannedPart {
  readonly id: PartId;
  readonly crdt: DocumentCRDTv2;
  readonly ops: readonly PartOp[];
  /** After-frontier of the newest entry that wrote each op (undefined: unknown). */
  readonly frontiers: readonly (Frontier | undefined)[];
}

/** Compare every target of a part's inverse with the state right after the step that wrote it. */
function detectConflicts(plan: PlannedPart, stepActor: string): UndoConflict[] {
  const { crdt, ops, frontiers, id } = plan;
  // target → first (newest) op index and its frontier
  const targets = new Map<string, { target: Target; ops: number[]; frontier: Frontier | undefined }>();
  ops.forEach((op, index) => {
    const target = targetOf(op);
    const key = targetKey(target);
    const existing = targets.get(key);
    if (existing === undefined) targets.set(key, { target, ops: [index], frontier: frontiers[index] });
    else existing.ops.push(index);
  });
  const conflicts: UndoConflict[] = [];
  const byFrontier = new Map<Frontier | undefined, { target: Target; ops: number[] }[]>();
  for (const t of targets.values()) {
    const list = byFrontier.get(t.frontier) ?? [];
    list.push(t);
    byFrontier.set(t.frontier, list);
  }
  for (const [frontier, list] of byFrontier) {
    if (frontier === undefined) {
      for (const { target, ops: indices } of list) conflicts.push({ kind: 'history-unavailable', part: id, node: target.node, ...pathOf(target), by: [], ops: indices });
      continue;
    }
    const nodes = [...new Set(list.map((t) => t.target.node))];
    const summary = crdt.changedSince(frontier, { nodes });
    if (!summary.ok) {
      for (const { target, ops: indices } of list) conflicts.push({ kind: 'history-unavailable', part: id, node: target.node, ...pathOf(target), by: [], ops: indices, code: summary.error.code });
      continue;
    }
    let fork: DocumentCRDTv2 | undefined;
    const before = (): DocumentCRDTv2 | undefined => {
      if (fork === undefined) {
        const forked = crdt.fork(randomPeerId(), frontier);
        if (forked.ok) fork = forked.value;
      }
      return fork;
    };
    try {
      for (const { target, ops: indices } of list) {
        const change = summary.value.nodes.get(target.node);
        const by = change === undefined ? [] : change.actors.filter((a) => a !== stepActor);
        const base = { part: id, node: target.node, ...pathOf(target), by: by.length > 0 || change === undefined ? by : change.actors, ops: indices };
        const firstOp = ops[indices[0] as number] as PartOp;
        if (target.type === 'recreate') {
          if (crdt.has(target.node)) conflicts.push({ ...base, kind: 'edited' });
          continue;
        }
        if (!crdt.has(target.node)) {
          conflicts.push({ ...base, kind: 'deleted' });
          continue;
        }
        if (target.type === 'text') continue; // anchored text edits merge with concurrent typing
        if (target.type === 'remove') {
          const inside = crdt.changedSince(frontier, { subtree: target.node });
          if (!inside.ok || inside.value.nodes.size === 0) continue;
          const expected = before()?.subtree(target.node);
          const current = crdt.subtree(target.node);
          if (!same(stripOrder(expected), stripOrder(current))) {
            const actors = new Set<string>();
            for (const c of inside.value.nodes.values()) for (const a of c.actors) if (a !== stepActor) actors.add(a);
            conflicts.push({ ...base, kind: 'edited', by: [...actors].sort() });
          }
          continue;
        }
        if (change === undefined) continue;
        if (target.type === 'move') {
          if (!change.moved) continue;
          const expected = before()?.node(target.node)?.parent ?? null;
          const current = crdt.node(target.node)?.parent ?? null;
          if (!same(expected, current) || !same(before()?.node(target.node)?.order, crdt.node(target.node)?.order)) {
            conflicts.push({ ...base, kind: 'moved', expected, current, restore: firstOp.op === 'move' ? firstOp.parent : null });
          }
          continue;
        }
        if (!change.paths.includes(target.path)) continue;
        const expected = target.type === 'prop' ? before()?.prop(target.node, target.path) : before()?.list(target.node, target.path);
        const current = target.type === 'prop' ? crdt.prop(target.node, target.path) : crdt.list(target.node, target.path);
        if (same(expected, current)) continue;
        conflicts.push({
          ...base,
          kind: 'overwritten',
          ...(expected === undefined ? {} : { expected: expected as JsonValue }),
          ...(current === undefined ? {} : { current: current as JsonValue }),
          ...(firstOp.op === 'set' ? { restore: lastSetValue(ops, indices) } : {}),
        });
      }
    } finally {
      fork?.dispose();
    }
  }
  return conflicts;
}

function pathOf(target: Target): { path?: PropertyPath } {
  return 'path' in target ? { path: target.path } : {};
}

/** The value the step's inverse finally leaves (the last set on the path wins). */
function lastSetValue(ops: readonly PartOp[], indices: readonly number[]): JsonValue {
  const last = ops[indices[indices.length - 1] as number] as Extract<PartOp, { op: 'set' }>;
  return last.value;
}

function stripOrder<T extends { readonly order: string }>(nodes: readonly T[] | undefined): unknown {
  return nodes?.map(({ order: _order, ...rest }) => rest);
}

function stripPosition(op: PartOp): PartOp | undefined {
  if ((op.op === 'move' || op.op === 'create') && op.position !== undefined) {
    const { position: _position, ...rest } = op;
    return rest as PartOp;
  }
  return undefined;
}

/** Validate a part's ops, repairing (dropping a stale position) or dropping invalid ones. */
function repair(crdt: DocumentCRDTv2, part: PartId, input: readonly { op: PartOp; index: number }[]): Result<{ ops: PartOp[]; resolved: UndoConflict[] }> {
  const items = [...input];
  const resolved: UndoConflict[] = [];
  const repaired = new Set<number>();
  for (let guard = 0; guard <= input.length * 2 + 1; guard += 1) {
    const checked = crdt.check(items.map((i) => i.op));
    if (checked.ok) return ok({ ops: items.map((i) => i.op), resolved });
    const at = checked.error.details?.['op'];
    if (typeof at !== 'number' || items[at] === undefined) return err(UndoUnavailableError({ cause: checked.error, details: { part } }));
    const item = items[at] as { op: PartOp; index: number };
    const stripped = repaired.has(item.index) ? undefined : stripPosition(item.op);
    if (stripped !== undefined) {
      repaired.add(item.index);
      items[at] = { op: stripped, index: item.index };
      continue;
    }
    items.splice(at, 1);
    const t = targetOf(item.op);
    resolved.push({ kind: 'invalid', part, node: t.node, ...pathOf(t), by: [], ops: [item.index], code: checked.error.code });
  }
  return err(UndoUnavailableError({ details: { part } }));
}

class UndoServiceImpl implements UndoService {
  private readonly stacks = new Map<string, Stacks>();
  private readonly seen = new Set<string>();
  private readonly limit: number;
  private readonly stop: () => void;
  private chain: Promise<unknown> = Promise.resolve();
  private isDisposed = false;

  constructor(private readonly options: UndoServiceOptions) {
    this.limit = options.limit ?? DEFAULT_UNDO_LIMIT;
    for (const entry of [...options.doc.undoHistory()].reverse()) this.ingest(entry);
    this.stop = options.doc.onCommit((record) => this.ingest(record));
  }

  get disposed(): boolean {
    return this.isDisposed;
  }

  private stacksOf(actor: string): Stacks {
    let s = this.stacks.get(actor);
    if (s === undefined) this.stacks.set(actor, (s = { undo: [], redo: [] }));
    return s;
  }

  private remember(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > this.limit * 8) this.seen.delete(this.seen.values().next().value as string);
    return true;
  }

  ingest(input: CommitRecord | UndoEntry): void {
    if (this.isDisposed) return;
    const entry = toEntry(input);
    const key = txnOf(entry.meta);
    if (key === undefined || !this.remember(key)) return;
    const stacks = this.stacksOf(entry.meta.actor.id);
    const link = linkOf(entry.meta);
    if (link.undoOf !== undefined) {
      const index = stacks.undo.findIndex((s) => s.key === link.undoOf);
      if (index < 0) return;
      const [step] = stacks.undo.splice(index, 1) as [Step];
      if (hasOps(entry)) stacks.redo.push({ key, label: step.label, entries: [entry], group: undefined });
      return;
    }
    if (link.redoOf !== undefined) {
      const index = stacks.redo.findIndex((s) => s.key === link.redoOf);
      if (index < 0) return;
      const [step] = stacks.redo.splice(index, 1) as [Step];
      if (hasOps(entry)) this.push(stacks, { key, label: step.label, entries: [entry], group: undefined });
      return;
    }
    stacks.redo = [];
    const group = groupOf(entry.meta);
    const top = stacks.undo[stacks.undo.length - 1];
    if (group !== undefined && top !== undefined && top.group === group) {
      top.entries.unshift(entry);
      return;
    }
    this.push(stacks, { key, label: entry.meta.label, entries: [entry], group });
  }

  private push(stacks: Stacks, step: Step): void {
    stacks.undo.push(step);
    if (stacks.undo.length > this.limit) stacks.undo.splice(0, stacks.undo.length - this.limit);
  }

  private guarded(changes: Readonly<Record<PartId, readonly PartOp[]>>, actor: Actor): Result<void> {
    if (this.isDisposed) return err(StageDisposedError());
    return this.options.guard?.(changes, actor) ?? ok();
  }

  commit(actor: Actor, label: string, changes: Readonly<Record<PartId, readonly PartOp[]>>, options?: TransactionMetaOptions): Result<Committed> {
    const allowed = this.guarded(changes, actor);
    if (!allowed.ok) return allowed;
    return this.options.doc.commit(transactionMeta(actor, label, options), changes);
  }

  gesture(actor: Actor, label: string, part: PartId, options?: TransactionMetaOptions): Result<Gesture<Committed>> {
    if (this.isDisposed) return err(StageDisposedError());
    return ok(createGesture<Committed>({ transact: (meta, ops) => this.commitMeta(actor, meta, { [part]: ops }) }, transactionMeta(actor, label, options)));
  }

  private commitMeta(actor: Actor, meta: TransactionMeta, changes: Readonly<Record<PartId, readonly PartOp[]>>): Result<Committed> {
    const allowed = this.guarded(changes, actor);
    if (!allowed.ok) return allowed;
    return this.options.doc.commit(meta, changes);
  }

  applyRemote(record: CommitRecord): Result<Readonly<Record<PartId, PartChange>>> {
    if (this.isDisposed) return err(StageDisposedError());
    const applied = this.options.doc.applyRemote(record);
    if (applied.ok) this.ingest(record);
    return applied;
  }

  canUndo(actor: string): boolean {
    return (this.stacks.get(actor)?.undo.length ?? 0) > 0;
  }

  canRedo(actor: string): boolean {
    return (this.stacks.get(actor)?.redo.length ?? 0) > 0;
  }

  peek(actor: string, direction: UndoDirection): UndoStepInfo | undefined {
    const list = this.stacks.get(actor)?.[direction];
    const top = list?.[list.length - 1];
    return top === undefined ? undefined : infoOf(top);
  }

  history(actor: string): { readonly undo: readonly UndoStepInfo[]; readonly redo: readonly UndoStepInfo[] } {
    const s = this.stacks.get(actor);
    return { undo: [...(s?.undo ?? [])].reverse().map(infoOf), redo: [...(s?.redo ?? [])].reverse().map(infoOf) };
  }

  actors(): readonly string[] {
    return [...this.stacks.entries()].filter(([, s]) => s.undo.length + s.redo.length > 0).map(([a]) => a).sort();
  }

  undo(actor: Actor, signal: AbortSignal, options?: UndoOptions): Promise<Result<UndoOutcome>> {
    return this.serial(() => this.run('undo', actor, signal, options ?? {}));
  }

  redo(actor: Actor, signal: AbortSignal, options?: UndoOptions): Promise<Result<UndoOutcome>> {
    return this.serial(() => this.run('redo', actor, signal, options ?? {}));
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async run(direction: UndoDirection, actor: Actor, signal: AbortSignal, options: UndoOptions): Promise<Result<UndoOutcome>> {
    if (this.isDisposed) return err(StageDisposedError());
    const list = this.stacks.get(actor.id)?.[direction];
    const step = list?.[list.length - 1];
    if (step === undefined) return ok({ kind: 'empty', direction });
    const info = infoOf(step);
    // Gather the inverse per part, newest entry first, remembering which entry wrote each op.
    const perPart = new Map<PartId, { ops: PartOp[]; frontiers: (Frontier | undefined)[] }>();
    for (const entry of step.entries) {
      for (const [id, ops] of Object.entries(entry.inverse)) {
        if (ops.length === 0) continue;
        let slot = perPart.get(id);
        if (slot === undefined) perPart.set(id, (slot = { ops: [], frontiers: [] }));
        const frontier = entry.after?.[id];
        for (const op of ops) {
          slot.ops.push(op);
          slot.frontiers.push(frontier);
        }
      }
    }
    const plans: PlannedPart[] = [];
    for (const [id, slot] of perPart) {
      const crdt = await this.options.doc.part(id, signal);
      if (!crdt.ok) return crdt;
      plans.push({ id, crdt: crdt.value, ops: slot.ops, frontiers: slot.frontiers });
    }
    if (signal.aborted) return err(AbortedError({ message: 'Undo aborted before it was applied.', cause: signal.reason }));
    if (this.isDisposed) return err(StageDisposedError());
    // Steps are consumed in order; re-check that this one is still on top after the awaits.
    if (list?.[list.length - 1] !== step) return this.run(direction, actor, signal, options);
    const policy = options.onConflict ?? 'flag';
    const detected = plans.flatMap((plan) => detectConflicts(plan, actor.id));
    const changes: Record<PartId, readonly PartOp[]> = {};
    const resolved: UndoConflict[] = [];
    for (const plan of plans) {
      const conflicting = new Set(detected.filter((c) => c.part === plan.id).flatMap((c) => c.ops));
      const keep = plan.ops.map((op, index) => ({ op, index })).filter(({ index }) => policy !== 'keep-theirs' || !conflicting.has(index));
      if (policy === 'flag') {
        const checked = plan.crdt.check(keep.map((k) => k.op));
        if (!checked.ok) {
          const at = checked.error.details?.['op'];
          const item = typeof at === 'number' ? keep[at] : undefined;
          const t = item === undefined ? undefined : targetOf(item.op);
          detected.push({ kind: 'invalid', part: plan.id, node: t?.node ?? '', ...(t === undefined ? {} : pathOf(t)), by: [], ops: item === undefined ? [] : [item.index], code: checked.error.code });
        }
        changes[plan.id] = keep.map((k) => k.op);
        continue;
      }
      const fixed = repair(plan.crdt, plan.id, keep);
      if (!fixed.ok) return fixed;
      resolved.push(...detected.filter((c) => c.part === plan.id), ...fixed.value.resolved);
      if (fixed.value.ops.length > 0) changes[plan.id] = fixed.value.ops;
    }
    if (policy === 'flag' && detected.length > 0) return ok({ kind: 'conflict', direction, step: info, conflicts: detected });
    const allowed = this.guarded(changes, actor);
    if (!allowed.ok) return allowed;
    const meta: UndoMeta = {
      ...transactionMeta(actor, `${direction === 'undo' ? 'Undo' : 'Redo'} ${step.label}`),
      ...(direction === 'undo' ? { undoOf: step.key } : { redoOf: step.key }),
    };
    const committed = this.options.doc.commit(meta, changes);
    if (!committed.ok) return committed;
    // The commit listener consumed the step; make sure even a foreign UndoTarget without listeners does.
    this.ingest(committed.value.record);
    return ok({ kind: 'applied', direction, step: info, record: committed.value.record, resolved });
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.stop();
    this.stacks.clear();
    this.seen.clear();
  }
}

/** Create the undo service over an open document (rebuilds every actor's stacks from its persisted history). */
export function createUndoService(options: UndoServiceOptions): UndoService {
  return new UndoServiceImpl(options);
}
