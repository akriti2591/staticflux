/**
 * Element geometry queries in page space (IF-7.8, IF-20.11–20.15): what tools (B3), smart guides, snapping, align and
 * distribute, the spatial index (A7) and hit testing read.
 *
 * - `elementBounds(ctx, node)` — exact geometry bounds, ink bounds (stroke, effects; clipped by a non-inverted mask),
 *   centre and the local → page transform. Groups cover their children; boolean groups use the derived outline.
 * - `containerOf` — the parent frame or page with its bounds and centre (align targets, smart guides).
 * - `siblingBounds` — the bounds of an element's siblings (equal-spacing and edge guides).
 * - `maskOf` — the mask that masks an element (a preceding sibling with `mask.mode`, or one of an ancestor).
 * - `hitElement` — a precise hit honouring fill, stroke and masks.
 * - `gridLines(box, grids)` — layout-grid lines and tracks of a frame or page (B3 snaps to them; never exported).
 */
import { err, ok, type Result } from '@staticflux/core';
import type { Box } from '@staticflux/document/spatial-index';
import type { JsonValue, NodeId, PropertyPath } from '@staticflux/document/v2';
import type { Stage } from '@staticflux/stage';
import type { BrandKitView } from './brand-kit.js';
import { CONTAINER_KINDS, ELEMENT_KINDS, P } from './components.js';
import { ActionNotApplicableError } from './errors.js';
import type { GeometryService, HitKind, PathData } from './geometry.js';
import { type Affine, applyAffine, IDENTITY, multiply, type Radii, type ResolvedElement, type ResolvedStroke, resolveElement } from './resolve.js';
import { isLayoutGridValue, type LayoutGridValue } from './values.js';

export interface ElementContext {
  readonly stage: Pick<Stage, 'read' | 'children' | 'value'>;
  readonly geometry: GeometryService;
  readonly kit?: BrandKitView;
}

/**
 * Content a stage view derives from an element's parameters (B7's repeat view, #76): the document children that hold
 * its source (its view children are derived and refuse writes), and the parameter writes that scale its layout by
 * `kx, ky` along the element's own axes, so a resize scales it like a group.
 */
export interface DerivedContent {
  readonly children: readonly NodeId[];
  scaled(kx: number, ky: number): readonly { readonly path: PropertyPath; readonly value: JsonValue }[];
}

/** A stage view that can report derived content (undefined for an element whose children are its content). */
export interface DerivedContentStage {
  derivedContent(node: NodeId): DerivedContent | undefined;
}

/** The derived content of `node` when the context's stage is a view that has any (#76). */
export function derivedContent(ctx: Pick<ElementContext, 'stage'>, node: NodeId): DerivedContent | undefined {
  return (ctx.stage as Partial<DerivedContentStage>).derivedContent?.(node);
}

export interface ElementBounds {
  readonly node: NodeId;
  /** Exact outline bounds in page space (no stroke). */
  readonly geometry: Box;
  /** What the element can paint: stroke and effects included, clipped by a non-inverted mask. */
  readonly ink: Box;
  readonly center: readonly [number, number];
  /** Local → page. */
  readonly transform: Affine;
}

const ELEMENTS = new Set<string>(ELEMENT_KINDS);
const CONTAINERS = new Set<string>(CONTAINER_KINDS);

export function unionBox(a: Box | undefined, b: Box): Box {
  return a === undefined ? b : { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
}

export function intersectBox(a: Box, b: Box): Box {
  const minX = Math.max(a.minX, b.minX);
  const minY = Math.max(a.minY, b.minY);
  return { minX, minY, maxX: Math.max(minX, Math.min(a.maxX, b.maxX)), maxY: Math.max(minY, Math.min(a.maxY, b.maxY)) };
}

export const boxCenter = (b: Box): readonly [number, number] => [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];

/** True for element kinds with a transform (frames, groups, shapes, vectors, images; text when B2 adds it). */
export function isElement(kind: string | undefined): boolean {
  return kind !== undefined && (ELEMENTS.has(kind) || kind === 'text');
}

/**
 * True when `node` or an element ancestor has `spatial.hidden` (B12, A-2): not drawn, exported, hit, snapped to or
 * announced, and left out of its group's bounds.
 */
export function isHidden(ctx: Pick<ElementContext, 'stage'>, node: NodeId): boolean {
  for (let at: NodeId | null = node; at !== null; ) {
    const composed = ctx.stage.read(at);
    if (composed === undefined || !isElement(composed.kind)) return false;
    if (composed.values[P.hidden] === true) return true;
    at = composed.parent;
  }
  return false;
}

/** Local → page transform: the product of the element ancestors' transforms (pages are the origin). */
export function pageTransform(ctx: ElementContext, node: NodeId): Affine {
  let t: Affine = IDENTITY;
  for (let at: NodeId | null = node; at !== null; ) {
    const el = resolveElement(ctx.stage, at, ctx.kit);
    if (el === undefined || !isElement(el.kind)) break;
    t = multiply(el.transform, t);
    at = el.parent;
  }
  return t;
}

/**
 * An element's outline in its local space; boolean groups combine their children (derived, never stored), and a
 * plain group's outline is the union of its children (a group can be a boolean operand or a clip mask, and a
 * repeat's instances are groups, B7).
 */
export function localOutline(ctx: ElementContext, el: ResolvedElement): Result<PathData> {
  if (el.geometry.kind !== 'boolean' && el.geometry.kind !== 'group') return ctx.geometry.outline(el);
  const operands = [];
  for (const child of ctx.stage.children(el.id)) {
    const c = resolveElement(ctx.stage, child, ctx.kit);
    if (c === undefined || !isElement(c.kind)) continue;
    const path = localOutline(ctx, c);
    if (!path.ok) return path;
    operands.push({ path: path.value, transform: c.transform, evenOdd: c.geometry.kind === 'path' && c.geometry.evenOdd });
  }
  if (el.geometry.kind === 'group') return operands.length === 0 ? ctx.geometry.outline(el) : ctx.geometry.boolean('union', operands);
  return ctx.geometry.boolean(el.geometry.op, operands);
}

/**
 * The filled outline ("ring") of a stroke that the renderer cannot stroke directly: inside, outside and per-side
 * strokes (rectangles, frames, images: outer box minus inner box, corners following the radii). Centred strokes, also
 * dashed ones, return undefined: the renderer strokes them itself.
 */
export function strokeRing(ctx: ElementContext, el: ResolvedElement, stroke: ResolvedStroke, outline: PathData): Result<PathData | undefined> {
  const g = el.geometry;
  if (stroke.sides !== undefined && (g.kind === 'rect' || g.kind === 'frame' || g.kind === 'image')) {
    const outward = stroke.align === 'center' ? 0.5 : stroke.align === 'outside' ? 1 : 0;
    const [t, r, b, l] = stroke.sides;
    const out = [t * outward, r * outward, b * outward, l * outward] as const;
    const inn = [t * (1 - outward), r * (1 - outward), b * (1 - outward), l * (1 - outward)] as const;
    const box = (grow: readonly [number, number, number, number], sign: 1 | -1): Result<PathData> => {
      const w = el.box.w + sign * (grow[1] + grow[3]);
      const h = el.box.h + sign * (grow[0] + grow[2]);
      if (!(w > 0 && h > 0)) return ok({ verbs: new Uint8Array(0), points: new Float64Array(0) });
      const [tl, tr, br, bl] = g.radii;
      const adjust = (radius: number, a: number, c: number): number => Math.max(0, radius + (sign * (a + c)) / 2);
      const radii: Radii = [adjust(tl, grow[3], grow[0]), adjust(tr, grow[0], grow[1]), adjust(br, grow[1], grow[2]), adjust(bl, grow[2], grow[3])];
      const shape = ctx.geometry.outline({ geometry: { kind: 'rect', radii, smoothing: g.smoothing }, box: { ...el.box, w, h } });
      return shape.ok ? ctx.geometry.transform(shape.value, [1, 0, 0, 1, -sign * grow[3], -sign * grow[0]]) : shape;
    };
    const outer = box(out, 1);
    if (!outer.ok) return outer;
    const inner = box(inn, -1);
    if (!inner.ok) return inner;
    return ctx.geometry.boolean('subtract', [
      { path: outer.value, transform: IDENTITY },
      { path: inner.value, transform: IDENTITY },
    ]);
  }
  if (stroke.align === 'center') return ok(undefined);
  return ctx.geometry.outlineStroke(outline, stroke);
}

/** The mask masking `node`: a visible preceding sibling with `mask.mode`, else its ancestors' mask. */
export function maskOf(ctx: ElementContext, node: NodeId): ResolvedElement | undefined {
  for (let at: NodeId | null = node; at !== null; ) {
    const el = resolveElement(ctx.stage, at, ctx.kit);
    if (el === undefined) return undefined;
    const siblings = ctx.stage.children(el.parent);
    const index = siblings.indexOf(at);
    for (let i = index - 1; i >= 0; i--) {
      const s = resolveElement(ctx.stage, siblings[i] as NodeId, ctx.kit);
      if (s?.mask !== undefined && s.hidden !== true) return s;
    }
    at = isElement(el.kind) ? el.parent : null;
  }
  return undefined;
}

/** Page-space bounds of an element (see the module header). */
export function elementBounds(ctx: ElementContext, node: NodeId): Result<ElementBounds> {
  const el = resolveElement(ctx.stage, node, ctx.kit);
  if (el === undefined || !isElement(el.kind)) return err(ActionNotApplicableError({ message: `"${node}" is not an element.`, details: { node, needs: 'an element' } }));
  const transform = pageTransform(ctx, node);
  let geometry: Box | undefined;
  let ink: Box | undefined;
  if (el.geometry.kind === 'group') {
    for (const child of ctx.stage.children(node)) {
      if (ctx.stage.read(child)?.values[P.hidden] === true) continue;
      const b = elementBounds(ctx, child);
      if (!b.ok) continue;
      geometry = unionBox(geometry, b.value.geometry);
      ink = unionBox(ink, b.value.ink);
    }
    const origin = applyAffine(transform, 0, 0);
    geometry ??= { minX: origin[0], minY: origin[1], maxX: origin[0], maxY: origin[1] };
    ink ??= geometry;
  } else {
    const outline = localOutline(ctx, el);
    if (!outline.ok) return outline;
    const g = ctx.geometry.bounds(outline.value, transform);
    if (!g.ok) return g;
    const i = ctx.geometry.inkBounds(outline.value, transform, el.strokes, el.effects);
    if (!i.ok) return i;
    geometry = g.value;
    ink = i.value;
  }
  const mask = maskOf(ctx, node);
  if (mask !== undefined && !mask.mask?.invert && mask.id !== node) {
    const m = elementBounds(ctx, mask.id);
    if (m.ok) ink = intersectBox(ink, m.value.geometry);
  }
  return ok({ node, geometry, ink, center: boxCenter(geometry), transform });
}

/**
 * Exact outline bounds of an element under `transform` (its local space → any space; no stroke): groups are the
 * union of their visible children, booleans their derived outline. Undefined for a group with nothing visible. With
 * `pageTransform(ctx, node)` it is `elementBounds(…).geometry`; with the identity it is the element's own local box
 * of content (#66: what a group's or a boolean's selection frame hugs).
 */
export function boundsIn(ctx: ElementContext, node: NodeId, transform: Affine): Result<Box | undefined> {
  const el = resolveElement(ctx.stage, node, ctx.kit);
  if (el === undefined || !isElement(el.kind)) return err(ActionNotApplicableError({ message: `"${node}" is not an element.`, details: { node, needs: 'an element' } }));
  if (el.geometry.kind !== 'group') {
    const outline = localOutline(ctx, el);
    return outline.ok ? ctx.geometry.bounds(outline.value, transform) : outline;
  }
  let box: Box | undefined;
  for (const child of ctx.stage.children(node)) {
    const c = resolveElement(ctx.stage, child, ctx.kit);
    if (c === undefined || !isElement(c.kind) || c.hidden === true) continue;
    const b = boundsIn(ctx, child, multiply(transform, c.transform));
    if (b.ok && b.value !== undefined) box = unionBox(box, b.value);
  }
  return ok(box);
}

export interface ContainerInfo {
  readonly node: NodeId;
  readonly kind: string;
  readonly bounds: Box;
  readonly center: readonly [number, number];
}

const sizeOf = (v: JsonValue | undefined): readonly [number, number] | undefined => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, JsonValue>;
  return typeof o['width'] === 'number' && typeof o['height'] === 'number' ? [o['width'], o['height']] : undefined;
};

/** Bounds of a container: a frame's box, or a page's size (`page.size`, else its spatial box). */
export function containerBounds(ctx: ElementContext, node: NodeId): Result<ContainerInfo> {
  const composed = ctx.stage.read(node);
  if (composed === undefined || !CONTAINERS.has(composed.kind)) return err(ActionNotApplicableError({ message: `"${node}" is not a frame, group or page.`, details: { node, needs: 'a container' } }));
  if (composed.kind === 'page') {
    const size = sizeOf(composed.values['page.size']) ?? [Number(composed.values[P.w] ?? 0), Number(composed.values[P.h] ?? 0)];
    const bounds = { minX: 0, minY: 0, maxX: size[0], maxY: size[1] };
    return ok({ node, kind: 'page', bounds, center: boxCenter(bounds) });
  }
  const b = elementBounds(ctx, node);
  if (!b.ok) return b;
  return ok({ node, kind: composed.kind, bounds: b.value.geometry, center: b.value.center });
}

/** The parent frame, group or page of an element. */
export function containerOf(ctx: ElementContext, node: NodeId): Result<ContainerInfo> {
  const parent = ctx.stage.read(node)?.parent ?? null;
  if (parent === null) return err(ActionNotApplicableError({ message: `"${node}" has no container.`, details: { node, needs: 'a parent' } }));
  return containerBounds(ctx, parent);
}

/** Bounds of every sibling element of `node` (smart guides: edges, centres, equal spacing). */
export function siblingBounds(ctx: ElementContext, node: NodeId): ElementBounds[] {
  const parent = ctx.stage.read(node)?.parent ?? null;
  const out: ElementBounds[] = [];
  for (const id of ctx.stage.children(parent)) {
    if (id === node || ctx.stage.read(id)?.values[P.hidden] === true) continue;
    const b = elementBounds(ctx, id);
    if (b.ok) out.push(b.value);
  }
  return out;
}

/** The widest stroke as a centred width (inside / outside strokes reach twice as far on their side). */
function strokeReach(el: ResolvedElement): number {
  let reach = 0;
  for (const s of el.strokes) {
    const w = s.sides === undefined ? s.width : Math.max(...s.sides);
    reach = Math.max(reach, s.align === 'center' ? w : 2 * w);
  }
  return reach;
}

/**
 * The box a precise hit can land in: the ink, grown to every point within half the stroke reach of the geometry.
 * `hitElement` counts a point that close as a stroke hit (a round-join model), while the ink follows the real miter or
 * bevel outline, which stops short at sharp corners; spatial indexes store this box so the broad phase never drops
 * an element the narrow phase would hit.
 */
export function hitBox(ctx: ElementContext, bounds: ElementBounds): Box {
  const el = resolveElement(ctx.stage, bounds.node, ctx.kit);
  const reach = el === undefined ? 0 : (strokeReach(el) / 2) * Math.sqrt(Math.abs(bounds.transform[0] * bounds.transform[3] - bounds.transform[1] * bounds.transform[2]));
  const g = bounds.geometry;
  return unionBox(bounds.ink, { minX: g.minX - reach, minY: g.minY - reach, maxX: g.maxX + reach, maxY: g.maxY + reach });
}

/** Precise hit (fill or stroke) at a page point, honouring the element's mask. Groups hit through their children. */
export function hitElement(ctx: ElementContext, node: NodeId, x: number, y: number, tolerance = 0): Result<HitKind> {
  const el = resolveElement(ctx.stage, node, ctx.kit);
  if (el === undefined || !isElement(el.kind) || el.hidden === true) return ok('none');
  const transform = pageTransform(ctx, node);
  let hit: HitKind = 'none';
  if (el.geometry.kind === 'group') {
    for (const child of [...ctx.stage.children(node)].reverse()) {
      if (ctx.stage.read(child)?.values[P.hidden] === true) continue;
      const r = hitElement(ctx, child, x, y, tolerance);
      if (r.ok && r.value !== 'none') {
        hit = r.value;
        break;
      }
    }
  } else {
    const outline = localOutline(ctx, el);
    if (!outline.ok) return outline;
    // Text is hit across its box (its glyphs have no fill paint here; B9 found double click to edit missed inside).
    const filled = el.fills.length > 0 || el.kind === 'image' || el.kind === 'frame' || el.kind === 'text' || el.geometry.kind === 'boolean';
    const r = ctx.geometry.hit(outline.value, transform, x, y, {
      tolerance,
      ...(filled ? { fill: el.geometry.kind === 'path' && el.geometry.evenOdd ? ('evenodd' as const) : ('nonzero' as const) } : {}),
      strokeWidth: strokeReach(el),
    });
    if (!r.ok) return r;
    hit = r.value;
  }
  if (hit === 'none') return ok(hit);
  const mask = maskOf(ctx, node);
  if (mask === undefined || mask.id === node) return ok(hit);
  const m = localOutline(ctx, mask);
  if (!m.ok) return ok(hit);
  const covered = ctx.geometry.hit(m.value, pageTransform(ctx, mask.id), x, y, { fill: 'nonzero', strokeWidth: strokeReach(mask) });
  if (!covered.ok) return ok(hit);
  const masked = (covered.value !== 'none') !== (mask.mask?.invert === true);
  return ok(masked ? hit : 'none');
}

// ---------------------------------------------------------------- layout grids

export interface GridLines {
  /** Vertical line positions (x) and horizontal ones (y), page space, sorted. */
  readonly x: readonly number[];
  readonly y: readonly number[];
  /** Column and row tracks `[start, end]` (snap targets for edges and centres). */
  readonly columns: readonly (readonly [number, number])[];
  readonly rows: readonly (readonly [number, number])[];
}

function tracks(start: number, length: number, g: Extract<LayoutGridValue, { kind: 'columns' | 'rows' }>): [number, number][] {
  const out: [number, number][] = [];
  const n = g.count;
  if (g.align === 'stretch') {
    const size = (length - 2 * g.margin - (n - 1) * g.gutter) / n;
    if (!(size > 0)) return out;
    for (let i = 0; i < n; i++) {
      const a = start + g.margin + i * (size + g.gutter);
      out.push([a, a + size]);
    }
    return out;
  }
  const size = g.size ?? 0;
  if (!(size > 0)) return out;
  const total = n * size + (n - 1) * g.gutter;
  const first = g.align === 'start' ? start + g.margin : g.align === 'end' ? start + length - g.margin - total : start + (length - total) / 2;
  for (let i = 0; i < n; i++) {
    const a = first + i * (size + g.gutter);
    out.push([a, a + size]);
  }
  return out;
}

/** Lines and tracks of the visible layout grids over `box` (exact values; tools snap to them). */
export function gridLines(box: Box, grids: readonly LayoutGridValue[]): GridLines {
  const x = new Set<number>();
  const y = new Set<number>();
  const columns: [number, number][] = [];
  const rows: [number, number][] = [];
  const w = box.maxX - box.minX;
  const h = box.maxY - box.minY;
  for (const g of grids) {
    if (g.visible === false) continue;
    if (g.kind === 'grid') {
      for (let v = box.minX; v <= box.maxX + 1e-9; v += g.size) x.add(v);
      for (let v = box.minY; v <= box.maxY + 1e-9; v += g.size) y.add(v);
      continue;
    }
    const t = g.kind === 'columns' ? tracks(box.minX, w, g) : tracks(box.minY, h, g);
    for (const [a, b] of t) {
      (g.kind === 'columns' ? x : y).add(a).add(b);
      (g.kind === 'columns' ? columns : rows).push([a, b]);
    }
  }
  const sort = (s: Set<number>): number[] => [...s].sort((a, b) => a - b);
  return { x: sort(x), y: sort(y), columns, rows };
}

/** The layout grids of a frame or page (`layout.grids`), with their page-space lines. */
export function containerGrids(ctx: ElementContext, node: NodeId): Result<{ readonly grids: readonly LayoutGridValue[]; readonly lines: GridLines }> {
  const container = containerBounds(ctx, node);
  if (!container.ok) return container;
  const raw = ctx.stage.value(node, P.grids);
  const grids = Array.isArray(raw) ? (raw.filter(isLayoutGridValue) as unknown as LayoutGridValue[]) : [];
  return ok({ grids, lines: gridLines(container.value.bounds, grids) });
}
