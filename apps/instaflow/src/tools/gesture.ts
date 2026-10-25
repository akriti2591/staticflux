/**
 * The pointer tools (IF-24.2–24.7, IF-24.14–24.16, IF-24.19): select (click, Shift+click, Mod+click deep select,
 * double click to enter a group or frame, marquee with Alt for "fully inside"), move, resize and rotate through the
 * round handles, and the hand (pan). One controller per tab over the open page (`ToolSession`); headless — the
 * canvas feeds it pointer events in screen pixels and draws `view.overlay`.
 *
 * **One drag = one undo step**: while dragging, new values are previews in the stage's **session layer** (never
 * persisted, drawn through the render projection like any composed value); on release they are cleared and
 * committed as one change set through B1's `commitEdit` (value checks, locks, final paths, brand rules). Escape or
 * pointercancel clears the preview and commits nothing. Position-locked elements never move.
 *
 * **No branch on mode** (rule 4): what a press starts is data — `PRESS_GESTURES[behaviour][pressTarget]` — and each
 * gesture kind is a strategy in `GESTURES` (begin, update, end). The active tool's behaviour comes from
 * `TOOL_BEHAVIOURS`. Machine: `ToolGestureLifecycle` (`instaflow/tool-gesture`, LIFECYCLES §25).
 */
import { createMachine, defineMachine, err, ok, type Result } from '@staticflux/core';
import type { Box } from '@staticflux/document/spatial-index';
import type { JsonValue, NodeId } from '@staticflux/document/v2';
import type { Actor, SessionLayer, Stage } from '@staticflux/stage';
import { commitEdit, type EditTarget } from '../elements/actions.js';
import { P } from '../elements/components.js';
import { elementBounds } from '../elements/layout.js';
import { StudioIds } from '../spec/studio-ids.js';
import { GestureStateError, TargetGoneError } from './errors.js';
import { type ElementIndex, hitTest, marqueeSelect, rectFrom, type ToolContext } from './hit-test.js';
import { EMPTY_OVERLAY, type ToolOverlay } from './overlay.js';
import { collectSnapTargets, type Guide, type GuideLabel, shiftBox, SNAP_THRESHOLD_PX, type SnapFeature, snapBox, type SnapTargets } from './snapping.js';
import {
  angleAbout,
  axisAligned,
  captureTransform,
  HANDLE_DIRECTIONS,
  moveValues,
  pickHandle,
  type ResizeHandleId,
  resizedBounds,
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
}

export const ToolGestureLifecycle = /* @__PURE__ */ defineMachine({
  id: 'instaflow/tool-gesture',
  initial: 'idle',
  states: ['idle', 'pressed', 'moving', 'resizing', 'rotating', 'marqueeing', 'panning'],
  transitions: {
    idle: { press: 'pressed' },
    pressed: { move: 'moving', resize: 'resizing', rotate: 'rotating', marquee: 'marqueeing', pan: 'panning', release: 'idle', cancel: 'idle' },
    moving: { release: 'idle', cancel: 'idle' },
    resizing: { release: 'idle', cancel: 'idle' },
    rotating: { release: 'idle', cancel: 'idle' },
    marqueeing: { release: 'idle', cancel: 'idle' },
    panning: { release: 'idle', cancel: 'idle' },
  },
});
export type ToolGestureState = (typeof ToolGestureLifecycle.states)[number];

export const DRAG_KINDS = ['move', 'resize', 'rotate', 'marquee', 'pan'] as const;
export type DragKind = (typeof DRAG_KINDS)[number];

/** What is under the pointer when it goes down. */
export const PRESS_TARGETS = ['resize-handle', 'rotate-handle', 'element', 'selected', 'empty'] as const;
export type PressTarget = (typeof PRESS_TARGETS)[number];

export const TOOL_BEHAVIOURS_LIST = ['select', 'hand'] as const;
export type ToolBehaviour = (typeof TOOL_BEHAVIOURS_LIST)[number];

/** Which gesture a drag starts, per tool behaviour and press target (data, rule 4). */
export const PRESS_GESTURES: Readonly<Record<ToolBehaviour, Readonly<Record<PressTarget, DragKind>>>> = Object.freeze({
  select: { 'resize-handle': 'resize', 'rotate-handle': 'rotate', element: 'move', selected: 'move', empty: 'marquee' },
  hand: { 'resize-handle': 'pan', 'rotate-handle': 'pan', element: 'pan', selected: 'pan', empty: 'pan' },
});

/** Tool contribution id → pointer behaviour (other tools, e.g. B2's text, bring their own controllers). */
export const TOOL_BEHAVIOURS: Readonly<Record<string, ToolBehaviour>> = Object.freeze({ [StudioIds.tool.select]: 'select', [StudioIds.tool.hand]: 'hand' });

/** Screen-pixel constants. */
export const POINTER = Object.freeze({ dragSlop: 3, hitTolerance: 3 });

export interface ToolPointer {
  readonly phase: 'down' | 'move' | 'up' | 'cancel';
  /** Screen pixels in the canvas. */
  readonly x: number;
  readonly y: number;
  readonly shift?: boolean;
  readonly alt?: boolean;
  /** Cmd on macOS, Ctrl elsewhere: deep select on press, no snapping while dragging. */
  readonly mod?: boolean;
  /** Click count on `down` (2 = double click). */
  readonly clicks?: number;
}

export type ToolOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'selection'; readonly selection: readonly NodeId[] }
  | { readonly kind: 'committed'; readonly label: string; readonly ops: number }
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

interface GestureContext {
  readonly s: ToolSession;
  readonly press: Press;
  readonly preview: Preview;
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

/** Session-layer previews of one gesture. */
interface Preview {
  show(values: readonly SpatialValues[]): void;
  clear(): void;
}

function createPreview(session: ToolSession['session']): Preview {
  const touched = new Set<NodeId>();
  const PATHS = { x: P.x, y: P.y, w: P.w, h: P.h, rotation: P.rotation } as const;
  return {
    show(values) {
      for (const v of values) {
        touched.add(v.node);
        for (const key of ['x', 'y', 'w', 'h', 'rotation'] as const) {
          const value = v[key];
          if (value !== undefined) session.set(v.node, PATHS[key], value as JsonValue);
        }
      }
    },
    clear() {
      for (const node of touched) for (const path of Object.values(PATHS)) session.clear(node, path);
      touched.clear();
    },
  };
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

function transformRun(g: GestureContext, start: TransformStart, label: string, compute: (page: readonly [number, number], mods: Modifiers) => { values: SpatialValues[]; guides: readonly Guide[]; labels: readonly GuideLabel[] }): GestureRun {
  let last: SpatialValues[] = [];
  return {
    update(page, _screen, mods) {
      const r = compute(page, mods);
      last = r.values;
      g.preview.show(r.values);
      refreshOverlay(g.s, { guides: r.guides, labels: r.labels });
    },
    end() {
      g.preview.clear();
      const outcome = commitValues(g.s, start, last, label);
      refreshOverlay(g.s);
      return outcome;
    },
    cancel() {
      g.preview.clear();
      refreshOverlay(g.s);
    },
  };
}

const movingFeatures = (d: -1 | 0 | 1): readonly SnapFeature[] => (d === 1 ? ['max'] : d === -1 ? ['min'] : []);

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
      return ok(
        transformRun(g, start.value, 'Resize', (page, mods) => {
          let dx = page[0] - g.press.page[0];
          let dy = page[1] - g.press.page[1];
          const options = { aspect: mods.shift, fromCenter: mods.alt };
          let guides: readonly Guide[] = [];
          if (snappable && !mods.mod && !mods.shift) {
            const raw = resizedBounds(start.value.frame.bounds, handle, dx, dy, options);
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
      const pivot = start.value.frame.center;
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

/** Recompute the selection frame and handles (plus gesture extras) into `view.overlay`. */
export function refreshOverlay(s: Pick<ToolSession, 'ctx' | 'view'>, extra: Partial<Pick<ToolOverlay, 'guides' | 'labels' | 'marquee'>> = {}): void {
  const frame = selectionFrame(s.ctx, s.view.selection.filter((n) => s.ctx.stage.read(n) !== undefined));
  const hoverNode = s.view.hover;
  const hover = hoverNode === undefined || s.view.selection.includes(hoverNode) ? undefined : elementBounds(s.ctx, hoverNode);
  const f = frame.ok ? frame.value : undefined;
  s.view.setOverlay({
    ...EMPTY_OVERLAY,
    ...(f === undefined ? {} : { frame: f, handles: transformHandles(f, s.view.camera.zoom) }),
    ...(hover?.ok === true && hoverNode !== undefined ? { hover: { node: hoverNode, bounds: hover.value.geometry } } : {}),
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

/** The pointer tool controller of one tab (see the module header). */
export function createToolController(s: ToolSession): ToolController {
  const machine = createMachine(ToolGestureLifecycle);
  let press: Press | undefined;
  let run: GestureRun | undefined;
  let preview: Preview | undefined;
  const behaviour = (): ToolBehaviour => TOOL_BEHAVIOURS[s.view.tool] ?? 'select';
  const tolerance = (): number => POINTER.hitTolerance / s.view.camera.zoom;

  const classify = (page: readonly [number, number], deep: boolean): Result<{ target: PressTarget; handle?: TransformHandle; hit?: NodeId }> => {
    const handle = pickHandle(s.view.overlay.handles, page[0], page[1]);
    if (handle !== undefined && s.view.selection.length > 0) return ok({ target: handle.kind === 'resize' ? 'resize-handle' : 'rotate-handle', handle });
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
      preview = createPreview(s.session);
      const begun = GESTURES[kind].begin({ s, press, preview }, mods(e));
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

  /** A press released without dragging: empty space clears (and leaves the entered container); a selected element becomes the only selection (Shift: leaves it). */
  const click = (e: ToolPointer): ToolOutcome => {
    const p = press;
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
    preview = undefined;
    return r;
  };

  const cancel = (): ToolOutcome => {
    if (machine.is('idle')) return NONE;
    run?.cancel();
    preview?.clear();
    machine.send('cancel');
    press = undefined;
    run = undefined;
    preview = undefined;
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
