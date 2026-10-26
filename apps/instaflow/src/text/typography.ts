/**
 * Typography service (B2; IF-21.26–21.29): the headless model behind the Typography inspector panel and the text
 * HUD actions (font, size, Fit to box). It reads the style of the current text selection (or the whole element when
 * the element is selected but not being edited) and turns user choices into rich-text ops committed as one undo
 * step each. Agents and keyboard users drive the same commands (Studio is usable by hand, M1B-NOTES).
 */
import { err, ok, type Result, token } from '@staticflux/core';
import type { JsonValue, PartOp } from '@staticflux/document/v2';
import { TextRangeError } from './errors.js';
import { CharMark, type CharMarkKey, type CharStyle, type ColorRef, type FontRef, type ParagraphStyle, type Script, SCRIPTS, type TextAlign, TEXT_ALIGNS, TEXT_BOXES, type TextBox, VERTICAL_ALIGNS, type VerticalAlign } from './model.js';
import { replaceTextOps, setCharStyleOps, setParagraphStyleOps, type TextBlockModel, toggleCharMarkOps } from './rich-text.js';

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
  /** B11b: strikethrough, sub/superscript and paragraph spacing (the inspector's Text section). */
  readonly strike: Mixed<boolean>;
  readonly script: Mixed<Script | undefined>;
  readonly spaceBefore: Mixed<number>;
  readonly spaceAfter: Mixed<number>;
  readonly indent: Mixed<number>;
  /** The element's box mode and vertical alignment (undefined when the target does not say). */
  readonly box?: TextBox;
  readonly verticalAlign?: VerticalAlign;
  /** The preset every value matches (`Heading 1`), else undefined (`Custom`). */
  readonly preset?: TextPresetName;
}

/** TEXT-FONTS §4.3: the M1 text presets (one bundle of values; the document's default font stays). */
export const TEXT_PRESETS = Object.freeze({
  Title: { size: 64, weight: 800, lineHeight: 1.05, spaceAfter: 16, letterSpacing: -1 },
  'Heading 1': { size: 48, weight: 700, lineHeight: 1.1, spaceAfter: 12 },
  'Heading 2': { size: 32, weight: 700, lineHeight: 1.15, spaceAfter: 10 },
  'Heading 3': { size: 24, weight: 600, lineHeight: 1.2, spaceAfter: 8 },
  Subheading: { size: 20, weight: 500, lineHeight: 1.3, spaceAfter: 8, color: '#56606C' },
  Body: { size: 18, weight: 400, lineHeight: 1.4, spaceAfter: 8 },
  Caption: { size: 13, weight: 400, lineHeight: 1.3, spaceAfter: 4, color: '#56606C' },
  Quote: { size: 24, weight: 400, lineHeight: 1.3, spaceAfter: 12, italic: true },
} as const);
export type TextPresetName = keyof typeof TEXT_PRESETS;
interface TextPreset {
  readonly size: number;
  readonly weight: number;
  readonly lineHeight: number;
  readonly spaceAfter: number;
  readonly letterSpacing?: number;
  readonly color?: string;
  readonly italic?: boolean;
}
/** Presets shrink on narrow pages (a Story is not a poster): × 0.75 below 800 px. */
export const PRESET_NARROW = Object.freeze({ width: 800, scale: 0.75 });
const presetScale = (pageWidth: number | undefined): number => (pageWidth !== undefined && pageWidth < PRESET_NARROW.width ? PRESET_NARROW.scale : 1);
const presetValues = (preset: TextPreset, scale: number): TextPreset => ({ ...preset, size: Math.round(preset.size * scale * 4) / 4, spaceAfter: Math.round(preset.spaceAfter * scale) });

/** The preset a summary matches exactly (size, weight, line height, space after), if any. Pure. */
export function matchPreset(summary: Pick<TypographySummary, 'size' | 'weight' | 'lineHeight' | 'spaceAfter'>, pageWidth?: number): TextPresetName | undefined {
  const scale = presetScale(pageWidth);
  return (Object.keys(TEXT_PRESETS) as TextPresetName[]).find((name) => {
    const p = presetValues(TEXT_PRESETS[name], scale);
    return summary.size === p.size && summary.weight === p.weight && summary.lineHeight === p.lineHeight && summary.spaceAfter === p.spaceAfter;
  });
}

/** TEXT-FONTS §4.2 Case (M1 = Convert case: the text is rewritten, marks kept per run). */
export const TEXT_CASES = ['upper', 'lower', 'title', 'sentence'] as const;
export type TextCase = (typeof TEXT_CASES)[number];

/** `text` in `kind` case; `sentenceStart` / `wordStart` say whether `text` begins a sentence / word. Pure. */
export function convertCase(text: string, kind: TextCase, sentenceStart = true, wordStart = true): string {
  switch (kind) {
    case 'upper':
      return text.toLocaleUpperCase();
    case 'lower':
      return text.toLocaleLowerCase();
    case 'title': {
      let start = wordStart;
      let out = '';
      for (const ch of text) {
        out += start ? ch.toLocaleUpperCase() : ch.toLocaleLowerCase();
        start = /\s/u.test(ch);
      }
      return out;
    }
    case 'sentence': {
      let start = sentenceStart;
      let out = '';
      for (const ch of text) {
        if (/\p{L}/u.test(ch)) {
          out += start ? ch.toLocaleUpperCase() : ch.toLocaleLowerCase();
          start = false;
        } else {
          out += ch;
          if (/[.!?\n\u2028]/u.test(ch)) start = true;
        }
      }
      return out;
    }
  }
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
    strike: same(styles.map((s) => s.strike === true), false),
    script: same(styles.map((s) => s.script), undefined),
    spaceBefore: same(paras.map((p) => p.style.spaceBefore ?? 0), 0),
    spaceAfter: same(paras.map((p) => p.style.spaceAfter ?? 0), 0),
    indent: same(paras.map((p) => p.style.indent ?? 0), 0),
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
  /** B11b: the element's box mode and vertical alignment (for the summary). */
  readonly element?: { readonly box: TextBox; readonly verticalAlign: VerticalAlign };
}

/** Element props the typography commands set (the text component's box and vertical alignment). */
export const TEXT_ELEMENT_PATHS = Object.freeze({ box: 'text.box', verticalAlign: 'text.verticalAlign' } as const);

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
  /** The page width (presets shrink on narrow pages). */
  readonly pageWidth?: () => number | undefined;
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
  /** B11b: subscript / superscript (null = normal). */
  setScript(script: Script | null): Result<void>;
  /** B11b: paragraph spacing before / after and first-line indent (px). */
  setParagraph(patch: { readonly spaceBefore?: number; readonly spaceAfter?: number; readonly indent?: number }): Result<void>;
  /** B11b: the element's box mode (Auto width · Auto height · Fixed). */
  setBox(box: TextBox): Result<void>;
  /** B11b: the element's vertical alignment (fixed boxes). */
  setVerticalAlign(align: VerticalAlign): Result<void>;
  /** B11b: rewrite the range in another case (marks kept per run). */
  convertCase(kind: TextCase): Result<void>;
  /** B11b: remove every character mark in the range (paragraph marks stay). */
  clearFormatting(): Result<void>;
  /** B11b: apply a text preset to the range's paragraphs. */
  applyPreset(name: TextPresetName): Result<void>;
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
      if (t === undefined) return undefined;
      const s = summarizeTypography(t.block, t.from, t.to, options.defaults);
      const preset = matchPreset(s, options.pageWidth?.());
      return { ...s, ...(t.element === undefined ? {} : { box: t.element.box, verticalAlign: t.element.verticalAlign }), ...(preset === undefined ? {} : { preset }) };
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
    setScript: (script) => chars({ script }, script === null ? 'Normal script' : script === 'sub' ? 'Subscript' : 'Superscript'),
    setParagraph: (patch) => paragraph(patch, 'Paragraph spacing'),
    setBox(box) {
      const t = target();
      if (!t.ok) return t;
      if (!(TEXT_BOXES as readonly string[]).includes(box)) return err(TextRangeError({ message: `Unknown box mode ${String(box)}.` }));
      return run(ok([{ op: 'set', node: t.value.block.node, path: TEXT_ELEMENT_PATHS.box, value: box }]), 'Auto-size');
    },
    setVerticalAlign(align) {
      const t = target();
      if (!t.ok) return t;
      if (!(VERTICAL_ALIGNS as readonly string[]).includes(align)) return err(TextRangeError({ message: `Unknown vertical alignment ${String(align)}.` }));
      return run(ok([{ op: 'set', node: t.value.block.node, path: TEXT_ELEMENT_PATHS.verticalAlign, value: align }]), 'Vertical align');
    },
    convertCase(kind) {
      const t = target();
      if (!t.ok) return t;
      if (!(TEXT_CASES as readonly string[]).includes(kind)) return err(TextRangeError({ message: `Unknown case ${String(kind)}.` }));
      const [a, b] = range(t.value);
      const block = t.value.block;
      const runs = block.paragraphs.flatMap((p) => p.runs).filter((r) => r.end > a && r.start < b && r.end > r.start);
      const ops: PartOp[] = [];
      // Back to front: each replace leaves the offsets before it valid.
      for (const r of [...runs].reverse()) {
        const from = Math.max(a, r.start);
        const to = Math.min(b, r.end);
        const before = block.text.slice(0, from);
        const text = block.text.slice(from, to);
        const next = convertCase(text, kind, before.trim() === '' || /[.!?\n\u2028]\s*$/u.test(before), before === '' || /\s$/u.test(before));
        if (next === text) continue;
        const replaced = replaceTextOps(block, from, to, next, r.style);
        if (!replaced.ok) return replaced;
        ops.push(...replaced.value);
      }
      return run(ok(ops), 'Convert case');
    },
    clearFormatting() {
      const t = target();
      if (!t.ok) return t;
      const [a, b] = range(t.value);
      const patch = Object.fromEntries(Object.values(CharMark).map((key) => [key, null])) as { [K in CharMarkKey]?: JsonValue };
      return run(setCharStyleOps(t.value.block, a, b, patch), 'Clear formatting');
    },
    applyPreset(name) {
      const preset = (TEXT_PRESETS as Readonly<Record<string, TextPreset>>)[name];
      const t = target();
      if (!t.ok) return t;
      if (preset === undefined) return err(TextRangeError({ message: `Unknown text style ${String(name)}.` }));
      const p = presetValues(preset, presetScale(options.pageWidth?.()));
      const block = t.value.block;
      // A preset styles whole paragraphs: the paragraphs the range touches.
      const paras = block.paragraphs.filter((x) => x.end >= t.value.from && x.start <= t.value.to);
      const from = paras[0]?.start ?? 0;
      const to = paras.at(-1)?.end ?? block.text.length;
      const charOps = setCharStyleOps(block, from, to, { size: p.size, weight: p.weight, bold: null, italic: p.italic === true ? true : null, letterSpacing: p.letterSpacing ?? null, ...(p.color === undefined ? {} : { color: p.color }) });
      if (!charOps.ok) return charOps;
      const paraOps = setParagraphStyleOps(block, from, to, { lineHeight: p.lineHeight, spaceAfter: p.spaceAfter, indent: 0 });
      if (!paraOps.ok) return paraOps;
      return run(ok([...charOps.value, ...paraOps.value]), name);
    },
  };
}
