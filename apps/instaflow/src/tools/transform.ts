/**
 * Transforms (IF-24.6–24.7, IF-24.14–24.16): selection frames, round transform handles (Clean Pop: "selection
 * handles are round"), and the page-space maths of move, resize and rotate as `spatial.*` values. Every function
 * works from a **start snapshot** taken when the gesture begins (`captureTransform`), so a gesture's preview and its
 * commit are the same pure function of the pointer, and position-locked elements are never moved (they stay out of
 * the snapshot and are reported in `locked`).
 *
 * - `selectionFrame(ctx, nodes)` — one element: its rotated box (four page corners, rotation); several: the union
 *   of their geometry bounds.
 * - `transformHandles(frame, zoom)` / `pickHandle(handles, x, y)` — eight resize handles, four rotate zones just
 *   outside the corners; radii are screen pixels converted to page units.
 * - `moveValues`, `resizeValues`, `rotateValues` — the new `spatial.x/y/w/h/rotation` per element; `valuesToOps`
 *   turns them into one batch of part ops (one change set, one undo step).
 */
import { err, ok, type Result } from '@staticflux/core';
import type { Box } from '@staticflux/document/spatial-index';
import type { NodeId, PartOp } from '@staticflux/document/v2';
import type { Stage } from '@staticflux/stage';
import { P } from '../elements/components.js';
import { type ElementContext, elementBounds, pageTransform } from '../elements/layout.js';
import { type Affine, applyAffine, boxTransform, type ElementBox, IDENTITY, invert, multiply, resolveElement } from '../elements/resolve.js';
import { NothingToTransformError } from './errors.js';

export type Point = readonly [number, number];

// ---------------------------------------------------------------- selection frame and handles

export interface SelectionFrame {
  /** Page corners: top-left, top-right, bottom-right, bottom-left (of the unrotated box). */
  readonly corners: readonly [Point, Point, Point, Point];
  /** Degrees clockwise (0 for a multi-selection). */
  readonly rotation: number;
  /** Axis-aligned page bounds. */
  readonly bounds: Box;
  readonly center: Point;
}

const boxCorners = (b: Box): [Point, Point, Point, Point] => [
  [b.minX, b.minY],
  [b.maxX, b.minY],
  [b.maxX, b.maxY],
  [b.minX, b.maxY],
];

const boundsOf = (points: readonly Point[]): Box => ({
  minX: Math.min(...points.map((p) => p[0])),
  minY: Math.min(...points.map((p) => p[1])),
  maxX: Math.max(...points.map((p) => p[0])),
  maxY: Math.max(...points.map((p) => p[1])),
});

/** The frame the handles sit on (see the module header); undefined for an empty selection. */
export function selectionFrame(ctx: ElementContext, nodes: readonly NodeId[]): Result<SelectionFrame | undefined> {
  if (nodes.length === 0) return ok(undefined);
  const single = nodes.length === 1 ? resolveElement(ctx.stage, nodes[0] as NodeId, ctx.kit) : undefined;
  if (single !== undefined && single.geometry.kind !== 'group' && single.box.w > 0 && single.box.h > 0) {
    const t = pageTransform(ctx, single.id);
    const corners = boxCorners({ minX: 0, minY: 0, maxX: single.box.w, maxY: single.box.h }).map(([x, y]) => applyAffine(t, x, y)) as unknown as [Point, Point, Point, Point];
    const rotation = (Math.atan2(t[1], t[0]) * 180) / Math.PI;
    const bounds = boundsOf(corners);
    const [a, , c] = corners;
    return ok({ corners, rotation, bounds, center: [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2] });
  }
  let bounds: Box | undefined;
  for (const node of nodes) {
    const b = elementBounds(ctx, node);
    if (!b.ok) return b;
    const g = b.value.geometry;
    bounds = bounds === undefined ? g : { minX: Math.min(bounds.minX, g.minX), minY: Math.min(bounds.minY, g.minY), maxX: Math.max(bounds.maxX, g.maxX), maxY: Math.max(bounds.maxY, g.maxY) };
  }
  const b = bounds as Box;
  return ok({ corners: boxCorners(b), rotation: 0, bounds: b, center: [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2] });
}

export const RESIZE_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
export type ResizeHandleId = (typeof RESIZE_HANDLES)[number];
export const ROTATE_HANDLES = ['rotate-nw', 'rotate-ne', 'rotate-se', 'rotate-sw'] as const;
export type RotateHandleId = (typeof ROTATE_HANDLES)[number];
export type HandleId = ResizeHandleId | RotateHandleId;

/** Handle direction in the frame's unit box: which edges move (−1 min edge, +1 max edge, 0 none). */
export const HANDLE_DIRECTIONS: Readonly<Record<ResizeHandleId, readonly [-1 | 0 | 1, -1 | 0 | 1]>> = Object.freeze({
  nw: [-1, -1],
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
});

const ROTATE_CORNER: Readonly<Record<RotateHandleId, ResizeHandleId>> = Object.freeze({ 'rotate-nw': 'nw', 'rotate-ne': 'ne', 'rotate-se': 'se', 'rotate-sw': 'sw' });

/** Handle sizes in screen pixels (Clean Pop: round handles). */
export const HANDLE_SIZES = Object.freeze({ radius: 4.5, hitRadius: 7, rotateRadius: 14, rotateOffset: 12 });

export interface TransformHandle {
  readonly id: HandleId;
  readonly kind: 'resize' | 'rotate';
  /** Page-space centre. */
  readonly x: number;
  readonly y: number;
  /** Page units: drawn radius and hit radius. */
  readonly radius: number;
  readonly hitRadius: number;
}

function framePoint(frame: SelectionFrame, u: number, v: number): Point {
  const [tl, tr, , bl] = frame.corners;
  return [tl[0] + (tr[0] - tl[0]) * u + (bl[0] - tl[0]) * v, tl[1] + (tr[1] - tl[1]) * u + (bl[1] - tl[1]) * v];
}

/** Handles of a frame at a zoom (rotate zones first in hit priority after resize handles). */
export function transformHandles(frame: SelectionFrame, zoom: number): readonly TransformHandle[] {
  const s = 1 / zoom;
  const out: TransformHandle[] = [];
  for (const id of RESIZE_HANDLES) {
    const [hx, hy] = HANDLE_DIRECTIONS[id];
    const [x, y] = framePoint(frame, (hx + 1) / 2, (hy + 1) / 2);
    out.push({ id, kind: 'resize', x, y, radius: HANDLE_SIZES.radius * s, hitRadius: HANDLE_SIZES.hitRadius * s });
  }
  for (const id of ROTATE_HANDLES) {
    const [hx, hy] = HANDLE_DIRECTIONS[ROTATE_CORNER[id]];
    const [cx, cy] = framePoint(frame, (hx + 1) / 2, (hy + 1) / 2);
    const dx = cx - frame.center[0];
    const dy = cy - frame.center[1];
    const len = Math.hypot(dx, dy) || 1;
    const off = HANDLE_SIZES.rotateOffset * s;
    out.push({ id, kind: 'rotate', x: cx + (dx / len) * off, y: cy + (dy / len) * off, radius: 0, hitRadius: HANDLE_SIZES.rotateRadius * s });
  }
  return out;
}

/** The handle under a page point (resize handles win over rotate zones). */
export function pickHandle(handles: readonly TransformHandle[], x: number, y: number): TransformHandle | undefined {
  let best: TransformHandle | undefined;
  let bestD = Infinity;
  for (const h of handles) {
    const d = Math.hypot(h.x - x, h.y - y);
    if (d > h.hitRadius) continue;
    const rank = (h.kind === 'resize' ? 0 : 1e6) + d;
    if (rank < bestD) {
      best = h;
      bestD = rank;
    }
  }
  return best;
}

// ---------------------------------------------------------------- start snapshot

export interface ElementStart {
  readonly node: NodeId;
  readonly box: ElementBox;
  /** Local → page. */
  readonly transform: Affine;
  /** Parent → page (identity under a page). */
  readonly parent: Affine;
  /** Page geometry bounds. */
  readonly bounds: Box;
}

export interface TransformStart {
  readonly elements: readonly ElementStart[];
  /** Position-locked elements left out (they stay put). */
  readonly locked: readonly NodeId[];
  readonly frame: SelectionFrame;
}

/** Snapshot the movable elements of `nodes` (IF-TOOL-002 when none can move). */
export function captureTransform(ctx: ElementContext & { readonly stage: Pick<Stage, 'read' | 'children' | 'value' | 'lockOf'> }, nodes: readonly NodeId[]): Result<TransformStart> {
  const elements: ElementStart[] = [];
  const locked: NodeId[] = [];
  for (const node of nodes) {
    if (ctx.stage.lockOf(node).position) {
      locked.push(node);
      continue;
    }
    const el = resolveElement(ctx.stage, node, ctx.kit);
    if (el === undefined) continue;
    const b = elementBounds(ctx, node);
    if (!b.ok) return b;
    elements.push({ node, box: el.box, transform: b.value.transform, parent: el.parent === null ? IDENTITY : pageTransform(ctx, el.parent), bounds: b.value.geometry });
  }
  if (elements.length === 0) return err(NothingToTransformError({ message: nodes.length === 0 ? 'Nothing is selected.' : 'Every selected element is position-locked.', details: { locked } }));
  const frame = selectionFrame(ctx, elements.map((e) => e.node));
  if (!frame.ok) return frame;
  return ok({ elements, locked, frame: frame.value as SelectionFrame });
}

// ---------------------------------------------------------------- values

/** New spatial values of one element (only the fields that change). */
export interface SpatialValues {
  readonly node: NodeId;
  readonly x: number;
  readonly y: number;
  readonly w?: number;
  readonly h?: number;
  readonly rotation?: number;
}

const linear = (t: Affine): Affine => [t[0], t[1], t[2], t[3], 0, 0];

/** Move every element by a page-space delta. */
export function moveValues(start: TransformStart, dx: number, dy: number): SpatialValues[] {
  return start.elements.map((e) => {
    const inv = invert(linear(e.parent)) ?? IDENTITY;
    const [px, py] = applyAffine(inv, dx, dy);
    return { node: e.node, x: e.box.x + px, y: e.box.y + py };
  });
}

/**
 * Place an element with a new box so that the local point `local` (in the new box) lands on the page point `target`.
 * Translation lives in parent space: page = parent · (B₀(p) + (x, y)).
 */
function place(e: ElementStart, next: ElementBox, local: Point, target: Point): { readonly x: number; readonly y: number } {
  const b0 = boxTransform({ ...next, x: 0, y: 0 });
  const q = applyAffine(b0, local[0], local[1]);
  const inv = invert(e.parent) ?? IDENTITY;
  const t = applyAffine(inv, target[0], target[1]);
  return { x: t[0] - q[0], y: t[1] - q[1] };
}

export const MIN_SIZE = 1;

export interface ResizeOptions {
  /** Keep the aspect ratio (Shift). */
  readonly aspect?: boolean;
  /** Resize about the centre (Alt). */
  readonly fromCenter?: boolean;
}

/** True when an element's local axes are the page axes (no rotation, skew or flip): its edges can snap. */
export function axisAligned(t: Affine): boolean {
  return Math.abs(t[1]) < 1e-9 && Math.abs(t[2]) < 1e-9 && t[0] > 0 && t[3] > 0;
}

/** Page-space box after dragging a handle by `(dx, dy)` (axis-aligned frames; what snapping works on). */
export function resizedBounds(b: Box, handle: ResizeHandleId, dx: number, dy: number, options: ResizeOptions = {}): Box {
  const [hx, hy] = HANDLE_DIRECTIONS[handle];
  const k = options.fromCenter === true ? 2 : 1;
  const w0 = b.maxX - b.minX;
  const h0 = b.maxY - b.minY;
  let w = Math.max(MIN_SIZE, w0 + hx * dx * k);
  let h = Math.max(MIN_SIZE, h0 + hy * dy * k);
  if (options.aspect === true && w0 > 0 && h0 > 0) {
    const s = hx === 0 ? h / h0 : hy === 0 ? w / w0 : Math.abs(w / w0 - 1) >= Math.abs(h / h0 - 1) ? w / w0 : h / h0;
    w = Math.max(MIN_SIZE, w0 * s);
    h = Math.max(MIN_SIZE, h0 * s);
  }
  const [ux, uy] = fixedFraction(handle, options);
  const px = b.minX + w0 * ux;
  const py = b.minY + h0 * uy;
  return { minX: px - w * ux, minY: py - h * uy, maxX: px + w * (1 - ux), maxY: py + h * (1 - uy) };
}

/** The point of the unit box that stays put while a handle is dragged (the opposite edge, or the centre). */
export function fixedFraction(handle: ResizeHandleId, options: ResizeOptions = {}): Point {
  const [hx, hy] = HANDLE_DIRECTIONS[handle];
  return [options.fromCenter === true || hx === 0 ? 0.5 : (1 - hx) / 2, options.fromCenter === true || hy === 0 ? 0.5 : (1 - hy) / 2];
}

/**
 * Resize: one element in its own (possibly rotated) frame — the opposite handle (or the centre) stays put on the
 * page; several elements scale with the selection frame about its fixed point (each keeps its rotation, its centre
 * follows the frame and its local axes stretch by the frame's factors).
 */
export function resizeValues(start: TransformStart, handle: ResizeHandleId, dx: number, dy: number, options: ResizeOptions = {}): SpatialValues[] {
  const single = start.elements.length === 1 ? (start.elements[0] as ElementStart) : undefined;
  if (single !== undefined && single.box.w > 0 && single.box.h > 0) {
    const e = single;
    const inv = invert(linear(e.transform)) ?? IDENTITY;
    const [ldx, ldy] = applyAffine(inv, dx, dy);
    const local = resizedBounds({ minX: 0, minY: 0, maxX: e.box.w, maxY: e.box.h }, handle, ldx, ldy, options);
    const w = local.maxX - local.minX;
    const h = local.maxY - local.minY;
    // The fixed point: where the unmoved part of the old box was (in old local units) and is (in new local units).
    const [fx, fy] = fixedFraction(handle, options);
    const target = applyAffine(e.transform, fx * e.box.w, fy * e.box.h);
    const next: ElementBox = { ...e.box, w, h };
    const at = place(e, next, [fx * w, fy * h], target);
    return [{ node: e.node, ...at, w, h }];
  }
  const from = start.frame.bounds;
  const to = resizedBounds(from, handle, dx, dy, options);
  const sx = (to.maxX - to.minX) / Math.max(1e-9, from.maxX - from.minX);
  const sy = (to.maxY - to.minY) / Math.max(1e-9, from.maxY - from.minY);
  return start.elements.map((e) => {
    const c = [(e.bounds.minX + e.bounds.maxX) / 2, (e.bounds.minY + e.bounds.maxY) / 2] as const;
    const target: Point = [to.minX + (c[0] - from.minX) * sx, to.minY + (c[1] - from.minY) * sy];
    const theta = Math.atan2(e.transform[1], e.transform[0]);
    const kx = Math.hypot(sx * Math.cos(theta), sy * Math.sin(theta));
    const ky = Math.hypot(sx * Math.sin(theta), sy * Math.cos(theta));
    const w = e.box.w > 0 ? Math.max(MIN_SIZE, e.box.w * kx) : e.box.w;
    const h = e.box.h > 0 ? Math.max(MIN_SIZE, e.box.h * ky) : e.box.h;
    const inv = invert(e.transform) ?? IDENTITY;
    const lc = applyAffine(inv, c[0], c[1]);
    const local: Point = [e.box.w > 0 ? (lc[0] / e.box.w) * w : lc[0], e.box.h > 0 ? (lc[1] / e.box.h) * h : lc[1]];
    const at = place(e, { ...e.box, w, h }, local, target);
    return { node: e.node, ...at, ...(w === e.box.w ? {} : { w }), ...(h === e.box.h ? {} : { h }) };
  });
}

/** Grow or shrink each element by `(dw, dh)` in its own units, its local top-left corner staying put (keyboard). */
export function resizeByValues(start: TransformStart, dw: number, dh: number): SpatialValues[] {
  return start.elements.map((e) => {
    const w = e.box.w > 0 ? Math.max(MIN_SIZE, e.box.w + dw) : e.box.w;
    const h = e.box.h > 0 ? Math.max(MIN_SIZE, e.box.h + dh) : e.box.h;
    const at = place(e, { ...e.box, w, h }, [0, 0], applyAffine(e.transform, 0, 0));
    return { node: e.node, ...at, w, h };
  });
}

/** Rotation step with Shift. */
export const ROTATE_STEP = 15;

/** Normalise degrees to (−180, 180]. */
export function normalizeDegrees(d: number): number {
  const r = ((d % 360) + 360) % 360;
  return r > 180 ? r - 360 : r;
}

/** Pointer angle about a pivot in degrees (clockwise, y down). */
export function angleAbout(pivot: Point, x: number, y: number): number {
  return (Math.atan2(y - pivot[1], x - pivot[0]) * 180) / Math.PI;
}

/** Rotate every element by `degrees` about the frame centre (each element's centre orbits it). */
export function rotateValues(start: TransformStart, degrees: number, pivot: Point = start.frame.center): SpatialValues[] {
  const r = (degrees * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return start.elements.map((e) => {
    const c: Point = [(e.bounds.minX + e.bounds.maxX) / 2, (e.bounds.minY + e.bounds.maxY) / 2];
    const own = e.box.w > 0 && e.box.h > 0 ? applyAffine(e.transform, e.box.w / 2, e.box.h / 2) : c;
    const target: Point = [pivot[0] + (own[0] - pivot[0]) * cos - (own[1] - pivot[1]) * sin, pivot[1] + (own[0] - pivot[0]) * sin + (own[1] - pivot[1]) * cos];
    const inv = invert(e.transform) ?? IDENTITY;
    const local = applyAffine(inv, own[0], own[1]);
    const rotation = normalizeDegrees(e.box.rotation + degrees);
    const at = place(e, { ...e.box, rotation }, local, target);
    return { node: e.node, ...at, rotation };
  });
}

/** Snap a rotation delta so the resulting rotation of the first element lands on a multiple of `step`. */
export function snapRotation(start: TransformStart, degrees: number, step = ROTATE_STEP): number {
  const base = start.elements.length === 1 ? (start.elements[0] as ElementStart).box.rotation : 0;
  return Math.round((base + degrees) / step) * step - base;
}

const PATHS = { x: P.x, y: P.y, w: P.w, h: P.h, rotation: P.rotation } as const;

/** One batch of `set` ops for new spatial values (unchanged fields are skipped). */
export function valuesToOps(start: TransformStart, values: readonly SpatialValues[]): PartOp[] {
  const before = new Map(start.elements.map((e) => [e.node, e.box]));
  const ops: PartOp[] = [];
  for (const v of values) {
    const b = before.get(v.node);
    for (const key of ['x', 'y', 'w', 'h', 'rotation'] as const) {
      const value = v[key];
      if (value === undefined || (b !== undefined && Math.abs(b[key] - value) < 1e-9)) continue;
      ops.push({ op: 'set', node: v.node, path: PATHS[key], value });
    }
  }
  return ops;
}

/** The page bounds of a start element after new values (preview of snapping and overlays). */
export function boundsAfter(e: ElementStart, v: SpatialValues): Box {
  const box: ElementBox = { ...e.box, x: v.x, y: v.y, w: v.w ?? e.box.w, h: v.h ?? e.box.h, rotation: v.rotation ?? e.box.rotation };
  const t = multiply(e.parent, boxTransform(box));
  return boundsOf(boxCorners({ minX: 0, minY: 0, maxX: box.w, maxY: box.h }).map(([x, y]) => applyAffine(t, x, y)));
}
