/**
 * One commit per gesture (D14, S4): a drag, a resize or a typing burst stages
 * ops frame by frame and commits ONCE. S4 measured 12.8 KB for a 1k-node drag
 * committed once, against 146 KB of log when committing every frame.
 *
 * Staged ops are coalesced: only the last `set` of a (node, path) and the last
 * `move` of a node are kept, so the commit carries the gesture's end state,
 * not its trajectory. Previews during
 * the gesture come from `pending()` (the stage's session layer, SF-Δ7), never
 * from the CRDT.
 *
 * Lifecycle `document/gesture`: open → committed | aborted (docs/LIFECYCLES.md).
 */
import { createMachine, defineMachine, err, ok, type Result } from '@staticflux/core';
import type { PartOp, TransactionMeta } from './crdt-v2.js';
import { DocumentClosedError } from './errors.js';

export const GestureMachine = /* @__PURE__ */ defineMachine({
  id: 'document/gesture',
  initial: 'open',
  states: ['open', 'committed', 'aborted'],
  transitions: { open: { commit: 'committed', abort: 'aborted' } },
  terminal: ['committed', 'aborted'],
});

export type GestureState = (typeof GestureMachine.states)[number];

/** Anything that applies ops as one commit: a `DocumentCRDTv2`, or a repo document's part (`doc.gesture`). */
export interface GestureTarget<R> {
  transact(meta: TransactionMeta, ops: readonly PartOp[]): Result<R>;
}

export interface Gesture<R = unknown> {
  readonly state: GestureState;
  readonly meta: TransactionMeta;
  /** Add ops for this frame (coalesced with earlier frames). */
  stage(ops: readonly PartOp[]): Result<void>;
  /** The coalesced ops so far (for previews). */
  pending(): readonly PartOp[];
  /** Apply the coalesced ops as one commit. An empty gesture commits nothing and returns `undefined`. */
  commit(): Result<R | undefined>;
  /** Drop the staged ops. */
  abort(): void;
}

function coalesceKey(op: PartOp): string | undefined {
  if (op.op === 'set') return `set\u0001${op.node}\u0001${op.path}`;
  if (op.op === 'move') return `move\u0001${op.node}`;
  return undefined;
}

/**
 * Coalesce a list of ops: only the last `set` per (node, path) and the last `move` per node are kept, at the
 * position of that last occurrence (so a move into a parent created mid-gesture stays after the create).
 */
export function coalesceOps(ops: readonly PartOp[]): readonly PartOp[] {
  const last = new Map<string, number>();
  ops.forEach((op, i) => {
    const key = coalesceKey(op);
    if (key !== undefined) last.set(key, i);
  });
  return ops.filter((op, i) => {
    const key = coalesceKey(op);
    return key === undefined || last.get(key) === i;
  });
}

export function createGesture<R>(target: GestureTarget<R>, meta: TransactionMeta): Gesture<R> {
  const machine = createMachine(GestureMachine);
  let staged: PartOp[] = [];
  const closed = (): Result<never> => err(DocumentClosedError({ message: `The gesture is ${machine.state}.`, details: { state: machine.state } }));
  return {
    meta,
    get state() {
      return machine.state;
    },
    stage(ops) {
      if (!machine.is('open')) return closed();
      staged = coalesceOps([...staged, ...ops]) as PartOp[];
      return ok();
    },
    pending: () => staged,
    commit() {
      if (!machine.can('commit')) return closed();
      const ops = staged;
      if (ops.length === 0) {
        machine.send('commit');
        return ok(undefined);
      }
      const result = target.transact(meta, ops);
      if (!result.ok) return result; // stays open: the caller may fix or abort
      machine.send('commit');
      staged = [];
      return result;
    },
    abort() {
      if (machine.send('abort').ok) staged = [];
    },
  };
}
