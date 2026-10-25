/**
 * Free Transform basics (Instaflow M1c B10a; IF-34.1–34.12): flip, skew, the pivot (reference point) and the numeric
 * transform, as pure functions of a start snapshot (`captureTransform`), like B3's move, resize and rotate. Every
 * function returns `SpatialValues`; the caller previews them in the session layer or commits them as one change set.
 *
 * Everything works in the **selection frame**: for one element its own box (so a rotated, skewed or nested element
 * flips and skews along its own axes), for several the axis-aligned union of their bounds. A frame-local affine `S`
 * becomes the page affine `F · S · F⁻¹` and is decomposed back into each element's box by B3's
 * `valuesForTransform` (rotation · flips and scale · horizontal skew).
 *
 * - `frameBasis(start)` — the frame's local → page affine and its size.
 * - `pivotPoint(frame, pivot?)` / `pivotFraction(frame, point)` / `snapPivot(fraction, threshold)` — the reference point
 *   in page units and frame fractions (default the centre); the pivot is per selection and lives in the view state,
 *   never in the document (IF-34.6).
 * - `flipValues(start, axis, pivot?)` — mirror over the pivot along the frame's axis (IF-34.1).
 * - `skewValues(start, handle, ldx, ldy, options)` — a side handle dragged with Mod: top / bottom lean the frame
 *   horizontally, left / right vertically, about the opposite edge (Alt: the pivot); Shift snaps the edge's lean to
 *   `SKEW_STEP` (IF-34.3–34.4). `skewByValues` is the keyboard / agent form (degrees).
 * - `transformModel(start)` / `numericValues(start, edit, pivot?)` — the numeric transform bar's values (X, Y, W, H,
 *   angle, skew) and one edit of them (IF-34.8–34.10).
 */
import { err, ok, type Result } from '@staticflux/core';
import type { NodeId } from '@staticflux/document/v2';
import { type Affine, applyAffine, IDENTITY, invert, multiply } from '../elements/resolve.js';
import { InvalidTransformValueError } from './errors.js';
import {
  aboutPoint,
  type ElementStart,
  framePoint,
  MIN_SIZE,
  moveValues,
  normalizeDegrees,
  type Point,
  resizeByValues,
  resizeValues,
  rotateValues,
  type SelectionFrame,
  type SpatialValues,
  type TransformStart,
  transformValues,
} from './transform.js';

/** The default pivot: the frame centre (frame fractions). */
export const CENTER_PIVOT: Point = Object.freeze([0.5, 0.5]) as unknown as Point;

/** Shift-snapping step for skew (degrees). */
export const SKEW_STEP = 15;
/** The steepest lean a skew may give an edge (degrees); beyond it the box collapses to a line. */
export const SKEW_LIMIT = 80;

const DEG = Math.PI / 180;

// ---------------------------------------------------------------- frame and pivot

export interface FrameBasis {
  /** Frame-local → page (frame-local units are page units for several elements, the element's own for one). */
  readonly toPage: Affine;
  readonly w: number;
  readonly h: number;
}

const single = (start: TransformStart): ElementStart | undefined => {
  const e = start.elements.length === 1 ? start.elements[0] : undefined;
  return e !== undefined && e.box.w > 0 && e.box.h > 0 ? e : undefined;
};

/** The selection frame as an affine basis (see the module header). */
export function frameBasis(start: TransformStart): FrameBasis {
  const e = single(start);
  if (e !== undefined) return { toPage: e.transform, w: e.box.w, h: e.box.h };
  const b = start.frame.bounds;
  return { toPage: [1, 0, 0, 1, b.minX, b.minY], w: b.maxX - b.minX, h: b.maxY - b.minY };
}

/** A frame-local affine as a page affine (`F · S · F⁻¹`). */
export function inFrame(basis: FrameBasis, local: Affine): Affine {
  return multiply(basis.toPage, multiply(local, invert(basis.toPage) ?? IDENTITY));
}

/** The pivot's page point (frame fractions; default the centre). */
export function pivotPoint(frame: SelectionFrame, pivot: Point = CENTER_PIVOT): Point {
  return framePoint(frame, pivot[0], pivot[1]);
}

/** The frame fractions of a page point (inverse of `framePoint`; the centre for a degenerate frame). */
export function pivotFraction(frame: SelectionFrame, point: Point): Point {
  const [tl, tr, , bl] = frame.corners;
  const ux: Point = [tr[0] - tl[0], tr[1] - tl[1]];
  const vy: Point = [bl[0] - tl[0], bl[1] - tl[1]];
  const inv = invert([ux[0], ux[1], vy[0], vy[1], tl[0], tl[1]]);
  if (inv === undefined) return CENTER_PIVOT;
  const [u, v] = applyAffine(inv, point[0], point[1]);
  return [u, v];
}

/** The nine reference points of a frame (corners, edge midpoints, centre) in frame fractions. */
export const REFERENCE_POINTS: readonly Point[] = Object.freeze([0, 0.5, 1].flatMap((v) => [0, 0.5, 1].map((u) => [u, v] as const)));

/** Snap a pivot (frame fractions) to the nearest reference point within `threshold` page units (`frame` gives the scale). */
export function snapPivot(frame: SelectionFrame, pivot: Point, threshold: number): Point {
  const at = framePoint(frame, pivot[0], pivot[1]);
  let best: Point = pivot;
  let bestD = threshold;
  for (const ref of REFERENCE_POINTS) {
    const p = framePoint(frame, ref[0], ref[1]);
    const d = Math.hypot(p[0] - at[0], p[1] - at[1]);
    if (d <= bestD) {
      best = ref;
      bestD = d;
    }
  }
  return best;
}

/** True when a pivot is the default (the centre). */
export function isCenterPivot(pivot: Point | undefined): boolean {
  return pivot === undefined || (Math.abs(pivot[0] - 0.5) < 1e-9 && Math.abs(pivot[1] - 0.5) < 1e-9);
}

const pivotLocal = (basis: FrameBasis, pivot: Point): Point => [pivot[0] * basis.w, pivot[1] * basis.h];

/** Apply a frame-local linear map about the pivot to every element. */
function aboutPivot(start: TransformStart, m: Affine, pivot: Point): SpatialValues[] {
  const basis = frameBasis(start);
  return transformValues(start, inFrame(basis, aboutPoint(m, pivotLocal(basis, pivot))));
}

// ---------------------------------------------------------------- flip

export type FlipAxis = 'horizontal' | 'vertical';

/** The mirror per axis (horizontal: left ↔ right). */
export const FLIPS: Readonly<Record<FlipAxis, Affine>> = Object.freeze({ horizontal: [-1, 0, 0, 1, 0, 0], vertical: [1, 0, 0, -1, 0, 0] });

/** Mirror the selection over the pivot along the frame's axis (an element's own axes when it is alone). Twice is identity. */
export function flipValues(start: TransformStart, axis: FlipAxis, pivot: Point = CENTER_PIVOT): SpatialValues[] {
  return aboutPivot(start, FLIPS[axis], pivot);
}

// ---------------------------------------------------------------- skew

export const SKEW_HANDLES = ['n', 'e', 's', 'w'] as const;
export type SkewHandleId = (typeof SKEW_HANDLES)[number];

/** Per side handle: which axis it skews and which frame-local edge it drags (`at`, in frame fractions). */
export const SKEW_SIDES: Readonly<Record<SkewHandleId, { readonly axis: 'x' | 'y'; readonly at: number }>> = Object.freeze({
  n: { axis: 'x', at: 0 },
  s: { axis: 'x', at: 1 },
  w: { axis: 'y', at: 0 },
  e: { axis: 'y', at: 1 },
});

export interface SkewOptions {
  /** Snap the edge's lean to `SKEW_STEP` (Shift). */
  readonly snap?: boolean;
  /** Skew about the pivot instead of the opposite edge (Alt). */
  readonly aboutPivot?: boolean;
  /** Frame fractions (default the centre). */
  readonly pivot?: Point;
}

const clampLean = (t: number): number => Math.tan(Math.max(-SKEW_LIMIT, Math.min(SKEW_LIMIT, Math.atan(t) / DEG)) * DEG);

/** The frame-local shear for a lean `t` (tan of the angle) on an axis. */
const shear = (axis: 'x' | 'y', t: number): Affine => (axis === 'x' ? [1, 0, t, 1, 0, 0] : [1, t, 0, 1, 0, 0]);

/**
 * Skew by dragging a side handle by a **frame-local** delta `(ldx, ldy)` (see the module header). The lean is the
 * dragged edge's displacement over its distance to the fixed line; with `snap`, the resulting edge angle of one
 * element (its existing skew included) lands on a multiple of `SKEW_STEP`.
 */
export function skewValues(start: TransformStart, handle: SkewHandleId, ldx: number, ldy: number, options: SkewOptions = {}): SpatialValues[] {
  const basis = frameBasis(start);
  const side = SKEW_SIDES[handle];
  const pivot = options.pivot ?? CENTER_PIVOT;
  const fixed: Point = options.aboutPivot === true ? pivot : side.axis === 'x' ? [0.5, 1 - side.at] : [1 - side.at, 0.5];
  const span = side.axis === 'x' ? (side.at - fixed[1]) * basis.h : (side.at - fixed[0]) * basis.w;
  if (Math.abs(span) < 1e-9) return start.elements.map((e) => ({ node: e.node, x: e.box.x, y: e.box.y }));
  // The lean already there (one element's own horizontal skew), so snapping and the limit apply to the result.
  const base = side.axis === 'x' ? Math.tan((single(start)?.box.skewX ?? 0) * DEG) : 0;
  let lean = base + (side.axis === 'x' ? ldx : ldy) / span;
  if (options.snap === true) lean = Math.tan(Math.round(Math.atan(lean) / DEG / SKEW_STEP) * SKEW_STEP * DEG);
  lean = clampLean(lean);
  const m = shear(side.axis, lean - base);
  return transformValues(start, inFrame(basis, aboutPoint(m, pivotLocal(basis, fixed))));
}

/** Skew by angles (degrees; x leans vertical edges, y horizontal ones) about the pivot (keyboard, agents). */
export function skewByValues(start: TransformStart, x: number, y: number, pivot: Point = CENTER_PIVOT): SpatialValues[] {
  const tx = clampLean(Math.tan(x * DEG));
  const ty = clampLean(Math.tan(y * DEG));
  return aboutPivot(start, multiply(shear('y', ty), shear('x', tx)), pivot);
}

// ---------------------------------------------------------------- numeric transform bar

/** What the numeric transform bar shows (one element: its box in its parent; several: the frame on the page). */
export interface TransformModel {
  readonly nodes: readonly NodeId[];
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Degrees clockwise (0 for several). */
  readonly rotation: number;
  /** Horizontal skew in degrees (0 for several). */
  readonly skew: number;
  readonly flipX: boolean;
  readonly flipY: boolean;
  /** Elements left out because they are position-locked. */
  readonly locked: number;
}

export const NUMERIC_FIELDS = ['x', 'y', 'w', 'h', 'rotation', 'skew'] as const;
export type NumericField = (typeof NUMERIC_FIELDS)[number];

/** One edit of the numeric bar (`linked`: W and H keep their ratio). */
export type TransformEdit = { readonly field: NumericField; readonly value: number; readonly linked?: boolean } | { readonly flip: FlipAxis };

/** The bar's values for a start snapshot. */
export function transformModel(start: TransformStart): TransformModel {
  const e = single(start);
  const nodes = start.elements.map((el) => el.node);
  if (e !== undefined) return { nodes, x: e.box.x, y: e.box.y, w: e.box.w, h: e.box.h, rotation: e.box.rotation, skew: e.box.skewX, flipX: e.box.flipX, flipY: e.box.flipY, locked: start.locked.length };
  const b = start.frame.bounds;
  return { nodes, x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY, rotation: 0, skew: 0, flipX: false, flipY: false, locked: start.locked.length };
}

/** Field → the values that set it (relative to the model; rule 4: a table, not a branch per field). */
const NUMERIC: Readonly<Record<NumericField, (start: TransformStart, m: TransformModel, value: number, linked: boolean, pivot: Point) => SpatialValues[]>> = Object.freeze({
  x: (start, m, value) => (single(start) === undefined ? moveValues(start, value - m.x, 0) : start.elements.map((e) => ({ node: e.node, x: value, y: e.box.y }))),
  y: (start, m, value) => (single(start) === undefined ? moveValues(start, 0, value - m.y) : start.elements.map((e) => ({ node: e.node, x: e.box.x, y: value }))),
  w: (start, m, value, linked) => resizeTo(start, m, value, linked ? (m.h * value) / m.w : m.h),
  h: (start, m, value, linked) => resizeTo(start, m, linked ? (m.w * value) / m.h : m.w, value),
  rotation: (start, m, value, _linked, pivot) => rotateValues(start, normalizeDegrees(value - m.rotation), pivotPoint(start.frame, pivot)),
  skew: (start, m, value, _linked, pivot) => aboutPivot(start, shear('x', Math.tan(value * DEG) - Math.tan(m.skew * DEG)), pivot),
});

/** The top-left stays put (one element: in its own axes; several: the frame's). */
function resizeTo(start: TransformStart, m: TransformModel, w: number, h: number): SpatialValues[] {
  return single(start) === undefined ? resizeValues(start, 'se', w - m.w, h - m.h) : resizeByValues(start, w - m.w, h - m.h);
}

const RANGES: Readonly<Record<NumericField, { readonly min: number; readonly max: number }>> = Object.freeze({
  x: { min: -1e7, max: 1e7 },
  y: { min: -1e7, max: 1e7 },
  w: { min: MIN_SIZE, max: 1e7 },
  h: { min: MIN_SIZE, max: 1e7 },
  rotation: { min: -3600, max: 3600 },
  skew: { min: -SKEW_LIMIT, max: SKEW_LIMIT },
});

/** The values of one numeric-bar edit (IF-XF-001 for a value out of range or not finite). */
export function numericValues(start: TransformStart, edit: TransformEdit, pivot: Point = CENTER_PIVOT): Result<SpatialValues[]> {
  if ('flip' in edit) return ok(flipValues(start, edit.flip, pivot));
  const range = RANGES[edit.field];
  if (!Number.isFinite(edit.value) || edit.value < range.min || edit.value > range.max) {
    return err(InvalidTransformValueError({ message: `${edit.field} must be a number from ${range.min} to ${range.max}.`, details: { field: edit.field, value: edit.value, range } }));
  }
  const m = transformModel(start);
  return ok(NUMERIC[edit.field](start, m, edit.value, edit.linked === true, pivot));
}
