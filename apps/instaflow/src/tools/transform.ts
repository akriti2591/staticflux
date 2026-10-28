/**
 * Transforms (IF-24.6–24.7, IF-24.14–24.16): selection frames, round transform handles (Clean Pop: "selection
 * handles are round"), and the page-space maths of move, resize and rotate as `spatial.*` values. Every function
 * works from a **start snapshot** taken when the gesture begins (`captureTransform`), so a gesture's preview and its
 * commit are the same pure function of the pointer, and position-locked elements are never moved (they stay out of
 * the snapshot and are reported in `locked`).
 *
 * - `selectionFrame(ctx, nodes)` — one element: its rotated box (four page corners, rotation); several: the union
 *   of their geometry bounds.
 * - `transformHandles(frame, zoom, pivot?)` / `pickHandle(handles, x, y)` — eight resize handles, four rotate zones
 *   just outside the corners, and (B10a) the pivot; radii are screen pixels converted to page units.
 * - `moveValues`, `resizeValues`, `rotateValues` — the new `spatial.*` values per element; `valuesToOps` turns them
 *   into one batch of part ops (one change set, one undo step).
 * - B10a: `valuesForTransform` / `transformValues` decompose any page-space affine back into an element's box
 *   (`x, y, w, h, rotation, skewX, flipX, flipY`), which is how flips, skew and a resize dragged past the opposite
 *   edge (a flip, IF-34.2) are written; resize with `fromCenter` works about the pivot (`ResizeOptions.pivot`).
 */
import { err, ok, type Result } from '@staticflux/core';
import type { Box } from '@staticflux/document/spatial-index';
import type { JsonValue, NodeId, PartOp, PropertyPath } from '@staticflux/document/v2';
import type { Stage } from '@staticflux/stage';
import { P } from '../elements/components.js';
import { boundsIn, type DerivedContent, derivedContent, type ElementContext, elementBounds, isElement, pageTransform } from '../elements/layout.js';
import { type Affine, applyAffine, boxTransform, type ElementBox, fitBox, IDENTITY, invert, multiply, type ResolvedElement, resolveElement } from '../elements/resolve.js';
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

/** Geometry kinds whose outline comes from their children, not from their box (#66). */
const CHILD_SIZED: ReadonlySet<string> = new Set(['group', 'boolean']);

/**
 * The box a selection frame and every transform of one element work on: its own, or for a group or a boolean the box
 * that hugs its visible children in its own axes (#66: their stored `w, h` are 0 and draw nothing). An empty group
 * keeps its own box.
 */
export function frameBox(ctx: ElementContext, el: ResolvedElement): Result<ElementBox> {
  if (!CHILD_SIZED.has(el.geometry.kind)) return ok(el.box);
  const local = boundsIn(ctx, el.id, IDENTITY);
  if (!local.ok) return local;
  return ok(local.value === undefined ? el.box : fitBox(el.box, local.value));
}

/** Parent → page of an element (identity under a page). */
const parentToPage = (ctx: ElementContext, el: ResolvedElement): Affine => (el.parent === null ? IDENTITY : pageTransform(ctx, el.parent));

/** The frame the handles sit on (see the module header); undefined for an empty selection. */
export function selectionFrame(ctx: ElementContext, nodes: readonly NodeId[]): Result<SelectionFrame | undefined> {
  if (nodes.length === 0) return ok(undefined);
  const single = nodes.length === 1 ? resolveElement(ctx.stage, nodes[0] as NodeId, ctx.kit) : undefined;
  const box = single === undefined ? undefined : frameBox(ctx, single);
  if (box !== undefined && !box.ok) return box;
  if (single !== undefined && box?.ok === true && (single.geometry.kind !== 'group' || box.value !== single.box) && box.value.w > 0 && box.value.h > 0) {
    const t = multiply(parentToPage(ctx, single), boxTransform(box.value));
    const corners = boxCorners({ minX: 0, minY: 0, maxX: box.value.w, maxY: box.value.h }).map(([x, y]) => applyAffine(t, x, y)) as unknown as [Point, Point, Point, Point];
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
/** B11b (STUDIO §6.1): the visible rotate handle, 24 px below the frame's bottom edge on a stem. */
export const ROTATE_STEM_HANDLE = 'rotate-stem';
export type RotateHandleId = (typeof ROTATE_HANDLES)[number] | typeof ROTATE_STEM_HANDLE;
/** The reference point (B10a): the point rotate and Alt-resize work about. */
export const PIVOT_HANDLE = 'pivot';
export type HandleId = ResizeHandleId | RotateHandleId | typeof PIVOT_HANDLE;

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

const ROTATE_CORNER: Readonly<Record<(typeof ROTATE_HANDLES)[number], ResizeHandleId>> = Object.freeze({ 'rotate-nw': 'nw', 'rotate-ne': 'ne', 'rotate-se': 'se', 'rotate-sw': 'sw' });

/** Handle sizes in screen pixels (Clean Pop: round handles). */
export const HANDLE_SIZES = Object.freeze({ radius: 4.5, hitRadius: 7, rotateRadius: 14, rotateOffset: 12, stemLength: 24, pivotRadius: 5, pivotHitRadius: 8 });

export type HandleKind = 'resize' | 'rotate' | 'pivot';

export interface TransformHandle {
  readonly id: HandleId;
  readonly kind: HandleKind;
  /** Page-space centre. */
  readonly x: number;
  readonly y: number;
  /** Page units: drawn radius and hit radius. */
  readonly radius: number;
  readonly hitRadius: number;
}

/** The page point at frame fractions `(u, v)` (0, 0 = top-left corner; 1, 1 = bottom-right; rotated and skewed frames too). */
export function framePoint(frame: SelectionFrame, u: number, v: number): Point {
  const [tl, tr, , bl] = frame.corners;
  return [tl[0] + (tr[0] - tl[0]) * u + (bl[0] - tl[0]) * v, tl[1] + (tr[1] - tl[1]) * u + (bl[1] - tl[1]) * v];
}

/** Where the rotate stem starts (the bottom edge's midpoint) and ends (24 screen px further, along the frame's down axis). */
export function stemStart(frame: SelectionFrame): Point {
  return framePoint(frame, 0.5, 1);
}

export function stemEnd(frame: SelectionFrame, zoom: number): Point {
  const [tl, , , bl] = frame.corners;
  const dx = bl[0] - tl[0];
  const dy = bl[1] - tl[1];
  const len = Math.hypot(dx, dy) || 1;
  const off = HANDLE_SIZES.stemLength / zoom;
  const [x, y] = stemStart(frame);
  return [x + (dx / len) * off, y + (dy / len) * off];
}

/**
 * Handles of a frame at a zoom (rotate zones first in hit priority after resize handles). `pivot` (frame fractions)
 * adds the reference-point handle (B10a: shown in transform mode, or once it was moved).
 */
export function transformHandles(frame: SelectionFrame, zoom: number, pivot?: Point): readonly TransformHandle[] {
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
  const [x, y] = stemEnd(frame, zoom);
  out.push({ id: ROTATE_STEM_HANDLE, kind: 'rotate', x, y, radius: HANDLE_SIZES.radius * s, hitRadius: HANDLE_SIZES.hitRadius * s });
  if (pivot !== undefined) {
    const [x, y] = framePoint(frame, pivot[0], pivot[1]);
    out.push({ id: PIVOT_HANDLE, kind: 'pivot', x, y, radius: HANDLE_SIZES.pivotRadius * s, hitRadius: HANDLE_SIZES.pivotHitRadius * s });
  }
  return out;
}

/** Hit priority per handle kind (lower wins, then the nearest): resize handles, the pivot, rotate zones. */
const HANDLE_RANK: Readonly<Record<HandleKind, number>> = Object.freeze({ resize: 0, pivot: 1e6, rotate: 2e6 });

/**
 * The handle under a page point (resize handles win over the pivot, the pivot over rotate zones). `prefer` puts one
 * kind first (B10a: Alt grabs the pivot even where it sits on a resize handle).
 */
export function pickHandle(handles: readonly TransformHandle[], x: number, y: number, prefer?: HandleKind): TransformHandle | undefined {
  let best: TransformHandle | undefined;
  let bestD = Infinity;
  for (const h of handles) {
    const d = Math.hypot(h.x - x, h.y - y);
    if (d > h.hitRadius) continue;
    const rank = (h.kind === prefer ? -1e7 : HANDLE_RANK[h.kind]) + d;
    if (rank < bestD) {
      best = h;
      bestD = rank;
    }
  }
  return best;
}

// ---------------------------------------------------------------- start snapshot

/**
 * What follows an element's box when it changes (#54, #66), because the box alone draws nothing of it: a vector's
 * path (scaled by the box's size change) or the children of a group or a boolean (`box` is then the element's stored
 * box, while `ElementStart.box` is the frame box that hugs the children; the children's starts are in its local space).
 */
export type ElementContent =
  | { readonly kind: 'path'; readonly d: string; readonly scaled: (kx: number, ky: number) => string }
  | {
      readonly kind: 'children';
      readonly box: ElementBox;
      readonly children: readonly ElementStart[];
      /** #76: a repeat's spacing, which scales with its source (its children are then the source, not the instances). */
      readonly layout?: DerivedContent['scaled'];
    };

export interface ElementStart {
  readonly node: NodeId;
  /** The box transforms work on: the element's own, or the frame box of a group or a boolean (`frameBox`). */
  readonly box: ElementBox;
  /** Local (of `box`) → page. */
  readonly transform: Affine;
  /** Parent → page (identity under a page). */
  readonly parent: Affine;
  /** Page geometry bounds. */
  readonly bounds: Box;
  readonly content?: ElementContent;
}

export interface TransformStart {
  readonly elements: readonly ElementStart[];
  /** Position-locked elements left out (they stay put). */
  readonly locked: readonly NodeId[];
  readonly frame: SelectionFrame;
}

/**
 * One element's start under `parent` (parent → page, or → the group a child is in), with what follows its box.
 * `bounds` defaults to the box's corners in the parent's space (children: never read by the transforms).
 */
function startOf(ctx: ElementContext, el: ResolvedElement, parent: Affine, bounds?: Box): Result<ElementStart> {
  const box = frameBox(ctx, el);
  if (!box.ok) return box;
  const transform = multiply(parent, boxTransform(box.value));
  const corners = boxCorners({ minX: 0, minY: 0, maxX: box.value.w, maxY: box.value.h }).map(([x, y]) => applyAffine(transform, x, y));
  const start = { node: el.id, box: box.value, transform, parent, bounds: bounds ?? boundsOf(corners) };
  const g = el.geometry;
  if (g.kind === 'path') {
    const path = ctx.geometry.parsePath(g.d);
    if (!path.ok) return ok(start);
    const scaled = (kx: number, ky: number): string => {
      const t = ctx.geometry.transform(path.value, [kx, 0, 0, ky, 0, 0]);
      return t.ok ? ctx.geometry.toSvg(t.value) : g.d;
    };
    return ok({ ...start, content: { kind: 'path', d: g.d, scaled } });
  }
  if (!CHILD_SIZED.has(g.kind) || box.value === el.box) return ok(start);
  const children: ElementStart[] = [];
  // A repeat's view children are derived instances (writes to them are refused, IF-REP-004): its source takes the
  // scale and its spacing scales with it (#76).
  const derived = derivedContent(ctx, el.id);
  // Hidden children scale too (they come back the right size); the frame box only hugs the visible ones.
  for (const child of derived?.children ?? ctx.stage.children(el.id)) {
    const c = resolveElement(ctx.stage, child, ctx.kit);
    if (c === undefined || !isElement(c.kind)) continue;
    const s = startOf(ctx, c, IDENTITY);
    if (!s.ok) return s;
    children.push(s.value);
  }
  return ok({ ...start, content: { kind: 'children', box: el.box, children, ...(derived === undefined ? {} : { layout: derived.scaled }) } });
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
    const e = startOf(ctx, el, parentToPage(ctx, el), b.value.geometry);
    if (!e.ok) return e;
    elements.push(e.value);
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
  /** B10a. */
  readonly skewX?: number;
  readonly flipX?: boolean;
  readonly flipY?: boolean;
}

/** Every field `SpatialValues` can carry, with its document path (previews and ops walk this; rule 1). */
export const SPATIAL_VALUE_PATHS = Object.freeze({ x: P.x, y: P.y, w: P.w, h: P.h, rotation: P.rotation, skewX: P.skewX, flipX: P.flipX, flipY: P.flipY } as const);
export type SpatialValueKey = keyof typeof SPATIAL_VALUE_PATHS;
export const SPATIAL_VALUE_KEYS: readonly SpatialValueKey[] = Object.freeze(Object.keys(SPATIAL_VALUE_PATHS) as SpatialValueKey[]);

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
  /** Resize about the centre (Alt), or about `pivot` when there is one. */
  readonly fromCenter?: boolean;
  /** B10a: the reference point in frame fractions (default the centre); used with `fromCenter`. */
  readonly pivot?: Point;
}

/** True when an element's local axes are the page axes (no rotation, skew or flip): its edges can snap. */
export function axisAligned(t: Affine): boolean {
  return Math.abs(t[1]) < 1e-9 && Math.abs(t[2]) < 1e-9 && t[0] > 0 && t[3] > 0;
}

/** The closest a pivot may sit to the dragged edge, as a fraction of the frame (keeps the scale factor finite). */
const MIN_LEVER = 0.05;

const signedMin = (v: number): number => (v < 0 ? -1 : 1) * Math.max(MIN_SIZE, Math.abs(v));

/**
 * Signed size after dragging a handle by `(dx, dy)`: negative when the dragged edge crossed the fixed point (B10a: a
 * flip on that axis, IF-34.2); the magnitude is never below `MIN_SIZE`.
 */
export function resizedSize(w0: number, h0: number, handle: ResizeHandleId, dx: number, dy: number, options: ResizeOptions = {}): { readonly w: number; readonly h: number } {
  const [hx, hy] = HANDLE_DIRECTIONS[handle];
  const [ux, uy] = fixedFraction(handle, options);
  const kx = 1 / Math.max(MIN_LEVER, Math.abs((hx + 1) / 2 - ux));
  const ky = 1 / Math.max(MIN_LEVER, Math.abs((hy + 1) / 2 - uy));
  let w = w0 + hx * dx * kx;
  let h = h0 + hy * dy * ky;
  if (options.aspect === true && w0 > 0 && h0 > 0) {
    const s = hx === 0 ? h / h0 : hy === 0 ? w / w0 : Math.abs(w / w0 - 1) >= Math.abs(h / h0 - 1) ? w / w0 : h / h0;
    w = w0 * s;
    h = h0 * s;
  }
  return { w: signedMin(w), h: signedMin(h) };
}

/** Page-space box after dragging a handle by `(dx, dy)` (axis-aligned frames; what snapping works on); past the fixed point the box flips over it. */
export function resizedBounds(b: Box, handle: ResizeHandleId, dx: number, dy: number, options: ResizeOptions = {}): Box {
  const w0 = b.maxX - b.minX;
  const h0 = b.maxY - b.minY;
  const { w, h } = resizedSize(w0, h0, handle, dx, dy, options);
  const [ux, uy] = fixedFraction(handle, options);
  const px = b.minX + w0 * ux;
  const py = b.minY + h0 * uy;
  const x0 = px - w * ux;
  const x1 = px + w * (1 - ux);
  const y0 = py - h * uy;
  const y1 = py + h * (1 - uy);
  return { minX: Math.min(x0, x1), minY: Math.min(y0, y1), maxX: Math.max(x0, x1), maxY: Math.max(y0, y1) };
}

/** The point of the unit box that stays put while a handle is dragged (the opposite edge, or the centre / pivot). */
export function fixedFraction(handle: ResizeHandleId, options: ResizeOptions = {}): Point {
  const [hx, hy] = HANDLE_DIRECTIONS[handle];
  const [px, py] = options.pivot ?? [0.5, 0.5];
  const about = options.fromCenter === true;
  return [about ? px : hx === 0 ? 0.5 : (1 - hx) / 2, about ? py : hy === 0 ? 0.5 : (1 - hy) / 2];
}

/**
 * Resize: one element in its own (possibly rotated or skewed) frame — the opposite handle (or the centre / pivot)
 * stays put on the page; several elements scale with the selection frame about its fixed point (each keeps its
 * rotation, its centre follows the frame and its local axes stretch by the frame's factors). Dragged past the fixed
 * point, the box flips over it on that axis (B10a).
 */
export function resizeValues(start: TransformStart, handle: ResizeHandleId, dx: number, dy: number, options: ResizeOptions = {}): SpatialValues[] {
  const single = start.elements.length === 1 ? (start.elements[0] as ElementStart) : undefined;
  if (single !== undefined && single.box.w > 0 && single.box.h > 0) {
    const e = single;
    const inv = invert(linear(e.transform)) ?? IDENTITY;
    const [ldx, ldy] = applyAffine(inv, dx, dy);
    const signed = resizedSize(e.box.w, e.box.h, handle, ldx, ldy, options);
    const w = Math.abs(signed.w);
    const h = Math.abs(signed.h);
    // The fixed point: where the unmoved part of the old box was (in old local units) and is (in new local units).
    const [fx, fy] = fixedFraction(handle, options);
    const target = applyAffine(e.transform, fx * e.box.w, fy * e.box.h);
    const values: SpatialValues = { node: e.node, ...place(e, { ...e.box, w, h }, [fx * w, fy * h], target), w, h };
    // Past the fixed point: mirror the resized box over it, in its own axes.
    return [flipOver(e, values, signed, (t) => [applyAffine(t, fx * w, fy * h), linear(t)])];
  }
  const from = start.frame.bounds;
  const signed = resizedSize(from.maxX - from.minX, from.maxY - from.minY, handle, dx, dy, options);
  const [ux, uy] = fixedFraction(handle, options);
  const fixed: Point = [from.minX + (from.maxX - from.minX) * ux, from.minY + (from.maxY - from.minY) * uy];
  return magnitudeResize(start, handle, dx, dy, options).map((v, i) => flipOver(start.elements[i] as ElementStart, v, signed, () => [fixed, IDENTITY]));
}

/**
 * Mirror resized values over the fixed point on the axes whose signed size is negative. `axes(t)` gives, for the
 * resized element's transform, the fixed point (page) and the linear map whose axes the mirror follows (the element's
 * own for one element, the page's for a selection frame).
 */
function flipOver(e: ElementStart, v: SpatialValues, signed: { readonly w: number; readonly h: number }, axes: (t: Affine) => readonly [Point, Affine]): SpatialValues {
  if (signed.w > 0 && signed.h > 0) return v;
  const resized = startAfter(e, v);
  const [fixed, basis] = axes(resized.transform);
  const mirror = multiply(basis, multiply([signed.w < 0 ? -1 : 1, 0, 0, signed.h < 0 ? -1 : 1, 0, 0], invert(basis) ?? IDENTITY));
  return { ...v, ...valuesForTransform(resized, multiply(aboutPoint(mirror, fixed), resized.transform)) };
}

/** B3's frame scale with the sizes' magnitudes (each element keeps its rotation; its centre follows the frame). */
function magnitudeResize(start: TransformStart, handle: ResizeHandleId, dx: number, dy: number, options: ResizeOptions): SpatialValues[] {
  const from = start.frame.bounds;
  const to = resizedBounds(from, handle, dx, dy, options);
  const sx = (to.maxX - to.minX) / Math.max(1e-9, from.maxX - from.minX);
  const sy = (to.maxY - to.minY) / Math.max(1e-9, from.maxY - from.minY);
  const [ux, uy] = fixedFraction(handle, options);
  const fixed: Point = [from.minX + (from.maxX - from.minX) * ux, from.minY + (from.maxY - from.minY) * uy];
  return start.elements.map((e) => {
    const c = [(e.bounds.minX + e.bounds.maxX) / 2, (e.bounds.minY + e.bounds.maxY) / 2] as const;
    // Magnitudes: the frame scales about its fixed point (a flip is applied afterwards, by `flipOver`).
    const target: Point = [fixed[0] + (c[0] - fixed[0]) * sx, fixed[1] + (c[1] - fixed[1]) * sy];
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

// ---------------------------------------------------------------- page affines (B10a)

/** `T(p) · m · T(−p)`: the linear part of `m` about a page point. */
export function aboutPoint(m: Affine, p: Point): Affine {
  const [x, y] = applyAffine(linear(m), p[0], p[1]);
  return [m[0], m[1], m[2], m[3], p[0] - x, p[1] - y];
}

/** A start element as it would be after `v` (box and transforms), to chain one change onto another. */
export function startAfter(e: ElementStart, v: SpatialValues): ElementStart {
  const box: ElementBox = { ...e.box, ...v };
  const transform = multiply(e.parent, boxTransform(box));
  const corners = boxCorners({ minX: 0, minY: 0, maxX: box.w, maxY: box.h }).map(([x, y]) => applyAffine(transform, x, y));
  return { node: e.node, box, transform, parent: e.parent, bounds: boundsOf(corners) };
}

const EPS = 1e-9;

/**
 * The box values that give an element the page transform `next`, which maps the element's **old** local coordinates
 * to the page: `next = parent · boxTransform(box') · diag(w'/w, h'/h)`. The linear part is decomposed as rotation ·
 * flips and scale · horizontal skew (`boxTransform`'s order); of the two equivalent flip choices the one whose rotation
 * is closest to the old rotation wins (a horizontal flip stays a flip, not a 180° turn plus a vertical flip). Zero-size
 * axes (groups) keep their size. A singular `next` changes nothing.
 */
export function valuesForTransform(e: ElementStart, next: Affine): SpatialValues {
  const unchanged: SpatialValues = { node: e.node, x: e.box.x, y: e.box.y };
  const inParent = multiply(invert(e.parent) ?? IDENTITY, next);
  const [c1x, c1y, c2x, c2y] = inParent;
  const sX = Math.abs(e.box.scaleX);
  const sY = Math.abs(e.box.scaleY);
  const len1 = Math.hypot(c1x, c1y);
  if (len1 < EPS || sX < EPS || sY < EPS || Math.abs(c1x * c2y - c1y * c2x) < EPS) return unchanged;
  const choice = (flipX: boolean): { readonly flipX: boolean; readonly f: number; readonly rotation: number; readonly off: number } => {
    const f = flipX ? -1 : 1;
    const rotation = normalizeDegrees((Math.atan2(f * c1y, f * c1x) * 180) / Math.PI);
    return { flipX, f, rotation, off: Math.abs(normalizeDegrees(rotation - e.box.rotation)) };
  };
  const keep = choice(e.box.flipX);
  const other = choice(!e.box.flipX);
  const { flipX, f, rotation } = other.off < keep.off - 1e-6 ? other : keep;
  const r = (rotation * Math.PI) / 180;
  const qx = Math.cos(r) * c2x + Math.sin(r) * c2y;
  const qy = -Math.sin(r) * c2x + Math.cos(r) * c2y;
  const kx = len1 / sX;
  const ky = Math.abs(qy) / sY;
  const flipY = qy < 0;
  const skewX = (Math.atan(qx / (f * sX * ky)) * 180) / Math.PI;
  const w = e.box.w > 0 ? e.box.w * kx : e.box.w;
  const h = e.box.h > 0 ? e.box.h * ky : e.box.h;
  const box: ElementBox = { ...e.box, w, h, rotation, skewX, flipX, flipY };
  const at = place(e, box, [0, 0], applyAffine(next, 0, 0));
  return { node: e.node, ...at, w, h, rotation, skewX, flipX, flipY };
}

/** Apply a page-space affine to every element of a start snapshot (B10a: flips, skew, numeric transforms). */
export function transformValues(start: TransformStart, g: Affine): SpatialValues[] {
  return start.elements.map((e) => valuesForTransform(e, multiply(g, e.transform)));
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

/** Rotate every element by `degrees` about a page point (default the frame centre; each element's centre orbits it). */
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

const same = (a: number | boolean, b: number | boolean): boolean => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : a === b);

/** One value a transform writes: a spatial value, a vector's path, or a value of a group's or a boolean's child. */
export interface TransformWrite {
  readonly node: NodeId;
  readonly path: PropertyPath;
  readonly value: JsonValue;
}

/**
 * Which writes a transform makes: `changed` only what differs from the start (commits: one change set of real
 * changes); `shown` every value of what it reaches, so a preview redrawn on each pointer move never leaves a stale
 * value behind (a size dragged back to the start still rewrites the path and the children).
 */
export type WriteMode = 'changed' | 'shown';

const SCALE_EPS = 1e-12;

/** The spatial values of `after` against `before` (only the keys `keys` names, all of them when shown). */
function spatialWrites(node: NodeId, before: ElementBox, after: ElementBox, keys: readonly SpatialValueKey[], mode: WriteMode, out: TransformWrite[]): void {
  for (const key of keys) if (mode === 'shown' || !same(before[key], after[key])) out.push({ node, path: SPATIAL_VALUE_PATHS[key], value: after[key] });
}

/**
 * Writes for new values `v` of the box a start works on. A vector's path scales with its box (#54); a group or a
 * boolean takes what its stored box can hold (move, rotation, flips, skew) and its children take the rest, the scale
 * (#66), recursively; any other element writes its values as they are.
 */
function followValues(e: ElementStart, v: Partial<SpatialValues>, keys: readonly SpatialValueKey[], mode: WriteMode, out: TransformWrite[]): void {
  const defined = Object.fromEntries(SPATIAL_VALUE_KEYS.filter((k) => v[k] !== undefined).map((k) => [k, v[k]])) as Partial<ElementBox>;
  const box: ElementBox = { ...e.box, ...defined };
  const kx = e.box.w > 0 ? box.w / e.box.w : 1;
  const ky = e.box.h > 0 ? box.h / e.box.h : 1;
  const content = e.content;
  const scaled = Math.abs(kx - 1) > SCALE_EPS || Math.abs(ky - 1) > SCALE_EPS;
  if (content?.kind !== 'children') {
    spatialWrites(e.node, e.box, box, keys, mode, out);
    if (content?.kind === 'path' && (scaled || mode === 'shown')) out.push({ node: e.node, path: P.path, value: scaled ? content.scaled(kx, ky) : content.d });
    return;
  }
  // The stored box's local space → parent after the change (the frame box's local axes stretch by kx, ky).
  const next = multiply(boxTransform(box), multiply([kx, 0, 0, ky, 0, 0], multiply(invert(boxTransform(e.box)) ?? IDENTITY, boxTransform(content.box))));
  const own: ElementStart = { node: e.node, box: content.box, transform: boxTransform(content.box), parent: IDENTITY, bounds: e.bounds };
  const held = valuesForTransform(own, next);
  // A resize keeps the group's own origin (its children take the move with the scale); anything else moves the group.
  const at = scaled ? { x: content.box.x, y: content.box.y } : { x: held.x, y: held.y };
  const kept: ElementBox = { ...content.box, ...at, ...(held.rotation === undefined ? {} : { rotation: held.rotation }), ...(held.skewX === undefined ? {} : { skewX: held.skewX }), ...(held.flipX === undefined ? {} : { flipX: held.flipX }), ...(held.flipY === undefined ? {} : { flipY: held.flipY }) };
  spatialWrites(e.node, content.box, kept, ['x', 'y', 'rotation', 'skewX', 'flipX', 'flipY'], mode, out);
  if (content.layout !== undefined && (scaled || mode === 'shown')) {
    const was = content.layout(1, 1);
    content.layout(kx, ky).forEach((w, i) => {
      if (mode === 'shown' || w.value !== was[i]?.value) out.push({ node: e.node, path: w.path, value: w.value });
    });
  }
  // What the stored box could not hold, in the group's own space: applied to every child.
  const rest = multiply(invert(boxTransform(kept)) ?? IDENTITY, next);
  const identity = rest.every((n, i) => Math.abs(n - (IDENTITY[i] as number)) < 1e-9);
  if (identity && mode === 'changed') return;
  for (const c of content.children) followValues(c, valuesForTransform(c, multiply(rest, c.transform)), SPATIAL_VALUE_KEYS, mode, out);
}

/** The writes of new spatial values (see `WriteMode`); values of nodes outside the start are written as given. */
export function transformWrites(start: TransformStart, values: readonly SpatialValues[], mode: WriteMode = 'changed'): TransformWrite[] {
  const starts = new Map(start.elements.map((e) => [e.node, e]));
  const out: TransformWrite[] = [];
  for (const v of values) {
    const keys = SPATIAL_VALUE_KEYS.filter((k) => v[k] !== undefined);
    const e = starts.get(v.node);
    if (e === undefined) for (const key of keys) out.push({ node: v.node, path: SPATIAL_VALUE_PATHS[key], value: v[key] as JsonValue });
    else followValues(e, v, keys, mode, out);
  }
  return out;
}

/** One batch of `set` ops for new spatial values (unchanged fields are skipped; paths and children follow, #54 #66). */
export function valuesToOps(start: TransformStart, values: readonly SpatialValues[]): PartOp[] {
  return transformWrites(start, values).map((w) => ({ op: 'set', node: w.node, path: w.path, value: w.value }));
}

/** The page bounds of a start element after new values (preview of snapping and overlays). */
export function boundsAfter(e: ElementStart, v: SpatialValues): Box {
  return startAfter(e, v).bounds;
}
