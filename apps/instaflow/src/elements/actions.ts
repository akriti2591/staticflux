/**
 * Element actions (IF-20.16–20.24): pure functions from a selection to one batch of part ops, committed as **one
 * change set = one undo step** by `commitEdit` (locks and final paths checked by the stage, brand rules by the
 * undo service's write guard). Every action has a non-agent path through the HUD (`contributions.ts`).
 *
 * - **Align** left / horizontal centre / right / top / vertical centre / bottom to the selection bounds, the parent
 *   container (frame or page), the page, or a key object; `centerInContainer` is one action. Exact geometry: page-space
 *   outline bounds (rotation, curves and booleans included), never rounded. Position-locked elements stay put and
 *   still count for the selection bounds.
 * - **Distribute** horizontally or vertically by equal gaps (first and last stay) or by centres; **tidy up** snaps a
 *   rough grid into even rows and columns.
 * - **Booleans** union / subtract / intersect / exclude as live groups (`geometry.boolean`; operands stay editable),
 *   change op, release, **flatten** (bake to a vector path) and **outline stroke** (stroke → filled path).
 * - **Masks**: use as mask (clip, alpha, luminance; the bottom-most selected element masks the rest, grouped), change
 *   mode or invert, release (nothing else changes).
 * - **Tokens**: apply a brand token to the top fill or stroke, the radii or the effects preset (it must exist with the
 *   right type).
 * - **Duplicate** keeps the match key (`lineage.key`) on the copies (Smart Move), with fresh node ids.
 */
import { err, ok, type Result } from '@staticflux/core';
import type { Box } from '@staticflux/document/spatial-index';
import type { JsonValue, NodeId, PartId, PartOp, PropertyPath, RichTextValue } from '@staticflux/document/v2';
import type { Actor, Stage, UndoService } from '@staticflux/stage';
import { type BooleanOpName, CORNER_PATHS, type MaskModeName, P } from './components.js';
import { checkToken, type TokenType } from './brand-kit.js';
import { ActionNotApplicableError, EmptyNameError, UnknownTokenError } from './errors.js';
import { type ElementBounds, type ElementContext, elementBounds, isElement, localOutline, pageTransform, strokeRing, unionBox } from './layout.js';
import { type Affine, applyAffine, invert, multiply as multiplyAffine, type ResolvedElement, resolveElement } from './resolve.js';
import { type ImageRotation, rgbaToHex, validateElementOps } from './values.js';

export interface ActionContext extends ElementContext {
  readonly stage: Pick<Stage, 'read' | 'children' | 'value' | 'explain' | 'lockOf' | 'checkWrite'>;
  /** A fresh, unique node id (also used to mint match keys). */
  readonly newId: () => NodeId;
  /**
   * The rich texts a node holds in its part (B2 text content; the composed stage exposes values only). `duplicate`
   * copies them, so a duplicated text element keeps its rich text (B8 fix). Omitted: copies carry props only.
   */
  readonly texts?: (node: NodeId) => Readonly<Record<PropertyPath, RichTextValue>> | undefined;
}

export const ALIGN_EDGES = ['left', 'center-x', 'right', 'top', 'center-y', 'bottom'] as const;
export type AlignEdge = (typeof ALIGN_EDGES)[number];
export type AlignTarget = { readonly kind: 'selection' } | { readonly kind: 'container' } | { readonly kind: 'page' } | { readonly kind: 'key'; readonly node: NodeId };
export type Axis = 'x' | 'y';
export type DistributeMode = 'spacing' | 'centers';

const notApplicable = (message: string, needs: string, details: Record<string, unknown> = {}): Result<never> => err(ActionNotApplicableError({ message, details: { needs, ...details } }));

const num = (v: JsonValue | undefined, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** Siblings of `nodes` in paint order (bottom first); all must share one parent. */
function inPaintOrder(ctx: ElementContext, nodes: readonly NodeId[]): Result<{ readonly parent: NodeId | null; readonly ordered: NodeId[] }> {
  const parents = new Set(nodes.map((n) => ctx.stage.read(n)?.parent ?? null));
  if (parents.size !== 1) return notApplicable('The elements must share one parent.', 'siblings');
  const parent = [...parents][0] as NodeId | null;
  const set = new Set(nodes);
  return ok({ parent, ordered: ctx.stage.children(parent).filter((c) => set.has(c)) });
}

/** A page-space move of an element as `spatial.x/y` writes in its parent's space. */
function moveOps(ctx: ElementContext, node: NodeId, dx: number, dy: number): PartOp[] {
  if (dx === 0 && dy === 0) return [];
  const el = resolveElement(ctx.stage, node, ctx.kit);
  if (el === undefined) return [];
  const parent = el.parent === null ? undefined : invert(pageTransform(ctx, el.parent));
  const linear: Affine = parent === undefined ? [1, 0, 0, 1, 0, 0] : [parent[0], parent[1], parent[2], parent[3], 0, 0];
  const [px, py] = applyAffine(linear, dx, dy);
  const ops: PartOp[] = [];
  if (px !== 0) ops.push({ op: 'set', node, path: P.x, value: el.box.x + px });
  if (py !== 0) ops.push({ op: 'set', node, path: P.y, value: el.box.y + py });
  return ops;
}

function boundsOf(ctx: ElementContext, nodes: readonly NodeId[]): Result<ElementBounds[]> {
  const out: ElementBounds[] = [];
  for (const node of nodes) {
    const b = elementBounds(ctx, node);
    if (!b.ok) return b;
    out.push(b.value);
  }
  return ok(out);
}

function pageOf(ctx: ElementContext, node: NodeId): NodeId | undefined {
  for (let at: NodeId | null = node; at !== null; ) {
    const c = ctx.stage.read(at);
    if (c === undefined) return undefined;
    if (c.kind === 'page') return at;
    at = c.parent;
  }
  return undefined;
}

function containerBox(ctx: ElementContext, node: NodeId, page: boolean): Result<Box> {
  const target = page ? pageOf(ctx, node) : (ctx.stage.read(node)?.parent ?? undefined);
  if (target === undefined || target === null) return notApplicable(`"${node}" has no ${page ? 'page' : 'container'}.`, page ? 'a page' : 'a container');
  const composed = ctx.stage.read(target);
  if (composed?.kind === 'page') {
    const size = composed.values['page.size'];
    const o = typeof size === 'object' && size !== null && !Array.isArray(size) ? (size as Record<string, JsonValue>) : {};
    return ok({ minX: 0, minY: 0, maxX: num(o['width'], num(composed.values[P.w], 0)), maxY: num(o['height'], num(composed.values[P.h], 0)) });
  }
  const b = elementBounds(ctx, target);
  return b.ok ? ok(b.value.geometry) : b;
}

const movable = (ctx: ActionContext, node: NodeId): boolean => !ctx.stage.lockOf(node).position;

function edgeDelta(b: Box, target: Box, edge: AlignEdge): readonly [number, number] {
  switch (edge) {
    case 'left':
      return [target.minX - b.minX, 0];
    case 'right':
      return [target.maxX - b.maxX, 0];
    case 'center-x':
      return [(target.minX + target.maxX) / 2 - (b.minX + b.maxX) / 2, 0];
    case 'top':
      return [0, target.minY - b.minY];
    case 'bottom':
      return [0, target.maxY - b.maxY];
    case 'center-y':
      return [0, (target.minY + target.maxY) / 2 - (b.minY + b.maxY) / 2];
  }
}

/** Align `nodes` (see the module header). Selection alignment needs two elements; other targets work with one. */
export function align(ctx: ActionContext, nodes: readonly NodeId[], edges: AlignEdge | readonly AlignEdge[], target: AlignTarget = { kind: 'selection' }): Result<PartOp[]> {
  const list = typeof edges === 'string' ? [edges] : edges;
  const subjects = target.kind === 'key' ? nodes.filter((n) => n !== target.node) : nodes;
  if (subjects.length === 0 || (target.kind === 'selection' && nodes.length < 2)) return notApplicable('Select at least two elements to align.', 'two elements');
  const bounds = boundsOf(ctx, subjects);
  if (!bounds.ok) return bounds;
  let shared: Box | undefined;
  if (target.kind === 'selection') {
    for (const b of bounds.value) shared = unionBox(shared, b.geometry);
  } else if (target.kind === 'key') {
    const key = elementBounds(ctx, target.node);
    if (!key.ok) return key;
    shared = key.value.geometry;
  }
  const ops: PartOp[] = [];
  for (const b of bounds.value) {
    if (!movable(ctx, b.node)) continue;
    let box = shared;
    if (box === undefined) {
      const c = containerBox(ctx, b.node, target.kind === 'page');
      if (!c.ok) return c;
      box = c.value;
    }
    let dx = 0;
    let dy = 0;
    for (const edge of list) {
      const [x, y] = edgeDelta(b.geometry, box, edge);
      dx += x;
      dy += y;
    }
    ops.push(...moveOps(ctx, b.node, dx, dy));
  }
  return ok(ops);
}

/** Centre each element in its parent frame or page (one action, both axes). */
export function centerInContainer(ctx: ActionContext, nodes: readonly NodeId[]): Result<PartOp[]> {
  return align(ctx, nodes, ['center-x', 'center-y'], { kind: 'container' });
}

/** Distribute along `axis` by equal gaps (`spacing`, first and last stay) or equal centre steps (`centers`). */
export function distribute(ctx: ActionContext, nodes: readonly NodeId[], axis: Axis, mode: DistributeMode): Result<PartOp[]> {
  if (nodes.length < 3) return notApplicable('Select at least three elements to distribute.', 'three elements');
  const bounds = boundsOf(ctx, nodes);
  if (!bounds.ok) return bounds;
  const lo = (b: Box): number => (axis === 'x' ? b.minX : b.minY);
  const hi = (b: Box): number => (axis === 'x' ? b.maxX : b.maxY);
  const mid = (b: Box): number => (lo(b) + hi(b)) / 2;
  const sorted = [...bounds.value].sort((a, b) => (mode === 'spacing' ? lo(a.geometry) - lo(b.geometry) : mid(a.geometry) - mid(b.geometry)) || (a.node < b.node ? -1 : 1));
  const first = sorted[0] as ElementBounds;
  const last = sorted[sorted.length - 1] as ElementBounds;
  const ops: PartOp[] = [];
  const n = sorted.length;
  if (mode === 'spacing') {
    const sizes = sorted.reduce((s, b) => s + hi(b.geometry) - lo(b.geometry), 0);
    const gap = (hi(last.geometry) - lo(first.geometry) - sizes) / (n - 1);
    let at = hi(first.geometry) + gap;
    for (const b of sorted.slice(1, -1)) {
      const delta = at - lo(b.geometry);
      if (movable(ctx, b.node)) ops.push(...moveOps(ctx, b.node, axis === 'x' ? delta : 0, axis === 'y' ? delta : 0));
      at += hi(b.geometry) - lo(b.geometry) + gap;
    }
  } else {
    const step = (mid(last.geometry) - mid(first.geometry)) / (n - 1);
    sorted.slice(1, -1).forEach((b, i) => {
      const delta = mid(first.geometry) + (i + 1) * step - mid(b.geometry);
      if (movable(ctx, b.node)) ops.push(...moveOps(ctx, b.node, axis === 'x' ? delta : 0, axis === 'y' ? delta : 0));
    });
  }
  return ok(ops);
}

/** Tidy up: rows by vertical overlap, then even rows and columns (cell = the largest item, gaps = the mean gap). */
export function tidyUp(ctx: ActionContext, nodes: readonly NodeId[]): Result<PartOp[]> {
  if (nodes.length < 2) return notApplicable('Select at least two elements to tidy up.', 'two elements');
  const bounds = boundsOf(ctx, nodes);
  if (!bounds.ok) return bounds;
  const items = [...bounds.value].sort((a, b) => a.center[1] - b.center[1]);
  const rows: ElementBounds[][] = [];
  for (const item of items) {
    const row = rows[rows.length - 1];
    const reach = row === undefined ? undefined : Math.max(...row.map((r) => r.geometry.maxY));
    if (row !== undefined && reach !== undefined && item.geometry.minY < reach && item.center[1] <= reach) row.push(item);
    else rows.push([item]);
  }
  for (const row of rows) row.sort((a, b) => a.center[0] - b.center[0]);
  const w = (b: ElementBounds): number => b.geometry.maxX - b.geometry.minX;
  const h = (b: ElementBounds): number => b.geometry.maxY - b.geometry.minY;
  const cellW = Math.max(...items.map(w));
  const cellH = Math.max(...items.map(h));
  const gaps = (list: number[]): number => (list.length === 0 ? 0 : Math.max(0, list.reduce((s, v) => s + v, 0) / list.length));
  const gapX = gaps(rows.flatMap((row) => row.slice(1).map((b, i) => b.geometry.minX - (row[i] as ElementBounds).geometry.maxX)));
  const gapY = gaps(rows.slice(1).map((row, i) => Math.min(...row.map((b) => b.geometry.minY)) - Math.max(...(rows[i] as ElementBounds[]).map((b) => b.geometry.maxY))));
  const originX = Math.min(...items.map((b) => b.geometry.minX));
  const originY = Math.min(...items.map((b) => b.geometry.minY));
  const ops: PartOp[] = [];
  rows.forEach((row, r) => {
    row.forEach((b, c) => {
      if (!movable(ctx, b.node)) return;
      const x = originX + c * (cellW + gapX) + (cellW - w(b)) / 2;
      const y = originY + r * (cellH + gapY) + (cellH - h(b)) / 2;
      ops.push(...moveOps(ctx, b.node, x - b.geometry.minX, y - b.geometry.minY));
    });
  });
  return ok(ops);
}

// ---------------------------------------------------------------- local values (copies keep tokens and classes)

const STYLE_PATHS = [P.fills, P.strokes, P.radius, ...CORNER_PATHS, P.smoothing, P.effects, P.inherit] as const;
const SPATIAL_PATHS = [P.x, P.y, P.w, P.h, P.rotation, P.scaleX, P.scaleY, P.anchorX, P.anchorY, P.opacity, P.blend, P.flipX, P.flipY, P.skewX] as const;

/** The node's own (local-layer) opinions: what a copy must carry so it inherits and follows tokens like the source. */
export function localValues(stage: Pick<Stage, 'read'>, node: NodeId): Record<PropertyPath, JsonValue> {
  const composed = stage.read(node);
  const out: Record<PropertyPath, JsonValue> = {};
  if (composed === undefined) return out;
  for (const [path, winner] of Object.entries(composed.provenance)) {
    if (winner.arc !== 'local' || winner.layer !== 'local') continue;
    out[path] = winner.token !== undefined ? `@${winner.token.path.slice(`${P.tokens}.`.length)}` : winner.value;
  }
  return out;
}

function pick(values: Readonly<Record<PropertyPath, JsonValue>>, paths: readonly string[]): Record<PropertyPath, JsonValue> {
  const out: Record<PropertyPath, JsonValue> = {};
  for (const path of paths) if (values[path] !== undefined) out[path] = values[path] as JsonValue;
  return out;
}

// ---------------------------------------------------------------- booleans

/** Wrap sibling `nodes` in a live boolean group (style from the bottom-most operand). */
export function booleanGroup(ctx: ActionContext, nodes: readonly NodeId[], op: BooleanOpName): Result<PartOp[]> {
  if (nodes.length < 2) return notApplicable('A boolean needs at least two shapes.', 'two shapes');
  const order = inPaintOrder(ctx, nodes);
  if (!order.ok) return order;
  const { parent, ordered } = order.value;
  if (ordered.some((n) => !isElement(ctx.stage.read(n)?.kind))) return notApplicable('Booleans combine elements only.', 'elements');
  const bottom = ordered[0] as NodeId;
  const group = ctx.newId();
  const style = pick(localValues(ctx.stage, bottom), STYLE_PATHS);
  const ops: PartOp[] = [
    {
      op: 'create',
      node: group,
      kind: 'group',
      parent,
      position: { before: bottom },
      props: { name: op[0]?.toUpperCase() + op.slice(1), [P.boolean]: op, [P.matchKey]: `lk_${group}`, ...style },
    },
  ];
  ordered.forEach((node, index) => ops.push({ op: 'move', node, parent: group, position: { index } }));
  return ok(ops);
}

/** Change a boolean group's operation (it stays live). */
export function setBooleanOp(ctx: ActionContext, group: NodeId, op: BooleanOpName | null): Result<PartOp[]> {
  const el = resolveElement(ctx.stage, group, ctx.kit);
  if (el?.kind !== 'group') return notApplicable(`"${group}" is not a group.`, 'a group');
  return ok([{ op: 'set', node: group, path: P.boolean, value: op }]);
}

/** Children of a group (or a frame) back into its parent, keeping their page positions; the container is deleted. */
function ungroupOps(ctx: ActionContext, group: NodeId): Result<PartOp[]> {
  const el = resolveElement(ctx.stage, group, ctx.kit);
  if (el === undefined || (el.kind !== 'group' && el.kind !== 'frame')) return notApplicable(`"${group}" is not a group.`, 'a group');
  const g = el.transform;
  const turn = Math.atan2(g[1], g[0]);
  const ops: PartOp[] = [];
  for (const child of ctx.stage.children(group)) {
    const c = resolveElement(ctx.stage, child, ctx.kit);
    if (c === undefined) continue;
    // Keep the child's anchor where it is on the page and add the group's rotation (scale-free groups).
    const anchor = applyAffine(c.transform, c.box.anchorX * c.box.w, c.box.anchorY * c.box.h);
    const [ax, ay] = applyAffine(g, anchor[0], anchor[1]);
    const rotation = c.box.rotation + (turn * 180) / Math.PI;
    ops.push({ op: 'move', node: child, parent: el.parent, position: { before: group } });
    ops.push({ op: 'set', node: child, path: P.x, value: ax - c.box.anchorX * c.box.w });
    ops.push({ op: 'set', node: child, path: P.y, value: ay - c.box.anchorY * c.box.h });
    if (rotation !== c.box.rotation) ops.push({ op: 'set', node: child, path: P.rotation, value: rotation });
  }
  ops.push({ op: 'delete', node: group });
  return ok(ops);
}

/** Release a boolean: operands go back to the parent unchanged on the page. */
export function releaseBoolean(ctx: ActionContext, group: NodeId): Result<PartOp[]> {
  if (ctx.stage.read(group)?.kind !== 'group') return notApplicable(`"${group}" is not a group.`, 'a group');
  return ungroupOps(ctx, group);
}

/** Flatten: replace an element (a boolean group, a shape) with a vector of its outline (same place, style, key). */
export function flatten(ctx: ActionContext, node: NodeId): Result<PartOp[]> {
  const el = resolveElement(ctx.stage, node, ctx.kit);
  if (el === undefined || !isElement(el.kind) || el.geometry.kind === 'group') return notApplicable('Flatten needs a shape, a vector or a boolean.', 'a shape');
  const outline = localOutline(ctx, el);
  if (!outline.ok) return outline;
  const local = localValues(ctx.stage, node);
  const id = ctx.newId();
  let props: Record<PropertyPath, JsonValue> = { ...pick(local, SPATIAL_PATHS), ...pick(local, STYLE_PATHS) };
  let path = outline.value;
  if (el.geometry.kind === 'boolean') {
    const b = ctx.geometry.bounds(outline.value, [1, 0, 0, 1, 0, 0]);
    if (!b.ok) return b;
    const plain = el.box.rotation === 0 && el.box.scaleX === 1 && el.box.scaleY === 1 && !el.box.flipX && !el.box.flipY && el.box.skewX === 0;
    if (plain) {
      const moved = ctx.geometry.transform(outline.value, [1, 0, 0, 1, -b.value.minX, -b.value.minY]);
      if (!moved.ok) return moved;
      path = moved.value;
      props = { ...props, [P.x]: el.box.x + b.value.minX, [P.y]: el.box.y + b.value.minY, [P.w]: b.value.maxX - b.value.minX, [P.h]: b.value.maxY - b.value.minY };
    } else {
      props = { ...props, [P.w]: b.value.maxX, [P.h]: b.value.maxY };
    }
  }
  const fillRule = el.geometry.kind === 'path' && el.geometry.evenOdd ? { [P.fillRule]: 'evenodd' } : {};
  const identity = pick(local, ['name', 'role', P.matchKey, P.maskMode, P.maskInvert, P.lockScope]);
  return ok([
    { op: 'create', node: id, kind: 'vector', parent: el.parent, position: { before: node }, props: { ...props, ...identity, ...fillRule, [P.path]: ctx.geometry.toSvg(path) } },
    { op: 'delete', node },
  ]);
}

/** Raw stack items as written (tokens kept), visible ones only: the inputs of copies and conversions. */
function rawItems(ctx: ActionContext, node: NodeId, path: PropertyPath): Record<string, JsonValue>[] {
  const winner = ctx.stage.explain(node, path).winner;
  const raw = winner?.token !== undefined ? undefined : winner?.value;
  return Array.isArray(raw) ? raw.filter((x): x is Record<string, JsonValue> => typeof x === 'object' && x !== null && !Array.isArray(x) && x['visible'] !== false) : [];
}

/** Outline stroke: every stroke becomes a filled vector above the element; the element keeps its fills (or goes). */
export function outlineStroke(ctx: ActionContext, node: NodeId): Result<PartOp[]> {
  const el = resolveElement(ctx.stage, node, ctx.kit);
  if (el === undefined || el.strokes.length === 0) return notApplicable('Outline stroke needs an element with a stroke.', 'a stroke');
  const outline = localOutline(ctx, el);
  if (!outline.ok) return outline;
  const local = localValues(ctx.stage, node);
  const raw = rawItems(ctx, node, P.strokes);
  const keepsFill = el.fills.length > 0;
  const key = typeof local[P.matchKey] === 'string' ? (local[P.matchKey] as string) : `lk_${node}`;
  const ops: PartOp[] = [];
  let previous = node;
  for (const [i, stroke] of el.strokes.entries()) {
    const ring = strokeRing(ctx, el, stroke, outline.value);
    if (!ring.ok) return ring;
    const path = ring.value ?? (() => {
      const r = ctx.geometry.outlineStroke(outline.value, stroke);
      return r.ok ? r.value : undefined;
    })();
    if (path === undefined) return err(ActionNotApplicableError({ message: 'The stroke could not be outlined.', details: { node, needs: 'a closed outline' } }));
    const item = raw.length === el.strokes.length ? raw[i] : undefined;
    const paint: JsonValue = (item?.['paint'] as JsonValue | undefined) ?? (stroke.paint.kind === 'solid' ? rgbaToHex(stroke.paint.color) : '#000000');
    const id = ctx.newId();
    ops.push({
      op: 'create',
      node: id,
      kind: 'vector',
      parent: el.parent,
      position: { after: previous },
      props: {
        ...pick(local, SPATIAL_PATHS),
        name: `${typeof local['name'] === 'string' ? local['name'] : 'Shape'} stroke`,
        [P.fills]: [{ paint, opacity: stroke.opacity, blend: stroke.blend }],
        [P.path]: ctx.geometry.toSvg(path),
        [P.matchKey]: keepsFill || i > 0 ? `${key}/stroke${i === 0 ? '' : `-${i}`}` : key,
      },
    });
    previous = id;
  }
  if (keepsFill) ops.push({ op: 'set', node, path: P.strokes, value: [] });
  else ops.push({ op: 'delete', node });
  return ok(ops);
}

// ---------------------------------------------------------------- masks

/** Use the bottom-most selected element as a mask over the others (grouped, Figma-style). */
export function useAsMask(ctx: ActionContext, nodes: readonly NodeId[], mode: MaskModeName = 'clip'): Result<PartOp[]> {
  if (nodes.length < 2) return notApplicable('Select a mask shape and what it masks.', 'two elements');
  const order = inPaintOrder(ctx, nodes);
  if (!order.ok) return order;
  const { parent, ordered } = order.value;
  const group = ctx.newId();
  const bottom = ordered[0] as NodeId;
  const ops: PartOp[] = [{ op: 'create', node: group, kind: 'group', parent, position: { before: bottom }, props: { name: 'Mask group', [P.matchKey]: `lk_${group}` } }];
  ordered.forEach((node, index) => ops.push({ op: 'move', node, parent: group, position: { index } }));
  ops.push({ op: 'set', node: bottom, path: P.maskMode, value: mode });
  return ok(ops);
}

/** Change a mask's mode or invert flag. */
export function setMask(ctx: ActionContext, node: NodeId, mode: MaskModeName, invert?: boolean): Result<PartOp[]> {
  if (resolveElement(ctx.stage, node, ctx.kit) === undefined) return notApplicable(`"${node}" does not exist.`, 'an element');
  const ops: PartOp[] = [{ op: 'set', node, path: P.maskMode, value: mode }];
  if (invert !== undefined) ops.push({ op: 'set', node, path: P.maskInvert, value: invert });
  return ok(ops);
}

/** Release a mask: the element draws again and its siblings are unmasked (nothing else changes). */
export function releaseMask(ctx: ActionContext, node: NodeId): Result<PartOp[]> {
  const el = resolveElement(ctx.stage, node, ctx.kit);
  if (el?.mask === undefined) return notApplicable(`"${node}" is not a mask.`, 'a mask');
  return ok([
    { op: 'set', node, path: P.maskMode, value: null },
    { op: 'set', node, path: P.maskInvert, value: null },
  ]);
}

// ---------------------------------------------------------------- tokens

/** Where a brand token can go: the top fill's or stroke's paint, the radii, the effects preset. */
export const TOKEN_TARGETS = { fill: 'color', stroke: 'color', radius: 'size', radiusTL: 'size', radiusTR: 'size', radiusBR: 'size', radiusBL: 'size', effects: 'effect' } as const satisfies Readonly<
  Record<string, TokenType>
>;
export type TokenTarget = keyof typeof TOKEN_TARGETS;

/** Apply a brand token (`@name`) to `target` of every node (one change set). */
export function applyToken(ctx: ActionContext, nodes: readonly NodeId[], target: TokenTarget, token: string): Result<PartOp[]> {
  const type = TOKEN_TARGETS[target];
  if (type === undefined) return notApplicable(`"${target}" does not take a brand token.`, 'a paint, size or effects target', { target });
  if (ctx.kit === undefined) return err(UnknownTokenError({ message: 'No brand kit is attached to this document.', details: { token } }));
  const checked = checkToken(ctx.kit, token, type);
  if (!checked.ok) return checked;
  if (nodes.length === 0) return notApplicable('Select an element.', 'an element');
  const ops: PartOp[] = [];
  for (const node of nodes) {
    if (target === 'fill' || target === 'stroke') {
      const path = target === 'fill' ? P.fills : P.strokes;
      const items = rawItems(ctx, node, path);
      const top = items[items.length - 1];
      const next = top === undefined ? [...items, target === 'fill' ? { paint: token } : { paint: token, width: 1 }] : [...items.slice(0, -1), { ...top, paint: token }];
      ops.push({ op: 'set', node, path, value: next as JsonValue });
    } else {
      ops.push({ op: 'set', node, path: target === 'effects' ? P.effects : `style.${target}`, value: token });
    }
  }
  return ok(ops);
}


// ---------------------------------------------------------------- structure (B12: group, frame, order, rename, hide)

/** `Group` / `Frame` names the actions give new containers (APPEARANCE §4.1). */
export const STRUCTURE_NAMES = { group: 'Group', frame: 'Frame' } as const;
/** Longest element name `rename` accepts (characters, after trimming). */
export const NAME_MAX_LENGTH = 200;

/** Group sibling `nodes` (APPEARANCE §4.1): a plain `group` at the top-most one's place in paint order; nothing moves. */
export function group(ctx: ActionContext, nodes: readonly NodeId[]): Result<PartOp[]> {
  if (nodes.length === 0) return notApplicable('Select something to group.', 'an element');
  const order = inPaintOrder(ctx, nodes);
  if (!order.ok) return order;
  const { parent, ordered } = order.value;
  if (ordered.length !== new Set(nodes).size || ordered.some((n) => !isElement(ctx.stage.read(n)?.kind))) return notApplicable('Only elements can be grouped.', 'elements');
  const top = ordered[ordered.length - 1] as NodeId;
  const id = ctx.newId();
  const ops: PartOp[] = [{ op: 'create', node: id, kind: 'group', parent, position: { after: top }, props: { name: STRUCTURE_NAMES.group, [P.matchKey]: `lk_${id}` } }];
  ordered.forEach((node, index) => ops.push({ op: 'move', node, parent: id, position: { index } }));
  return ok(ops);
}

/** The bounds of `node` in its parent's space (exact: outlines through the element's own transform). */
function parentSpaceBounds(ctx: ElementContext, node: NodeId, outer: Affine = [1, 0, 0, 1, 0, 0]): Result<Box | undefined> {
  const el = resolveElement(ctx.stage, node, ctx.kit);
  if (el === undefined || !isElement(el.kind) || el.hidden === true) return ok(undefined);
  const t = multiplyAffine(outer, el.transform);
  if (el.geometry.kind === 'group') {
    let out: Box | undefined;
    for (const child of ctx.stage.children(node)) {
      const b = parentSpaceBounds(ctx, child, t);
      if (!b.ok) return b;
      if (b.value !== undefined) out = unionBox(out, b.value);
    }
    return ok(out);
  }
  const outline = localOutline(ctx, el);
  if (!outline.ok) return outline;
  return ctx.geometry.bounds(outline.value, t);
}

/**
 * Frame selection (APPEARANCE §4.1): wrap sibling `nodes` in a `frame` sized to their union (in the parent's space,
 * `padding` on every side), clip on, no fill, at the top-most one's place; the children keep their place on the page.
 */
export function frameSelection(ctx: ActionContext, nodes: readonly NodeId[], padding = 0): Result<PartOp[]> {
  if (nodes.length === 0) return notApplicable('Select something to frame.', 'an element');
  const order = inPaintOrder(ctx, nodes);
  if (!order.ok) return order;
  const { parent, ordered } = order.value;
  if (ordered.length !== new Set(nodes).size || ordered.some((n) => !isElement(ctx.stage.read(n)?.kind))) return notApplicable('Only elements can be framed.', 'elements');
  let box: Box | undefined;
  for (const node of ordered) {
    const b = parentSpaceBounds(ctx, node);
    if (!b.ok) return b;
    if (b.value !== undefined) box = unionBox(box, b.value);
  }
  if (box === undefined) return notApplicable('The selection has no size to frame.', 'visible elements');
  const pad = Number.isFinite(padding) ? Math.max(0, padding) : 0;
  const x = box.minX - pad;
  const y = box.minY - pad;
  const id = ctx.newId();
  const top = ordered[ordered.length - 1] as NodeId;
  const ops: PartOp[] = [
    {
      op: 'create',
      node: id,
      kind: 'frame',
      parent,
      position: { after: top },
      props: { name: STRUCTURE_NAMES.frame, [P.x]: x, [P.y]: y, [P.w]: box.maxX - box.minX + 2 * pad, [P.h]: box.maxY - box.minY + 2 * pad, [P.clip]: true, [P.fills]: [], [P.matchKey]: `lk_${id}` },
    },
  ];
  ordered.forEach((node, index) => {
    ops.push({ op: 'move', node, parent: id, position: { index } });
    const el = resolveElement(ctx.stage, node, ctx.kit) as ResolvedElement;
    ops.push({ op: 'set', node, path: P.x, value: el.box.x - x });
    ops.push({ op: 'set', node, path: P.y, value: el.box.y - y });
  });
  return ok(ops);
}

/**
 * Ungroup (APPEARANCE §4.1): each group or frame in `nodes` puts its children back in its place (page position and
 * paint order kept) and goes; a boolean is released the same way and a mask group's mask is released with it (the
 * mask would otherwise start masking the parent's later siblings). Unframe is ungroup on a frame.
 */
export function ungroup(ctx: ActionContext, nodes: readonly NodeId[]): Result<PartOp[]> {
  const ops: PartOp[] = [];
  for (const node of nodes) {
    const kind = ctx.stage.read(node)?.kind;
    if (kind !== 'group' && kind !== 'frame') return notApplicable(`"${node}" is not a group or a frame.`, 'a group or a frame', { node });
    for (const child of ctx.stage.children(node)) {
      if (resolveElement(ctx.stage, child, ctx.kit)?.mask !== undefined) ops.push({ op: 'set', node: child, path: P.maskMode, value: null }, { op: 'set', node: child, path: P.maskInvert, value: null });
    }
    const out = ungroupOps(ctx, node);
    if (!out.ok) return out;
    ops.push(...out.value);
  }
  if (ops.length === 0) return notApplicable('Select a group or a frame.', 'a group or a frame');
  return ok(ops);
}

/** Bring forward / send backward one step, bring to front / send to back (APPEARANCE §4.9). */
export const REORDER_DIRECTIONS = ['forward', 'backward', 'front', 'back'] as const;
export type ReorderDirection = (typeof REORDER_DIRECTIONS)[number];

/** The new child order of one parent (bottom first) when `selected` move in `direction`. */
export function reorderedChildren(children: readonly NodeId[], selected: ReadonlySet<NodeId>, direction: ReorderDirection): NodeId[] {
  const list = [...children];
  const s = (i: number): boolean => selected.has(list[i] as NodeId);
  const swap = (i: number, j: number): void => {
    [list[i], list[j]] = [list[j] as NodeId, list[i] as NodeId];
  };
  switch (direction) {
    case 'front':
      return [...list.filter((n) => !selected.has(n)), ...list.filter((n) => selected.has(n))];
    case 'back':
      return [...list.filter((n) => selected.has(n)), ...list.filter((n) => !selected.has(n))];
    case 'forward':
      for (let i = list.length - 2; i >= 0; i--) if (s(i) && !s(i + 1)) swap(i, i + 1);
      return list;
    case 'backward':
      for (let i = 1; i < list.length; i++) if (s(i) && !s(i - 1)) swap(i, i - 1);
      return list;
  }
}

/**
 * Reorder `nodes` within their parents (APPEARANCE §4.9): a selection across several parents moves in each one. The
 * selected keep their relative order; a step moves past the next unselected sibling. Nothing to move: not applicable.
 */
export function reorder(ctx: ActionContext, nodes: readonly NodeId[], direction: ReorderDirection): Result<PartOp[]> {
  const byParent = new Map<NodeId | null, Set<NodeId>>();
  for (const node of nodes) {
    const composed = ctx.stage.read(node);
    if (composed === undefined || !isElement(composed.kind)) return notApplicable(`"${node}" is not an element.`, 'elements', { node });
    let set = byParent.get(composed.parent);
    if (set === undefined) byParent.set(composed.parent, (set = new Set()));
    set.add(node);
  }
  const ops: PartOp[] = [];
  for (const [parent, selected] of byParent) {
    const before = ctx.stage.children(parent);
    const after = reorderedChildren(before, selected, direction);
    if (after.every((n, i) => n === before[i])) continue;
    // Move the selected in their final order, each after its final predecessor (already in place).
    after.forEach((node, i) => {
      if (!selected.has(node)) return;
      ops.push({ op: 'move', node, parent, position: i === 0 ? { index: 0 } : { after: after[i - 1] as NodeId } });
    });
  }
  return ok(ops);
}

/** Rename one element (APPEARANCE §4.9): the trimmed name; empty or longer than `NAME_MAX_LENGTH` is refused. */
export function rename(ctx: ActionContext, node: NodeId, name: string): Result<PartOp[]> {
  if (!isElement(ctx.stage.read(node)?.kind)) return notApplicable(`"${node}" is not an element.`, 'an element', { node });
  const trimmed = name.trim();
  if (trimmed === '') return err(EmptyNameError({ details: { node } }));
  if (trimmed.length > NAME_MAX_LENGTH) return err(EmptyNameError({ message: `A name has at most ${NAME_MAX_LENGTH} characters.`, details: { node, length: trimmed.length } }));
  return ok(ctx.stage.value(node, 'name') === trimmed ? [] : [{ op: 'set', node, path: 'name', value: trimmed }]);
}

/**
 * Hide or show `nodes` (APPEARANCE §4.9, A-2): `spatial.hidden`. Hidden elements (and everything inside them) are not
 * drawn, exported, hit or announced; `hidden: undefined` toggles (any visible → hide all, else show all).
 */
export function setHidden(ctx: ActionContext, nodes: readonly NodeId[], hidden?: boolean): Result<PartOp[]> {
  if (nodes.length === 0 || nodes.some((n) => !isElement(ctx.stage.read(n)?.kind))) return notApplicable('Select an element to hide or show.', 'an element');
  const want = hidden ?? nodes.some((n) => ctx.stage.value(n, P.hidden) !== true);
  return ok(nodes.filter((n) => (ctx.stage.value(n, P.hidden) === true) !== want).map((node): PartOp => ({ op: 'set', node, path: P.hidden, value: want ? true : null })));
}

/** Show every hidden element under `root` (Layers `Show all`). */
export function showAll(ctx: ActionContext, root: NodeId): Result<PartOp[]> {
  const ops: PartOp[] = [];
  const walk = (parent: NodeId): void => {
    for (const child of ctx.stage.children(parent)) {
      if (ctx.stage.value(child, P.hidden) === true) ops.push({ op: 'set', node: child, path: P.hidden, value: null });
      walk(child);
    }
  };
  walk(root);
  return ok(ops);
}

// ---------------------------------------------------------------- image crop (B12, A-3)

/** A crop to write on an image paint (APPEARANCE §2.4): any field omitted keeps the current one. */
export interface ImageCropEdit {
  /** `[x, y]` ∈ 0…1 of the free space (0.5, 0.5 centred). */
  readonly offset?: readonly [number, number];
  /** × the fit's size. */
  readonly scale?: number;
  /** Clockwise, 0 · 90 · 180 · 270. */
  readonly rotation?: ImageRotation;
}

/** Storage index of the top-most visible image fill of `node` (an image element's own picture), or undefined. */
export function imageFillIndex(ctx: Pick<ActionContext, 'stage'>, node: NodeId): number | undefined {
  const raw = ctx.stage.explain(node, P.fills).winner?.value;
  if (!Array.isArray(raw)) return undefined;
  for (let i = raw.length - 1; i >= 0; i--) {
    const item = raw[i];
    if (typeof item !== 'object' || item === null || Array.isArray(item) || item['visible'] === false) continue;
    const paint = item['paint'];
    if (typeof paint === 'object' && paint !== null && !Array.isArray(paint) && paint['kind'] === 'image') return i;
  }
  return undefined;
}

/**
 * Crop an image paint (A-3): write `offset`, `scale`, `rotation` on fill `index` (default the top-most image fill) of
 * each node; `crop: null` resets it to the plain fit. One change set; values are validated like every paint.
 */
export function cropImage(ctx: ActionContext, nodes: readonly NodeId[], crop: ImageCropEdit | null, index?: number): Result<PartOp[]> {
  const ops: PartOp[] = [];
  for (const node of nodes) {
    const raw = ctx.stage.explain(node, P.fills).winner?.value;
    const at = index ?? imageFillIndex(ctx, node);
    const items = Array.isArray(raw) ? [...raw] : [];
    const item = at === undefined ? undefined : items[at];
    const paint = typeof item === 'object' && item !== null && !Array.isArray(item) ? item['paint'] : undefined;
    if (at === undefined || typeof paint !== 'object' || paint === null || Array.isArray(paint) || paint['kind'] !== 'image') return notApplicable(`"${node}" has no image fill to crop.`, 'an image', { node });
    const { offset: _o, scale: _s, rotation: _r, ...plain } = paint as Record<string, JsonValue>;
    const next: Record<string, JsonValue> =
      crop === null
        ? plain
        : {
            ...(paint as Record<string, JsonValue>),
            ...(crop.offset === undefined ? {} : { offset: [...crop.offset] }),
            ...(crop.scale === undefined ? {} : { scale: crop.scale }),
            ...(crop.rotation === undefined ? {} : { rotation: crop.rotation }),
          };
    items[at] = { ...(item as Record<string, JsonValue>), paint: next };
    ops.push({ op: 'set', node, path: P.fills, value: items as JsonValue });
  }
  return ok(ops);
}

// ---------------------------------------------------------------- duplicate (match keys)

/** Copy `nodes` (with their subtrees) right above themselves, offset by `(dx, dy)`; copies keep the match key. */
export function duplicate(ctx: ActionContext, nodes: readonly NodeId[], offset: readonly [number, number] = [0, 0]): Result<{ readonly ops: PartOp[]; readonly copies: ReadonlyMap<NodeId, NodeId> }> {
  const ops: PartOp[] = [];
  const copies = new Map<NodeId, NodeId>();
  const copy = (source: NodeId, parent: NodeId | null, position: { readonly after: NodeId } | { readonly index: number }, top: boolean): void => {
    const composed = ctx.stage.read(source);
    if (composed === undefined) return;
    const id = ctx.newId();
    copies.set(source, id);
    const props = localValues(ctx.stage, source);
    let key = props[P.matchKey];
    if (typeof key !== 'string') {
      key = `lk_${source}`;
      ops.push({ op: 'set', node: source, path: P.matchKey, value: key });
    }
    props[P.matchKey] = key;
    if (top && isElement(composed.kind)) {
      props[P.x] = num(props[P.x], 0) + offset[0];
      props[P.y] = num(props[P.y], 0) + offset[1];
    }
    const texts = ctx.texts?.(source);
    ops.push({ op: 'create', node: id, kind: composed.kind, parent, position, props, ...(texts === undefined || Object.keys(texts).length === 0 ? {} : { texts }) });
    // Derived nodes (a repeat's instances) are regenerated from the copy's own parameters, never copied (B11b fix:
    // writing their match key failed the whole duplicate).
    const derived = (ctx.stage as { isDerived?: (node: NodeId) => boolean }).isDerived;
    ctx.stage
      .children(source)
      .filter((child) => derived?.call(ctx.stage, child) !== true)
      .forEach((child, index) => copy(child, id, { index }, false));
  };
  for (const node of nodes) {
    const parent = ctx.stage.read(node)?.parent ?? null;
    copy(node, parent, { after: node }, true);
  }
  if (copies.size === 0) return notApplicable('Nothing to duplicate.', 'an element');
  return ok({ ops, copies });
}

// ---------------------------------------------------------------- commit

export interface EditTarget {
  readonly undo: Pick<UndoService, 'commit'>;
  readonly stage: Pick<Stage, 'checkWrite'>;
  /** The page part the ops write. */
  readonly part: PartId;
}

/** Commit one action as one change set (one undo step): element values, locks and final paths are checked first. */
export function commitEdit(target: EditTarget, actor: Actor, label: string, ops: Result<readonly PartOp[]>): Result<void> {
  if (!ops.ok) return ops;
  if (ops.value.length === 0) return notApplicable('Nothing changes.', 'a change');
  const valid = validateElementOps(ops.value);
  if (!valid.ok) return valid;
  const locks = target.stage.checkWrite(ops.value, { actor });
  if (!locks.ok) return locks;
  const committed = target.undo.commit(actor, label, { [target.part]: ops.value });
  return committed.ok ? ok() : committed;
}

