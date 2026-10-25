/**
 * Hit testing and marquee selection (IF-7.8, IF-24.2–24.5): a **broad phase** over A7's spatial index (rbush over
 * B1's page-space ink bounds) and an **exact narrow phase** on B1 geometry (kurbo in the authoring Wasm:
 * `hitElement` for points, `GeometryService.intersects` for rectangles), honouring fills, strokes, masks and frame
 * clips. The brute-force variants (`hitTestBrute`, `marqueeSelectBrute`) walk every element and run the same narrow
 * test; the parity property in `hit-test.test.ts` checks that both always agree.
 *
 * - `createElementIndex(ctx, root, scope?)` — the element index of one page: bulk-built once, kept current from the
 *   stage's `onInvalidate` (a moved container re-indexes its subtree), refreshed lazily before a query.
 * - `hitTest(ctx, index, x, y, options)` — the topmost hittable leaf at a page point and the **selection target**
 *   it stands for: the child of the entered container (`context`) above it, seen through frames (frames are
 *   transparent, groups are opaque; `deep` picks the leaf itself, Mod+click). Fully locked elements (position and
 *   content) are not selectable on the canvas and let the click through.
 * - `marqueeSelect(ctx, index, rect, options)` — children of `context` touched by (`touch`) or inside (`contain`)
 *   a page-space rectangle, in paint order.
 * - `paintOrder(stage, node)` — the node's paint-order key (compare with `comparePaintOrder`).
 */
import { ok, type Result, type Scope } from '@staticflux/core';
import { type Box, createSpatialIndex, type SpatialIndex } from '@staticflux/document/spatial-index';
import type { NodeId } from '@staticflux/document/v2';
import type { Stage } from '@staticflux/stage';
import type { HitKind } from '../elements/geometry.js';
import { type ElementContext, elementBounds, hitElement, isElement, localOutline, pageTransform } from '../elements/layout.js';
import { resolveElement } from '../elements/resolve.js';

/** What tools read: B1's element context plus locks and invalidations. */
export interface ToolContext extends ElementContext {
  readonly stage: Pick<Stage, 'read' | 'children' | 'value' | 'lockOf' | 'onInvalidate'>;
}

export interface ElementIndex {
  readonly root: NodeId;
  /** The rbush index (A7's `createSpatialIndex`) of every element's ink bounds. */
  readonly index: SpatialIndex<NodeId>;
  /** Apply pending invalidations (queries call it first). */
  refresh(): void;
  rebuild(): void;
  readonly stats: { readonly rebuilds: number; readonly reindexed: number };
  dispose(): void;
}

/** The element index of the page `root` (see the module header). Disposed with `scope` when given. */
export function createElementIndex(ctx: ToolContext, root: NodeId, scope?: Scope): ElementIndex {
  const index = createSpatialIndex<NodeId>();
  const dirty = new Set<NodeId>();
  let full = true;
  const stats = { rebuilds: 0, reindexed: 0 };
  const indexSubtree = (node: NodeId, into: (node: NodeId, box: Box) => void): void => {
    const composed = ctx.stage.read(node);
    if (composed === undefined) {
      index.delete(node);
      return;
    }
    if (isElement(composed.kind)) {
      const b = elementBounds(ctx, node);
      stats.reindexed += 1;
      if (b.ok) into(node, b.value.ink);
      else index.delete(node);
    }
    for (const child of ctx.stage.children(node)) indexSubtree(child, into);
  };
  const rebuild = (): void => {
    const entries: [NodeId, Box][] = [];
    for (const child of ctx.stage.children(root)) indexSubtree(child, (node, b) => entries.push([node, b]));
    index.load(entries);
    stats.rebuilds += 1;
    full = false;
    dirty.clear();
  };
  const unsubscribe = ctx.stage.onInvalidate((nodes) => {
    for (const node of nodes) dirty.add(node);
  });
  const handle: ElementIndex = {
    root,
    index,
    refresh() {
      if (full) return rebuild();
      if (dirty.size === 0) return;
      const nodes = [...dirty];
      dirty.clear();
      const ancestors = new Set<NodeId>();
      for (const node of nodes) {
        if (node === root) return rebuild();
        indexSubtree(node, (n, b) => index.set(n, b));
        // A group's bounds are its children's union (and a frame's ink can depend on them): refresh every ancestor
        // of a changed node too, or a group keeps its old box after a child moves (B8 fix, B6 handoff).
        for (let at = ctx.stage.read(node)?.parent ?? null; at !== null && at !== root; at = ctx.stage.read(at)?.parent ?? null) ancestors.add(at);
      }
      for (const node of ancestors) {
        if (nodes.includes(node)) continue;
        const composed = ctx.stage.read(node);
        if (composed === undefined || !isElement(composed.kind)) continue;
        const b = elementBounds(ctx, node);
        stats.reindexed += 1;
        if (b.ok) index.set(node, b.value.ink);
        else index.delete(node);
      }
    },
    rebuild,
    get stats() {
      return { ...stats };
    },
    dispose: () => {
      unsubscribe();
      index.clear();
    },
  };
  scope?.defer(() => handle.dispose());
  return handle;
}

// ---------------------------------------------------------------- order and targets

/** Paint-order key: child indices from the root (a parent paints before its children). */
export function paintOrder(stage: Pick<Stage, 'read' | 'children'>, node: NodeId): readonly number[] {
  const path: number[] = [];
  for (let at: NodeId | null = node; at !== null; ) {
    const parent: NodeId | null = stage.read(at)?.parent ?? null;
    path.push(stage.children(parent).indexOf(at));
    at = parent;
  }
  return path.reverse();
}

/** Negative when `a` paints below `b`. */
export function comparePaintOrder(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if ((a[i] as number) !== (b[i] as number)) return (a[i] as number) - (b[i] as number);
  return a.length - b.length;
}

/** Ancestors from the root's child down to `node` (empty when `node` is not under `root`). */
function chainFrom(stage: Pick<Stage, 'read'>, root: NodeId, node: NodeId): NodeId[] {
  const chain: NodeId[] = [];
  for (let at: NodeId | null = node; at !== null; at = stage.read(at)?.parent ?? null) {
    if (at === root) return chain.reverse();
    chain.push(at);
  }
  return [];
}

/** A leaf the narrow phase tests: a drawn element (not a group, not a mask, not a boolean operand). */
export function isHittableLeaf(ctx: ElementContext, node: NodeId): boolean {
  const el = resolveElement(ctx.stage, node, ctx.kit);
  if (el === undefined || !isElement(el.kind) || el.geometry.kind === 'group' || el.mask !== undefined) return false;
  for (let at = el.parent; at !== null; ) {
    const p = resolveElement(ctx.stage, at, ctx.kit);
    if (p === undefined || !isElement(p.kind)) break;
    if (p.geometry.kind === 'boolean') return false;
    at = p.parent;
  }
  return true;
}

/** Selectable on the canvas: not locked for both position and content (a full lock lets clicks through). */
export function canvasSelectable(stage: Pick<Stage, 'lockOf'>, node: NodeId): boolean {
  const lock = stage.lockOf(node);
  return !(lock.position && lock.content);
}

/** The selection target a leaf stands for under `context` (see the module header). */
export function selectionTarget(ctx: ToolContext, leaf: NodeId, context: NodeId, root: NodeId, deep: boolean): NodeId | undefined {
  let chain = chainFrom(ctx.stage, context, leaf);
  if (chain.length === 0) chain = chainFrom(ctx.stage, root, leaf);
  if (chain.length === 0) return undefined;
  // Boolean operands stand for their boolean group.
  const booleanAt = chain.findIndex((n) => resolveElement(ctx.stage, n, ctx.kit)?.geometry.kind === 'boolean');
  if (booleanAt >= 0) chain = chain.slice(0, booleanAt + 1);
  if (deep) return chain[chain.length - 1];
  let i = 0;
  while (i < chain.length - 1 && ctx.stage.read(chain[i] as NodeId)?.kind === 'frame') i += 1;
  return chain[i];
}

// ---------------------------------------------------------------- narrow phase

/** True when the page point is inside every clipping frame above `node`. */
function insideClips(ctx: ElementContext, node: NodeId, x: number, y: number): Result<boolean> {
  for (let at = ctx.stage.read(node)?.parent ?? null; at !== null; ) {
    const el = resolveElement(ctx.stage, at, ctx.kit);
    if (el === undefined || !isElement(el.kind)) break;
    if (el.geometry.kind === 'frame' && el.geometry.clip) {
      const outline = localOutline(ctx, el);
      if (!outline.ok) return outline;
      const r = ctx.geometry.hit(outline.value, pageTransform(ctx, at), x, y, { fill: 'nonzero' });
      if (!r.ok) return r;
      if (r.value === 'none') return ok(false);
    }
    at = el.parent;
  }
  return ok(true);
}

function narrowHit(ctx: ElementContext, leaf: NodeId, x: number, y: number, tolerance: number): Result<HitKind> {
  const clipped = insideClips(ctx, leaf, x, y);
  if (!clipped.ok) return clipped;
  if (!clipped.value) return ok('none');
  return hitElement(ctx, leaf, x, y, tolerance);
}

export interface HitOptions {
  /** Page units (screen px / zoom). */
  readonly tolerance?: number;
  /** The entered container (default the root). */
  readonly context?: NodeId;
  /** Select the leaf itself (Mod+click). */
  readonly deep?: boolean;
}

export interface Hit {
  readonly leaf: NodeId;
  readonly target: NodeId;
  readonly kind: Exclude<HitKind, 'none'>;
}

function firstHit(ctx: ToolContext, root: NodeId, ordered: readonly NodeId[], x: number, y: number, options: HitOptions): Result<Hit | undefined> {
  const tolerance = options.tolerance ?? 0;
  for (const leaf of ordered) {
    const r = narrowHit(ctx, leaf, x, y, tolerance);
    if (!r.ok) return r;
    if (r.value === 'none') continue;
    const target = selectionTarget(ctx, leaf, options.context ?? root, root, options.deep === true);
    if (target === undefined || !canvasSelectable(ctx.stage, target)) continue;
    return ok({ leaf, target, kind: r.value });
  }
  return ok(undefined);
}

const topFirst = (stage: Pick<Stage, 'read' | 'children'>, nodes: readonly NodeId[]): NodeId[] =>
  nodes
    .map((node) => ({ node, order: paintOrder(stage, node) }))
    .sort((a, b) => comparePaintOrder(b.order, a.order))
    .map((e) => e.node);

/** The topmost hit at a page point (broad phase: the index; narrow phase: exact geometry). */
export function hitTest(ctx: ToolContext, index: ElementIndex, x: number, y: number, options: HitOptions = {}): Result<Hit | undefined> {
  index.refresh();
  const t = Math.max(0, options.tolerance ?? 0);
  const candidates = index.index.search({ minX: x - t, minY: y - t, maxX: x + t, maxY: y + t }).filter((n) => isHittableLeaf(ctx, n) && chainFrom(ctx.stage, index.root, n).length > 0);
  return firstHit(ctx, index.root, topFirst(ctx.stage, candidates), x, y, options);
}

/** Every element under `root`, in paint order (bottom first). */
export function elementsInPaintOrder(stage: Pick<Stage, 'read' | 'children'>, root: NodeId): NodeId[] {
  const out: NodeId[] = [];
  const walk = (node: NodeId): void => {
    for (const child of stage.children(node)) {
      if (isElement(stage.read(child)?.kind)) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

/** Reference hit test without the index: every leaf, topmost first (tests check parity with `hitTest`). */
export function hitTestBrute(ctx: ToolContext, root: NodeId, x: number, y: number, options: HitOptions = {}): Result<Hit | undefined> {
  const leaves = elementsInPaintOrder(ctx.stage, root).filter((n) => isHittableLeaf(ctx, n));
  return firstHit(ctx, root, leaves.reverse(), x, y, options);
}

// ---------------------------------------------------------------- marquee

export type MarqueeMode = 'touch' | 'contain';

export interface MarqueeOptions {
  readonly context?: NodeId;
  /** `touch` (default): anything the rectangle touches; `contain`: only what lies fully inside (Alt). */
  readonly mode?: MarqueeMode;
}

const inside = (inner: Box, outer: Box): boolean => inner.minX >= outer.minX && inner.minY >= outer.minY && inner.maxX <= outer.maxX && inner.maxY <= outer.maxY;

function leafTouches(ctx: ElementContext, leaf: NodeId, rect: Box): Result<boolean> {
  const el = resolveElement(ctx.stage, leaf, ctx.kit);
  if (el === undefined) return ok(false);
  const outline = localOutline(ctx, el);
  if (!outline.ok) return outline;
  return ctx.geometry.intersects(outline.value, pageTransform(ctx, leaf), rect, { filled: true });
}

function marqueeOf(ctx: ToolContext, root: NodeId, leaves: readonly NodeId[], rect: Box, options: MarqueeOptions): Result<NodeId[]> {
  const context = options.context ?? root;
  const children = new Set(ctx.stage.children(context));
  const picked = new Set<NodeId>();
  for (const leaf of leaves) {
    const chain = chainFrom(ctx.stage, context, leaf);
    const target = chain[0];
    if (target === undefined || !children.has(target) || picked.has(target) || !canvasSelectable(ctx.stage, target)) continue;
    if (options.mode === 'contain') {
      const b = elementBounds(ctx, target);
      if (!b.ok) return b;
      if (inside(b.value.geometry, rect)) picked.add(target);
      continue;
    }
    const touches = leafTouches(ctx, leaf, rect);
    if (!touches.ok) return touches;
    if (touches.value) picked.add(target);
  }
  return ok(topFirst(ctx.stage, [...picked]).reverse());
}

/** Children of the entered container touched by (or inside) a page rectangle, in paint order. */
export function marqueeSelect(ctx: ToolContext, index: ElementIndex, rect: Box, options: MarqueeOptions = {}): Result<NodeId[]> {
  index.refresh();
  const candidates = index.index.search(rect).filter((n) => isHittableLeaf(ctx, n));
  return marqueeOf(ctx, index.root, candidates, rect, options);
}

/** Reference marquee without the index (parity tests). */
export function marqueeSelectBrute(ctx: ToolContext, root: NodeId, rect: Box, options: MarqueeOptions = {}): Result<NodeId[]> {
  const leaves = elementsInPaintOrder(ctx.stage, root).filter((n) => isHittableLeaf(ctx, n));
  return marqueeOf(ctx, root, leaves, rect, options);
}

/** A normalised rectangle from two corners. */
export function rectFrom(ax: number, ay: number, bx: number, by: number): Box {
  return { minX: Math.min(ax, bx), minY: Math.min(ay, by), maxX: Math.max(ax, bx), maxY: Math.max(ay, by) };
}

/** Bounds of a set of elements (the union of their geometry bounds). */
export function selectionBounds(ctx: ElementContext, nodes: readonly NodeId[]): Result<Box | undefined> {
  let out: Box | undefined;
  for (const node of nodes) {
    const b = elementBounds(ctx, node);
    if (!b.ok) return b;
    const g = b.value.geometry;
    out = out === undefined ? g : { minX: Math.min(out.minX, g.minX), minY: Math.min(out.minY, g.minY), maxX: Math.max(out.maxX, g.maxX), maxY: Math.max(out.maxY, g.maxY) };
  }
  return ok(out);
}
