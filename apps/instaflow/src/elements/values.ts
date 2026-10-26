/**
 * Element value shapes and their validation (IF-20.2–20.4): appearance stacks, paints, effects, sizes that may be
 * brand tokens, layout grids and colours. They live in `json` fields (a token is neither a number nor a CSS colour),
 * so `validateElementOps` checks them on top of the component registry's own validation.
 *
 * - **Colour:** `#rgb[a]`, `#rrggbb[aa]`, `rgb()` / `rgba()`, or a token `@name`.
 * - **Paint:** colour | `{ kind: 'linear', from, to, stops }` | `{ kind: 'radial', center, radius, stops }` |
 *   `{ kind: 'conic', center, angle?, stops }` (points in the unit box: 0…1 of w and h; a radial radius is a fraction
 *   of max(w, h); `angle` in degrees, clockwise from 3 o'clock) | `{ kind: 'image', asset: { asset }, fit? }`
 *   (`fit` cover | contain | stretch | tile). Stops are `{ offset: 0…1, color }`.
 * - **Fill** (`style.fills`, bottom first): `{ paint, opacity?, blend?, visible?, id? }`.
 * - **Stroke** (`style.strokes`, bottom first): `{ paint, width, sides?: [top, right, bottom, left], align?: center |
 *   inside | outside, dash?: number[], dashOffset?, cap?: butt | round | square, join?: miter | round | bevel,
 *   miter?, opacity?, blend?, visible?, id? }`. Per-side widths apply to rectangles, frames and images.
 * - **Effect** (`style.effects`, in order): `{ kind: 'drop-shadow' | 'inner-shadow', x, y, blur, spread?, color }` |
 *   `{ kind: 'outer-glow' | 'inner-glow', blur, spread?, color }` | `{ kind: 'layer-blur' | 'background-blur', radius }`,
 *   each with `visible?` and `id?`; an item, or the whole list, may be a `@preset` token (a named shadow style).
 *   Local px; blur = 2σ, like CSS. At most 16.
 * - **Size:** a number ≥ 0 or a token `@name` (stroke widths, corner radii).
 * - **Layout grid:** `{ kind: 'columns' | 'rows', count ≥ 1, gutter ≥ 0, margin ≥ 0, align: 'stretch' | 'start' |
 *   'center' | 'end', size? (track size unless stretch), visible?, color? }` | `{ kind: 'grid', size > 0, visible?,
 *   color? }` (square baseline grid). Several per frame or page.
 *
 * Item `id`s are stable handles for later animation channels and per-item edits; every value is plain data.
 */
import { err, ok, type Result } from '@staticflux/core';
import type { JsonValue, PartOp } from '@staticflux/document/v2';
import { parseColor } from '@staticflux/ui/theme';
import { BLEND_MODE_NAMES, type BlendModeName, CORNER_PATHS, IMAGE_FIT_NAMES, type ImageFitName, P, STROKE_ALIGNS, STROKE_CAPS, STROKE_JOINS, type StrokeAlign } from './components.js';
import { InvalidElementValueError } from './errors.js';

export type Rgba8 = readonly [number, number, number, number];
export type TokenRef = `@${string}`;
export type ColorValue = string;
export type Vec2 = readonly [number, number];
export interface GradientStopValue {
  readonly offset: number;
  readonly color: ColorValue;
}
export type PaintValue =
  | ColorValue
  | { readonly kind: 'linear'; readonly from: Vec2; readonly to: Vec2; readonly stops: readonly GradientStopValue[] }
  | { readonly kind: 'radial'; readonly center: Vec2; readonly radius: number; readonly stops: readonly GradientStopValue[] }
  | { readonly kind: 'conic'; readonly center: Vec2; readonly angle?: number; readonly stops: readonly GradientStopValue[] }
  | { readonly kind: 'image'; readonly asset: { readonly asset: string; readonly at?: string }; readonly fit?: ImageFitName };
export type SizeValue = number | TokenRef;

interface ItemBase {
  readonly visible?: boolean;
  readonly id?: string;
}
export interface FillValue extends ItemBase {
  readonly paint: PaintValue;
  readonly opacity?: number;
  readonly blend?: BlendModeName;
}
export interface StrokeValue extends ItemBase {
  readonly paint: PaintValue;
  readonly width: SizeValue;
  readonly sides?: readonly [SizeValue, SizeValue, SizeValue, SizeValue];
  readonly align?: StrokeAlign;
  readonly dash?: readonly number[];
  readonly dashOffset?: number;
  readonly cap?: (typeof STROKE_CAPS)[number];
  readonly join?: (typeof STROKE_JOINS)[number];
  readonly miter?: number;
  readonly opacity?: number;
  readonly blend?: BlendModeName;
}
export type EffectValue =
  | (ItemBase & { readonly kind: 'drop-shadow' | 'inner-shadow'; readonly x: number; readonly y: number; readonly blur: number; readonly spread?: number; readonly color: ColorValue })
  | (ItemBase & { readonly kind: 'outer-glow' | 'inner-glow'; readonly blur: number; readonly spread?: number; readonly color: ColorValue })
  | (ItemBase & { readonly kind: 'layer-blur' | 'background-blur'; readonly radius: number });
export type LayoutGridValue =
  | {
      readonly kind: 'columns' | 'rows';
      readonly count: number;
      readonly gutter: number;
      readonly margin: number;
      readonly align: 'stretch' | 'start' | 'center' | 'end';
      readonly size?: number;
      readonly visible?: boolean;
      readonly color?: ColorValue;
    }
  | { readonly kind: 'grid'; readonly size: number; readonly visible?: boolean; readonly color?: ColorValue };

export const MAX_STACK = 16;
export const MAX_GRADIENT_STOPS = 32;
const TOKEN = /^@[A-Za-z][\w.-]*$/;

/** `@name` → `name`; anything else → undefined. */
export function tokenName(value: unknown): string | undefined {
  return typeof value === 'string' && TOKEN.test(value) ? value.slice(1) : undefined;
}

export function isTokenRef(value: unknown): value is TokenRef {
  return tokenName(value) !== undefined;
}

/** A CSS colour (hex or rgb[a]) as straight 8-bit RGBA, or undefined. */
export function colorToRgba(value: string): Rgba8 | undefined {
  const parsed = parseColor(value);
  if (!parsed.ok) return undefined;
  const { r, g, b, a } = parsed.value;
  return [Math.round(r), Math.round(g), Math.round(b), Math.round(a * 255)];
}

/** `#rrggbb[aa]` for 8-bit RGBA. */
export function rgbaToHex(c: Rgba8): string {
  const h = (n: number): string => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
  return `#${h(c[0])}${h(c[1])}${h(c[2])}${c[3] === 255 ? '' : h(c[3])}`;
}

const isObject = (v: unknown): v is Readonly<Record<string, unknown>> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec2 = (v: unknown): v is Vec2 => Array.isArray(v) && v.length === 2 && v.every(finite);
const unit = (v: unknown): boolean => v === undefined || (finite(v) && v >= 0 && v <= 1);
const oneOf = (values: readonly string[], v: unknown): boolean => v === undefined || values.includes(v as string);
const itemBase = (v: Readonly<Record<string, unknown>>): boolean =>
  (v['visible'] === undefined || typeof v['visible'] === 'boolean') && (v['id'] === undefined || typeof v['id'] === 'string');

export function isColorValue(v: unknown): v is ColorValue {
  return typeof v === 'string' && (isTokenRef(v) || colorToRgba(v) !== undefined);
}

function isStops(v: unknown): v is readonly GradientStopValue[] {
  return (
    Array.isArray(v) &&
    v.length >= 1 &&
    v.length <= MAX_GRADIENT_STOPS &&
    v.every((s) => isObject(s) && finite(s['offset']) && (s['offset'] as number) >= 0 && (s['offset'] as number) <= 1 && isColorValue(s['color']))
  );
}

export function isPaintValue(v: unknown): v is PaintValue {
  if (typeof v === 'string') return isColorValue(v);
  if (!isObject(v)) return false;
  switch (v['kind']) {
    case 'linear':
      return isVec2(v['from']) && isVec2(v['to']) && isStops(v['stops']);
    case 'radial':
      return isVec2(v['center']) && finite(v['radius']) && (v['radius'] as number) > 0 && isStops(v['stops']);
    case 'conic':
      return isVec2(v['center']) && (v['angle'] === undefined || finite(v['angle'])) && isStops(v['stops']);
    case 'image':
      return isObject(v['asset']) && typeof v['asset']['asset'] === 'string' && oneOf(IMAGE_FIT_NAMES, v['fit']);
    default:
      return false;
  }
}

export function isSizeValue(v: unknown): v is SizeValue {
  return (finite(v) && v >= 0) || isTokenRef(v);
}

export function isFillValue(v: unknown): v is FillValue {
  return isObject(v) && itemBase(v) && isPaintValue(v['paint']) && unit(v['opacity']) && oneOf(BLEND_MODE_NAMES, v['blend']);
}

export function isStrokeValue(v: unknown): v is StrokeValue {
  if (!isObject(v) || !itemBase(v) || !isPaintValue(v['paint']) || !isSizeValue(v['width'])) return false;
  const sides = v['sides'];
  const dash = v['dash'];
  return (
    (sides === undefined || (Array.isArray(sides) && sides.length === 4 && sides.every(isSizeValue))) &&
    (dash === undefined || (Array.isArray(dash) && dash.length <= 16 && dash.every((d) => finite(d) && d >= 0))) &&
    (v['dashOffset'] === undefined || finite(v['dashOffset'])) &&
    (v['miter'] === undefined || (finite(v['miter']) && v['miter'] >= 1)) &&
    oneOf(STROKE_ALIGNS, v['align']) &&
    oneOf(STROKE_CAPS, v['cap']) &&
    oneOf(STROKE_JOINS, v['join']) &&
    unit(v['opacity']) &&
    oneOf(BLEND_MODE_NAMES, v['blend'])
  );
}

export function isEffectValue(v: unknown): v is EffectValue {
  if (isTokenRef(v)) return true;
  if (!isObject(v) || !itemBase(v)) return false;
  switch (v['kind']) {
    case 'layer-blur':
    case 'background-blur':
      return finite(v['radius']) && v['radius'] >= 0;
    case 'drop-shadow':
    case 'inner-shadow':
      if (!finite(v['x']) || !finite(v['y'])) return false;
      return finite(v['blur']) && v['blur'] >= 0 && (v['spread'] === undefined || finite(v['spread'])) && isColorValue(v['color']);
    case 'outer-glow':
    case 'inner-glow':
      return finite(v['blur']) && v['blur'] >= 0 && (v['spread'] === undefined || finite(v['spread'])) && isColorValue(v['color']);
    default:
      return false;
  }
}

export function isLayoutGridValue(v: unknown): v is LayoutGridValue {
  if (!isObject(v)) return false;
  if (v['visible'] !== undefined && typeof v['visible'] !== 'boolean') return false;
  if (v['color'] !== undefined && !isColorValue(v['color'])) return false;
  if (v['kind'] === 'grid') return finite(v['size']) && v['size'] > 0;
  if (v['kind'] !== 'columns' && v['kind'] !== 'rows') return false;
  const count = v['count'];
  return (
    finite(count) &&
    Number.isInteger(count) &&
    count >= 1 &&
    count <= 1000 &&
    finite(v['gutter']) &&
    v['gutter'] >= 0 &&
    finite(v['margin']) &&
    v['margin'] >= 0 &&
    ['stretch', 'start', 'center', 'end'].includes(v['align'] as string) &&
    (v['size'] === undefined || (finite(v['size']) && v['size'] > 0))
  );
}

/** A brand-class reference `{ kit?, class }` (stage rule `style.inherit`). */
export function isClassRef(v: unknown): boolean {
  return isObject(v) && typeof v['class'] === 'string' && v['class'].length > 0 && (v['kit'] === undefined || (isObject(v['kit']) && typeof v['kit']['asset'] === 'string'));
}

const list = (item: (v: unknown) => boolean) => (v: unknown): boolean => Array.isArray(v) && v.length <= MAX_STACK && v.every(item);

/** Validators for the `json` element paths (null always removes an opinion). */
const CHECKS: Readonly<Record<string, { readonly ok: (v: unknown) => boolean; readonly expects: string }>> = {
  [P.fills]: { ok: list(isFillValue), expects: `a list of at most ${MAX_STACK} fills { paint, opacity?, blend?, visible? }` },
  [P.strokes]: { ok: list(isStrokeValue), expects: `a list of at most ${MAX_STACK} strokes { paint, width, align?, … }` },
  [P.effects]: { ok: (v) => isTokenRef(v) || list(isEffectValue)(v), expects: `a list of at most ${MAX_STACK} effects, or a @preset token` },
  [P.radius]: { ok: isSizeValue, expects: 'a size (number ≥ 0 or @token)' },
  ...Object.fromEntries(CORNER_PATHS.map((path) => [path, { ok: isSizeValue, expects: 'a size (number ≥ 0 or @token)' }])),
  [P.smoothing]: { ok: (v) => finite(v) && v >= 0 && v <= 1, expects: 'a number in [0, 1]' },
  [P.radiusInner]: { ok: isSizeValue, expects: 'a size (number ≥ 0 or @token)' },
  [P.vertexRadii]: { ok: (v) => Array.isArray(v) && v.length <= 10_000 && v.every((r) => r === null || isSizeValue(r)), expects: 'a list of vertex radii (sizes or null)' },
  [P.grids]: { ok: (v) => Array.isArray(v) && v.length <= 32 && v.every(isLayoutGridValue), expects: 'a list of layout grids' },
  [P.inherit]: { ok: isClassRef, expects: 'a class reference { kit?, class }' },
  [P.final]: { ok: (v) => Array.isArray(v) && v.every((p) => typeof p === 'string'), expects: 'a list of path patterns' },
  [P.lockPolicy]: { ok: (v) => isObject(v) && typeof v['reason'] === 'string', expects: 'a policy lock { by, reason }' },
  [P.sides]: { ok: (v) => finite(v) && Number.isInteger(v) && v >= 3 && v <= 1000, expects: 'an integer 3…1000' },
  [P.ratio]: { ok: (v) => finite(v) && v > 0 && v <= 1, expects: 'a ratio in (0, 1]' },
  [P.opacity]: { ok: (v) => finite(v) && v >= 0 && v <= 1, expects: 'a number in [0, 1]' },
  [P.w]: { ok: (v) => finite(v) && v >= 0, expects: 'a number ≥ 0' },
  [P.h]: { ok: (v) => finite(v) && v >= 0, expects: 'a number ≥ 0' },
};

/** Check one element write beyond its field type (`null` removes the opinion and is always valid). */
export function checkElementValue(path: string, value: JsonValue | null): Result<void> {
  if (value === null) return ok();
  const check = CHECKS[path];
  if (check === undefined || check.ok(value)) return ok();
  return err(InvalidElementValueError({ message: `"${path}" expects ${check.expects}.`, details: { path, expects: check.expects } }));
}

/** Check the element value shapes in a batch of part ops (the component registry checks field types). */
export function validateElementOps(ops: readonly PartOp[]): Result<void> {
  for (const op of ops) {
    if (op.op === 'set') {
      const r = checkElementValue(op.path, op.value);
      if (!r.ok) return r;
    } else if (op.op === 'create') {
      for (const [path, value] of Object.entries(op.props ?? {})) {
        const r = checkElementValue(path, value);
        if (!r.ok) return r;
      }
    }
  }
  return ok();
}

/** The page's fills when it has none written (B12 A-1, APPEARANCE §2.8: one white row). */
export const PAGE_FILL_DEFAULT: readonly JsonValue[] = Object.freeze([Object.freeze({ paint: '#ffffff' })]);

/** Raw page fills as written (tokens kept), with the default when the page has none (the Page section's model). */
export function pageFills(stage: { value(node: string, path: string): JsonValue | undefined }, page: string): readonly JsonValue[] {
  const raw = stage.value(page, P.fills);
  return Array.isArray(raw) ? raw : PAGE_FILL_DEFAULT;
}
