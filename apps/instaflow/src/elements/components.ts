/**
 * Element components (M1 B1; IF-4.1, IF-4.14, IF-20.1–20.4): typed, versioned `@staticflux/document/v2` components
 * for frames, groups, shapes (rect, ellipse, polygon, star, line), images and vector paths, with transforms, fill,
 * stroke, per-corner radii, effects, masks, locks, layout grids, brand kits and the match key.
 *
 * Paths follow DOCUMENT-FORMAT §3.2 and the S8 agent-view vocabulary (`spatial.x`, `style.radius`, `frame.clip`,
 * `source.asset`, `image.fit`); the view's `fill` / `stroke` attributes are the top items of `style.fills` /
 * `style.strokes`. Values that can hold a brand token (`@name`) are `json` fields whose
 * shapes are checked by `validateElementOps` (values.ts), because a token is not a number or a CSS colour.
 *
 * - **Kinds:** `frame` (sized container, clips its content), `group` (free container; with `geometry.boolean` a
 *   live boolean of its children), `shape` (`geometry.shape`: rect | ellipse | polygon | star | line), `vector`
 *   (`geometry.path`, SVG path data in the local box), `image` (`source.asset` = a blob asset, `image.fit`).
 * - **Masks:** any element or group with `mask.mode` masks the siblings after it in its parent (Figma-style).
 *   Releasing a mask removes `mask.mode`; the masked content was never changed. `mask.asset` (optional) names a
 *   matte image asset (S9) whose alpha is the mask, stretched over the mask element's box.
 * - **Match key** (`lineage.key`): a stable lineage for Smart Move / Auto Animate (M4). A new element gets a fresh
 *   key; duplicating an element, a subtree or a page copies it, so copies match across pages. It is never the node
 *   id (ids stay unique). It is part of the persisted format (canonical parts, `.iflow`), so it survives export and
 *   import. Generators (repeat patterns) give each instance the source's key plus an instance suffix.
 * - **Brand kit:** a `brand-kit` tree asset whose root (`kit`) carries `brand.tokens.<name>` and `brand.rules`; its
 *   children are style classes (`style.*`, `policy.final`) that elements inherit through `style.inherit`.
 *
 * `style` is version 2: version 1 was DOCUMENT-FORMAT §3.2's draft (one `fill` and one `stroke` as `{ color } |
 * { gradient } | { image, fit }` objects, the stroke width and alignment inside the stroke). Version 2 has appearance
 * **stacks** (`fills`, `strokes`, `effects`: ordered, toggleable lists; one LWW register each) and one register per
 * corner radius, so concurrent edits to different concerns merge.
 */
import { type ComponentDefinitionV2, type ComponentMigration, type ComponentRegistry, createComponentRegistry, defineComponent, field, type JsonValue } from '@staticflux/document/v2';

export const BLEND_MODE_NAMES = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
] as const;
export type BlendModeName = (typeof BLEND_MODE_NAMES)[number];

export const SHAPES = ['rect', 'ellipse', 'polygon', 'star', 'line'] as const;
export type ShapeName = (typeof SHAPES)[number];
export const BOOLEAN_OPS = ['union', 'subtract', 'intersect', 'exclude'] as const;
export type BooleanOpName = (typeof BOOLEAN_OPS)[number];
export const FILL_RULES = ['nonzero', 'evenodd'] as const;
export const STROKE_ALIGNS = ['center', 'inside', 'outside'] as const;
export const EFFECT_KINDS = ['drop-shadow', 'inner-shadow', 'outer-glow', 'inner-glow', 'layer-blur', 'background-blur'] as const;
export type EffectKind = (typeof EFFECT_KINDS)[number];
export type StrokeAlign = (typeof STROKE_ALIGNS)[number];
export const STROKE_JOINS = ['miter', 'round', 'bevel'] as const;
export const STROKE_CAPS = ['butt', 'round', 'square'] as const;
export const IMAGE_FIT_NAMES = ['cover', 'contain', 'stretch', 'tile'] as const;
export type ImageFitName = (typeof IMAGE_FIT_NAMES)[number];
export const MASK_MODE_NAMES = ['clip', 'alpha', 'luminance'] as const;
export type MaskModeName = (typeof MASK_MODE_NAMES)[number];
export const LOCK_SCOPE_NAMES = ['position', 'content', 'all'] as const;

/** Semantic roles (IF-4.1; closed, extensible): the S8 vocabulary plus DOCUMENT-FORMAT's list. */
export const ELEMENT_ROLES = [
  'headline',
  'subhead',
  'body',
  'cta',
  'logo',
  'hero',
  'price',
  'legal',
  'caption',
  'background',
  'badge',
  'date',
  'bullet',
  'title',
  'photo',
  'chart',
  'notes',
  'reaction',
  'decoration',
] as const;

// ---------------------------------------------------------------- components

export const Spatial = defineComponent(
  'spatial',
  {
    x: 'f64',
    y: 'f64',
    w: 'f64',
    h: 'f64',
    rotation: 'f64',
    scaleX: 'f64',
    scaleY: 'f64',
    anchorX: 'f64',
    anchorY: 'f64',
    opacity: 'f64',
    blend: field.enum(BLEND_MODE_NAMES),
    flipX: 'bool',
    flipY: 'bool',
  },
  {
    defaults: { x: 0, y: 0, w: 0, h: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5, opacity: 1, blend: 'normal', flipX: false, flipY: false },
    description: 'Box in the parent’s space: x, y = top-left of the unrotated box; rotation (degrees, clockwise) and flips about the anchor (fractions of w, h).',
  },
);

export const Geometry = defineComponent(
  'geometry',
  {
    shape: field.enum(SHAPES),
    sides: 'i32',
    ratio: 'f64',
    path: 'string',
    vertexRadii: 'json',
    fillRule: field.enum(FILL_RULES),
    boolean: field.enum(BOOLEAN_OPS),
  },
  {
    defaults: { shape: 'rect', ratio: 0.382, fillRule: 'nonzero' },
    description:
      'Outline: `shape` for shape nodes (polygon sides default 3, star points 5, star inner `ratio`), `path` (SVG path data in the local w × h box) for vectors with optional per-vertex corner radii `vertexRadii` (numbers or @tokens, vertices in path order), `boolean` on a group = a live boolean of its children (derived, non-destructive).',
  },
);

/** `style` v1 (DOCUMENT-FORMAT §3.2 draft: one `fill`, one `stroke` with its width and alignment) → v2 (stacks). */
const styleV2: ComponentMigration = (v) => {
  const out: Record<string, JsonValue> = {};
  for (const [k, value] of Object.entries(v)) if (k !== 'fill' && k !== 'stroke' && k !== 'effects') out[k] = value;
  const paint = (p: JsonValue | undefined): JsonValue | undefined => {
    if (typeof p !== 'object' || p === null || Array.isArray(p)) return undefined;
    const o = p as Record<string, JsonValue>;
    if (o['color'] !== undefined) {
      const c = o['color'];
      if (typeof c === 'string') return c;
      if (typeof c === 'object' && c !== null && !Array.isArray(c) && typeof (c as Record<string, JsonValue>)['token'] === 'string') {
        const token = (c as Record<string, JsonValue>)['token'] as string;
        return `@${token.split('.').pop() ?? token}`;
      }
      return undefined;
    }
    const g = o['gradient'];
    if (typeof g === 'object' && g !== null && !Array.isArray(g)) return { kind: 'linear', ...(g as Record<string, JsonValue>) };
    if (o['image'] !== undefined) return { kind: 'image', asset: o['image'] as JsonValue, fit: (o['fit'] as JsonValue | undefined) ?? 'cover' };
    return undefined;
  };
  const fill = paint(v['fill']);
  if (fill !== undefined) out['fills'] = [{ paint: fill }];
  const stroke = v['stroke'];
  const strokePaint = paint(stroke);
  if (strokePaint !== undefined && typeof stroke === 'object' && stroke !== null && !Array.isArray(stroke)) {
    const s = stroke as Record<string, JsonValue>;
    out['strokes'] = [{ paint: strokePaint, width: typeof s['width'] === 'number' ? s['width'] : 1, align: typeof s['align'] === 'string' ? s['align'] : 'center' }];
  }
  if (Array.isArray(v['effects'])) out['effects'] = v['effects'];
  return out;
};

export const Style = defineComponent(
  'style',
  {
    fills: 'json',
    strokes: 'json',
    radius: 'json',
    radiusTL: 'json',
    radiusTR: 'json',
    radiusBR: 'json',
    radiusBL: 'json',
    radiusInner: 'json',
    smoothing: 'f64',
    effects: 'json',
    inherit: 'json',
  },
  {
    version: 2,
    migrations: { 2: styleV2 },
    defaults: { smoothing: 0 },
    description:
      'Appearance stacks (bottom first, each item toggleable with `visible`, reorderable, with an `id` for animation): `fills` (solid, linear / radial / conic gradient, image; own opacity and blend), `strokes` (paint, width or per-side widths, inside / center / outside, dashes, caps, joins; own opacity and blend), `effects` (drop / inner shadow, outer / inner glow, layer / background blur; or a `@preset` token). `radius` (linked: every corner or vertex) with unlinked per-corner `radiusTL/TR/BR/BL` (rects, frames, images), `radiusInner` (the inner vertices of a star), `geometry.vertexRadii` (vectors), and `smoothing` 0…1 (smooth, squircle-like corners); radii are clamped to half the shortest side. Colours, sizes and presets may be `@tokens`. `inherit` = the brand class `{ kit, class }`.',
  },
);

export const Frame = defineComponent('frame', { clip: 'bool' }, { defaults: { clip: true }, description: 'A frame clips its content to its (rounded) box unless `clip` is false.' });

export const ImageFit = defineComponent('image', { fit: field.enum(IMAGE_FIT_NAMES) }, { defaults: { fit: 'cover' }, description: 'How an image element maps its asset onto its box.' });

export const Source = defineComponent(
  'source',
  { asset: field.ref('asset'), in: 'ticks', out: 'ticks', speed: 'f64', reverse: 'bool', loop: 'bool', freezeAt: 'ticks', crop: 'json' },
  { defaults: { speed: 1, reverse: false, loop: false }, description: 'The referenced media asset (DOCUMENT-FORMAT §3.2 `Source`); still images use `asset` only.' },
);

export const Mask = defineComponent(
  'mask',
  { mode: field.enum(MASK_MODE_NAMES), invert: 'bool', asset: field.ref('asset') },
  {
    defaults: { invert: false },
    description:
      'With `mode`, this element masks the siblings after it in its parent: `clip` uses its geometry, `alpha` its rendered alpha, `luminance` its brightness; `invert` flips it. `asset` (optional) is a matte image whose alpha is the mask.',
  },
);

export const Lineage = defineComponent('lineage', { key: 'string' }, { description: 'Match key: stable across duplicates of an element or page (Smart Move, M4); never the node id.' });

export const Lock = defineComponent(
  'lock',
  { scope: field.enum(LOCK_SCOPE_NAMES), policy: 'json' },
  { description: 'UX lock (`scope`, removable by anyone with edit rights) or policy lock (`policy: { by, reason }`, humans only, with confirmation).' },
);

export const Policy = defineComponent('policy', { final: 'json' }, { description: 'On brand classes and kits: path patterns kept regardless of local opinions (final).' });

export const Layout = defineComponent('layout', { grids: 'json' }, { description: 'Layout grids of a frame or page (columns, rows, square baseline): non-printing guides that tools snap to.' });

export const Brand = defineComponent(
  'brand',
  { tokens: field.map('json'), rules: 'json' },
  { description: 'On a brand kit root: tokens (`brand.tokens.<name>` = colour, number or font) and brand rules enforced on writes.' },
);

export const ELEMENT_COMPONENTS: readonly ComponentDefinitionV2[] = [Spatial, Geometry, Style, Frame, ImageFit, Source, Mask, Lineage, Lock, Policy, Layout, Brand];

/** Element node kinds (B1). Text (`text`) is B2's, pages and compositions are the document's. */
export const ELEMENT_KINDS = ['frame', 'group', 'shape', 'vector', 'image'] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];
/** Container kinds that hold elements (DOCUMENT-FORMAT §3.1, plus frames). */
export const CONTAINER_KINDS = ['page', 'frame', 'group'] as const;
/** Brand kit node kinds: the root `composition` (`kit`) and its style `class` children. */
export const BRAND_KIT_ROOT = 'kit';
export const CLASS_KIND = 'class';

/** Components every element kind carries (other WPs add theirs, e.g. B2's `text` kind spreads these). */
export const ELEMENT_COMMON_COMPONENTS = ['spatial', 'style', 'mask', 'lineage', 'lock'] as const;

export const ELEMENT_KIND_COMPONENTS: Readonly<Record<string, readonly string[]>> = {
  frame: [...ELEMENT_COMMON_COMPONENTS, 'frame', 'layout'],
  group: [...ELEMENT_COMMON_COMPONENTS, 'geometry'],
  shape: [...ELEMENT_COMMON_COMPONENTS, 'geometry'],
  vector: [...ELEMENT_COMMON_COMPONENTS, 'geometry'],
  image: [...ELEMENT_COMMON_COMPONENTS, 'source', 'image'],
  [CLASS_KIND]: ['style', 'geometry', 'frame', 'image', 'policy'],
};

/** Registry version for the element components (bump with every component version change). */
export const ELEMENT_TREE_SCHEMA = 1;

export interface ElementRegistryOptions {
  /** Registry version (default `ELEMENT_TREE_SCHEMA`). */
  readonly version?: number;
  /** Components of other work packages (text, pages, motion…). */
  readonly components?: readonly ComponentDefinitionV2[];
  /** Kind tables of other work packages; merged over the element kinds. */
  readonly kinds?: Readonly<Record<string, readonly string[]>>;
  readonly roles?: readonly string[];
}

/** A component registry with the element components (plus others' components and kinds). */
export function createElementRegistry(options: ElementRegistryOptions = {}): ComponentRegistry {
  return createComponentRegistry({
    version: options.version ?? ELEMENT_TREE_SCHEMA,
    components: [...ELEMENT_COMPONENTS, ...(options.components ?? [])],
    kinds: { ...ELEMENT_KIND_COMPONENTS, ...options.kinds },
    roles: options.roles ?? ELEMENT_ROLES,
  });
}

// ---------------------------------------------------------------- paths (typed values, rule 1)

export const P = {
  x: 'spatial.x',
  y: 'spatial.y',
  w: 'spatial.w',
  h: 'spatial.h',
  rotation: 'spatial.rotation',
  scaleX: 'spatial.scaleX',
  scaleY: 'spatial.scaleY',
  anchorX: 'spatial.anchorX',
  anchorY: 'spatial.anchorY',
  opacity: 'spatial.opacity',
  blend: 'spatial.blend',
  flipX: 'spatial.flipX',
  flipY: 'spatial.flipY',
  shape: 'geometry.shape',
  sides: 'geometry.sides',
  ratio: 'geometry.ratio',
  path: 'geometry.path',
  fillRule: 'geometry.fillRule',
  boolean: 'geometry.boolean',
  fills: 'style.fills',
  strokes: 'style.strokes',
  radius: 'style.radius',
  smoothing: 'style.smoothing',
  radiusTL: 'style.radiusTL',
  radiusTR: 'style.radiusTR',
  radiusBR: 'style.radiusBR',
  radiusBL: 'style.radiusBL',
  radiusInner: 'style.radiusInner',
  vertexRadii: 'geometry.vertexRadii',
  effects: 'style.effects',
  inherit: 'style.inherit',
  clip: 'frame.clip',
  fit: 'image.fit',
  asset: 'source.asset',
  maskMode: 'mask.mode',
  maskInvert: 'mask.invert',
  maskAsset: 'mask.asset',
  matchKey: 'lineage.key',
  lockScope: 'lock.scope',
  lockPolicy: 'lock.policy',
  final: 'policy.final',
  grids: 'layout.grids',
  tokens: 'brand.tokens',
  rules: 'brand.rules',
} as const;

/** The path of one brand token on the kit root. */
export function tokenPath(name: string): string {
  return `${P.tokens}.${name}`;
}

/** Corner paths in `[top-left, top-right, bottom-right, bottom-left]` order. */
export const CORNER_PATHS = [P.radiusTL, P.radiusTR, P.radiusBR, P.radiusBL] as const;

/** Spatial defaults as a lookup (composed values omit defaults). */
export function spatialDefault(path: string): JsonValue | undefined {
  const [component, name] = path.split('.');
  const defaults = ELEMENT_COMPONENTS.find((c) => c.id === component)?.defaults;
  return name === undefined ? undefined : defaults?.[name];
}
