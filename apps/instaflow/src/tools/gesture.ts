/**
 * The pointer tools (IF-24.2–24.7, IF-24.14–24.16, IF-24.19): select (click, Shift+click, Mod+click deep select,
 * double click to enter a group or frame, marquee with Alt for "fully inside"), move, resize and rotate through the
 * round handles, and the hand (pan). B10a adds skew (Mod-drag a side handle), the draggable pivot (Alt-click resets
 * it), flips on a resize past the opposite edge, and transform mode's behaviour. One controller per tab over the open
 * page (`ToolSession`); headless — the canvas feeds it pointer events in screen pixels and draws `view.overlay`.
 *
 * **One drag = one undo step**: while dragging, new values are previews in the stage's **session layer** (never
 * persisted, drawn through the render projection like any composed value); on release they are cleared and
 * committed as one change set through B1's `commitEdit` (value checks, locks, final paths, brand rules). Escape or
 * pointercancel clears the preview and commits nothing. Position-locked elements never move. In transform mode
 * (B10a, `transform-mode.ts`) a released drag is staged into the session instead (`SINKS`).
 *
 * **No branch on mode** (rule 4): what a press starts is data — `PRESS_GESTURES[behaviour][pressTarget]` — and each
 * gesture kind is a strategy in `GESTURES` (begin, update, end). The active tool's behaviour comes from
 * `TOOL_BEHAVIOURS`, overridden by `MODE_BEHAVIOURS` while a transform session is active. Machine:
 * `ToolGestureLifecycle` (`instaflow/tool-gesture`, LIFECYCLES §25).
 */
import { createMachine, defineMachine, err, ok, type Result } from '@staticflux/core';
import type { Box } from '@staticflux/document/spatial-index';
import type { NodeId } from '@staticflux/document/v2';
import type { Actor, SessionLayer, Stage } from '@staticflux/stage';
import { commitEdit, type EditTarget } from '../elements/actions.js';
import { applyAffine, IDENTITY, invert } from '../elements/resolve.js';
import { elementBounds } from '../elements/layout.js';
import { StudioIds } from '../spec/studio-ids.js';
import { GestureStateError, TargetGoneError } from './errors.js';
import { CENTER_PIVOT, frameBasis, isCenterPivot, pivotFraction, pivotPoint, SKEW_HANDLES, type SkewHandleId, skewValues, snapPivot } from './free-transform.js';
import { type ElementIndex, hitTest, marqueeSelect, rectFrom, type ToolContext } from './hit-test.js';
import { EMPTY_OVERLAY, type ToolOverlay } from './overlay.js';
import { collectSnapTargets, type Guide, type GuideLabel, shiftBox, SNAP_THRESHOLD_PX, type SnapFeature, snapBox, type SnapTargets } from './snapping.js';
import { createPreview, type Preview, type TransformMode, type TransformModeState } from './transform-mode.js';
import {
  angleAbout,
  axisAligned,
  captureTransform,
  HANDLE_DIRECTIONS,
  type HandleKind,
  moveValues,
  pickHandle,
  type ResizeHandleId,
  resizedBounds,
  resizedSize,
  resizeValues,
  rotateValues,
  selectionFrame,
  snapRotation,
  type SpatialValues,
  type TransformHandle,
  transformHandles,
  type TransformStart,
  valuesToOps,
} from './transform.js';
import { toPage, type ViewState } from './view-state.js';

/** The open page a tool edits (one per tab and page). */
export interface ToolSession {
  readonly ctx: ToolContext & { readonly stage: Pick<Stage, 'read' | 'children' | 'value' | 'lockOf' | 'onInvalidate' | 'checkWrite'> };
  /** B1's commit target (undo service, stage, page part). */
  readonly target: EditTarget;
  /** The stage's session layer: gesture previews. */
  readonly session: Pick<SessionLayer, 'set' | 'clear'>;
  readonly index: ElementIndex;
  readonly view: ViewState;
  /** The person at the pointer (attribution of commits). */
  readonly actor: () => Actor;
  /** B10a: the tab's transform session (Mod+T); without one, gestures always commit at once. */
  readonly mode?: TransformMode;
}

export const ToolGestureLifecycle = /* @__PURE__ */ defineMachine({
  id: 'instaflow/tool-gesture',
  initial: 'idle',
  states: ['idle', 'pressed', 'moving', 'resizing', 'rotating', 'skewing', 'pivoting', 'marqueeing', 'panning'],
  transitions: {
    idle: { press: 'pressed' },
    pressed: { move: 'moving', resize: 'resizing', rotate: 'rotating', skew: 'skewing', pivot: 'pivoting', marquee: 'marqueeing', pan: 'panning', release: 'idle', cancel: 'idle' },
    moving: { release: 'idle', cancel: 'idle' },
    resizing: { release: 'idle', cancel: 'idle' },
    rotating: { release: 'idle', cancel: 'idle' },
    skewing: { release: 'idle', cancel: 'idle' },
    pivoting: { release: 'idle', cancel: 'idle' },
    marqueeing: { release: 'idle', cancel: 'idle' },
    panning: { release: 'idle', cancel: 'idle' },
  },
});
export type ToolGestureState = (typeof ToolGestureLifecycle.states)[number];

export const DRAG_KINDS = ['move', 'resize', 'rotate', 'skew', 'pivot', 'marquee', 'pan'] as const;
export type DragKind = (typeof DRAG_KINDS)[number];

/** What is under the pointer when it goes down (`skew-handle`: a side handle pressed with Mod, B10a). */
export const PRESS_TARGETS = ['resize-handle', 'rotate-handle', 'skew-handle', 'pivot-handle', 'element', 'selected', 'empty'] as const;
export type PressTarget = (typeof PRESS_TARGETS)[number];

/** `transform`: the select tool while a transform session is active (B10a). */
export const TOOL_BEHAVIOURS_LIST = ['select', 'hand', 'transform'] as const;
export type ToolBehaviour = (typeof TOOL_BEHAVIOURS_LIST)[number];

/** Which gesture a drag starts, per tool behaviour and press target (data, rule 4). */
export const PRESS_GESTURES: Readonly<Record<ToolBehaviour, Readonly<Record<PressTarget, DragKind>>>> = Object.freeze({
  select: { 'resize-handle': 'resize', 'rotate-handle': 'rotate', 'skew-handle': 'skew', 'pivot-handle': 'pivot', element: 'move', selected: 'move', empty: 'marquee' },
  hand: { 'resize-handle': 'pan', 'rotate-handle': 'pan', 'skew-handle': 'pan', 'pivot-handle': 'pan', element: 'pan', selected: 'pan', empty: 'pan' },
  // Free Transform: a press anywhere inside moves the session's elements, outside the frame rotates them.
  transform: { 'resize-handle': 'resize', 'rotate-handle': 'rotate', 'skew-handle': 'skew', 'pivot-handle': 'pivot', element: 'move', selected: 'move', empty: 'rotate' },
});

/** Tool contribution id → pointer behaviour (other tools, e.g. B2's text, bring their own controllers). */
export const TOOL_BEHAVIOURS: Readonly<Record<string, ToolBehaviour>> = Object.freeze({ [StudioIds.tool.select]: 'select', [StudioIds.tool.hand]: 'hand' });

/** The behaviour a transform session imposes (undefined: the tool's own). */
export const MODE_BEHAVIOURS: Readonly<Record<TransformModeState, ToolBehaviour | undefined>> = Object.freeze({ idle: undefined, active: 'transform' });

/** Screen-pixel constants. */
export const POINTER = Object.freeze({ dragSlop: 3, hitTolerance: 3 });

export interface ToolPointer {
  readonly phase: 'down' | 'move' | 'up' | 'cancel';
  /** Screen pixels in the canvas. */
  readonly x: number;
  readonly y: number;
  readonly shift?: boolean;
  readonly alt?: boolean;
  /** Cmd on macOS, Ctrl elsewhere: deep select on press, no snapping while dragging, skew on a side handle. */
  readonly mod?: boolean;
  /** Click count on `down` (2 = double click). */
  readonly clicks?: number;
}

export type ToolOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'selection'; readonly selection: readonly NodeId[] }
  | { readonly kind: 'committed'; readonly label: string; readonly ops: number }
  /** B10a: a step joined the active transform session (committed with it on Enter). */
  | { readonly kind: 'staged'; readonly label: string }
  /** B10a: the transform session started. */
  | { readonly kind: 'mode'; readonly state: TransformModeState }
  | { readonly kind: 'cancelled' };

const NONE: ToolOutcome = Object.freeze({ kind: 'none' });

interface Press {
  readonly sx: number;
  readonly sy: number;
  readonly page: readonly [number, number];
  readonly target: PressTarget;
  readonly handle?: TransformHandle;
  readonly behaviour: ToolBehaviour;
  /** An already selected element pressed: released without a drag, it becomes the only selection. */
  readonly reselect?: NodeId;
}

interface Modifiers {
  readonly shift: boolean;
  readonly alt: boolean;
  readonly mod: boolean;
}

/** Where a transform gesture previews and what its release does (B10a: commit now, or stage into the session). */
interface GestureSink {
  readonly preview: Preview;
  end(start: TransformStart, values: readonly SpatialValues[], label: string): Result<ToolOutcome>;
  cancel(): void;
}

interface GestureContext {
  readonly s: ToolSession;
  readonly press: Press;
  readonly sink: GestureSink;
}

/** A gesture kind: begin once the pointer leaves the slop, update on every move, end on release. */
interface GestureStrategy {
  begin(g: GestureContext, mods: Modifiers): Result<GestureRun>;
}

interface GestureRun {
  update(page: readonly [number, number], screen: readonly [number, number], mods: Modifiers): void;
  end(): Result<ToolOutcome>;
  cancel(): void;
}

const threshold = (s: ToolSession): number => SNAP_THRESHOLD_PX / s.view.camera.zoom;

/** Commit a transform gesture's values as one change set (targets deleted meanwhile are dropped). */
function commitValues(s: ToolSession, start: TransformStart, values: readonly SpatialValues[], label: string): Result<ToolOutcome> {
  const alive = values.filter((v) => s.ctx.stage.read(v.node) !== undefined);
  pruneSelection(s);
  if (alive.length === 0) return err(TargetGoneError({ details: { nodes: values.map((v) => v.node) } }));
  const ops = valuesToOps(start, alive);
  if (ops.length === 0) return ok(NONE);
  const committed = commitEdit(s.target, s.actor(), label, ok(ops));
  return committed.ok ? ok({ kind: 'committed', label, ops: ops.length }) : committed;
}

/** Gesture sinks per transform-session state (rule 4). */
export const SINKS: Readonly<Record<TransformModeState, (s: ToolSession) => GestureSink>> = Object.freeze({
  idle(s: ToolSession): GestureSink {
    const preview = createPreview(s.session);
    return {
      preview,
      end(start, values, label) {
        preview.clear();
        return commitValues(s, start, values, label);
      },
      cancel: () => preview.clear(),
    };
  },
  active(s: ToolSession): GestureSink {
    const mode = s.mode as TransformMode;
    return {
      preview: mode.preview,
      end(_start, values, label) {
        mode.stage(values, label);
        return ok({ kind: 'staged', label });
      },
      cancel: () => mode.restore(),
    };
  },
});

const modeState = (s: Pick<ToolSession, 'mode'>): TransformModeState => s.mode?.state ?? 'idle';

function transformRun(g: GestureContext, start: TransformStart, label: string, compute: (page: readonly [number, number], mods: Modifiers) => { values: SpatialValues[]; guides: readonly Guide[]; labels: readonly GuideLabel[] }): GestureRun {
  let last: SpatialValues[] = [];
  return {
    update(page, _screen, mods) {
      const r = compute(page, mods);
      last = r.values;
      g.sink.preview.show(r.values);
      refreshOverlay(g.s, { guides: r.guides, labels: r.labels });
    },
    end() {
      const outcome = g.sink.end(start, last, label);
      refreshOverlay(g.s);
      return outcome;
    },
    cancel() {
      g.sink.cancel();
      refreshOverlay(g.s);
    },
  };
}

const movingFeatures = (d: -1 | 0 | 1): readonly SnapFeature[] => (d === 1 ? ['max'] : d === -1 ? ['min'] : []);

/** The pivot of a start snapshot on the page (the view's pivot fractions in the start's frame). */
const pivotOf = (s: ToolSession, start: TransformStart): readonly [number, number] => pivotPoint(start.frame, s.view.pivot);

/** The gesture strategies (rule 4: chosen from data, never by mode). */
export const GESTURES: Readonly<Record<DragKind, GestureStrategy>> = Object.freeze({
  move: {
    begin(g) {
      const start = captureTransform(g.s.ctx, g.s.view.selection);
      if (!start.ok) return start;
      const targets = collectSnapTargets(g.s.ctx, { moving: start.value.elements.map((e) => e.node) });
      if (!targets.ok) return targets;
      const frame = start.value.frame.bounds;
      return ok(
        transformRun(g, start.value, 'Move', (page, mods) => {
          let dx = page[0] - g.press.page[0];
          let dy = page[1] - g.press.page[1];
          if (mods.shift) {
            if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
            else dx = 0;
          }
          let guides: readonly Guide[] = [];
          let labels: readonly GuideLabel[] = [];
          if (!mods.mod) {
            const r = snapBox(shiftBox(frame, dx, dy), targets.value, {
              threshold: threshold(g.s),
              ...(mods.shift ? { features: { x: dy === 0 ? ['min', 'center', 'max'] : [], y: dx === 0 ? ['min', 'center', 'max'] : [] } } : {}),
            });
            dx += r.dx;
            dy += r.dy;
            guides = r.guides;
            labels = r.labels;
          }
          return { values: moveValues(start.value, dx, dy), guides, labels };
        }),
      );
    },
  },
  resize: {
    begin(g) {
      const handle = g.press.handle?.id as ResizeHandleId;
      const start = captureTransform(g.s.ctx, g.s.view.selection);
      if (!start.ok) return start;
      const targets = collectSnapTargets(g.s.ctx, { moving: start.value.elements.map((e) => e.node) });
      if (!targets.ok) return targets;
      const [hx, hy] = HANDLE_DIRECTIONS[handle];
      const single = start.value.elements.length === 1 ? start.value.elements[0] : undefined;
      const snappable = single === undefined || axisAligned(single.transform);
      const pivot = g.s.view.pivot;
      const b = start.value.frame.bounds;
      return ok(
        transformRun(g, start.value, 'Resize', (page, mods) => {
          let dx = page[0] - g.press.page[0];
          let dy = page[1] - g.press.page[1];
          // Alt: about the pivot (B10a; the centre unless it was moved).
          const options = { aspect: mods.shift, fromCenter: mods.alt, ...(pivot === undefined ? {} : { pivot }) };
          let guides: readonly Guide[] = [];
          const signed = resizedSize(b.maxX - b.minX, b.maxY - b.minY, handle, dx, dy, options);
          // A flipped box has its dragged edge on the other side: no edge snapping past the fixed point.
          if (snappable && !mods.mod && !mods.shift && signed.w > 0 && signed.h > 0) {
            const raw = resizedBounds(b, handle, dx, dy, options);
            const r = snapBox(raw, targets.value, { threshold: threshold(g.s), spacing: false, features: { x: movingFeatures(hx), y: movingFeatures(hy) } });
            // The dragged edge moves by exactly the pointer delta (also about the centre), so the snap offset adds up.
            dx += r.dx;
            dy += r.dy;
            guides = r.guides;
          }
          return { values: resizeValues(start.value, handle, dx, dy, options), guides, labels: [] };
        }),
      );
    },
  },
  rotate: {
    begin(g) {
      const start = captureTransform(g.s.ctx, g.s.view.selection);
      if (!start.ok) return start;
      const pivot = pivotOf(g.s, start.value);
      const from = angleAbout(pivot, g.press.page[0], g.press.page[1]);
      return ok(
        transformRun(g, start.value, 'Rotate', (page, mods) => {
          let degrees = angleAbout(pivot, page[0], page[1]) - from;
          if (mods.shift) degrees = snapRotation(start.value, degrees);
          return { values: rotateValues(start.value, degrees, pivot), guides: [], labels: [] };
        }),
      );
    },
  },
  skew: {
    begin(g) {
      const handle = g.press.handle?.id as SkewHandleId;
      const start = captureTransform(g.s.ctx, g.s.view.selection);
      if (!start.ok) return start;
      const basis = frameBasis(start.value);
      const toLocal = invert([basis.toPage[0], basis.toPage[1], basis.toPage[2], basis.toPage[3], 0, 0]) ?? IDENTITY;
      const pivot = g.s.view.pivot ?? CENTER_PIVOT;
      return ok(
        transformRun(g, start.value, 'Skew', (page, mods) => {
          const [ldx, ldy] = applyAffine(toLocal, page[0] - g.press.page[0], page[1] - g.press.page[1]);
          return { values: skewValues(start.value, handle, ldx, ldy, { snap: mods.shift, aboutPivot: mods.alt, pivot }), guides: [], labels: [] };
        }),
      );
    },
  },
  pivot: {
    begin(g) {
      const before = g.s.view.pivot;
      const frame = selectionFrame(g.s.ctx, g.s.view.selection);
      if (!frame.ok) return frame;
      const f = frame.value;
      return ok({
        update(page, _screen, mods) {
          if (f === undefined) return;
          const raw = pivotFraction(f, page);
          // Snaps to the frame's nine reference points (Mod: free).
          g.s.view.setPivot(mods.mod ? raw : snapPivot(f, raw, threshold(g.s)));
          refreshOverlay(g.s);
        },
        end: () => ok(NONE),
        cancel() {
          g.s.view.setPivot(before);
          refreshOverlay(g.s);
        },
      });
    },
  },
  marquee: {
    begin(g, mods) {
      const before = g.s.view.selection;
      const base = mods.shift ? before : [];
      return ok({
        update(page, _screen, m) {
          const rect = rectFrom(g.press.page[0], g.press.page[1], page[0], page[1]);
          const picked = marqueeSelect(g.s.ctx, g.s.index, rect, { context: g.s.view.context, mode: m.alt ? 'contain' : 'touch' });
          if (picked.ok) g.s.view.select([...base, ...picked.value]);
          refreshOverlay(g.s, { marquee: rect });
        },
        end() {
          refreshOverlay(g.s);
          return ok({ kind: 'selection', selection: g.s.view.selection });
        },
        cancel() {
          g.s.view.select(before);
          refreshOverlay(g.s);
        },
      });
    },
  },
  pan: {
    begin(g) {
      const camera = g.s.view.camera;
      return ok({
        update(_page, screen) {
          void g.s.view.setCamera({ ...camera, tx: camera.tx + screen[0] - g.press.sx, ty: camera.ty + screen[1] - g.press.sy });
        },
        end: () => ok(NONE),
        cancel() {
          void g.s.view.setCamera(camera);
        },
      });
    },
  },
});

/** Drop deleted nodes from the selection (remote deletes, agent edits). */
export function pruneSelection(s: Pick<ToolSession, 'ctx' | 'view'>): void {
  const alive = s.view.selection.filter((n) => s.ctx.stage.read(n) !== undefined);
  if (alive.length !== s.view.selection.length) s.view.select(alive);
}

/** Whether the pivot handle shows, per session state: always in transform mode, otherwise once it was moved (B10a). */
const SHOW_PIVOT: Readonly<Record<TransformModeState, (pivot: readonly [number, number] | undefined) => boolean>> = Object.freeze({
  idle: (pivot: readonly [number, number] | undefined) => !isCenterPivot(pivot),
  active: () => true,
});

/** Recompute the selection frame and handles (plus gesture extras) into `view.overlay`. */
export function refreshOverlay(s: Pick<ToolSession, 'ctx' | 'view' | 'mode'>, extra: Partial<Pick<ToolOverlay, 'guides' | 'labels' | 'marquee'>> = {}): void {
  const frame = selectionFrame(s.ctx, s.view.selection.filter((n) => s.ctx.stage.read(n) !== undefined));
  const hoverNode = s.view.hover;
  const hover = hoverNode === undefined || s.view.selection.includes(hoverNode) ? undefined : elementBounds(s.ctx, hoverNode);
  const f = frame.ok ? frame.value : undefined;
  const pivot = SHOW_PIVOT[modeState(s)](s.view.pivot) ? (s.view.pivot ?? CENTER_PIVOT) : undefined;
  s.view.setOverlay({
    ...EMPTY_OVERLAY,
    ...(f === undefined ? {} : { frame: f, handles: transformHandles(f, s.view.camera.zoom, pivot) }),
    ...(hover?.ok === true && hoverNode !== undefined ? { hover: { node: hoverNode, bounds: hover.value.geometry } } : {}),
    ...(f !== undefined && modeState(s) === 'active' ? { transforming: true } : {}),
    ...extra,
  });
}

export interface ToolController {
  /** Reactive. */
  readonly state: ToolGestureState;
  pointer(event: ToolPointer): Result<ToolOutcome>;
  /** Wheel: pan, or zoom about the pointer with Mod (pinch arrives as Mod+wheel). */
  wheel(event: { readonly x: number; readonly y: number; readonly dx: number; readonly dy: number; readonly mod?: boolean }): Result<void>;
  /** Escape / pointercancel: end the gesture without committing. */
  cancel(): ToolOutcome;
}

const mods = (e: ToolPointer): Modifiers => ({ shift: e.shift === true, alt: e.alt === true, mod: e.mod === true });

const SKEW_SIDES_SET: ReadonlySet<string> = new Set(SKEW_HANDLES);

/** Press target per handle kind (a side handle with Mod skews, B10a). */
const HANDLE_TARGETS: Readonly<Record<HandleKind, (handle: TransformHandle, mod: boolean) => PressTarget>> = Object.freeze({
  resize: (handle: TransformHandle, mod: boolean) => (mod && SKEW_SIDES_SET.has(handle.id) ? 'skew-handle' : 'resize-handle'),
  rotate: () => 'rotate-handle',
  pivot: () => 'pivot-handle',
});

/** The pointer tool controller of one tab (see the module header). */
export function createToolController(s: ToolSession): ToolController {
  const machine = createMachine(ToolGestureLifecycle);
  let press: Press | undefined;
  let run: GestureRun | undefined;
  const behaviour = (): ToolBehaviour => MODE_BEHAVIOURS[modeState(s)] ?? TOOL_BEHAVIOURS[s.view.tool] ?? 'select';
  const tolerance = (): number => POINTER.hitTolerance / s.view.camera.zoom;

  const classify = (page: readonly [number, number], deep: boolean): Result<{ target: PressTarget; handle?: TransformHandle; hit?: NodeId }> => {
    const handle = pickHandle(s.view.overlay.handles, page[0], page[1]);
    if (handle !== undefined && s.view.selection.length > 0) return ok({ target: HANDLE_TARGETS[handle.kind](handle, deep), handle });
    const hit = hitTest(s.ctx, s.index, page[0], page[1], { tolerance: tolerance(), context: s.view.context, deep });
    if (!hit.ok) return hit;
    if (hit.value === undefined) return ok({ target: 'empty' });
    return ok({ target: s.view.selection.includes(hit.value.target) ? 'selected' : 'element', hit: hit.value.target });
  };

  const down = (e: ToolPointer): Result<ToolOutcome> => {
    if (!machine.is('idle')) return err(GestureStateError({ message: `Pointer down during "${machine.state}".`, details: { state: machine.state } }));
    pruneSelection(s);
    const page = toPage(s.view.camera, e.x, e.y);
    const b = behaviour();
    const c = classify(page, e.mod === true);
    if (!c.ok) return c;
    const { target, hit, handle } = c.value;
    let reselect: NodeId | undefined;
    if (b === 'select' && hit !== undefined && (e.clicks ?? 1) >= 2 && s.ctx.stage.children(hit).length > 0) {
      // Double click enters the group or frame and selects what is under the pointer inside it.
      s.view.setContext(hit);
      const inner = hitTest(s.ctx, s.index, page[0], page[1], { tolerance: tolerance(), context: hit });
      s.view.select(inner.ok && inner.value !== undefined ? [inner.value.target] : []);
    } else if (b === 'select' && hit !== undefined && target === 'element') {
      if (e.shift === true) s.view.toggle(hit);
      else s.view.select([hit]);
    } else if (target === 'selected') {
      reselect = hit;
    }
    press = { sx: e.x, sy: e.y, page, target, behaviour: b, ...(handle === undefined ? {} : { handle }), ...(reselect === undefined ? {} : { reselect }) };
    machine.send('press');
    refreshOverlay(s);
    return ok({ kind: 'selection', selection: s.view.selection });
  };

  const move = (e: ToolPointer): Result<ToolOutcome> => {
    const page = toPage(s.view.camera, e.x, e.y);
    if (machine.is('idle')) {
      const hit = hitTest(s.ctx, s.index, page[0], page[1], { tolerance: tolerance(), context: s.view.context, deep: e.mod === true });
      const next = hit.ok ? hit.value?.target : undefined;
      if (next !== s.view.hover) {
        s.view.setHover(next);
        refreshOverlay(s);
      }
      return ok(NONE);
    }
    if (press === undefined) return err(GestureStateError({ details: { state: machine.state } }));
    if (machine.is('pressed')) {
      if (Math.hypot(e.x - press.sx, e.y - press.sy) < POINTER.dragSlop) return ok(NONE);
      const kind = PRESS_GESTURES[press.behaviour][press.target];
      const sink = SINKS[modeState(s)](s);
      const begun = GESTURES[kind].begin({ s, press, sink }, mods(e));
      if (!begun.ok) {
        machine.send('cancel');
        press = undefined;
        return begun;
      }
      run = begun.value;
      machine.send(kind);
    }
    run?.update(page, [e.x, e.y], mods(e));
    return ok(NONE);
  };

  /**
   * A press released without dragging: empty space clears (and leaves the entered container); a selected element
   * becomes the only selection (Shift: leaves it); Alt-click on the pivot puts it back in the centre (B10a).
   */
  const click = (e: ToolPointer): ToolOutcome => {
    const p = press;
    if (p?.target === 'pivot-handle') {
      if (e.alt === true) s.view.setPivot(undefined);
      refreshOverlay(s);
      return NONE;
    }
    if (p === undefined || p.behaviour !== 'select') return NONE;
    if (p.target === 'empty' && e.shift !== true) {
      s.view.clear();
      s.view.setContext(s.view.root);
    } else if (p.reselect !== undefined) {
      if (e.shift === true) s.view.toggle(p.reselect);
      else s.view.select([p.reselect]);
    }
    refreshOverlay(s);
    return { kind: 'selection', selection: s.view.selection };
  };

  const up = (e: ToolPointer): Result<ToolOutcome> => {
    if (machine.is('idle')) return err(GestureStateError({ message: 'Pointer up without a press.', details: { state: machine.state } }));
    if (machine.is('pressed')) {
      const outcome = click(e);
      machine.send('release');
      press = undefined;
      return ok(outcome);
    }
    const r = run?.end() ?? ok(NONE);
    machine.send('release');
    press = undefined;
    run = undefined;
    return r;
  };

  const cancel = (): ToolOutcome => {
    if (machine.is('idle')) return NONE;
    run?.cancel();
    machine.send('cancel');
    press = undefined;
    run = undefined;
    return { kind: 'cancelled' };
  };

  const handlers: Readonly<Record<ToolPointer['phase'], (e: ToolPointer) => Result<ToolOutcome>>> = { down, move, up, cancel: () => ok(cancel()) };

  return {
    get state() {
      return machine.state;
    },
    pointer: (event) => handlers[event.phase](event),
    wheel(event) {
      const r = event.mod === true ? s.view.zoomBy(Math.exp(-event.dy * 0.01), event.x, event.y) : s.view.panBy(-event.dx, -event.dy);
      if (r.ok) refreshOverlay(s);
      return r;
    },
    cancel,
  };
}

/** Bounds of the selection (fit-to-selection, keyboard paths). */
export function selectionBox(s: Pick<ToolSession, 'ctx' | 'view'>): Box | undefined {
  const f = selectionFrame(s.ctx, s.view.selection);
  return f.ok ? f.value?.bounds : undefined;
}
