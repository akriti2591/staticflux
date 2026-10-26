/**
 * Resolved elements (IF-20.9): what the renderer, geometry and inspector use. Reads the **composed** stage node
 * (local > variant > inherit (brand classes) > reference, with `@token` values resolved by the stage's token rule)
 * and turns it into plain numbers and 8-bit colours: the box and transform, the outline kind, paints, stroke,
 * effects, mask and match key. Tokens nested in gradients and effects resolve against the brand kit here; anything
 * that does not resolve is reported in `issues` and drawn as nothing (never as a wrong colour).
 */
import type { JsonValue, NodeId } from '@staticflux/document/v2';
import type { ComposedNode, Stage } from '@staticflux/stage';
import { type BlendModeName, type BooleanOpName, CORNER_PATHS, type ImageFitName, type MaskModeName, P, type ShapeName, type StrokeAlign } from './components.js';
import { type BrandKitView, resolveTokens } from './brand-kit.js';
import { colorToRgba, type Rgba8, tokenName } from './values.js';

/** Affine `[a, b, c, d, e, f]` (kurbo order: x' = a·x + c·y + e, y' = b·x + d·y + f). */
export type Affine = readonly [number, number, number, number, number, number];
export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

export interface ElementBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly rotation: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly anchorX: number;
  readonly anchorY: number;
  readonly flipX: boolean;
  readonly flipY: boolean;
  /** Horizontal skew in degrees (B10a): local x' = x + tan(skewX)·y before flips, scale and rotation. */
  readonly skewX: number;
}

export type GradientStop = readonly [offset: number, color: Rgba8];
export type ResolvedPaint =
  | { readonly kind: 'none' }
  | { readonly kind: 'solid'; readonly color: Rgba8 }
  | { readonly kind: 'linear'; readonly from: readonly [number, number]; readonly to: readonly [number, number]; readonly stops: readonly GradientStop[] }
  | { readonly kind: 'radial'; readonly center: readonly [number, number]; readonly radius: number; readonly stops: readonly GradientStop[] }
  /** `start` in radians, clockwise from 3 o'clock. */
  | { readonly kind: 'conic'; readonly center: readonly [number, number]; readonly start: number; readonly stops: readonly GradientStop[] }
  | { readonly kind: 'image'; readonly asset: string; readonly fit: ImageFitName; readonly crop?: ResolvedCrop };

/** An image paint's crop (B12, A-3): offset 0…1 of the free space, scale × the fit, clockwise quarter turns. */
export interface ResolvedCrop {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly quarter: 0 | 1 | 2 | 3;
}

/** The crop of an image paint value (undefined when it has none or it is the default: B1's plain fit). */
export function cropOf(v: Readonly<Record<string, JsonValue>>): ResolvedCrop | undefined {
  const offset = vec2(v['offset'], [0.5, 0.5]);
  const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
  const scale = typeof v['scale'] === 'number' && Number.isFinite(v['scale']) && v['scale'] > 0 ? v['scale'] : 1;
  const turns = typeof v['rotation'] === 'number' && Number.isFinite(v['rotation']) ? Math.round(v['rotation'] / 90) : 0;
  const quarter = (((turns % 4) + 4) % 4) as 0 | 1 | 2 | 3;
  const crop: ResolvedCrop = { x: clamp01(offset[0]), y: clamp01(offset[1]), scale, quarter };
  return crop.x === 0.5 && crop.y === 0.5 && crop.scale === 1 && crop.quarter === 0 ? undefined : crop;
}

export interface ResolvedFill {
  readonly paint: ResolvedPaint;
  readonly opacity: number;
  readonly blend: BlendModeName;
}

export interface ResolvedStroke {
  readonly paint: ResolvedPaint;
  readonly width: number;
  /** Per-side widths `[top, right, bottom, left]` (rectangles, frames, images). */
  readonly sides?: readonly [number, number, number, number];
  readonly align: StrokeAlign;
  readonly join: 'miter' | 'round' | 'bevel';
  readonly cap: 'butt' | 'round' | 'square';
  readonly miter: number;
  readonly dash: readonly number[];
  readonly dashOffset: number;
  readonly opacity: number;
  readonly blend: BlendModeName;
}

/** Glows resolve to shadows without offset (outer glow → drop shadow, inner glow → inner shadow). */
export type ResolvedEffect =
  | { readonly kind: 'drop-shadow' | 'inner-shadow'; readonly x: number; readonly y: number; readonly blur: number; readonly spread: number; readonly color: Rgba8 }
  | { readonly kind: 'layer-blur' | 'background-blur'; readonly radius: number };

export type Radii = readonly [number, number, number, number];

export type ResolvedGeometry =
  | { readonly kind: 'rect'; readonly radii: Radii; readonly smoothing: number }
  | { readonly kind: 'ellipse' }
  | { readonly kind: 'polygon'; readonly sides: number; readonly radius: number; readonly smoothing: number }
  | { readonly kind: 'star'; readonly points: number; readonly ratio: number; readonly radius: number; readonly inner: number; readonly smoothing: number }
  | { readonly kind: 'line' }
  /** `radii`: one for every vertex, or one per vertex (path order); empty = sharp. */
  | { readonly kind: 'path'; readonly d: string; readonly evenOdd: boolean; readonly radii: readonly number[]; readonly smoothing: number }
  | { readonly kind: 'boolean'; readonly op: BooleanOpName }
  | { readonly kind: 'group' }
  | { readonly kind: 'frame'; readonly radii: Radii; readonly clip: boolean; readonly smoothing: number }
  | { readonly kind: 'image'; readonly radii: Radii; readonly smoothing: number };

export interface ResolvedMask {
  readonly mode: MaskModeName;
  readonly invert: boolean;
  /** A matte image asset (refKey) used as the mask's alpha. */
  readonly asset?: string;
}

export interface ResolvedElement {
  readonly id: NodeId;
  readonly kind: string;
  readonly parent: NodeId | null;
  readonly name?: string;
  readonly role?: string;
  readonly box: ElementBox;
  /** Local (box) → parent space. */
  readonly transform: Affine;
  readonly opacity: number;
  readonly blend: BlendModeName;
  readonly geometry: ResolvedGeometry;
  /** Visible fills, bottom first. */
  readonly fills: readonly ResolvedFill[];
  /** Visible strokes, bottom first. */
  readonly strokes: readonly ResolvedStroke[];
  readonly effects: readonly ResolvedEffect[];
  readonly mask?: ResolvedMask;
  readonly matchKey?: string;
  /** `spatial.hidden` (B12, A-2): present only when the element itself is hidden (ancestors: `isHidden` in layout). */
  readonly hidden?: true;
  /** Tokens that did not resolve, and values that could not be read (drawn as nothing). */
  readonly issues: readonly { readonly path: string; readonly problem: string }[];
}

const num = (v: JsonValue | undefined, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const str = <T extends string>(v: JsonValue | undefined, allowed: readonly T[], fallback: T): T => (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback);

/** Multiply affines: `a · b` (apply b first). */
export function multiply(a: Affine, b: Affine): Affine {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

/** Inverse affine (undefined when singular). */
export function invert(t: Affine): Affine | undefined {
  const det = t[0] * t[3] - t[1] * t[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return undefined;
  const [a, b, c, d, e, f] = t;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export function applyAffine(t: Affine, x: number, y: number): readonly [number, number] {
  return [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]];
}

/**
 * Local → parent transform of a box about the anchor: linear part `R · D · K` with K the horizontal skew
 * (`[[1, tan skewX], [0, 1]]`, B10a), D the scale and flips, R the rotation (degrees, clockwise).
 */
export function boxTransform(box: ElementBox): Affine {
  const ax = box.anchorX * box.w;
  const ay = box.anchorY * box.h;
  const r = (box.rotation * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const sx = box.scaleX * (box.flipX ? -1 : 1);
  const sy = box.scaleY * (box.flipY ? -1 : 1);
  const k = box.skewX === 0 ? 0 : Math.tan((box.skewX * Math.PI) / 180);
  // R · D = [cos·sx, sin·sx, −sin·sy, cos·sy]; · K adds k × the first column to the second.
  // Without skew the terms stay exactly B1's (−0 included: scene bytes and goldens do not change).
  const linear: Affine = k === 0 ? [cos * sx, sin * sx, -sin * sy, cos * sy, 0, 0] : [cos * sx, sin * sx, -sin * sy + k * cos * sx, cos * sy + k * sin * sx, 0, 0];
  const [ox, oy] = applyAffine(linear, -ax, -ay);
  return [linear[0], linear[1], linear[2], linear[3], box.x + ax + ox, box.y + ay + oy];
}

export function readBox(values: Readonly<Record<string, JsonValue>>): ElementBox {
  return {
    x: num(values[P.x], 0),
    y: num(values[P.y], 0),
    w: Math.max(0, num(values[P.w], 0)),
    h: Math.max(0, num(values[P.h], 0)),
    rotation: num(values[P.rotation], 0),
    scaleX: num(values[P.scaleX], 1),
    scaleY: num(values[P.scaleY], 1),
    anchorX: num(values[P.anchorX], 0.5),
    anchorY: num(values[P.anchorY], 0.5),
    flipX: values[P.flipX] === true,
    flipY: values[P.flipY] === true,
    skewX: num(values[P.skewX], 0),
  };
}

interface Reader {
  readonly issues: { path: string; problem: string }[];
  readonly kit: BrandKitView | undefined;
}

function color(v: JsonValue | undefined, path: string, r: Reader): Rgba8 | undefined {
  if (typeof v !== 'string') return undefined;
  const name = tokenName(v);
  const value = name === undefined ? v : r.kit?.token(name);
  const rgba = typeof value === 'string' ? colorToRgba(value) : undefined;
  if (rgba === undefined) r.issues.push({ path, problem: name === undefined ? `not a colour: ${v}` : `unresolved token ${v}` });
  return rgba;
}

function nested(v: JsonValue, path: string, r: Reader): JsonValue {
  if (r.kit === undefined) return v;
  const kit = r.kit;
  const resolved = resolveTokens(v, (name) => kit.token(name));
  for (const name of resolved.missing) r.issues.push({ path, problem: `unresolved token @${name}` });
  return resolved.value;
}

function stopsOf(v: JsonValue | undefined, path: string, r: Reader): GradientStop[] {
  if (!Array.isArray(v)) return [];
  const out: GradientStop[] = [];
  for (const s of v) {
    if (typeof s !== 'object' || s === null || Array.isArray(s)) continue;
    const o = s as Record<string, JsonValue>;
    const c = color(o['color'], path, r);
    if (c !== undefined) out.push([Math.max(0, Math.min(1, num(o['offset'], 0))), c]);
  }
  return out;
}

const vec2 = (v: JsonValue | undefined, fallback: readonly [number, number]): readonly [number, number] =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number' ? [v[0], v[1]] : fallback;

function readPaint(raw: JsonValue | undefined, path: string, r: Reader): ResolvedPaint {
  if (raw === undefined || raw === null || raw === 'none') return { kind: 'none' };
  if (typeof raw === 'string') {
    const c = color(raw, path, r);
    return c === undefined ? { kind: 'none' } : { kind: 'solid', color: c };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'none' };
  const v = nested(raw, path, r) as Record<string, JsonValue>;
  switch (v['kind']) {
    case 'linear':
      return { kind: 'linear', from: vec2(v['from'], [0, 0]), to: vec2(v['to'], [1, 0]), stops: stopsOf(v['stops'], path, r) };
    case 'radial':
      return { kind: 'radial', center: vec2(v['center'], [0.5, 0.5]), radius: num(v['radius'], 0.5), stops: stopsOf(v['stops'], path, r) };
    case 'conic':
      return { kind: 'conic', center: vec2(v['center'], [0.5, 0.5]), start: (num(v['angle'], 0) * Math.PI) / 180, stops: stopsOf(v['stops'], path, r) };
    case 'image': {
      const asset = v['asset'];
      if (typeof asset !== 'object' || asset === null || Array.isArray(asset) || typeof (asset as Record<string, JsonValue>)['asset'] !== 'string') return { kind: 'none' };
      const ref = asset as Record<string, JsonValue>;
      const key = typeof ref['at'] === 'string' && ref['at'] !== 'latest' ? `${ref['asset'] as string}@${ref['at']}` : (ref['asset'] as string);
      const crop = cropOf(v);
      return { kind: 'image', asset: key, fit: str(v['fit'], ['cover', 'contain', 'stretch', 'tile'] as const, 'cover'), ...(crop === undefined ? {} : { crop }) };
    }
    default:
      r.issues.push({ path, problem: 'unknown paint kind' });
      return { kind: 'none' };
  }
}

function size(v: JsonValue | undefined, path: string, r: Reader): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, v);
  const name = tokenName(v);
  const value = name === undefined ? undefined : r.kit?.token(name);
  if (typeof value === 'number') return Math.max(0, value);
  r.issues.push({ path, problem: name === undefined ? 'not a size' : `unresolved token ${String(v)}` });
  return undefined;
}

/** Corner radii scaled down together when adjacent ones do not fit (CSS rule), and never above half the shortest side. */
export function fitRadii(w: number, h: number, radii: Radii): Radii {
  const [tl, tr, br, bl] = radii.map((v) => (Number.isFinite(v) ? Math.max(0, v) : 0)) as [number, number, number, number];
  let f = 1;
  for (const [sum, side] of [
    [tl + tr, w],
    [bl + br, w],
    [tl + bl, h],
    [tr + br, h],
  ] as const) {
    if (sum > side && sum > 0) f = Math.min(f, side / sum);
  }
  const cap = Math.max(0, Math.min(w, h) / 2);
  return [Math.min(tl * f, cap), Math.min(tr * f, cap), Math.min(br * f, cap), Math.min(bl * f, cap)];
}

function radiiOf(values: Readonly<Record<string, JsonValue>>, r: Reader, box: ElementBox): Radii {
  const all = size(values[P.radius], P.radius, r) ?? 0;
  const [tl, tr, br, bl] = CORNER_PATHS.map((path) => size(values[path], path, r) ?? all) as [number, number, number, number];
  return fitRadii(box.w, box.h, [tl, tr, br, bl]);
}

const BLENDS = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'] as const;
const unitOf = (v: JsonValue | undefined): number => Math.max(0, Math.min(1, num(v, 1)));
const items = (raw: JsonValue | undefined): Record<string, JsonValue>[] =>
  Array.isArray(raw) ? raw.filter((x): x is Record<string, JsonValue> => typeof x === 'object' && x !== null && !Array.isArray(x) && x['visible'] !== false) : [];

function fillsOf(raw: JsonValue | undefined, r: Reader): ResolvedFill[] {
  const out: ResolvedFill[] = [];
  for (const item of items(raw)) {
    const paint = readPaint(item['paint'], P.fills, r);
    if (paint.kind !== 'none') out.push({ paint, opacity: unitOf(item['opacity']), blend: str(item['blend'], BLENDS, 'normal') });
  }
  return out;
}

function strokesOf(raw: JsonValue | undefined, r: Reader): ResolvedStroke[] {
  const out: ResolvedStroke[] = [];
  for (const item of items(raw)) {
    const paint = readPaint(item['paint'], P.strokes, r);
    const width = size(item['width'], P.strokes, r) ?? 0;
    const rawSides = item['sides'];
    const sides = Array.isArray(rawSides) && rawSides.length === 4 ? (rawSides.map((v) => size(v, P.strokes, r) ?? 0) as [number, number, number, number]) : undefined;
    if (paint.kind === 'none' || (width <= 0 && (sides === undefined || sides.every((v) => v <= 0)))) continue;
    const dash = Array.isArray(item['dash']) ? item['dash'].filter((d): d is number => typeof d === 'number' && Number.isFinite(d) && d >= 0) : [];
    out.push({
      paint,
      width,
      ...(sides === undefined ? {} : { sides }),
      align: str(item['align'], ['center', 'inside', 'outside'] as const, 'center'),
      join: str(item['join'], ['miter', 'round', 'bevel'] as const, 'miter'),
      cap: str(item['cap'], ['butt', 'round', 'square'] as const, 'butt'),
      miter: Math.max(1, num(item['miter'], 4)),
      dash: dash.some((d) => d > 0) ? dash : [],
      dashOffset: num(item['dashOffset'], 0),
      opacity: unitOf(item['opacity']),
      blend: str(item['blend'], BLENDS, 'normal'),
    });
  }
  return out;
}

function effectsOf(raw: JsonValue | undefined, r: Reader): ResolvedEffect[] {
  // A preset token (whole list or one item) resolves to its kit value; lists flatten.
  const expand = (v: JsonValue | undefined, depth: number): JsonValue[] => {
    if (v === undefined || v === null || depth > 4) return [];
    const name = tokenName(v);
    if (name !== undefined) {
      const value = r.kit?.token(name);
      if (value === undefined) {
        r.issues.push({ path: P.effects, problem: `unresolved token ${String(v)}` });
        return [];
      }
      return expand(value, depth + 1);
    }
    return Array.isArray(v) ? v.flatMap((x) => expand(x, depth + 1)) : [v];
  };
  const out: ResolvedEffect[] = [];
  for (const e of expand(raw, 0)) {
    if (typeof e !== 'object' || e === null || Array.isArray(e)) continue;
    const o = e as Record<string, JsonValue>;
    if (o['visible'] === false) continue;
    const kind = o['kind'];
    if (kind === 'layer-blur' || kind === 'background-blur') {
      out.push({ kind, radius: Math.max(0, num(o['radius'], 0)) });
      continue;
    }
    if (kind !== 'drop-shadow' && kind !== 'inner-shadow' && kind !== 'outer-glow' && kind !== 'inner-glow') continue;
    const c = color(o['color'], P.effects, r);
    if (c === undefined) continue;
    const glow = kind === 'outer-glow' || kind === 'inner-glow';
    out.push({
      kind: kind === 'drop-shadow' || kind === 'outer-glow' ? 'drop-shadow' : 'inner-shadow',
      x: glow ? 0 : num(o['x'], 0),
      y: glow ? 0 : num(o['y'], 0),
      blur: Math.max(0, num(o['blur'], 0)),
      spread: num(o['spread'], 0),
      color: c,
    });
  }
  return out;
}

function geometryOf(kind: string, values: Readonly<Record<string, JsonValue>>, r: Reader, box: ElementBox): ResolvedGeometry {
  switch (kind) {
    case 'frame':
      return { kind: 'frame', radii: radiiOf(values, r, box), clip: values[P.clip] !== false, smoothing: unitOf(values[P.smoothing] ?? 0) };
    case 'image':
      return { kind: 'image', radii: radiiOf(values, r, box), smoothing: unitOf(values[P.smoothing] ?? 0) };
    case 'vector': {
      const d = values[P.path];
      const perVertex = values[P.vertexRadii];
      const all = size(values[P.radius], P.radius, r) ?? 0;
      const radii = Array.isArray(perVertex) ? perVertex.map((v) => size(v, P.vertexRadii, r) ?? all) : all > 0 ? [all] : [];
      return { kind: 'path', d: typeof d === 'string' ? d : '', evenOdd: values[P.fillRule] === 'evenodd', radii, smoothing: unitOf(values[P.smoothing] ?? 0) };
    }
    case 'group': {
      const op = values[P.boolean];
      return typeof op === 'string' && ['union', 'subtract', 'intersect', 'exclude'].includes(op) ? { kind: 'boolean', op: op as BooleanOpName } : { kind: 'group' };
    }
    default: {
      const shape = str(values[P.shape], ['rect', 'ellipse', 'polygon', 'star', 'line'] as const, 'rect') as ShapeName;
      switch (shape) {
        case 'rect':
          return { kind: 'rect', radii: radiiOf(values, r, box), smoothing: unitOf(values[P.smoothing] ?? 0) };
        case 'polygon':
          return { kind: 'polygon', sides: Math.round(Math.max(3, Math.min(1000, num(values[P.sides], 3)))), radius: size(values[P.radius], P.radius, r) ?? 0, smoothing: unitOf(values[P.smoothing] ?? 0) };
        case 'star': {
          const radius = size(values[P.radius], P.radius, r) ?? 0;
          return {
            kind: 'star',
            points: Math.round(Math.max(3, Math.min(1000, num(values[P.sides], 5)))),
            ratio: Math.max(0.01, Math.min(1, num(values[P.ratio], 0.382))),
            radius,
            inner: size(values[P.radiusInner], P.radiusInner, r) ?? radius,
            smoothing: unitOf(values[P.smoothing] ?? 0),
          };
        }
        case 'ellipse':
          return { kind: 'ellipse' };
        case 'line':
          return { kind: 'line' };
      }
    }
  }
}

/** Resolve a composed node (see the module header). */
export function resolveComposed(composed: ComposedNode, kit?: BrandKitView): ResolvedElement {
  const values = composed.values;
  const r: Reader = { issues: [], kit };
  const box = readBox(values);
  const maskMode = values[P.maskMode];
  const maskAsset = values[P.maskAsset];
  const matchKey = values[P.matchKey];
  const name = values['name'];
  const role = values['role'];
  return {
    id: composed.id,
    kind: composed.kind,
    parent: composed.parent,
    ...(typeof name === 'string' ? { name } : {}),
    ...(typeof role === 'string' ? { role } : {}),
    box,
    transform: boxTransform(box),
    opacity: Math.max(0, Math.min(1, num(values[P.opacity], 1))),
    blend: str(values[P.blend], BLENDS, 'normal'),
    geometry: geometryOf(composed.kind, values, r, box),
    fills: fillsOf(values[P.fills], r),
    strokes: strokesOf(values[P.strokes], r),
    effects: effectsOf(values[P.effects], r),
    ...(typeof maskMode === 'string' && ['clip', 'alpha', 'luminance'].includes(maskMode)
      ? {
          mask: {
            mode: maskMode as MaskModeName,
            invert: values[P.maskInvert] === true,
            ...(typeof maskAsset === 'object' && maskAsset !== null && !Array.isArray(maskAsset) && typeof (maskAsset as Record<string, JsonValue>)['asset'] === 'string'
              ? { asset: (maskAsset as Record<string, JsonValue>)['asset'] as string }
              : {}),
          },
        }
      : {}),
    ...(typeof matchKey === 'string' ? { matchKey } : {}),
    ...(values[P.hidden] === true ? { hidden: true as const } : {}),
    issues: r.issues,
  };
}

/** Resolve a stage node (undefined when it does not exist). */
export function resolveElement(stage: Pick<Stage, 'read'>, node: NodeId, kit?: BrandKitView): ResolvedElement | undefined {
  const composed = stage.read(node);
  return composed === undefined ? undefined : resolveComposed(composed, kit);
}
