/**
 * On-canvas repeat handles (IF-26.20–26.22): the simple parameters get a drag handle — radial **radius** (at the
 * circle's centre, along the source direction) and **count** (on the second instance, around the circle), grid
 * **columns** and **rows** (past the last column / row), mirror **offset** (on the axis, along its normal).
 * Headless: `repeatHandles` gives page positions and drag directions for B3's overlay; `handlePatch` maps a page
 * point to a parameter patch; `beginHandleDrag` previews a drag in the session layer and commits it as one change
 * set (machine `instaflow/repeat-handle-drag`, LIFECYCLES §27). Every handle has a keyboard path: the same
 * parameter in the Repeat panel.
 */
import { AbortedError, createMachine, defineMachine, err, ok, type Result } from '@staticflux/core';
import type { Box } from '@staticflux/document/spatial-index';
import type { JsonValue, NodeId } from '@staticflux/document/v2';
import type { Actor, SessionLayer } from '@staticflux/stage';
import type { EditTarget } from '../elements/actions.js';
import { pageTransform } from '../elements/layout.js';
import { type Affine, applyAffine, invert } from '../elements/resolve.js';
import { commitRepeatEdit, liveRepeat, type RepeatContext } from './actions.js';
import { type RepeatKind, RP } from './components.js';
import { HandleDragError } from './errors.js';
import { mirrorAxis, radialCenter, radialStep } from './instances.js';
import { type GridParams, type MirrorParams, patchOps, type RadialParams, REPEAT_LIMITS, type RepeatParams, type RepeatPatch } from './params.js';

export const REPEAT_HANDLE_IDS = ['radius', 'count', 'columns', 'rows', 'offset'] as const;
export type RepeatHandleId = (typeof REPEAT_HANDLE_IDS)[number];

export interface RepeatHandle {
  readonly id: RepeatHandleId;
  readonly node: NodeId;
  readonly label: string;
  /** Page position. */
  readonly position: readonly [number, number];
  /** Unit drag direction in page space (the overlay draws it; drags may go anywhere). */
  readonly direction: readonly [number, number];
}

type Vec = readonly [number, number];
interface HandleSpec<T extends RepeatParams> {
  readonly id: RepeatHandleId;
  readonly label: string;
  readonly position: (p: T, content: Box) => Vec;
  readonly direction: (p: T, content: Box) => Vec;
  readonly drag: (p: T, content: Box, local: Vec) => RepeatPatch;
}

const RAD = Math.PI / 180;
const dir = (deg: number): Vec => [Math.sin(deg * RAD), -Math.cos(deg * RAD)];
const center = (b: Box): Vec => [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
const clampInt = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(v)));
/** Clockwise angle (degrees, [0, 360)) of `v` from 12 o'clock. */
const angleOf = (v: Vec): number => ((Math.atan2(v[0], -v[1]) / RAD) % 360 + 360) % 360;
const countHandleTurn = (p: RadialParams): number => (p.count > 1 ? radialStep(p) : Math.min(p.sweep, 180));

const RADIAL: readonly HandleSpec<RadialParams>[] = [
  {
    id: 'radius',
    label: 'Radius',
    position: (p, c) => radialCenter(p, c),
    direction: (p) => dir(p.startAngle),
    drag: (p, c, local) => {
      const s = center(c);
      const d = dir(p.startAngle);
      return { radius: Math.max(0, (s[0] - local[0]) * d[0] + (s[1] - local[1]) * d[1]) };
    },
  },
  {
    id: 'count',
    label: 'Count',
    position: (p, c) => {
      const o = radialCenter(p, c);
      const d = dir(p.startAngle + countHandleTurn(p));
      return [o[0] + p.radius * d[0], o[1] + p.radius * d[1]];
    },
    direction: (p) => dir(p.startAngle + countHandleTurn(p) + 90),
    drag: (p, c, local) => {
      const o = radialCenter(p, c);
      const turn = Math.max(1, (angleOf([local[0] - o[0], local[1] - o[1]]) - p.startAngle + 720) % 360);
      const count = p.sweep >= 360 ? 360 / turn : p.sweep / turn + 1;
      return { count: clampInt(count, REPEAT_LIMITS.count.min, REPEAT_LIMITS.count.max) };
    },
  },
];

const cell = (p: GridParams, c: Box): Vec => [c.maxX - c.minX + p.gapX, c.maxY - c.minY + p.gapY];

const GRID: readonly HandleSpec<GridParams>[] = [
  {
    id: 'columns',
    label: 'Columns',
    position: (p, c) => [c.minX + p.columns * cell(p, c)[0] - p.gapX / 2, (c.minY + c.maxY) / 2],
    direction: () => [1, 0],
    drag: (p, c, local) => {
      const w = cell(p, c)[0];
      return w > 0 ? { columns: clampInt((local[0] - c.minX + p.gapX / 2) / w, REPEAT_LIMITS.columns.min, Math.min(REPEAT_LIMITS.columns.max, Math.floor(REPEAT_LIMITS.instances / p.rows))) } : {};
    },
  },
  {
    id: 'rows',
    label: 'Rows',
    position: (p, c) => [(c.minX + c.maxX) / 2, c.minY + p.rows * cell(p, c)[1] - p.gapY / 2],
    direction: () => [0, 1],
    drag: (p, c, local) => {
      const h = cell(p, c)[1];
      return h > 0 ? { rows: clampInt((local[1] - c.minY + p.gapY / 2) / h, REPEAT_LIMITS.rows.min, Math.min(REPEAT_LIMITS.rows.max, Math.floor(REPEAT_LIMITS.instances / p.columns))) } : {};
    },
  },
];

const MIRROR: readonly HandleSpec<MirrorParams>[] = [
  {
    id: 'offset',
    label: 'Axis offset',
    position: (p, c) => mirrorAxis(p, c).point,
    direction: (p, c) => mirrorAxis(p, c).normal,
    drag: (p, c, local) => {
      const axis = mirrorAxis(p, c);
      return { offset: p.offset + (local[0] - axis.point[0]) * axis.normal[0] + (local[1] - axis.point[1]) * axis.normal[1] };
    },
  },
];

/** Handles per generator (a variant table). */
const HANDLES: { readonly [K in RepeatKind]: readonly HandleSpec<Extract<RepeatParams, { kind: K }>>[] } = { radial: RADIAL, grid: GRID, mirror: MIRROR };

const specsOf = (p: RepeatParams): readonly HandleSpec<RepeatParams>[] => HANDLES[p.kind] as readonly HandleSpec<RepeatParams>[];

const linear = (t: Affine): Affine => [t[0], t[1], t[2], t[3], 0, 0];
const unit = (v: Vec): Vec => {
  const n = Math.hypot(v[0], v[1]);
  return n > 0 ? [v[0] / n, v[1] / n] : [0, 0];
};

/** The handles of a live repeat, in page space. */
export function repeatHandles(ctx: RepeatContext, node: NodeId): Result<readonly RepeatHandle[]> {
  const live = liveRepeat(ctx, node);
  if (!live.ok) return live;
  const { params, content } = live.value;
  const toPage = pageTransform(ctx, node);
  return ok(
    specsOf(params).map((spec) => ({
      id: spec.id,
      node,
      label: spec.label,
      position: applyAffine(toPage, ...spec.position(params, content)),
      direction: unit(applyAffine(linear(toPage), ...spec.direction(params, content))),
    })),
  );
}

interface Frame {
  readonly params: RepeatParams;
  readonly content: Box;
  readonly toLocal: Affine;
  readonly spec: HandleSpec<RepeatParams>;
}

function frameOf(ctx: RepeatContext, node: NodeId, handle: RepeatHandleId): Result<Frame> {
  const live = liveRepeat(ctx, node);
  if (!live.ok) return live;
  const spec = specsOf(live.value.params).find((s) => s.id === handle);
  if (spec === undefined) return err(HandleDragError({ message: `A ${live.value.params.kind} repeat has no "${handle}" handle.`, details: { node, handle } }));
  const toLocal = invert(pageTransform(ctx, node));
  if (toLocal === undefined) return err(HandleDragError({ message: `"${node}" has a singular transform.`, details: { node, handle } }));
  return ok({ params: live.value.params, content: live.value.content, toLocal, spec });
}

/** The parameter patch for dragging `handle` to a page point. */
export function handlePatch(ctx: RepeatContext, node: NodeId, handle: RepeatHandleId, point: readonly [number, number]): Result<RepeatPatch> {
  const frame = frameOf(ctx, node, handle);
  if (!frame.ok) return frame;
  const f = frame.value;
  return ok(f.spec.drag(f.params, f.content, applyAffine(f.toLocal, point[0], point[1])));
}

export const RepeatHandleDragLifecycle = defineMachine({
  id: 'instaflow/repeat-handle-drag',
  initial: 'dragging',
  states: ['dragging', 'committed', 'cancelled', 'failed'],
  transitions: { dragging: { move: 'dragging', commit: 'committed', cancel: 'cancelled', fail: 'failed' } },
  terminal: ['committed', 'cancelled', 'failed'],
});
export type HandleDragState = (typeof RepeatHandleDragLifecycle.states)[number];

export interface HandleDragEnv {
  readonly context: RepeatContext;
  /** The stage's session layer: the drag previews there (live instances follow) and clears it when it ends. */
  readonly session: Pick<SessionLayer, 'set' | 'clear'>;
  readonly target: EditTarget;
}

export interface HandleDrag {
  readonly state: HandleDragState;
  /** The patch of the last move (empty before the first). */
  readonly patch: RepeatPatch;
  /** Preview the drag at a page point (session layer only; nothing is written). */
  move(point: readonly [number, number]): Result<RepeatPatch>;
  /** Write the last patch as one change set (one undo step) and end. */
  commit(actor: Actor): Result<void>;
  /** End without writing (Esc, pointercancel, abort). */
  cancel(): void;
}

/**
 * Start dragging a handle. Positions map against the repeat as it was when the drag began, so the preview never
 * feeds back into the drag. Aborting `signal` cancels.
 */
export function beginHandleDrag(env: HandleDragEnv, node: NodeId, handle: RepeatHandleId, options: { readonly signal: AbortSignal }): Result<HandleDrag> {
  if (options.signal.aborted) return err(AbortedError({ cause: options.signal.reason }));
  const frame = frameOf(env.context, node, handle);
  if (!frame.ok) return frame;
  const f = frame.value;
  const machine = createMachine(RepeatHandleDragLifecycle);
  let patch: RepeatPatch = {};
  const previewed = new Set<string>();
  const clear = (): void => {
    for (const path of previewed) env.session.clear(node, path);
    previewed.clear();
  };
  const ended = (): Result<never> => err(HandleDragError({ message: `The drag already ended (${machine.state}).`, details: { node, handle, state: machine.state } }));
  const onAbort = (): void => drag.cancel();
  const finish = (event: 'commit' | 'cancel' | 'fail'): void => {
    clear();
    options.signal.removeEventListener('abort', onAbort);
    machine.send(event);
  };
  const drag: HandleDrag = {
    get state() {
      return machine.state;
    },
    get patch() {
      return patch;
    },
    move(point) {
      if (!machine.can('move')) return ended();
      patch = f.spec.drag(f.params, f.content, applyAffine(f.toLocal, point[0], point[1]));
      for (const [name, value] of Object.entries(patch)) {
        const path = RP[name as keyof typeof RP];
        env.session.set(node, path, value as JsonValue);
        previewed.add(path);
      }
      machine.send('move');
      return ok(patch);
    },
    commit(actor) {
      if (!machine.can('commit')) return ended();
      const ops = patchOps(node, patch);
      clear();
      if (ops.length === 0) {
        finish('cancel');
        return ok();
      }
      const committed = commitRepeatEdit(env.target, actor, `Repeat ${handle}`, ok(ops), () => f.params);
      finish(committed.ok ? 'commit' : 'fail');
      return committed;
    },
    cancel() {
      if (machine.can('cancel')) finish('cancel');
    },
  };
  options.signal.addEventListener('abort', onAbort, { once: true });
  return ok(drag);
}
