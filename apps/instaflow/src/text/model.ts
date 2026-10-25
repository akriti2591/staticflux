/**
 * The text element's document model (B2; IF-21.1–21.6, DOCUMENT-FORMAT §3.2 `Text`, `RichText`, `TextStyle`).
 *
 * - **`TextComponent`** (`text.*`): `content` is CRDT rich text; `box`, `align` (default for paragraphs),
 *   `verticalAlign`.
 * - **Character marks** on `text.content` (A4 v2 marks, anchored, so concurrent edits keep them): `bold`, `italic`,
 *   `size`, `color` (CSS colour or `{ token }`), `font` (font asset `{ font: sha256 }` or `{ token }`), `link`
 *   (`{ href }`), `underline`, `strike`, `letterSpacing`, `weight`.
 * - **Paragraphs** (Quill-style): the content always ends with `\n`; each paragraph's style lives as `p.*` marks on
 *   its terminating `\n` (`p.align`, `p.list`, `p.lineHeight`, `p.spaceBefore`, `p.spaceAfter`, `p.indent`). Splitting
 *   a paragraph copies the style to the new break (`splitParagraphOps`), so concurrent edits converge without a
 *   separate paragraph list.
 * - Every peer must create its Loro engine with `TEXT_MARK_EXPAND` (A4 rule: one mark-expand table).
 *
 * Mark keys and values are typed here; nothing else in the app spells them (repo rule 1).
 */
import type { JsonValue } from '@staticflux/document/v2';
import { defineComponent, field } from '@staticflux/document/v2';
import { ELEMENT_COMMON_COMPONENTS, P } from '../elements/components.js';

export const TEXT_KIND = 'text';
/** The rich-text path of a text element. */
export const TEXT_CONTENT = 'text.content';

export const TEXT_BOXES = ['auto-width', 'auto-height', 'fixed'] as const;
export type TextBox = (typeof TEXT_BOXES)[number];
export const TEXT_ALIGNS = ['start', 'center', 'end', 'justify'] as const;
export type TextAlign = (typeof TEXT_ALIGNS)[number];
export const VERTICAL_ALIGNS = ['top', 'middle', 'bottom'] as const;
export type VerticalAlign = (typeof VERTICAL_ALIGNS)[number];
export const LIST_KINDS = ['none', 'bullet', 'number'] as const;
export type ListKind = (typeof LIST_KINDS)[number];

export const TextComponent = /* @__PURE__ */ defineComponent(
  'text',
  { content: 'richtext', box: field.enum(TEXT_BOXES), align: field.enum(TEXT_ALIGNS), verticalAlign: field.enum(VERTICAL_ALIGNS) },
  { defaults: { box: 'auto-height', align: 'start', verticalAlign: 'top' }, description: 'Rich text element (B2): CRDT content with marks; paragraph styles on breaks.' },
);

/**
 * Stable lineage key for Auto Animate / Magic Animate (M4): matching elements morph across pages. Text elements
 * carry B1's `lineage.key` like every other element; new text gets `lk_<node>` (B1's convention) and duplicates
 * keep it (`duplicateTextOps`, B1's `duplicate`).
 */
export const MATCH_KEY_PATH = P.matchKey;

/** The `text` element kind: B1's common element components (spatial, style, mask, lineage, lock) plus `text`. */
export const TEXT_KIND_COMPONENTS: Readonly<Record<typeof TEXT_KIND, readonly string[]>> = Object.freeze({ text: [...ELEMENT_COMMON_COMPONENTS, 'text'] });

/** Pass to B1's `createElementRegistry` so text nodes validate with appearance, masks, corners and match keys. */
export const TEXT_REGISTRY_OPTIONS = Object.freeze({ components: [TextComponent], kinds: TEXT_KIND_COMPONENTS });

/** Character mark keys (UTF-16 ranges on `text.content`). */
export const CharMark = Object.freeze({
  bold: 'bold',
  italic: 'italic',
  underline: 'underline',
  strike: 'strike',
  link: 'link',
  size: 'size',
  weight: 'weight',
  color: 'color',
  font: 'font',
  letterSpacing: 'letterSpacing',
} as const);
export type CharMarkKey = (typeof CharMark)[keyof typeof CharMark];

/** Paragraph mark keys (on the paragraph's terminating `\n`). */
export const ParaMark = Object.freeze({
  align: 'p.align',
  list: 'p.list',
  lineHeight: 'p.lineHeight',
  spaceBefore: 'p.spaceBefore',
  spaceAfter: 'p.spaceAfter',
  indent: 'p.indent',
} as const);
export type ParaMarkKey = (typeof ParaMark)[keyof typeof ParaMark];

export type MarkExpand = 'before' | 'after' | 'none' | 'both';

/**
 * How marks grow when text is typed at their edge (pass to `createLoroEngine({ marks: TEXT_MARK_EXPAND })` on every
 * peer). Style marks extend like in word processors; links and paragraph marks never grow.
 */
export const TEXT_MARK_EXPAND: Readonly<Record<CharMarkKey | ParaMarkKey, MarkExpand>> = Object.freeze({
  bold: 'after',
  italic: 'after',
  underline: 'after',
  strike: 'after',
  link: 'none',
  size: 'after',
  weight: 'after',
  color: 'after',
  font: 'after',
  letterSpacing: 'after',
  'p.align': 'none',
  'p.list': 'none',
  'p.lineHeight': 'none',
  'p.spaceBefore': 'none',
  'p.spaceAfter': 'none',
  'p.indent': 'none',
});

/** A brand-kit token reference (`color.primary`, `font.display`), optionally pinned to a kit asset. */
export interface TokenRef {
  readonly token: `${string}.${string}`;
  readonly kit?: string;
}

/** A font: a font asset by content hash (`sha256:…`) or a brand-kit font token. */
export type FontRef = { readonly font: `sha256:${string}`; readonly family?: string } | TokenRef;
/** A colour: CSS Color 4 string or a brand-kit colour token. */
export type ColorRef = string | TokenRef;

export interface LinkRef {
  readonly href: string;
}

/** Character style as stored (every field optional: unset inherits the element default). */
export interface CharStyle {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strike?: boolean;
  readonly link?: LinkRef;
  readonly size?: number;
  readonly weight?: number;
  readonly color?: ColorRef;
  readonly font?: FontRef;
  readonly letterSpacing?: number;
}

export interface ParagraphStyle {
  readonly align?: TextAlign;
  readonly list?: ListKind;
  /** Multiple of the font size (0 / unset = font metrics). */
  readonly lineHeight?: number;
  readonly spaceBefore?: number;
  readonly spaceAfter?: number;
  /** First-line indent in px. */
  readonly indent?: number;
}

export const isTokenRef = (value: unknown): value is TokenRef =>
  typeof value === 'object' && value !== null && typeof (value as { token?: unknown }).token === 'string' && /^[a-z][\w-]*\.[\w.-]+$/i.test((value as { token: string }).token);

const isFontAsset = (value: unknown): value is Extract<FontRef, { font: string }> =>
  typeof value === 'object' && value !== null && typeof (value as { font?: unknown }).font === 'string' && (value as { font: string }).font.startsWith('sha256:');

/** Validate one character mark value; returns an error message or undefined. */
export function checkCharMark(key: CharMarkKey, value: JsonValue): string | undefined {
  if (value === null) return undefined; // removes the mark
  switch (key) {
    case 'bold':
    case 'italic':
    case 'underline':
    case 'strike':
      return typeof value === 'boolean' ? undefined : `${key} must be a boolean`;
    case 'size':
      return typeof value === 'number' && value > 0 && value <= 4096 ? undefined : 'size must be a number in (0, 4096]';
    case 'weight':
      return typeof value === 'number' && value >= 1 && value <= 1000 ? undefined : 'weight must be 1…1000';
    case 'letterSpacing':
      return typeof value === 'number' && Math.abs(value) <= 1000 ? undefined : 'letterSpacing must be a number of px';
    case 'color':
      return typeof value === 'string' || isTokenRef(value) ? undefined : 'color must be a CSS colour or { token }';
    case 'font':
      return isFontAsset(value) || isTokenRef(value) ? undefined : 'font must be { font: "sha256:…" } or { token }';
    case 'link': {
      const href = (value as { href?: unknown }).href;
      return typeof href === 'string' && /^(https?:|mailto:|#)/i.test(href) ? undefined : 'link must be { href } with http(s), mailto or #';
    }
  }
}

const PARA_CHECKS: Readonly<Record<keyof ParagraphStyle, (v: JsonValue) => boolean>> = {
  align: (v) => (TEXT_ALIGNS as readonly unknown[]).includes(v),
  list: (v) => (LIST_KINDS as readonly unknown[]).includes(v),
  lineHeight: (v) => typeof v === 'number' && v >= 0 && v <= 10,
  spaceBefore: (v) => typeof v === 'number' && v >= 0 && v <= 4096,
  spaceAfter: (v) => typeof v === 'number' && v >= 0 && v <= 4096,
  indent: (v) => typeof v === 'number' && Math.abs(v) <= 4096,
};

/** Paragraph style field ↔ mark key. */
export const PARA_FIELDS: readonly (readonly [keyof ParagraphStyle, ParaMarkKey])[] = [
  ['align', ParaMark.align],
  ['list', ParaMark.list],
  ['lineHeight', ParaMark.lineHeight],
  ['spaceBefore', ParaMark.spaceBefore],
  ['spaceAfter', ParaMark.spaceAfter],
  ['indent', ParaMark.indent],
];

export function checkParagraphField(field: keyof ParagraphStyle, value: JsonValue): string | undefined {
  if (value === null) return undefined;
  return PARA_CHECKS[field](value) ? undefined : `paragraph ${field} has an invalid value`;
}

/** Character style from a span's marks (unknown keys are ignored). */
export function charStyleOf(marks: Readonly<Record<string, JsonValue>>): CharStyle {
  const out: Record<string, unknown> = {};
  for (const key of Object.values(CharMark)) {
    const v = marks[key];
    if (v !== undefined && v !== null && checkCharMark(key, v) === undefined) out[key] = v;
  }
  return out as CharStyle;
}

/** Paragraph style from the marks on a paragraph break. */
export function paragraphStyleOf(marks: Readonly<Record<string, JsonValue>>): ParagraphStyle {
  const out: Record<string, unknown> = {};
  for (const [fieldName, key] of PARA_FIELDS) {
    const v = marks[key];
    if (v !== undefined && v !== null && checkParagraphField(fieldName, v) === undefined) out[fieldName] = v;
  }
  return out as ParagraphStyle;
}

/** The paragraph marks of a style (for writing a break). */
export function paragraphMarks(style: ParagraphStyle): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [fieldName, key] of PARA_FIELDS) {
    const v = style[fieldName];
    if (v !== undefined) out[key] = v;
  }
  return out;
}
