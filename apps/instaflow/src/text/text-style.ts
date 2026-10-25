/**
 * Style resolution (B2; IF-21.4–21.6): a text element's paragraphs and runs → a layout spec plus a **brush table**
 * (paint and link per distinct span look). Brand-kit `@token`s resolve through `BrandTokenSource` (brand kits are
 * B1/B4's; this is the read port text needs). Unresolvable tokens fall back to the element defaults and are reported
 * (IF-TXT-009), never thrown: text always renders.
 */
import { err, ok, type Result, type SfError } from '@staticflux/core';
import { FontTokenUnresolvedError, TextStyleInvalidError } from './errors.js';
import { familyList, type LayoutParagraphSpec, type LayoutSpanSpec, type LayoutSpec } from './layout-spec.js';
import { type CharStyle, type ColorRef, type FontRef, isTokenRef, type TextAlign, type TokenRef } from './model.js';
import type { TextBlockModel } from './rich-text.js';

export type Rgba8 = readonly [number, number, number, number];

/** Brand-kit values text reads (`color.primary` → `#2255ff`, `font.display` → a font asset). */
export interface BrandTokenSource {
  color(token: TokenRef): string | undefined;
  font(token: TokenRef): FontRef | undefined;
}

/** Font asset hash → family names registered with the layout engine. */
export type FontFamilies = (hash: `sha256:${string}`) => readonly string[] | undefined;

export interface TextDefaults {
  readonly font: FontRef;
  readonly size: number;
  readonly color: ColorRef;
  readonly weight?: number;
  /** Families appended to every span (script fallbacks are per-script in the engine; this is the last resort). */
  readonly fallback?: readonly string[];
}

export interface TextBrush {
  readonly color: Rgba8;
  readonly link?: string;
}

export interface ResolvedTextLayout {
  readonly spec: LayoutSpec;
  readonly brushes: readonly TextBrush[];
  /** Unresolved tokens and invalid colours (the text used the defaults there). */
  readonly problems: readonly SfError[];
}

export interface ResolveTextOptions {
  /** Wrap width (px); ≤ 0 = auto width. */
  readonly width: number;
  /** Element-level paragraph alignment default. */
  readonly align?: TextAlign;
  readonly defaults: TextDefaults;
  readonly brand?: BrandTokenSource;
  readonly families: FontFamilies;
}

const NAMED: Readonly<Record<string, Rgba8>> = { black: [0, 0, 0, 255], white: [255, 255, 255, 255], transparent: [0, 0, 0, 0] };

/** Parse a CSS colour (hex 3/4/6/8, `rgb()`/`rgba()`, black/white/transparent). */
export function parseCssColor(css: string): Result<Rgba8> {
  const s = css.trim().toLowerCase();
  const named = NAMED[s];
  if (named !== undefined) return ok(named);
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s)?.[1];
  if (hex !== undefined) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex;
    const n = (i: number): number => Number.parseInt(full.slice(i * 2, i * 2 + 2), 16);
    return ok([n(0), n(1), n(2), full.length === 8 ? n(3) : 255]);
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(s);
  if (fn !== null) {
    const ch = (v: string | undefined): number => Math.max(0, Math.min(255, Math.round(Number(v))));
    const a = fn[4] === undefined ? 1 : fn[4].endsWith('%') ? Number(fn[4].slice(0, -1)) / 100 : Number(fn[4]);
    return ok([ch(fn[1]), ch(fn[2]), ch(fn[3]), Math.max(0, Math.min(255, Math.round(a * 255)))]);
  }
  return err(TextStyleInvalidError({ message: `"${css}" is not a supported colour (hex, rgb(), rgba()).`, details: { color: css } }));
}

/** Resolve a colour reference (token → brand value → parsed). */
export function resolveColor(ref: ColorRef, brand: BrandTokenSource | undefined): Result<Rgba8> {
  if (isTokenRef(ref)) {
    const value = brand?.color(ref);
    return value === undefined ? err(FontTokenUnresolvedError({ message: `Colour token ${ref.token} is not in the brand kit.`, details: { token: ref.token } })) : parseCssColor(value);
  }
  return parseCssColor(ref);
}

/** Resolve a font reference to registered family names. */
export function resolveFont(ref: FontRef, brand: BrandTokenSource | undefined, families: FontFamilies): Result<readonly string[]> {
  const asset = isTokenRef(ref) ? brand?.font(ref) : ref;
  if (asset === undefined || isTokenRef(asset)) return err(FontTokenUnresolvedError({ message: `Font token ${(ref as TokenRef).token} is not in the brand kit.`, details: { token: (ref as TokenRef).token } }));
  const names = families(asset.font);
  return names === undefined || names.length === 0 ? err(FontTokenUnresolvedError({ message: `Font ${asset.font} is not loaded.`, details: { font: asset.font } })) : ok(names);
}

/** Resolve a text element into a layout spec and its brush table. */
export function resolveTextLayout(block: TextBlockModel, options: ResolveTextOptions): ResolvedTextLayout {
  const problems: SfError[] = [];
  const brushes: TextBrush[] = [];
  const brushIndex = new Map<string, number>();
  const { defaults, brand } = options;
  const take = <T>(r: Result<T>, fallback: T): T => {
    if (r.ok) return r.value;
    problems.push(r.error);
    return fallback;
  };
  const baseColor = take(resolveColor(defaults.color, brand), [0, 0, 0, 255] as Rgba8);
  const baseFamilies = take(resolveFont(defaults.font, brand, options.families), [] as readonly string[]);
  const brushOf = (style: CharStyle): number => {
    const color = style.color === undefined ? baseColor : take(resolveColor(style.color, brand), baseColor);
    const brush: TextBrush = style.link === undefined ? { color } : { color, link: style.link.href };
    const key = JSON.stringify(brush);
    let index = brushIndex.get(key);
    if (index === undefined) {
      index = brushes.length;
      brushes.push(brush);
      brushIndex.set(key, index);
    }
    return index;
  };
  const span = (style: CharStyle, start: number, end: number): LayoutSpanSpec => {
    const families = style.font === undefined ? baseFamilies : take(resolveFont(style.font, brand, options.families), baseFamilies);
    return {
      start,
      end,
      family: familyList([...families, ...(defaults.fallback ?? [])]),
      size: style.size ?? defaults.size,
      weight: style.weight ?? (style.bold === true ? 700 : (defaults.weight ?? 400)),
      italic: style.italic === true,
      letterSpacing: style.letterSpacing ?? 0,
      underline: style.underline === true || style.link !== undefined,
      strike: style.strike === true,
      brush: brushOf(style),
    };
  };
  const paragraphs: LayoutParagraphSpec[] = block.paragraphs.map((p) => {
    const spans = p.runs.map((r) => span(r.style, r.start - p.start, r.end - p.start));
    return {
      text: p.text,
      spans,
      align: p.style.align ?? options.align ?? 'start',
      lineHeight: p.style.lineHeight ?? 0,
      spaceBefore: p.style.spaceBefore ?? 0,
      spaceAfter: p.style.spaceAfter ?? 0,
      indent: p.style.indent ?? 0,
    };
  });
  return { spec: { width: options.width, paragraphs }, brushes, problems };
}
