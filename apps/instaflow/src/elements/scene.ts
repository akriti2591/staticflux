/**
 * Render side of the element projection (IF-7.10, IF-20.26–20.28): the scene store (A7) plus the element resources
 * → scene IR batches (A6 draws them). `encode(store)` diffs the store against what it last encoded and writes only
 * changed nodes (upserts at their sorted sibling index, removes), so a drag re-encodes only the dragged elements.
 *
 * Scene ids: element in slot `s` = `2s + 2` (odd ids are free for editor overlays). Fill and stroke stacks map 1:1;
 * inside, outside and per-side strokes arrive as ring paths and are filled. Gradients come in unit-box coordinates and are mapped to the element's `w × h`. Images are drawn when the
 * render worker has uploaded their pixels under the id `images(asset)` returns (luminance masks ask for the
 * `luma` variant: upload `lumaToAlpha(pixels)` under that id).
 *
 * Layout grids are editor chrome: `gridOverlayBatch` encodes them for a separate overlay scene that export never sees.
 */
import { NO_SLOT, type SceneStore } from '@staticflux/document/render-projection';
import {
  BLEND_MODES,
  type BlendMode,
  createSceneWriter,
  type ImageFit,
  MASK_MODES,
  type SceneClip,
  type SceneEffect,
  type SceneFill,
  type SceneGeometry,
  type SceneNode,
  type ScenePaint,
  type ScenePath,
  type SceneStroke,
  type SceneWriter,
} from '../render/scene-ir.js';
import type { Box } from '@staticflux/document/spatial-index';
import { type ElementField, type Look, MASK_INVERT_BIT, RENDER_FLAGS, type SceneResource } from './projection.js';
import type { GridLines } from './layout.js';
import type { ResolvedPaint } from './resolve.js';
import type { Rgba8 } from './values.js';

// ---------------------------------------------------------------- resources (render side)

export interface SceneResources {
  /** Apply one resource batch (`ResourceTable.take()` / `snapshot()`); false when it is not a resource batch. */
  apply(batch: Uint8Array): boolean;
  look(id: number): Look | undefined;
  path(id: number): { readonly verbs: readonly number[]; readonly points: readonly number[] } | undefined;
  clear(): void;
  readonly size: number;
}

const decoder = new TextDecoder();

export function createSceneResources(): SceneResources {
  const looks = new Map<number, Look>();
  const paths = new Map<number, { readonly verbs: readonly number[]; readonly points: readonly number[] }>();
  return {
    apply(batch) {
      let parsed: { format?: unknown; define?: unknown; drop?: unknown };
      try {
        // Copy first: the batch may be a view into shared memory, which TextDecoder refuses.
        parsed = JSON.parse(decoder.decode(batch.slice())) as typeof parsed;
      } catch {
        return false;
      }
      if (parsed.format !== 'instaflow.scene-resources/1' || !Array.isArray(parsed.define) || !Array.isArray(parsed.drop)) return false;
      for (const id of parsed.drop as number[]) {
        looks.delete(id);
        paths.delete(id);
      }
      for (const [id, kind, value] of parsed.define as [number, SceneResource['kind'], unknown][]) {
        if (kind === 'look') looks.set(id, value as Look);
        else paths.set(id, value as { verbs: number[]; points: number[] });
      }
      return true;
    },
    look: (id) => looks.get(id),
    path: (id) => paths.get(id),
    clear() {
      looks.clear();
      paths.clear();
    },
    get size() {
      return looks.size + paths.size;
    },
  };
}

/** Luminance as alpha (Rec. 709 luma × alpha) for an image used as a luminance mask; RGBA8 in, RGBA8 out. */
export function lumaToAlpha(rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const y = 0.2126 * (rgba[i] as number) + 0.7152 * (rgba[i + 1] as number) + 0.0722 * (rgba[i + 2] as number);
    out[i + 3] = Math.round((y * (rgba[i + 3] as number)) / 255);
  }
  return out;
}

// ---------------------------------------------------------------- encoder

export interface ElementSceneEncoderOptions {
  /** Scene image id for an asset (refKey), or undefined while its pixels are not uploaded. `luma`: the luminance-as-alpha variant. */
  readonly images?: (asset: string, variant: 'rgba' | 'luma') => number | undefined;
}

export interface ElementSceneEncoder {
  /** Scene IR for everything that changed since the last call (undefined: nothing). `full` re-encodes all (after a resnapshot). */
  encode(store: SceneStore<ElementField>, resources: SceneResources, options?: { readonly full?: boolean }): Uint8Array | undefined;
  /** Scene id of a slot's element. */
  sceneId(slot: number): number;
  reset(): void;
}

export const sceneIdOf = (slot: number): number => 2 * slot + 2;

const FIT: Readonly<Record<string, ImageFit>> = { cover: 'cover', contain: 'contain', stretch: 'stretch', tile: 'tile' };

function paintOf(p: ResolvedPaint, w: number, h: number, images: ElementSceneEncoderOptions['images'], variant: 'rgba' | 'luma'): ScenePaint {
  switch (p.kind) {
    case 'none':
      return { kind: 'none' };
    case 'solid':
      return { kind: 'solid', color: p.color };
    case 'linear':
      return { kind: 'linear', start: [p.from[0] * w, p.from[1] * h], end: [p.to[0] * w, p.to[1] * h], stops: p.stops };
    case 'radial':
      return { kind: 'radial', center: [p.center[0] * w, p.center[1] * h], radius: Math.max(1e-6, p.radius * Math.max(w, h)), stops: p.stops };
    case 'conic':
      return { kind: 'sweep', center: [p.center[0] * w, p.center[1] * h], start: p.start, end: p.start + Math.PI * 2, stops: p.stops };
    case 'image': {
      const image = images?.(p.asset, variant);
      return image === undefined ? { kind: 'none' } : { kind: 'image', image, fit: FIT[p.fit] ?? 'cover', ...(p.crop === undefined ? {} : { crop: p.crop }) };
    }
  }
}

function effectsOf(look: Look): SceneEffect[] {
  return look.effects.map((e) =>
    'radius' in e ? { kind: e.kind, radius: e.radius } : { kind: e.kind, x: e.x, y: e.y, blur: e.blur, spread: e.spread, color: e.color as Rgba8 },
  );
}

const uniform = (r: readonly number[]): boolean => r.every((v) => v === r[0]);
type FlatPath = { readonly verbs: readonly number[]; readonly points: readonly number[] };
const scenePath = (p: FlatPath | undefined): ScenePath => ({ verbs: (p?.verbs ?? []) as ScenePath['verbs'], points: p?.points ?? [] });

export function createElementSceneEncoder(options: ElementSceneEncoderOptions = {}): ElementSceneEncoder {
  /** Last encoded signature per slot. */
  const seen = new Map<number, string>();
  /** Sibling slots per parent slot, sorted by order key (the IR index). */
  const siblings = new Map<number, number[]>();
  const parentOf = new Map<number, number>();

  const sortedInsert = (store: SceneStore<ElementField>, parent: number, slot: number): number => {
    let list = siblings.get(parent);
    if (list === undefined) siblings.set(parent, (list = []));
    const key = store.orderOf(slot) ?? '';
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const other = list[mid] as number;
      const k = store.orderOf(other) ?? '';
      if (k < key || (k === key && other < slot)) lo = mid + 1;
      else hi = mid;
    }
    list.splice(lo, 0, slot);
    return lo;
  };
  const unlink = (slot: number): void => {
    const parent = parentOf.get(slot);
    if (parent === undefined) return;
    const list = siblings.get(parent);
    const i = list?.indexOf(slot) ?? -1;
    if (list !== undefined && i >= 0) list.splice(i, 1);
    parentOf.delete(slot);
  };

  const node = (store: SceneStore<ElementField>, resources: SceneResources, slot: number, w: SceneWriter, index: number): void => {
    const col = (f: ElementField): number => store.column(f)[slot] as number;
    const width = col('w');
    const height = col('h');
    const parentSlot = store.parentOf(slot);
    const look = resources.look(col('look'));
    const maskBits = col('mask');
    const maskMode = MASK_MODES[maskBits & 0x7f] ?? 'none';
    const variant = maskMode === 'luminance' ? 'luma' : 'rgba';
    const flags = col('flags');
    const base: Omit<SceneNode, 'geometry'> = {
      id: sceneIdOf(slot),
      parent: parentSlot === NO_SLOT ? 0 : sceneIdOf(parentSlot),
      transform: [col('a'), col('b'), col('c'), col('d'), col('e'), col('f')],
      opacity: col('opacity'),
      blend: (BLEND_MODES[col('blend')] ?? 'normal') as BlendMode,
      visible: (flags & RENDER_FLAGS.visible) !== 0,
      evenOdd: (flags & RENDER_FLAGS.evenOdd) !== 0,
      ...(maskMode === 'none' ? {} : { mask: { mode: maskMode, invert: (maskBits & MASK_INVERT_BIT) !== 0 } }),
    };
    if (look === undefined) {
      w.upsert({ ...base, geometry: { kind: 'group' } }, index);
      return;
    }
    const paint = (p: ResolvedPaint): ScenePaint => paintOf(p, width, height, options.images, variant);
    let fills: SceneFill[] = look.fills.map((f) => ({ paint: paint(f.paint), opacity: f.opacity, blend: f.blend as BlendMode })).filter((f) => f.paint.kind !== 'none');
    if (look.matte !== undefined) {
      const image = options.images?.(look.matte, 'rgba');
      if (image !== undefined) fills = [{ paint: { kind: 'image', image, fit: 'stretch' } }];
    }
    const strokes: SceneStroke[] = look.strokes.map((s) => ({
      width: s.width,
      paint: paint(s.paint),
      opacity: s.opacity,
      blend: s.blend as BlendMode,
      join: s.join,
      cap: s.cap,
      miter: s.miter,
      dash: s.dash,
      dashOffset: s.dashOffset,
      ...(s.ring === undefined ? {} : { ring: scenePath(resources.path(s.ring)) }),
    }));
    const extras = { fills, strokes, effects: effectsOf(look) };
    const g = look.geometry;
    const outline = (): SceneGeometry => ({ kind: 'path', path: scenePath(resources.path(col('path'))) });
    let geometry: SceneGeometry;
    let clip: SceneClip | undefined;
    switch (g.kind) {
      case 'group':
        w.upsert({ ...base, geometry: { kind: 'group' }, effects: extras.effects }, index);
        return;
      case 'ellipse':
        geometry = { kind: 'ellipse', w: width, h: height };
        break;
      case 'path':
        geometry = outline();
        break;
      case 'rect':
      case 'image':
      case 'frame': {
        const r = g.radii;
        geometry = g.smooth ? outline() : uniform(r) ? { kind: 'rect', w: width, h: height, radius: r[0] } : { kind: 'rrect', w: width, h: height, radii: r };
        if (g.kind === 'frame' && g.clip) {
          clip = g.smooth
            ? { kind: 'path', path: scenePath(resources.path(col('path'))) }
            : uniform(r)
              ? (r[0] ?? 0) > 0
                ? { kind: 'rounded', rect: [0, 0, width, height], radius: r[0] ?? 0 }
                : { kind: 'rect', rect: [0, 0, width, height] }
              : { kind: 'path', path: roundedPath(width, height, r) };
        }
        break;
      }
    }
    w.upsert({ ...base, ...extras, geometry, ...(clip === undefined ? {} : { clip }) }, index);
  };

  const signature = (store: SceneStore<ElementField>, resources: SceneResources, slot: number): string => {
    const values = store.projection.fields.map((f) => store.column(f.name as ElementField)[slot]);
    // Resources are immutable per id, but a look or path may arrive after the slot first referenced it.
    const look = values[store.projection.fieldIndex.look] as number;
    const path = values[store.projection.fieldIndex.path] as number;
    return `${store.parentOf(slot)}|${store.orderOf(slot) ?? ''}|${values.join(',')}|${resources.look(look) === undefined ? 0 : 1}${resources.path(path) === undefined ? 0 : 1}`;
  };

  const encoder: ElementSceneEncoder = {
    encode(store, resources, encodeOptions = {}) {
      const w = createSceneWriter();
      if (encodeOptions.full === true) {
        encoder.reset();
        w.clear();
      }
      // Removed slots first.
      for (const slot of [...seen.keys()]) {
        if (store.alive(slot)) continue;
        seen.delete(slot);
        unlink(slot);
        w.remove(sceneIdOf(slot));
      }
      // Changed slots, parents before children.
      const changed: number[] = [];
      store.forEach((slot) => {
        const sig = signature(store, resources, slot);
        if (seen.get(slot) === sig) return;
        seen.set(slot, sig);
        changed.push(slot);
      });
      const depth = (slot: number): number => {
        let d = 0;
        for (let p = store.parentOf(slot); p !== NO_SLOT && d < 1e4; p = store.parentOf(p)) d++;
        return d;
      };
      changed.sort((a, b) => depth(a) - depth(b) || (store.orderOf(a) ?? '').localeCompare(store.orderOf(b) ?? ''));
      for (const slot of changed) {
        unlink(slot);
        const parent = store.parentOf(slot);
        parentOf.set(slot, parent);
        const index = sortedInsert(store, parent, slot);
        node(store, resources, slot, w, index);
      }
      return w.ops === 0 ? undefined : w.finish();
    },
    sceneId: sceneIdOf,
    reset() {
      seen.clear();
      siblings.clear();
      parentOf.clear();
    },
  };
  return encoder;
}

/** A rounded rect path with a radius per corner (frame clips with mixed corners). */
function roundedPath(w: number, h: number, r: readonly number[]): { readonly verbs: (0 | 1 | 2 | 3 | 4)[]; readonly points: number[] } {
  const k = 0.5522847498;
  const [tl = 0, tr = 0, br = 0, bl = 0] = r;
  const verbs: (0 | 1 | 2 | 3 | 4)[] = [];
  const points: number[] = [];
  const move = (x: number, y: number): void => {
    verbs.push(0);
    points.push(x, y);
  };
  const line = (x: number, y: number): void => {
    verbs.push(1);
    points.push(x, y);
  };
  const cubic = (...p: number[]): void => {
    verbs.push(3);
    points.push(...p);
  };
  move(tl, 0);
  line(w - tr, 0);
  if (tr > 0) cubic(w - tr + tr * k, 0, w, tr - tr * k, w, tr);
  line(w, h - br);
  if (br > 0) cubic(w, h - br + br * k, w - br + br * k, h, w - br, h);
  line(bl, h);
  if (bl > 0) cubic(bl - bl * k, h, 0, h - bl + bl * k, 0, h - bl);
  line(0, tl);
  if (tl > 0) cubic(0, tl - tl * k, tl - tl * k, 0, tl, 0);
  verbs.push(4);
  return { verbs, points };
}

// ---------------------------------------------------------------- layout grid overlay (non-printing)

/** Scene IR for layout grids (column/row tracks tinted, baseline lines) in a separate overlay scene, never exported. */
export function gridOverlayBatch(lines: GridLines, box: Box, options: { readonly firstId?: number; readonly color?: Rgba8; readonly line?: number } = {}): Uint8Array {
  const w = createSceneWriter().clear();
  const color = options.color ?? [255, 92, 57, 26];
  const stroke: Rgba8 = [color[0], color[1], color[2], Math.min(255, color[3] * 3)];
  const thin = options.line ?? 1;
  let id = options.firstId ?? 1;
  for (const [a, b] of lines.columns) w.upsert({ id: id++, transform: [1, 0, 0, 1, a, box.minY], geometry: { kind: 'rect', w: b - a, h: box.maxY - box.minY }, fill: { kind: 'solid', color } });
  for (const [a, b] of lines.rows) w.upsert({ id: id++, transform: [1, 0, 0, 1, box.minX, a], geometry: { kind: 'rect', w: box.maxX - box.minX, h: b - a }, fill: { kind: 'solid', color } });
  const tracked = new Set([...lines.columns.flat(), ...lines.rows.flat()]);
  for (const x of lines.x) if (!tracked.has(x)) w.upsert({ id: id++, transform: [1, 0, 0, 1, x - thin / 2, box.minY], geometry: { kind: 'rect', w: thin, h: box.maxY - box.minY }, fill: { kind: 'solid', color: stroke } });
  for (const y of lines.y) if (!tracked.has(y)) w.upsert({ id: id++, transform: [1, 0, 0, 1, box.minX, y - thin / 2], geometry: { kind: 'rect', w: box.maxX - box.minX, h: thin }, fill: { kind: 'solid', color: stroke } });
  return w.finish();
}
