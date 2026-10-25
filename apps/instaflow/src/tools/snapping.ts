/**
 * Smart guides and snapping (IF-7.8, IF-24.8–24.13). Pure functions over page-space boxes, so they run in the editor
 * worker on every pointer move without touching the document:
 *
 * - `collectSnapTargets(ctx, { moving, container })` — once per gesture: the edges and centres of the moving
 *   elements' siblings (snapping to other elements), the container's edges and centre lines, and the lines of its
 *   layout grids (B1's `containerGrids` / `gridLines`), plus the sibling boxes for equal spacing.
 * - `snapBox(box, targets, settings)` — the offset that snaps a moving box: per axis the nearest candidate within
 *   `threshold` among line targets (each of the box's `features`: min edge, centre, max edge) and **equal-spacing**
 *   candidates (centred between its neighbours, or repeating a gap that already exists in the row). The result is
 *   never further than `threshold` from the input, and snapping a snapped box again moves it by zero (stable).
 * - The result carries the **guides** to draw (every line the snapped box touches, and the equal gaps) with
 *   **distance labels**; they render as a non-printing overlay (`overlay.ts`) and never reach the document.
 *
 * Thresholds are page units: callers divide the screen threshold (`SNAP_THRESHOLD_PX`) by the zoom.
 */
import { ok, type Result } from '@staticflux/core';
import type { Box } from '@staticflux/document/spatial-index';
import type { NodeId } from '@staticflux/document/v2';
import { containerBounds, containerGrids, type ElementContext, elementBounds } from '../elements/layout.js';
import { resolveElement } from '../elements/resolve.js';

export type Axis = 'x' | 'y';
export type SnapFeature = 'min' | 'center' | 'max';
export const SNAP_FEATURES: readonly SnapFeature[] = Object.freeze(['min', 'center', 'max']);
export const SNAP_LINE_KINDS = ['edge', 'center', 'container-edge', 'container-center', 'grid'] as const;
export type SnapLineKind = (typeof SNAP_LINE_KINDS)[number];

/** Screen pixels within which a box snaps (divide by zoom for page units). */
export const SNAP_THRESHOLD_PX = 6;
/** Two positions closer than this are the same (guides at the snapped position). */
export const SNAP_EPSILON = 1e-6;

export interface SnapLine {
  /** x of a vertical line (axis `x`) or y of a horizontal one (axis `y`). */
  readonly value: number;
  readonly kind: SnapLineKind;
  readonly source?: NodeId;
  /** Extent along the other axis (drawn from the source to the moving box). */
  readonly from: number;
  readonly to: number;
}

export interface SnapBox {
  readonly node: NodeId;
  readonly box: Box;
}

export interface SnapTargets {
  readonly x: readonly SnapLine[];
  readonly y: readonly SnapLine[];
  /** Sibling boxes (equal spacing). */
  readonly boxes: readonly SnapBox[];
}

export const NO_TARGETS: SnapTargets = Object.freeze({ x: [], y: [], boxes: [] });

export interface SnapSettings {
  /** Page units. */
  readonly threshold: number;
  /** Which features of the box snap per axis (default all three; a resize snaps only the moving edges). */
  readonly features?: { readonly x: readonly SnapFeature[]; readonly y: readonly SnapFeature[] };
  /** Equal-spacing candidates (default true). */
  readonly spacing?: boolean;
  /** Line kinds that snap (default all). */
  readonly kinds?: readonly SnapLineKind[];
}

export type Guide =
  | { readonly kind: 'line'; readonly axis: Axis; readonly value: number; readonly from: number; readonly to: number; readonly line: SnapLineKind; readonly source?: NodeId }
  /** Equal gaps along `axis`: each `[start, end]` interval is one gap, drawn at `cross` on the other axis. */
  | { readonly kind: 'spacing'; readonly axis: Axis; readonly gaps: readonly (readonly [number, number])[]; readonly cross: number; readonly distance: number };

export interface GuideLabel {
  /** Page-space anchor (the middle of a gap). */
  readonly x: number;
  readonly y: number;
  readonly text: string;
}

export interface SnapResult {
  readonly dx: number;
  readonly dy: number;
  readonly guides: readonly Guide[];
  readonly labels: readonly GuideLabel[];
}

const lo = (b: Box, axis: Axis): number => (axis === 'x' ? b.minX : b.minY);
const hi = (b: Box, axis: Axis): number => (axis === 'x' ? b.maxX : b.maxY);
const mid = (b: Box, axis: Axis): number => (lo(b, axis) + hi(b, axis)) / 2;
const other = (axis: Axis): Axis => (axis === 'x' ? 'y' : 'x');
const featureValue = (b: Box, axis: Axis, f: SnapFeature): number => (f === 'min' ? lo(b, axis) : f === 'max' ? hi(b, axis) : mid(b, axis));

export function shiftBox(b: Box, dx: number, dy: number): Box {
  return { minX: b.minX + dx, minY: b.minY + dy, maxX: b.maxX + dx, maxY: b.maxY + dy };
}

/** A distance as a label: at most two decimals, no trailing zeros. */
export function formatDistance(d: number): string {
  const r = Math.round(Math.abs(d) * 100) / 100;
  return Number.isInteger(r) ? `${r}` : `${r}`.replace(/0+$/, '');
}

// ---------------------------------------------------------------- candidates

interface SpacingCandidate {
  readonly d: number;
  /** Boxes whose consecutive gaps become equal (sorted along the axis, the moving box as `undefined`). */
  readonly chain: readonly (Box | undefined)[];
}

/** Row neighbours of `box` along `axis`: siblings overlapping it on the other axis, sorted along the axis. */
function rowOf(box: Box, boxes: readonly SnapBox[], axis: Axis): Box[] {
  const c = other(axis);
  return boxes
    .map((b) => b.box)
    .filter((b) => lo(b, c) < hi(box, c) && hi(b, c) > lo(box, c))
    .sort((a, b) => lo(a, axis) - lo(b, axis) || hi(a, axis) - hi(b, axis));
}

function spacingCandidates(box: Box, boxes: readonly SnapBox[], axis: Axis, threshold: number): SpacingCandidate[] {
  const row = rowOf(box, boxes, axis);
  const size = hi(box, axis) - lo(box, axis);
  const centre = mid(box, axis);
  const before = row.filter((b) => hi(b, axis) <= centre && lo(b, axis) < lo(box, axis));
  const after = row.filter((b) => lo(b, axis) >= centre && hi(b, axis) > hi(box, axis));
  const left = before.reduce<Box | undefined>((best, b) => (best === undefined || hi(b, axis) > hi(best, axis) ? b : best), undefined);
  const right = after.reduce<Box | undefined>((best, b) => (best === undefined || lo(b, axis) < lo(best, axis) ? b : best), undefined);
  const out: SpacingCandidate[] = [];
  const push = (d: number, chain: (Box | undefined)[]): void => {
    if (Math.abs(d) <= threshold) out.push({ d, chain });
  };
  if (left !== undefined && right !== undefined && lo(right, axis) - hi(left, axis) >= size) {
    push((hi(left, axis) + lo(right, axis) - size) / 2 - lo(box, axis), [left, undefined, right]);
  }
  // Repeat a gap that already exists between two row boxes, next to the nearest neighbour on either side.
  const gaps: { readonly gap: number; readonly a: Box; readonly b: Box }[] = [];
  for (let i = 1; i < row.length; i++) {
    const a = row[i - 1] as Box;
    const b = row[i] as Box;
    if (lo(b, axis) >= hi(a, axis) && a !== left && b !== right) gaps.push({ gap: lo(b, axis) - hi(a, axis), a, b });
  }
  for (const { gap, a, b } of gaps) {
    if (left !== undefined && b === left) push(hi(left, axis) + gap - lo(box, axis), [a, left, undefined]);
    if (right !== undefined && a === right) push(lo(right, axis) - gap - hi(box, axis), [undefined, right, b]);
  }
  return out;
}

interface AxisSnap {
  readonly d: number;
}

function bestOnAxis(box: Box, targets: SnapTargets, axis: Axis, settings: SnapSettings): AxisSnap {
  const threshold = settings.threshold;
  const kinds = settings.kinds === undefined ? undefined : new Set(settings.kinds);
  const features = settings.features?.[axis] ?? SNAP_FEATURES;
  let best: number | undefined;
  const consider = (d: number): void => {
    if (Math.abs(d) <= threshold && (best === undefined || Math.abs(d) < Math.abs(best))) best = d;
  };
  for (const line of targets[axis]) {
    if (kinds !== undefined && !kinds.has(line.kind)) continue;
    for (const f of features) consider(line.value - featureValue(box, axis, f));
  }
  // Spacing moves the whole box: only when every feature may move (a move, not a resize).
  if (settings.spacing !== false && features.length === SNAP_FEATURES.length) {
    for (const c of spacingCandidates(box, targets.boxes, axis, threshold)) consider(c.d);
  }
  return { d: best ?? 0 };
}

// ---------------------------------------------------------------- guides at the snapped position

function lineGuides(box: Box, targets: SnapTargets, axis: Axis, settings: SnapSettings): Guide[] {
  const kinds = settings.kinds === undefined ? undefined : new Set(settings.kinds);
  const features = settings.features?.[axis] ?? SNAP_FEATURES;
  const c = other(axis);
  const seen = new Set<string>();
  const out: Guide[] = [];
  for (const line of targets[axis]) {
    if (kinds !== undefined && !kinds.has(line.kind)) continue;
    if (!features.some((f) => Math.abs(line.value - featureValue(box, axis, f)) <= SNAP_EPSILON)) continue;
    const from = Math.min(line.from, lo(box, c));
    const to = Math.max(line.to, hi(box, c));
    const key = `${line.value.toFixed(6)}:${line.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: 'line', axis, value: line.value, from, to, line: line.kind, ...(line.source === undefined ? {} : { source: line.source }) });
  }
  return out;
}

function spacingGuides(box: Box, targets: SnapTargets, axis: Axis): { guides: Guide[]; labels: GuideLabel[] } {
  const guides: Guide[] = [];
  const labels: GuideLabel[] = [];
  const row = rowOf(box, targets.boxes, axis);
  const c = other(axis);
  const centre = mid(box, axis);
  const before = row.filter((b) => hi(b, axis) <= centre && lo(b, axis) < lo(box, axis));
  const after = row.filter((b) => lo(b, axis) >= centre && hi(b, axis) > hi(box, axis));
  const left = before.reduce<Box | undefined>((best, b) => (best === undefined || hi(b, axis) > hi(best, axis) ? b : best), undefined);
  const right = after.reduce<Box | undefined>((best, b) => (best === undefined || lo(b, axis) < lo(best, axis) ? b : best), undefined);
  const gapLeft = left === undefined ? undefined : lo(box, axis) - hi(left, axis);
  const gapRight = right === undefined ? undefined : lo(right, axis) - hi(box, axis);
  const equal = (a: number, b: number): boolean => Math.abs(a - b) <= SNAP_EPSILON;
  const emit = (distance: number, gaps: [number, number][], crossBoxes: Box[]): void => {
    const cross = (Math.max(...crossBoxes.map((b) => lo(b, c))) + Math.min(...crossBoxes.map((b) => hi(b, c)))) / 2;
    guides.push({ kind: 'spacing', axis, gaps, cross, distance });
    for (const [a, b] of gaps) {
      const m = (a + b) / 2;
      labels.push(axis === 'x' ? { x: m, y: cross, text: formatDistance(distance) } : { x: cross, y: m, text: formatDistance(distance) });
    }
  };
  if (gapLeft !== undefined && gapRight !== undefined && left !== undefined && right !== undefined && gapLeft >= 0 && equal(gapLeft, gapRight)) {
    emit(gapLeft, [[hi(left, axis), lo(box, axis)], [hi(box, axis), lo(right, axis)]], [left, box, right]);
    return { guides, labels };
  }
  for (let i = 1; i < row.length; i++) {
    const a = row[i - 1] as Box;
    const b = row[i] as Box;
    const gap = lo(b, axis) - hi(a, axis);
    if (gap < 0) continue;
    if (left !== undefined && b === left && gapLeft !== undefined && equal(gap, gapLeft)) {
      emit(gap, [[hi(a, axis), lo(b, axis)], [hi(left, axis), lo(box, axis)]], [a, left, box]);
      break;
    }
    if (right !== undefined && a === right && gapRight !== undefined && equal(gap, gapRight)) {
      emit(gap, [[hi(box, axis), lo(right, axis)], [hi(a, axis), lo(b, axis)]], [box, right, b]);
      break;
    }
  }
  return { guides, labels };
}

/** Snap a moving box (see the module header). */
export function snapBox(box: Box, targets: SnapTargets, settings: SnapSettings): SnapResult {
  const dx = bestOnAxis(box, targets, 'x', settings).d;
  const dy = bestOnAxis(box, targets, 'y', settings).d;
  const snapped = shiftBox(box, dx, dy);
  const guides: Guide[] = [...lineGuides(snapped, targets, 'x', settings), ...lineGuides(snapped, targets, 'y', settings)];
  const labels: GuideLabel[] = [];
  if (settings.spacing !== false) {
    for (const axis of ['x', 'y'] as const) {
      if ((settings.features?.[axis] ?? SNAP_FEATURES).length !== SNAP_FEATURES.length) continue;
      const s = spacingGuides(snapped, targets, axis);
      guides.push(...s.guides);
      labels.push(...s.labels);
    }
  }
  return { dx, dy, guides, labels };
}

/** Snap a single point (resize handles of rotated elements, pen tools): its own features are all `min`. */
export function snapPoint(x: number, y: number, targets: SnapTargets, settings: Omit<SnapSettings, 'features' | 'spacing'>): SnapResult {
  return snapBox({ minX: x, minY: y, maxX: x, maxY: y }, targets, { ...settings, spacing: false, features: { x: ['min'], y: ['min'] } });
}

// ---------------------------------------------------------------- targets from the document

function boxLines(b: Box, node: NodeId, edge: SnapLineKind, centre: SnapLineKind): { x: SnapLine[]; y: SnapLine[] } {
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const v = (value: number, kind: SnapLineKind): SnapLine => ({ value, kind, source: node, from: b.minY, to: b.maxY });
  const h = (value: number, kind: SnapLineKind): SnapLine => ({ value, kind, source: node, from: b.minX, to: b.maxX });
  return { x: [v(b.minX, edge), v(cx, centre), v(b.maxX, edge)], y: [h(b.minY, edge), h(cy, centre), h(b.maxY, edge)] };
}

export interface SnapTargetOptions {
  /** The elements being moved or resized (excluded from the targets). */
  readonly moving: readonly NodeId[];
  /** Their container (default the first one's parent). */
  readonly container?: NodeId;
  /** Snap to the container's layout grids (default true). */
  readonly grids?: boolean;
  /** Extra elements to snap to (e.g. elements in view in other containers). */
  readonly extra?: readonly NodeId[];
}

/** Snap targets for one gesture (see the module header). */
export function collectSnapTargets(ctx: ElementContext, options: SnapTargetOptions): Result<SnapTargets> {
  const moving = new Set(options.moving);
  const first = options.moving[0];
  const container = options.container ?? (first === undefined ? undefined : (ctx.stage.read(first)?.parent ?? undefined));
  if (container === undefined) return ok(NO_TARGETS);
  const x: SnapLine[] = [];
  const y: SnapLine[] = [];
  const boxes: SnapBox[] = [];
  const add = (node: NodeId): void => {
    if (moving.has(node)) return;
    const el = resolveElement(ctx.stage, node, ctx.kit);
    if (el === undefined || el.mask !== undefined) return;
    const b = elementBounds(ctx, node);
    if (!b.ok) return;
    const lines = boxLines(b.value.geometry, node, 'edge', 'center');
    x.push(...lines.x);
    y.push(...lines.y);
    boxes.push({ node, box: b.value.geometry });
  };
  for (const child of ctx.stage.children(container)) add(child);
  for (const node of options.extra ?? []) if (!ctx.stage.children(container).includes(node)) add(node);
  const c = containerBounds(ctx, container);
  if (c.ok) {
    const lines = boxLines(c.value.bounds, container, 'container-edge', 'container-center');
    x.push(...lines.x);
    y.push(...lines.y);
    if (options.grids !== false) {
      const grids = containerGrids(ctx, container);
      if (grids.ok) {
        const b = c.value.bounds;
        for (const value of grids.value.lines.x) x.push({ value, kind: 'grid', source: container, from: b.minY, to: b.maxY });
        for (const value of grids.value.lines.y) y.push({ value, kind: 'grid', source: container, from: b.minX, to: b.maxX });
      }
    }
  }
  return ok({ x, y, boxes });
}
