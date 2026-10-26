/**
 * Element render projection (IF-7.10, IF-20.25–20.27): composed, resolved elements → A7's binary render projection
 * (`defineRenderProjection`) → the render module's scene store → scene IR (`scene.ts`) → A6 draws them.
 *
 * Hot, per-frame data travels as numeric columns (`ElementProjection`: the local → parent affine, size, opacity,
 * blend, flags, mask). Everything else is **interned resources** referenced by id from two columns:
 * - a **look** (the fill and stroke stacks with 8-bit colours, effects, corner radii, frame clip, image fit, mask
 *   matte), shared by every element that looks the same;
 * - a **path** (flat outline from the authoring Wasm) for polygons, stars, lines, vectors, smooth corners and boolean
 *   groups, and the **rings** of inside, outside and per-side strokes (filled instead of stroked).
 * A resource batch (`takeResources()`) must reach the render side **before** the projection delta that references
 * it; both go down the same ordered channel (resources first). Unused resources are dropped in a later batch.
 *
 * The source is the composed stage (local > variant > inherit > reference, tokens resolved), not the raw part, so
 * brand classes and tokens render exactly as the inspector shows them. Boolean groups are projected as one leaf
 * (their children are operands, never drawn); masks project their mode and invert flag.
 */
import type { JsonValue, NodeId, NodeRecord, PartChange } from '@staticflux/document/v2';
import { defineRenderProjection, type RenderProjectionSource } from '@staticflux/document/render-projection';
import type { Stage } from '@staticflux/stage';
import { BLEND_MODE_NAMES, MASK_MODE_NAMES, P } from './components.js';
import type { GeometryService, PathData } from './geometry.js';
import { type ElementContext, isElement, localOutline, strokeRing } from './layout.js';
import type { ResolvedEffect, ResolvedElement, ResolvedFill, ResolvedStroke } from './resolve.js';
import { resolveComposed, resolveElement } from './resolve.js';

export const ELEMENT_PROJECTION_KINDS = ['frame', 'group', 'shape', 'vector', 'image'] as const;

export const ElementProjection = /* @__PURE__ */ defineRenderProjection({
  id: 'instaflow/elements',
  version: 1,
  kinds: ELEMENT_PROJECTION_KINDS,
  fields: {
    a: { path: 'render.a', default: 1 },
    b: { path: 'render.b' },
    c: { path: 'render.c' },
    d: { path: 'render.d', default: 1 },
    e: { path: 'render.e' },
    f: { path: 'render.f' },
    w: { path: 'render.w' },
    h: { path: 'render.h' },
    opacity: { path: 'render.opacity', type: 'f32', default: 1 },
    blend: { path: 'render.blend', type: 'u32' },
    flags: { path: 'render.flags', type: 'u32', default: 1 },
    mask: { path: 'render.mask', type: 'u32' },
    look: { path: 'render.look', type: 'u32' },
    path: { path: 'render.path', type: 'u32' },
  },
});
export type ElementField = keyof typeof ElementProjection.fieldIndex;

/** `render.flags` bits. */
export const RENDER_FLAGS = { visible: 1, evenOdd: 2 } as const;
/** `render.mask`: mode index + 1 (0 none), bit 7 = invert (the scene IR encoding). */
export const MASK_INVERT_BIT = 0x80;

type Corners = readonly [number, number, number, number];

/** Geometry the renderer draws for an element (in its look). `smooth`: the outline is the element's path resource. */
export type LookGeometry =
  | { readonly kind: 'rect'; readonly radii: Corners; readonly smooth: boolean }
  | { readonly kind: 'ellipse' }
  | { readonly kind: 'path' }
  | { readonly kind: 'image'; readonly radii: Corners; readonly smooth: boolean }
  | { readonly kind: 'group' }
  | { readonly kind: 'frame'; readonly radii: Corners; readonly clip: boolean; readonly smooth: boolean };

/** A stroke as drawn: `ring` names the path resource filled instead of stroking (inside, outside, per side). */
export type LookStroke = Omit<ResolvedStroke, 'sides' | 'align'> & { readonly ring?: number };

export interface Look {
  readonly geometry: LookGeometry;
  readonly fills: readonly ResolvedFill[];
  readonly strokes: readonly LookStroke[];
  readonly effects: readonly ResolvedEffect[];
  /** A matte image asset used as this mask's alpha (S9). */
  readonly matte?: string;
}

export type SceneResource = { readonly kind: 'look'; readonly value: Look } | { readonly kind: 'path'; readonly value: { readonly verbs: readonly number[]; readonly points: readonly number[] } };

/** The look of a resolved element (`rings[i]`: the ring resource of stroke `i`, 0 for a plain stroke). */
export function lookOf(el: ResolvedElement, rings: readonly number[] = []): Look {
  const g = el.geometry;
  let geometry: LookGeometry;
  switch (g.kind) {
    case 'rect':
      geometry = { kind: 'rect', radii: g.radii, smooth: g.smoothing > 0 };
      break;
    case 'frame':
      geometry = { kind: 'frame', radii: g.radii, clip: g.clip, smooth: g.smoothing > 0 };
      break;
    case 'image':
      geometry = { kind: 'image', radii: g.radii, smooth: g.smoothing > 0 };
      break;
    case 'ellipse':
      geometry = { kind: 'ellipse' };
      break;
    case 'group':
      geometry = { kind: 'group' };
      break;
    default:
      geometry = { kind: 'path' };
  }
  return {
    geometry,
    fills: el.fills,
    strokes: el.strokes.map((s, i) => {
      const { sides: _sides, align: _align, ...rest } = s;
      const ring = rings[i] ?? 0;
      return ring === 0 ? rest : { ...rest, ring };
    }),
    effects: el.effects,
    ...(el.mask?.asset === undefined ? {} : { matte: el.mask.asset }),
  };
}

// ---------------------------------------------------------------- resources (editor side)

interface Interned {
  readonly id: number;
  readonly key: string;
  refs: number;
}

export interface ResourceTable {
  /** Intern a resource; returns its id (≥ 1). The caller releases it when no longer used. */
  intern(resource: SceneResource): number;
  release(id: number): void;
  /** Defines and drops since the last call, encoded (undefined when nothing changed). */
  take(): Uint8Array | undefined;
  /** Every live resource as one batch (for a resnapshot). */
  snapshot(): Uint8Array;
  readonly size: number;
}

const encoder = new TextEncoder();

export function createResourceTable(): ResourceTable {
  const byKey = new Map<string, Interned & { readonly resource: SceneResource }>();
  const byId = new Map<number, Interned & { readonly resource: SceneResource }>();
  let next = 1;
  let defines: [number, SceneResource][] = [];
  let drops: number[] = [];
  const encode = (define: readonly [number, SceneResource][], drop: readonly number[]): Uint8Array =>
    encoder.encode(JSON.stringify({ format: 'instaflow.scene-resources/1', define: define.map(([id, r]) => [id, r.kind, r.value]), drop }));
  return {
    intern(resource) {
      const key = `${resource.kind}:${JSON.stringify(resource.value)}`;
      let entry = byKey.get(key);
      if (entry === undefined) {
        entry = { id: next++, key, refs: 0, resource };
        byKey.set(key, entry);
        byId.set(entry.id, entry);
        defines.push([entry.id, resource]);
        drops = drops.filter((d) => d !== entry?.id);
      }
      entry.refs += 1;
      return entry.id;
    },
    release(id) {
      const entry = byId.get(id);
      if (entry === undefined) return;
      entry.refs -= 1;
      if (entry.refs > 0) return;
      byId.delete(id);
      byKey.delete(entry.key);
      const pending = defines.findIndex(([d]) => d === id);
      if (pending >= 0) defines.splice(pending, 1);
      else drops.push(id);
    },
    take() {
      if (defines.length === 0 && drops.length === 0) return undefined;
      const out = encode(defines, drops);
      defines = [];
      drops = [];
      return out;
    },
    snapshot() {
      defines = [];
      drops = [];
      return encode(
        [...byId.values()].map((e) => [e.id, e.resource]),
        [],
      );
    },
    get size() {
      return byId.size;
    },
  };
}

// ---------------------------------------------------------------- the composed source

export interface ElementRenderSourceOptions extends ElementContext {
  readonly stage: Pick<Stage, 'read' | 'children' | 'value' | 'onInvalidate'>;
  readonly geometry: GeometryService;
  /** The page (or other root) whose subtree is projected; the root itself is not drawn. */
  readonly root: NodeId;
  /** Fractional order keys from the document (default: sibling index keys). */
  readonly orderOf?: (node: NodeId) => string | undefined;
  readonly resources?: ResourceTable;
  /**
   * Draw the root page's fill stack (`style.fills` on the page, B12 A-1) as a full-page rect under everything, with the
   * node id `pageFillId(root)`. Absent fills mean `PAGE_FILL_DEFAULT` (white); an empty list draws nothing. Strokes
   * and effects on a page are never drawn. Export's `transparent` passes false (default false: element-only scenes).
   */
  readonly pageFill?: boolean;
}

/** The page's fills when it has none written (APPEARANCE §2.8: one white row). */
export const PAGE_FILL_DEFAULT: readonly JsonValue[] = Object.freeze([Object.freeze({ paint: '#ffffff' })]);
/** Node id of a page's fill in the render projection (never a document id: `#` is not in document ids). */
export const pageFillId = (page: NodeId): NodeId => `${page}#fill`;
/** Order key of the page fill: sorts before every fractional order key, so it draws first. */
const PAGE_FILL_ORDER = '';

/** Raw page fills as written (tokens kept), with the default when the page has none (the Page section's model). */
export function pageFills(stage: Pick<Stage, 'value'>, page: NodeId): readonly JsonValue[] {
  const raw = stage.value(page, P.fills);
  return Array.isArray(raw) ? raw : PAGE_FILL_DEFAULT;
}

/** The page's size (`page.size`), else its spatial box. */
export function pageBox(stage: Pick<Stage, 'value'>, page: NodeId): { readonly width: number; readonly height: number } {
  const size = stage.value(page, 'page.size');
  const o = typeof size === 'object' && size !== null && !Array.isArray(size) ? (size as Record<string, JsonValue>) : {};
  const n = (v: JsonValue | undefined): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  return { width: n(o['width']) || n(stage.value(page, P.w)), height: n(o['height']) || n(stage.value(page, P.h)) };
}

export interface ElementRenderSource extends RenderProjectionSource {
  readonly resources: ResourceTable;
  /** What changed since the last `snapshot`/`changes` (undefined: nothing). Resources go out first (`takeResources`). */
  changes(): PartChange | undefined;
  takeResources(): Uint8Array | undefined;
  /** Issues of the last resolution per node (unresolved tokens, bad geometry). */
  issues(node: NodeId): readonly { readonly path: string; readonly problem: string }[];
  dispose(): void;
}

const pathResource = (p: PathData): SceneResource => ({ kind: 'path', value: { verbs: [...p.verbs], points: [...p.points] } });

interface Projected {
  readonly record: NodeRecord;
  /** Resource ids this node holds (look, path, rings). */
  readonly holds: readonly number[];
}

/** A per-node source over the composed stage for `createRenderProjector(ElementProjection, source)`. */
export function createElementRenderSource(options: ElementRenderSourceOptions): ElementRenderSource {
  const ctx: ElementContext = options;
  const resources = options.resources ?? createResourceTable();
  const cache = new Map<NodeId, Projected>();
  const issues = new Map<NodeId, { path: string; problem: string }[]>();
  const dirty = new Set<NodeId>();

  /** Hidden (`spatial.hidden` on it or an ancestor, B12) or inside a boolean group (an operand): not drawn on its own. */
  const hidden = (el: ResolvedElement): boolean => {
    if (el.hidden === true) return true;
    for (let at = el.parent; at !== null && at !== options.root; ) {
      const parent = resolveElement(ctx.stage, at, ctx.kit);
      if (parent === undefined) return true;
      if (parent.geometry.kind === 'boolean' || parent.hidden === true) return true;
      at = parent.parent;
    }
    return false;
  };

  const orderKey = (id: NodeId, parent: NodeId | null): string => {
    const own = options.orderOf?.(id);
    if (own !== undefined) return own;
    const index = ctx.stage.children(parent).indexOf(id);
    return String(Math.max(0, index)).padStart(8, '0');
  };

  const fillId = options.pageFill === true ? pageFillId(options.root) : undefined;
  /** The page fill as a plain rect element (resolved like any fill stack: tokens, gradients, images). */
  const computePageFill = (id: NodeId): Projected | undefined => {
    const page = ctx.stage.read(options.root);
    if (page === undefined) return undefined;
    const { width, height } = pageBox(ctx.stage, options.root);
    const el = resolveComposed({ ...page, id, kind: 'shape', parent: null, values: { [P.fills]: pageFills(ctx.stage, options.root) as JsonValue, [P.w]: width, [P.h]: height } }, ctx.kit);
    if (el.fills.length === 0 || !(width > 0 && height > 0)) return undefined;
    issues.set(id, [...el.issues]);
    const look = resources.intern({ kind: 'look', value: { geometry: { kind: 'rect', radii: [0, 0, 0, 0], smooth: false }, fills: el.fills, strokes: [], effects: [] } });
    const props: Record<string, JsonValue> = { 'render.a': 1, 'render.b': 0, 'render.c': 0, 'render.d': 1, 'render.e': 0, 'render.f': 0, 'render.w': width, 'render.h': height, 'render.opacity': 1, 'render.blend': 0, 'render.flags': RENDER_FLAGS.visible, 'render.mask': 0, 'render.look': look, 'render.path': 0 };
    return { record: { id, kind: 'shape', parent: null, order: PAGE_FILL_ORDER, props, texts: [], lists: [] }, holds: [look] };
  };

  const compute = (id: NodeId): Projected | undefined => {
    if (id === fillId) return computePageFill(id);
    const el = resolveElement(ctx.stage, id, ctx.kit);
    if (el === undefined || !isElement(el.kind) || !(ELEMENT_PROJECTION_KINDS as readonly string[]).includes(el.kind) || hidden(el)) return undefined;
    const problems = [...el.issues];
    const holds: number[] = [];
    let path = 0;
    const rings: number[] = [];
    const g = el.geometry;
    const analytic = g.kind === 'ellipse' || g.kind === 'group' || ((g.kind === 'rect' || g.kind === 'frame' || g.kind === 'image') && g.smoothing === 0);
    const special = el.strokes.some((s) => s.align !== 'center' || s.sides !== undefined);
    if (!analytic || special) {
      const outline = localOutline(ctx, el);
      if (!outline.ok) problems.push({ path: 'geometry', problem: outline.error.message });
      else {
        if (!analytic) holds.push((path = resources.intern(pathResource(outline.value))));
        for (const stroke of el.strokes) {
          const ring = strokeRing(ctx, el, stroke, outline.value);
          if (!ring.ok) {
            problems.push({ path: P.strokes, problem: ring.error.message });
            rings.push(0);
          } else if (ring.value === undefined) rings.push(0);
          else {
            const id = resources.intern(pathResource(ring.value));
            holds.push(id);
            rings.push(id);
          }
        }
      }
    }
    const look = resources.intern({ kind: 'look', value: lookOf(el, rings) });
    holds.push(look);
    issues.set(id, problems);
    const t = el.transform;
    const props: Record<string, JsonValue> = {
      'render.a': t[0],
      'render.b': t[1],
      'render.c': t[2],
      'render.d': t[3],
      'render.e': t[4],
      'render.f': t[5],
      'render.w': el.box.w,
      'render.h': el.box.h,
      'render.opacity': el.opacity,
      'render.blend': BLEND_MODE_NAMES.indexOf(el.blend),
      'render.flags': RENDER_FLAGS.visible | (el.geometry.kind === 'path' && el.geometry.evenOdd ? RENDER_FLAGS.evenOdd : 0),
      'render.mask': el.mask === undefined ? 0 : (MASK_MODE_NAMES.indexOf(el.mask.mode) + 1) | (el.mask.invert ? MASK_INVERT_BIT : 0),
      'render.look': look,
      'render.path': path,
    };
    const parent = el.parent;
    return { record: { id, kind: el.kind, parent, order: orderKey(id, parent), props, texts: [], lists: [] }, holds };
  };

  const release = (p: Projected | undefined): void => {
    if (p === undefined) return;
    for (const id of p.holds) resources.release(id);
  };

  const walk = (visit: (id: NodeId) => void): void => {
    const visitChildren = (parent: NodeId): void => {
      for (const child of ctx.stage.children(parent)) {
        visit(child);
        visitChildren(child);
      }
    };
    if (fillId !== undefined) visit(fillId);
    visitChildren(options.root);
  };

  const stop = options.stage.onInvalidate((nodes) => {
    for (const node of nodes) dirty.add(node);
  });

  return {
    resources,
    node: (id) => {
      let p = cache.get(id);
      if (p === undefined) {
        p = compute(id);
        if (p !== undefined) cache.set(id, p);
      }
      return p?.record;
    },
    forEachNode(visit) {
      const fresh = new Map<NodeId, Projected>();
      walk((id) => {
        const p = compute(id);
        if (p !== undefined) fresh.set(id, p);
      });
      for (const old of cache.values()) release(old);
      cache.clear();
      dirty.clear();
      for (const [id, p] of fresh) {
        cache.set(id, p);
        if (visit(p.record) === false) break;
      }
    },
    changes() {
      if (dirty.size === 0) return undefined;
      // A changed node can change what its subtree projects (boolean operands, deletes) and its boolean ancestors.
      const queue = [...dirty];
      if (fillId !== undefined && dirty.has(options.root)) queue.push(fillId); // page fills or size changed
      dirty.clear();
      const touched = new Set<NodeId>();
      while (queue.length > 0) {
        const id = queue.pop() as NodeId;
        if (touched.has(id)) continue;
        touched.add(id);
        const node = ctx.stage.read(id);
        if (node === undefined) {
          for (const [cached, p] of cache) if (p.record.parent === id) queue.push(cached);
        } else if (node.kind === 'group' || node.kind === 'frame') {
          for (const child of ctx.stage.children(id)) queue.push(child);
        }
        const parent = node?.parent ?? cache.get(id)?.record.parent ?? null;
        if (parent !== null && parent !== options.root && resolveElement(ctx.stage, parent, ctx.kit)?.geometry.kind === 'boolean') queue.push(parent);
      }
      const created: NodeId[] = [];
      const deleted: NodeId[] = [];
      const moved: NodeId[] = [];
      const updated = new Map<NodeId, string[]>();
      for (const id of touched) {
        const before = cache.get(id);
        const after = compute(id);
        if (after === undefined) {
          if (before !== undefined) {
            cache.delete(id);
            release(before);
            deleted.push(id);
          }
          continue;
        }
        cache.set(id, after);
        if (before === undefined) {
          created.push(id);
          continue;
        }
        release(before);
        if (before.record.parent !== after.record.parent || before.record.order !== after.record.order) moved.push(id);
        const paths = Object.keys(after.record.props).filter((k) => after.record.props[k] !== before.record.props[k]);
        if (paths.length > 0) updated.set(id, paths);
      }
      if (created.length + deleted.length + moved.length + updated.size === 0) return undefined;
      return { origin: 'local', created, deleted, moved, updated };
    },
    takeResources: () => resources.take(),
    issues: (id) => issues.get(id) ?? [],
    dispose() {
      stop();
      for (const p of cache.values()) release(p);
      cache.clear();
    },
  };
}
