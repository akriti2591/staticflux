/**
 * The inspector's rules as data (B11b, STUDIO-UX-SPEC §5, APPEARANCE-TRANSFORM-UX-SPEC §2): which sections a selection
 * kind shows and in what order (§5.1: sections not listed are not rendered; `collapsed` ones start ▸), the one-line
 * summaries of stack rows and collapsed sections, gradient edits (type switch, angle, reverse, stops), the effect
 * preset menu, blend mode groups and page size presets. Lit-free and pure, so the inspector element only renders.
 */
import type { JsonValue } from '@staticflux/document/v2';
import type { SelectionKind } from '../app/scene-summary.js';
import { type BlendModeName, BLEND_MODE_NAMES } from '../elements/components.js';
import type { AppearanceModel } from '../elements/inspector.js';
import type { EffectValue, GradientStopValue, PaintValue, Vec2 } from '../elements/values.js';
import { designFormats } from '../home/formats.js';

export const INSPECTOR_SECTION_IDS = ['page', 'document', 'transform', 'text', 'image', 'frame', 'repeat', 'combine', 'mask', 'fill', 'stroke', 'corners', 'effects', 'layer', 'locked'] as const;
export type InspectorSectionId = (typeof INSPECTOR_SECTION_IDS)[number];

export interface InspectorSection {
  readonly id: InspectorSectionId;
  /** ▸ collapsed by default (its summary line shows the non-default state). */
  readonly collapsed?: boolean;
}

const open = (id: InspectorSectionId): InspectorSection => ({ id });
const folded = (id: InspectorSectionId): InspectorSection => ({ id, collapsed: true });

/**
 * Sections per selection kind, in order (§5.1). Text colour lives in the Text section (a character mark), so text has
 * no Fill stack in M1; text strokes are M2 (T-18) and not rendered. Layout grids are M1 data without a drawn overlay
 * in Studio yet, so the section is not rendered (B11c).
 */
export const INSPECTOR_SECTIONS: Readonly<Record<SelectionKind, readonly InspectorSection[]>> = Object.freeze({
  none: [open('page'), open('document')],
  shape: [open('transform'), open('fill'), open('stroke'), folded('corners'), folded('effects'), folded('layer')],
  text: [open('transform'), open('text'), folded('effects'), folded('layer')],
  image: [open('transform'), open('image'), folded('effects'), folded('layer')],
  frame: [open('transform'), open('frame'), open('fill'), folded('stroke'), folded('corners'), folded('effects'), folded('layer')],
  group: [open('transform'), folded('layer')],
  multi: [open('transform'), open('fill'), open('stroke'), folded('effects'), folded('layer')],
  mixed: [open('transform'), folded('effects'), folded('layer')],
  locked: [open('locked')],
  repeat: [open('transform'), open('repeat'), open('fill'), open('stroke'), folded('effects'), folded('layer')],
  boolean: [open('transform'), open('combine'), open('fill'), open('stroke'), folded('effects'), folded('layer')],
  mask: [open('transform'), open('mask'), folded('layer')],
});

/** The sections for a kind (corners only where the selection has corners: rectangles, frames, images). */
export function inspectorSections(kind: SelectionKind, common: string | undefined): readonly InspectorSection[] {
  const list = INSPECTOR_SECTIONS[kind];
  const corners = common === 'rectangle' || common === 'frame' || common === 'image';
  return list.filter((s) => s.id !== 'corners' || corners);
}

// ---------------------------------------------------------------- paints

export type PaintKind = 'solid' | 'linear' | 'radial' | 'conic' | 'image';
export const GRADIENT_KINDS = ['linear', 'radial', 'conic'] as const;
export type GradientKind = (typeof GRADIENT_KINDS)[number];
export const GRADIENT_LABELS: Readonly<Record<GradientKind, string>> = Object.freeze({ linear: 'Linear', radial: 'Radial', conic: 'Conic' });
export const FIT_LABELS = Object.freeze({ cover: 'Fill', contain: 'Fit', stretch: 'Stretch', tile: 'Tile' } as const);

type GradientPaint = Extract<PaintValue, { readonly stops: readonly GradientStopValue[] }>;

const isObject = (v: unknown): v is Readonly<Record<string, JsonValue>> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A paint's kind (a string is a solid colour or a `@token`). */
export function paintKind(paint: JsonValue | PaintValue | undefined): PaintKind {
  if (typeof paint === 'string') return 'solid';
  if (isObject(paint)) {
    const kind = paint['kind'];
    if (kind === 'linear' || kind === 'radial' || kind === 'conic' || kind === 'image') return kind;
  }
  return 'solid';
}

export function isGradient(paint: JsonValue | PaintValue | undefined): paint is GradientPaint {
  const k = paintKind(paint);
  return k === 'linear' || k === 'radial' || k === 'conic';
}

const round = (n: number, places = 0): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

/** A linear gradient's angle in degrees (0° = left → right, clockwise; CSS and Figma agree), 0…359. */
export function gradientAngle(paint: GradientPaint): number {
  if (paint.kind === 'conic') return round((((paint.angle ?? 0) % 360) + 360) % 360);
  if (paint.kind !== 'linear') return 0;
  const [x0, y0] = paint.from;
  const [x1, y1] = paint.to;
  const deg = (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI;
  return round(((deg % 360) + 360) % 360);
}

/** `from` / `to` in the unit box for an angle, through the centre, spanning the box (corner to corner on diagonals). */
export function linearEnds(angle: number): { readonly from: Vec2; readonly to: Vec2 } {
  const rad = (angle * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  // Half-length so the line reaches the box edge on its widest axis (the CSS rule for a square box).
  const half = 0.5 * (Math.abs(dx) + Math.abs(dy));
  const p = (n: number): number => round(n, 4);
  return { from: [p(0.5 - dx * half), p(0.5 - dy * half)], to: [p(0.5 + dx * half), p(0.5 + dy * half)] };
}

/** The colour of a gradient at `offset` (linear interpolation in sRGB between the neighbouring stops). */
export function colorAt(stops: readonly GradientStopValue[], offset: number): string {
  const sorted = [...stops].sort((a, b) => a.offset - b.offset);
  const first = sorted[0];
  if (first === undefined) return '#000000';
  if (offset <= first.offset) return first.color;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1] as GradientStopValue;
    const b = sorted[i] as GradientStopValue;
    if (offset <= b.offset) {
      const t = b.offset === a.offset ? 0 : (offset - a.offset) / (b.offset - a.offset);
      const ca = hexChannels(a.color);
      const cb = hexChannels(b.color);
      if (ca === undefined || cb === undefined) return a.color;
      return channelsHex(ca.map((v, k) => v + ((cb[k] as number) - v) * t) as [number, number, number, number]);
    }
  }
  return (sorted.at(-1) as GradientStopValue).color;
}

function hexChannels(color: string): [number, number, number, number] | undefined {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color.trim());
  if (m === null) return undefined;
  const hex = m[1] as string;
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), m[2] === undefined ? 255 : parseInt(m[2], 16)];
}

function channelsHex(c: readonly [number, number, number, number]): string {
  const h = (v: number): string =>
    Math.round(Math.max(0, Math.min(255, v)))
      .toString(16)
      .padStart(2, '0')
      .toUpperCase();
  return `#${h(c[0])}${h(c[1])}${h(c[2])}${c[3] >= 255 ? '' : h(c[3])}`;
}

/** The first stop's colour, or the solid itself (what a swatch shows). */
export function leadColor(paint: JsonValue | PaintValue | undefined): string | undefined {
  if (typeof paint === 'string') return paint;
  if (isGradient(paint)) return [...paint.stops].sort((a, b) => a.offset - b.offset)[0]?.color;
  return undefined;
}

/** A solid as a two-stop gradient of `kind`: the colour to its transparent self (it should look like the shape). */
export function gradientFrom(color: string, kind: GradientKind = 'linear'): GradientPaint {
  const base = /^#[0-9a-f]{6}/i.test(color) ? color.slice(0, 7).toUpperCase() : '#16151A';
  const stops: GradientStopValue[] = [
    { offset: 0, color: base },
    { offset: 1, color: `${base}00` },
  ];
  return withKind({ kind: 'linear', ...linearEnds(0), stops }, kind);
}

/** The same stops as another gradient kind (linear ends ↔ radial centre / radius ↔ conic centre / angle). */
export function withKind(paint: GradientPaint, kind: GradientKind): GradientPaint {
  if (paint.kind === kind) return paint;
  const angle = gradientAngle(paint);
  const center: Vec2 =
    paint.kind === 'linear' ? [round((paint.from[0] + paint.to[0]) / 2, 4), round((paint.from[1] + paint.to[1]) / 2, 4)] : paint.center;
  const stops = paint.stops;
  if (kind === 'linear') return { kind, ...linearEnds(angle), stops };
  if (kind === 'radial') {
    const radius = paint.kind === 'linear' ? round(Math.hypot(paint.to[0] - paint.from[0], paint.to[1] - paint.from[1]) / 2, 4) : 0.5;
    return { kind, center, radius: radius > 0 ? radius : 0.5, stops };
  }
  return { kind, center, angle, stops };
}

/** A new angle (linear: ends recomputed through the centre; conic: the start angle). */
export function withAngle(paint: GradientPaint, angle: number): GradientPaint {
  const a = ((round(angle) % 360) + 360) % 360;
  if (paint.kind === 'linear') return { ...paint, ...linearEnds(a) };
  if (paint.kind === 'conic') return { ...paint, angle: a };
  return paint;
}

/** Mirror the stop offsets (one step `Reverse gradient`). */
export function reversed(paint: GradientPaint): GradientPaint {
  return { ...paint, stops: [...paint.stops].map((s) => ({ ...s, offset: round(1 - s.offset, 4) })).sort((a, b) => a.offset - b.offset) };
}

/** The most stops a gradient holds (the model's limit). */
export const MAX_GRADIENT_STOPS = 32;

/** Add a stop at `offset` with the interpolated colour (≤ 32 stops; unchanged when full). */
export function withStopAdded(paint: GradientPaint, offset: number): GradientPaint {
  if (paint.stops.length >= MAX_GRADIENT_STOPS) return paint;
  const o = Math.max(0, Math.min(1, round(offset, 4)));
  return { ...paint, stops: [...paint.stops, { offset: o, color: colorAt(paint.stops, o) }].sort((a, b) => a.offset - b.offset) };
}

/** Remove stop `index` (never below two). */
export function withStopRemoved(paint: GradientPaint, index: number): GradientPaint {
  if (paint.stops.length <= 2 || paint.stops[index] === undefined) return paint;
  return { ...paint, stops: paint.stops.filter((_, i) => i !== index) };
}

/** Patch stop `index` (offset clamped 0…1; stops stay sorted). */
export function withStop(paint: GradientPaint, index: number, patch: Partial<GradientStopValue>): GradientPaint {
  const stop = paint.stops[index];
  if (stop === undefined) return paint;
  const next = { ...stop, ...patch, ...(patch.offset === undefined ? {} : { offset: Math.max(0, Math.min(1, round(patch.offset, 4))) }) };
  return { ...paint, stops: paint.stops.map((s, i) => (i === index ? next : s)).sort((a, b) => a.offset - b.offset) };
}

export interface RowSummary {
  /** The first line: `@cream`, `Linear · 3 stops · 45°`, `Image · Fill`. */
  readonly title: string;
  /** The second line (mono): the hex of a solid, nothing else. */
  readonly detail?: string;
}

/** A paint row's summary (APPEARANCE §2.1). `resolve` turns a `@token` into its hex (undefined when unresolved). */
export function paintRowSummary(paint: JsonValue | PaintValue | undefined, resolve: (token: string) => string | undefined = () => undefined): RowSummary {
  const kind = paintKind(paint);
  if (kind === 'solid' && typeof paint === 'string') {
    if (paint.startsWith('@')) {
      const hex = resolve(paint);
      return { title: paint, detail: hex === undefined ? 'not in this brand kit' : hex.toUpperCase() };
    }
    return { title: paint.toUpperCase() };
  }
  if (kind === 'image' && isObject(paint)) {
    const fit = (paint['fit'] as keyof typeof FIT_LABELS | undefined) ?? 'cover';
    return { title: `Image · ${FIT_LABELS[fit] ?? 'Fill'}` };
  }
  if (isGradient(paint)) {
    const n = paint.stops.length;
    const label = `${GRADIENT_LABELS[paint.kind]} · ${n} ${n === 1 ? 'stop' : 'stops'}`;
    return { title: paint.kind === 'radial' ? label : `${label} · ${gradientAngle(paint)}°` };
  }
  return { title: 'None' };
}

/** A stroke row's summary: `#16151A · 2 px · Inside`. */
export function strokeRowSummary(stroke: Readonly<Record<string, JsonValue>>, resolve?: (token: string) => string | undefined): RowSummary {
  const paint = paintRowSummary(stroke['paint'], resolve);
  const width = typeof stroke['width'] === 'number' ? `${round(stroke['width'], 2)} px` : String(stroke['width'] ?? '');
  const align = STROKE_POSITION_LABELS[(stroke['align'] as keyof typeof STROKE_POSITION_LABELS | undefined) ?? 'center'] ?? 'Centre';
  return { title: `${paint.title} · ${width} · ${align}`, ...(paint.detail === undefined ? {} : { detail: paint.detail }) };
}

export const STROKE_POSITION_LABELS = Object.freeze({ inside: 'Inside', center: 'Centre', outside: 'Outside' } as const);
export const STROKE_CAP_LABELS = Object.freeze({ butt: 'Butt', round: 'Round', square: 'Square' } as const);
export const STROKE_JOIN_LABELS = Object.freeze({ miter: 'Miter', round: 'Round', bevel: 'Bevel' } as const);

/** Dash presets (APPEARANCE §2.5): from the width, so a thicker stroke keeps the look. */
export const DASH_PRESETS = Object.freeze(['solid', 'dashed', 'dotted'] as const);
export type DashPreset = (typeof DASH_PRESETS)[number] | 'custom';
export const DASH_LABELS: Readonly<Record<DashPreset, string>> = Object.freeze({ solid: 'Solid', dashed: 'Dashed', dotted: 'Dotted', custom: 'Custom' });

/** The stroke patch a dash preset writes for `width`. */
export function dashPatch(preset: (typeof DASH_PRESETS)[number], width: number): Readonly<Record<string, JsonValue>> {
  const w = Math.max(0.5, width);
  if (preset === 'dashed') return { dash: [round(w * 3, 2), round(w * 2, 2)], cap: 'butt' };
  if (preset === 'dotted') return { dash: [0, round(w * 2, 2)], cap: 'round' };
  return { dash: [] };
}

/** Which preset a stroke's dash matches. */
export function dashPresetOf(stroke: Readonly<Record<string, JsonValue>>): DashPreset {
  const dash = Array.isArray(stroke['dash']) ? (stroke['dash'] as number[]) : [];
  if (dash.length === 0) return 'solid';
  const w = typeof stroke['width'] === 'number' ? Math.max(0.5, stroke['width']) : 1;
  const same = (preset: 'dashed' | 'dotted'): boolean => JSON.stringify(dashPatch(preset, w)['dash']) === JSON.stringify(dash);
  return same('dashed') ? 'dashed' : same('dotted') ? 'dotted' : 'custom';
}

// ---------------------------------------------------------------- effects

export const EFFECT_LABELS: Readonly<Record<EffectValue['kind'], string>> = Object.freeze({
  'drop-shadow': 'Shadow',
  'inner-shadow': 'Inner shadow',
  'outer-glow': 'Glow',
  'inner-glow': 'Inner glow',
  'layer-blur': 'Blur',
  'background-blur': 'Background blur',
});

/** One effect row's summary: `Shadow · 0 4 12 · 25 %`, `Glow · 8`, `Blur · 4`. */
export function effectRowSummary(effect: EffectValue | string): string {
  if (typeof effect === 'string') return effect;
  const label = EFFECT_LABELS[effect.kind];
  if (effect.kind === 'layer-blur' || effect.kind === 'background-blur') return `${label} · ${round(effect.radius, 1)}`;
  const lit = effect as Extract<EffectValue, { readonly color: string }>;
  const alpha = hexChannels(lit.color)?.[3];
  const strength = alpha === undefined ? '' : ` · ${Math.round((alpha / 255) * 100)} %`;
  if (lit.kind === 'drop-shadow' || lit.kind === 'inner-shadow') return `${label} · ${round(lit.x, 1)} ${round(lit.y, 1)} ${round(lit.blur, 1)}${strength}`;
  return `${label} · ${round(lit.blur, 1)}${strength}`;
}

export interface EffectPreset {
  readonly id: string;
  readonly label: string;
  /** The effect rows the preset adds (a bevel preset adds two). */
  readonly items: readonly EffectValue[];
}
export interface EffectPresetGroup {
  readonly label: string;
  readonly presets: readonly EffectPreset[];
}

const ink = (alpha: number): string => `#16151A${Math.round(alpha * 255).toString(16).padStart(2, '0').toUpperCase()}`;
const white = (alpha: number): string => `#FFFFFF${Math.round(alpha * 255).toString(16).padStart(2, '0').toUpperCase()}`;

/** `+ Add ▾` for Effects (APPEARANCE §2.6): presets grouped by kind; bevels are honest groups of inner shadows. */
export const EFFECT_PRESETS: readonly EffectPresetGroup[] = Object.freeze([
  {
    label: 'Shadow',
    presets: [
      { id: 'shadow-soft', label: 'Soft', items: [{ kind: 'drop-shadow', x: 0, y: 4, blur: 16, spread: 0, color: ink(0.16) }] },
      { id: 'shadow-medium', label: 'Medium', items: [{ kind: 'drop-shadow', x: 0, y: 8, blur: 24, spread: 0, color: ink(0.24) }] },
      { id: 'shadow-hard', label: 'Hard', items: [{ kind: 'drop-shadow', x: 4, y: 4, blur: 0, spread: 0, color: ink(1) }] },
      { id: 'shadow-long', label: 'Long', items: [{ kind: 'drop-shadow', x: 12, y: 12, blur: 0, spread: 0, color: ink(0.12) }] },
    ],
  },
  {
    label: 'Inner shadow',
    presets: [
      { id: 'inner-soft', label: 'Soft', items: [{ kind: 'inner-shadow', x: 0, y: 2, blur: 6, spread: 0, color: ink(0.2) }] },
      { id: 'inner-edge', label: 'Inset edge', items: [{ kind: 'inner-shadow', x: 0, y: 1, blur: 0, spread: 0, color: ink(0.3) }] },
    ],
  },
  {
    label: 'Glow',
    presets: [
      { id: 'glow-outer', label: 'Outer', items: [{ kind: 'outer-glow', blur: 12, spread: 0, color: '#FF5C3999' }] },
      { id: 'glow-inner', label: 'Inner', items: [{ kind: 'inner-glow', blur: 8, spread: 0, color: white(0.6) }] },
    ],
  },
  {
    label: 'Bevel',
    presets: [
      {
        id: 'bevel-soft',
        label: 'Soft bevel',
        items: [
          { kind: 'inner-shadow', x: -2, y: -2, blur: 4, spread: 0, color: white(0.6) },
          { kind: 'inner-shadow', x: 2, y: 2, blur: 4, spread: 0, color: ink(0.3) },
        ],
      },
      {
        id: 'bevel-hard',
        label: 'Hard bevel',
        items: [
          { kind: 'inner-shadow', x: -2, y: -2, blur: 0, spread: 0, color: white(0.6) },
          { kind: 'inner-shadow', x: 2, y: 2, blur: 0, spread: 0, color: ink(0.3) },
        ],
      },
      {
        id: 'bevel-pillow',
        label: 'Pillow',
        items: [
          { kind: 'inner-glow', blur: 6, spread: 0, color: white(0.4) },
          { kind: 'inner-shadow', x: 0, y: 2, blur: 4, spread: 0, color: ink(0.25) },
        ],
      },
    ],
  },
  {
    label: 'Blur',
    presets: [
      { id: 'blur-layer', label: 'Layer blur', items: [{ kind: 'layer-blur', radius: 4 }] },
      { id: 'blur-background', label: 'Background blur', items: [{ kind: 'background-blur', radius: 20 }] },
    ],
  },
]);

/** A preset by id. */
export function effectPreset(id: string): EffectPreset | undefined {
  for (const g of EFFECT_PRESETS) for (const p of g.presets) if (p.id === id) return p;
  return undefined;
}

/** A collapsed Effects section's summary: `Shadow · Soft`-like first row, or `2 effects`. */
export function effectsSummary(model: Pick<AppearanceModel, 'effects' | 'effectsPreset'> | undefined): string {
  if (model === undefined) return '';
  if (model.effectsPreset !== undefined) return model.effectsPreset;
  const n = model.effects.length;
  if (n === 0) return 'None';
  return n === 1 ? effectRowSummary(model.effects[0] as EffectValue | string) : `${n} effects`;
}

// ---------------------------------------------------------------- layer

export const BLEND_LABELS: Readonly<Record<BlendModeName, string>> = Object.freeze({
  normal: 'Normal',
  darken: 'Darken',
  multiply: 'Multiply',
  'color-burn': 'Colour burn',
  lighten: 'Lighten',
  screen: 'Screen',
  'color-dodge': 'Colour dodge',
  overlay: 'Overlay',
  'soft-light': 'Soft light',
  'hard-light': 'Hard light',
  difference: 'Difference',
  exclusion: 'Exclusion',
  hue: 'Hue',
  saturation: 'Saturation',
  color: 'Colour',
  luminosity: 'Luminosity',
});

/** Blend modes grouped as in every design tool (APPEARANCE §2.1). Every mode appears once. */
export const BLEND_GROUPS: readonly (readonly [string, readonly BlendModeName[]])[] = Object.freeze([
  ['Normal', ['normal']],
  ['Darken', ['darken', 'multiply', 'color-burn']],
  ['Lighten', ['lighten', 'screen', 'color-dodge']],
  ['Contrast', ['overlay', 'soft-light', 'hard-light']],
  ['Inversion', ['difference', 'exclusion']],
  ['Component', ['hue', 'saturation', 'color', 'luminosity']],
] as const);

/** A collapsed Layer section's summary: `50 % · Multiply` (empty at the defaults). */
export function layerSummary(opacity: number, blend: BlendModeName): string {
  const parts = [...(opacity < 1 ? [`${Math.round(opacity * 100)} %`] : []), ...(blend === 'normal' ? [] : [BLEND_LABELS[blend]])];
  return parts.join(' · ');
}

/** True when `BLEND_GROUPS` lists exactly the model's modes (a test guards it). */
export function blendGroupsComplete(): boolean {
  const listed = BLEND_GROUPS.flatMap(([, modes]) => modes);
  return listed.length === BLEND_MODE_NAMES.length && BLEND_MODE_NAMES.every((m) => listed.includes(m));
}

// ---------------------------------------------------------------- page

export interface PageSizePreset {
  readonly id: string;
  readonly label: string;
  readonly width: number;
  readonly height: number;
}

/** The page's `Size ▾` presets: Home's formats (one list, HOME-FILES §1.3), deduplicated by size. */
export function pageSizePresets(): readonly PageSizePreset[] {
  const seen = new Set<string>();
  const out: PageSizePreset[] = [];
  for (const f of designFormats()) {
    const key = `${f.size.width}x${f.size.height}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: f.id, label: `${f.title} · ${f.size.width} × ${f.size.height}`, width: f.size.width, height: f.size.height });
  }
  return out;
}

/** The preset a size matches, if any. */
export function pagePresetOf(width: number, height: number): PageSizePreset | undefined {
  return pageSizePresets().find((p) => p.width === width && p.height === height);
}

/** Page sizes Instaflow accepts (design px). */
export const PAGE_SIZE_RANGE = Object.freeze({ min: 16, max: 8192 });
