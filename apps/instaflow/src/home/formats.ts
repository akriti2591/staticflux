/**
 * Design formats (C0; IF-28.8; B11b HOME-FILES §1.2–§1.3): what "New design" can start, as data. Each format is a page
 * size and a page count; Studio creates the document from it (`StudioDocumentRef.create`). Home's quick actions, the
 * hero's format row, the New design dialog's chips and the `new-design` capability pick from this closed list; the
 * dialog's `custom` format carries its own size (1…16 384 px a side, `DESIGN_SIZE_LIMITS`).
 *
 * Print sizes are at 96 px per inch (the canvas unit; HOME-FILES §1.3: mm and in convert at 96 px/in).
 */
import type { LensId } from '../theme/lenses.js';
import type { DesignSize } from './index-record.js';

export const DESIGN_FORMAT_IDS = ['post', 'story', 'landscape', 'slides', 'poster', 'letter', 'carousel'] as const;
export type DesignFormatId = (typeof DESIGN_FORMAT_IDS)[number];

/** The New design dialog's own size (W × H typed or from a preset). */
export const CUSTOM_FORMAT = 'custom';
export const NEW_DESIGN_FORMAT_IDS = [...DESIGN_FORMAT_IDS, CUSTOM_FORMAT] as const;
export type NewDesignFormatId = (typeof NEW_DESIGN_FORMAT_IDS)[number];

/** A side of a new design (HOME-FILES §1.3: `Too large for this device (max 16 384 px)`). */
export const DESIGN_SIZE_LIMITS = Object.freeze({ min: 1, max: 16_384 });
/** Pages of a new design (`More ▾ › Pages`). */
export const DESIGN_PAGE_LIMITS = Object.freeze({ min: 1, max: 50 });

export interface DesignFormat {
  readonly id: DesignFormatId;
  /** Short name (quick action title, chip, document title prefix). */
  readonly title: string;
  /** One line under the title: what it is for and its size. */
  readonly detail: string;
  readonly size: DesignSize;
  readonly pages: number;
  /** The lens the format opens in (its mark on Home). */
  readonly lens: LensId;
}

const format = (id: DesignFormatId, title: string, detail: string, width: number, height: number, pages: number): DesignFormat =>
  Object.freeze({ id, title, detail, size: Object.freeze({ width, height }), pages, lens: 'layout' as const });

export const DESIGN_FORMATS: Readonly<Record<DesignFormatId, DesignFormat>> = Object.freeze({
  post: format('post', 'Post', 'Square post · 1080 × 1080', 1080, 1080, 1),
  story: format('story', 'Story', 'Story or Reel cover · 1080 × 1920', 1080, 1920, 1),
  landscape: format('landscape', 'Landscape', 'Widescreen image · 1920 × 1080', 1920, 1080, 1),
  slides: format('slides', 'Slide 16:9', 'Widescreen deck · 1920 × 1080', 1920, 1080, 5),
  poster: format('poster', 'Poster A4', 'A4 print · 794 × 1123', 794, 1123, 1),
  letter: format('letter', 'Letter', 'US Letter print · 816 × 1056', 816, 1056, 1),
  carousel: format('carousel', 'Carousel', 'Five swipeable slides · 1080 × 1350', 1080, 1350, 5),
});

/** What "New design" starts when no format is chosen. */
export const DEFAULT_DESIGN_FORMAT: DesignFormatId = 'post';

/** The New design dialog's chips and the hero's format row, in the spec's order (HOME-FILES §1.2–§1.3). */
export const NEW_DESIGN_CHIPS: readonly DesignFormatId[] = Object.freeze(['post', 'story', 'landscape', 'slides', 'poster', 'letter']);

/** The format for an id (the default for an unknown or missing one). */
export function designFormat(id: string | undefined): DesignFormat {
  return (DESIGN_FORMATS as Readonly<Record<string, DesignFormat>>)[id ?? DEFAULT_DESIGN_FORMAT] ?? DESIGN_FORMATS[DEFAULT_DESIGN_FORMAT];
}

/** Every format, in display order. */
export function designFormats(): readonly DesignFormat[] {
  return DESIGN_FORMAT_IDS.map((id) => DESIGN_FORMATS[id]);
}

/** The chip a size matches (`custom` when none does). */
export function formatOfSize(size: DesignSize): NewDesignFormatId {
  return NEW_DESIGN_CHIPS.find((id) => DESIGN_FORMATS[id].size.width === size.width && DESIGN_FORMATS[id].size.height === size.height) ?? CUSTOM_FORMAT;
}

/** The aspect ratio of a size as CSS (`1080 / 1350`), for previews. */
export function aspectOf(size: DesignSize | undefined): string {
  return size === undefined ? '4 / 5' : `${size.width} / ${size.height}`;
}

/** `1080` → `1 080` (HOME-FILES' chips and the presets menu). */
export function groupDigits(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
