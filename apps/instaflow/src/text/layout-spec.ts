/**
 * Layout spec encoder (B2): the binary input of the authoring module's `TextEngine.layout`, byte-identical with the
 * Rust `SpecWriter` (`engine/crates/authoring/src/text/spec.rs`, wire format in its module docs). Paragraph text has
 * no `\n`; span offsets are UTF-16 within the paragraph, contiguous and covering it.
 */

export const LAYOUT_SPEC_MAGIC = [0x53, 0x46, 0x54, 0x58] as const; // "SFTX"
export const LAYOUT_SPEC_VERSION = 1;

export const SPEC_ALIGNS = ['start', 'center', 'end', 'justify'] as const;
export type SpecAlign = (typeof SPEC_ALIGNS)[number];
export const SPEC_DIRECTIONS = ['auto', 'ltr', 'rtl'] as const;
export type SpecDirection = (typeof SPEC_DIRECTIONS)[number];

export interface LayoutSpanSpec {
  readonly start: number;
  readonly end: number;
  /** CSS family list, e.g. `"Noto Sans", "Noto Sans Arabic"` (empty = sans-serif). */
  readonly family: string;
  readonly size: number;
  readonly weight?: number;
  readonly italic?: boolean;
  readonly letterSpacing?: number;
  readonly underline?: boolean;
  readonly strike?: boolean;
  /** Opaque index returned on glyph runs and decorations (the paint / link table of the block). */
  readonly brush?: number;
  /** BCP 47 language tag (shaping and fallback). */
  readonly locale?: string;
}

export interface LayoutParagraphSpec {
  readonly text: string;
  readonly spans: readonly LayoutSpanSpec[];
  readonly align?: SpecAlign;
  readonly direction?: SpecDirection;
  /** Multiple of the font size; 0 = font metrics. */
  readonly lineHeight?: number;
  readonly spaceBefore?: number;
  readonly spaceAfter?: number;
  /** First-line indent (px). */
  readonly indent?: number;
}

export interface LayoutSpec {
  /** Wrap width in px; ≤ 0 = no wrapping (auto-width boxes). */
  readonly width: number;
  readonly paragraphs: readonly LayoutParagraphSpec[];
}

const utf8 = new TextEncoder();

/** Encode a spec (throws RangeError on malformed spans: a programmer error, like the scene IR writer). */
export function encodeLayoutSpec(spec: LayoutSpec): Uint8Array {
  const parts: number[] = [];
  const view = new DataView(new ArrayBuffer(8));
  const u8 = (v: number): void => {
    parts.push(v & 0xff);
  };
  const u16 = (v: number): void => {
    view.setUint16(0, v, true);
    parts.push(view.getUint8(0), view.getUint8(1));
  };
  const u32 = (v: number): void => {
    view.setUint32(0, v >>> 0, true);
    for (let i = 0; i < 4; i++) parts.push(view.getUint8(i));
  };
  const f32 = (v: number): void => {
    if (!Number.isFinite(v)) throw new RangeError(`layout spec: ${v} is not finite`);
    view.setFloat32(0, v, true);
    for (let i = 0; i < 4; i++) parts.push(view.getUint8(i));
  };
  const bytes = (b: Uint8Array): void => {
    for (const x of b) parts.push(x);
  };
  bytes(Uint8Array.from(LAYOUT_SPEC_MAGIC));
  u16(LAYOUT_SPEC_VERSION);
  u16(0);
  f32(spec.width);
  u32(spec.paragraphs.length);
  for (const p of spec.paragraphs) {
    if (p.text.includes('\n')) throw new RangeError('layout spec: paragraph text contains a line feed');
    let at = 0;
    for (const s of p.spans) {
      if (s.start !== at || s.end < s.start) throw new RangeError(`layout spec: spans must be contiguous (span ${s.start}..${s.end} at ${at})`);
      at = s.end;
    }
    if (at !== p.text.length || p.spans.length === 0) throw new RangeError(`layout spec: spans cover ${at} of ${p.text.length} code units`);
    u8(SPEC_ALIGNS.indexOf(p.align ?? 'start'));
    u8(SPEC_DIRECTIONS.indexOf(p.direction ?? 'auto'));
    f32(p.lineHeight ?? 0);
    f32(p.spaceBefore ?? 0);
    f32(p.spaceAfter ?? 0);
    f32(p.indent ?? 0);
    const text = utf8.encode(p.text);
    u32(text.length);
    bytes(text);
    u32(p.spans.length);
    for (const s of p.spans) {
      u32(s.start);
      u32(s.end);
      const family = utf8.encode(s.family);
      u16(family.length);
      bytes(family);
      f32(s.size);
      f32(s.weight ?? 400);
      u8(s.italic === true ? 1 : 0);
      f32(s.letterSpacing ?? 0);
      u8(s.underline === true ? 1 : 0);
      u8(s.strike === true ? 1 : 0);
      u32(s.brush ?? 0);
      const locale = utf8.encode(s.locale ?? '');
      u8(locale.length);
      bytes(locale);
    }
  }
  return Uint8Array.from(parts);
}

/** CSS family list for font family names (quoted, comma-separated). */
export function familyList(families: readonly string[]): string {
  return families.map((f) => `"${f.replace(/["\\]/g, '')}"`).join(', ');
}
