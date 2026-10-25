/**
 * Typography service (B2; IF-21.26–21.29): the headless model behind the Typography inspector panel and the text
 * HUD actions (font, size, Fit to box). It reads the style of the current text selection (or the whole element when
 * the element is selected but not being edited) and turns user choices into rich-text ops committed as one undo
 * step each. Agents and keyboard users drive the same commands (Studio is usable by hand, M1B-NOTES).
 */
import { err, ok, type Result, token } from '@staticflux/core';
import type { JsonValue, PartOp } from '@staticflux/document/v2';
import { TextRangeError } from './errors.js';
import { type CharMarkKey, type CharStyle, type ColorRef, type FontRef, type ParagraphStyle, type TextAlign, TEXT_ALIGNS } from './model.js';
import { setCharStyleOps, setParagraphStyleOps, type TextBlockModel, toggleCharMarkOps } from './rich-text.js';

export const MIXED = 'mixed' as const;
export type Mixed<T> = T | typeof MIXED;

export interface TypographySummary {
  readonly font: Mixed<FontRef | undefined>;
  readonly size: Mixed<number>;
  readonly weight: Mixed<number>;
  readonly bold: Mixed<boolean>;
  readonly italic: Mixed<boolean>;
  readonly underline: Mixed<boolean>;
  readonly color: Mixed<ColorRef | undefined>;
  readonly letterSpacing: Mixed<number>;
  readonly align: Mixed<TextAlign>;
  readonly lineHeight: Mixed<number>;
  readonly link: Mixed<string | undefined>;
}

export interface TypographyDefaults {
  readonly size: number;
  readonly weight?: number;
  readonly align?: TextAlign;
}

const same = <T>(values: readonly T[], fallback: T): Mixed<T> => {
  if (values.length === 0) return fallback;
  const first = JSON.stringify(values[0]);
  return values.every((v) => JSON.stringify(v) === first) ? (values[0] as T) : MIXED;
};

/** The common style of `[from, to)` (a collapsed range reads the run before the caret). */
export function summarizeTypography(block: TextBlockModel, from: number, to: number, defaults: TypographyDefaults): TypographySummary {
  const runs = block.paragraphs.flatMap((p) => p.runs);
  const caretRun = runs.find((r) => r.start < from && r.end >= from) ?? runs.find((r) => r.start >= from);
  const hit = from === to ? (caretRun === undefined ? [] : [caretRun]) : runs.filter((r) => r.end > from && r.start < to && r.end > r.start);
  const styles: CharStyle[] = hit.length > 0 ? hit.map((r) => r.style) : [runs[0]?.style ?? {}];
  const paras = block.paragraphs.filter((p) => p.end >= from && p.start <= to);
  const weight = (s: CharStyle): number => s.weight ?? (s.bold === true ? 700 : (defaults.weight ?? 400));
  return {
    font: same(styles.map((s) => s.font), undefined),
    size: same(styles.map((s) => s.size ?? defaults.size), defaults.size),
    weight: same(styles.map(weight), defaults.weight ?? 400),
    bold: same(styles.map((s) => weight(s) >= 600), false),
    italic: same(styles.map((s) => s.italic === true), false),
    underline: same(styles.map((s) => s.underline === true), false),
    color: same(styles.map((s) => s.color), undefined),
    letterSpacing: same(styles.map((s) => s.letterSpacing ?? 0), 0),
    align: same(paras.map((p) => p.style.align ?? defaults.align ?? 'start'), defaults.align ?? 'start'),
    lineHeight: same(paras.map((p) => p.style.lineHeight ?? 0), 0),
    link: same(styles.map((s) => s.link?.href), undefined),
  };
}

/**
 * Ops that scale every run's font size so the laid-out height fits `boxHeight` ("Fit to box", HUD).
 * `measure(scale)` lays the element out with all sizes multiplied by `scale` and returns its height.
 */
export function fitToBoxOps(block: TextBlockModel, boxHeight: number, defaults: TypographyDefaults, measure: (scale: number) => Result<number>): Result<PartOp[]> {
  if (!(boxHeight > 0)) return err(TextRangeError({ message: 'Fit to box needs a positive box height.', details: { boxHeight } }));
  let lo = 0.05;
  let hi = 20;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    const h = measure(mid);
    if (!h.ok) return h;
    if (h.value <= boxHeight) lo = mid;
    else hi = mid;
  }
  const ops: PartOp[] = [];
  for (const p of block.paragraphs) {
    for (const r of p.runs) {
      if (r.end <= r.start) continue;
      const size = Math.max(1, Math.round((r.style.size ?? defaults.size) * lo * 4) / 4);
      const run = setCharStyleOps(block, r.start, r.end, { size });
      if (!run.ok) return run;
      ops.push(...run.value);
    }
  }
  return ok(ops);
}

/** What the typography commands act on. */
export interface TypographyTarget {
  readonly block: TextBlockModel;
  readonly from: number;
  readonly to: number;
}

export interface TypographyServiceOptions {
  /** The current text target (undefined when no text element is selected). */
  readonly current: () => TypographyTarget | undefined;
  readonly commit: (ops: readonly PartOp[], label: string) => Result<void>;
  readonly defaults: TypographyDefaults;
  /** Height of the current element laid out with sizes × `scale`, and its box height (Fit to box). */
  readonly measure?: (scale: number) => Result<{ readonly height: number; readonly box: number }>;
  /** Fonts the panel offers (loaded assets and brand-kit font tokens). */
  readonly fonts?: () => readonly FontChoice[];
  /** Brand-kit colour tokens the panel offers. */
  readonly colors?: () => readonly ColorChoice[];
  /** Selection or document changes (the panel re-reads the summary). */
  readonly watch?: (listener: () => void) => () => void;
}

export interface FontChoice {
  readonly label: string;
  readonly value: FontRef;
}

export interface ColorChoice {
  readonly label: string;
  readonly value: ColorRef;
  /** Swatch (resolved CSS colour). */
  readonly css: string;
}

export interface TypographyService {
  summary(): TypographySummary | undefined;
  fontChoices(): readonly FontChoice[];
  colorChoices(): readonly ColorChoice[];
  onChange(listener: () => void): () => void;
  setFont(font: FontRef): Result<void>;
  setSize(size: number): Result<void>;
  setWeight(weight: number): Result<void>;
  toggle(key: 'bold' | 'italic' | 'underline' | 'strike'): Result<void>;
  setColor(color: ColorRef): Result<void>;
  setLetterSpacing(px: number): Result<void>;
  setLink(href: string | null): Result<void>;
  setAlign(align: TextAlign): Result<void>;
  setLineHeight(multiple: number): Result<void>;
  fitToBox(): Result<void>;
}

export const TypographyServiceToken = /* @__PURE__ */ token('instaflow/typography').type<TypographyService>();

export function createTypographyService(options: TypographyServiceOptions): TypographyService {
  const target = (): Result<TypographyTarget> => {
    const t = options.current();
    return t === undefined ? err(TextRangeError({ message: 'No text is selected.' })) : ok(t);
  };
  const range = (t: TypographyTarget): [number, number] => (t.from === t.to ? [0, t.block.text.length] : [t.from, t.to]);
  const run = (ops: Result<PartOp[]>, label: string): Result<void> => (ops.ok ? (ops.value.length === 0 ? ok(undefined) : options.commit(ops.value, label)) : ops);
  const chars = (patch: { readonly [K in CharMarkKey]?: JsonValue }, label: string): Result<void> => {
    const t = target();
    if (!t.ok) return t;
    const [a, b] = range(t.value);
    return run(setCharStyleOps(t.value.block, a, b, patch), label);
  };
  const paragraph = (patch: { readonly [K in keyof ParagraphStyle]?: JsonValue }, label: string): Result<void> => {
    const t = target();
    if (!t.ok) return t;
    return run(setParagraphStyleOps(t.value.block, t.value.from, t.value.to, patch), label);
  };
  return {
    fontChoices: () => options.fonts?.() ?? [],
    colorChoices: () => options.colors?.() ?? [],
    onChange: (listener) => options.watch?.(listener) ?? (() => undefined),
    summary() {
      const t = options.current();
      return t === undefined ? undefined : summarizeTypography(t.block, t.from, t.to, options.defaults);
    },
    setFont: (font) => chars({ font: font as unknown as JsonValue }, 'Change font'),
    setSize: (size) => chars({ size }, 'Change font size'),
    setWeight: (weight) => chars({ weight, bold: null }, 'Change font weight'),
    toggle(key) {
      const t = target();
      if (!t.ok) return t;
      const [a, b] = range(t.value);
      return run(toggleCharMarkOps(t.value.block, a, b, key), `Toggle ${key}`);
    },
    setColor: (color) => chars({ color: color as JsonValue }, 'Change text colour'),
    setLetterSpacing: (px) => chars({ letterSpacing: px }, 'Change letter spacing'),
    setLink: (href) => chars({ link: href === null ? null : { href } }, href === null ? 'Remove link' : 'Add link'),
    setAlign: (align) => ((TEXT_ALIGNS as readonly string[]).includes(align) ? paragraph({ align }, 'Align text') : paragraph({ align: 'invalid' }, 'Align text')),
    setLineHeight: (multiple) => paragraph({ lineHeight: multiple }, 'Change line height'),
    fitToBox() {
      const t = target();
      if (!t.ok) return t;
      if (options.measure === undefined) return err(TextRangeError({ message: 'Fit to box needs a layout.' }));
      const box = options.measure(1);
      if (!box.ok) return box;
      const measure = options.measure;
      return run(
        fitToBoxOps(t.value.block, box.value.box, options.defaults, (scale) => {
          const m = measure(scale);
          return m.ok ? ok(m.value.height) : m;
        }),
        'Fit text to box',
      );
    },
  };
}
