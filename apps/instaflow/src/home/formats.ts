/**
 * Design formats (C0; IF-28.8): what "New design" can start, as data. Each format is a page size and a page count;
 * Studio creates the document from it (`StudioDocumentRef.create`). Home's quick actions and the `new-design`
 * capability take a format id, never a size, so agents and people pick from the same closed list.
 */
import type { LensId } from '../theme/lenses.js';
import type { DesignSize } from './index-record.js';

export const DESIGN_FORMAT_IDS = ['post', 'story', 'carousel', 'slides', 'poster'] as const;
export type DesignFormatId = (typeof DESIGN_FORMAT_IDS)[number];

export interface DesignFormat {
  readonly id: DesignFormatId;
  /** Short name (quick action title, document title prefix). */
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
  post: format('post', 'Instagram post', 'Portrait post · 1080 × 1350', 1080, 1350, 1),
  story: format('story', 'Story or Reel cover', 'Full screen · 1080 × 1920', 1080, 1920, 1),
  carousel: format('carousel', 'Carousel', 'Five swipeable slides · 1080 × 1350', 1080, 1350, 5),
  slides: format('slides', 'Slides', 'Widescreen deck · 1920 × 1080', 1920, 1080, 5),
  poster: format('poster', 'Poster', 'A-series print · 1240 × 1754', 1240, 1754, 1),
});

/** What "New design" starts when no format is chosen. */
export const DEFAULT_DESIGN_FORMAT: DesignFormatId = 'post';

/** The format for an id (the default for an unknown or missing one). */
export function designFormat(id: string | undefined): DesignFormat {
  return (DESIGN_FORMATS as Readonly<Record<string, DesignFormat>>)[id ?? DEFAULT_DESIGN_FORMAT] ?? DESIGN_FORMATS[DEFAULT_DESIGN_FORMAT];
}

/** Every format, in display order. */
export function designFormats(): readonly DesignFormat[] {
  return DESIGN_FORMAT_IDS.map((id) => DESIGN_FORMATS[id]);
}

/** The aspect ratio of a size as CSS (`1080 / 1350`), for previews. */
export function aspectOf(size: DesignSize | undefined): string {
  return size === undefined ? '4 / 5' : `${size.width} / ${size.height}`;
}
