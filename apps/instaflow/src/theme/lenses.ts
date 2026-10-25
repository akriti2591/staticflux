/**
 * The Instaflow **lens palette** (design: Clean Pop, `docs/instaflow/design/README.md`).
 * A lens is a kind of editing; each has a colour, a readable on-colour and a shape, so the
 * kind reads without colour alone (shape) and without text (colour). The logo is the four.
 *
 * Lenses are an Instaflow concept, so the palette lives here, not in the framework theme
 * contract. Kit components take its values as data (`<sf-tag .color .ink>`, decorative marks).
 *
 * Use tangerine/sunflower/mint for shapes and tags only; primary actions use the theme's
 * deep tangerine accent (`themeTokens.color.accent`).
 */

/** Every lens, in display order (logo, switchers). */
export const LENS_IDS = ['layout', 'pixel', 'video', 'flow'] as const;
export type LensId = (typeof LENS_IDS)[number];

/** The shape that marks a lens: square (Layout), circle (Pixel), wide rounded frame (Video), pill (Flow). */
export type LensShape = 'square' | 'circle' | 'frame' | 'pill';

/** Geometry of a lens mark at its default size, in CSS pixels (a circle's radius is half its side, a pill's half its height). */
export interface LensMark {
  readonly width: number;
  readonly height: number;
  readonly radius: number;
}

export interface Lens {
  readonly id: LensId;
  /** Solid lens colour (shapes, type tags, the logo). Never the fill of a primary action. */
  readonly color: string;
  /** Text and icons on `color` (≥ 4.5:1). */
  readonly onColor: string;
  readonly shape: LensShape;
  readonly mark: LensMark;
}

const INK = '#16151A';
const WHITE = '#FFFFFF';

const MARKS: Readonly<Record<LensShape, LensMark>> = {
  square: { width: 10, height: 10, radius: 3 },
  circle: { width: 10, height: 10, radius: 5 },
  frame: { width: 14, height: 9, radius: 3 },
  pill: { width: 14, height: 9, radius: 4.5 },
};

const define = (id: LensId, color: string, onColor: string, shape: LensShape): Lens => Object.freeze({ id, color, onColor, shape, mark: MARKS[shape] });

/** The palette: tangerine square, sunflower circle, blue frame, mint pill. */
export const lensPalette: Readonly<Record<LensId, Lens>> = Object.freeze({
  layout: define('layout', '#FF5C39', INK, 'square'),
  pixel: define('pixel', '#FFC23D', INK, 'circle'),
  video: define('video', '#3D5AFE', WHITE, 'frame'),
  flow: define('flow', '#00B37E', INK, 'pill'),
});

/** The lens for an id. */
export function lensOf(id: LensId): Lens {
  return lensPalette[id];
}

/** Every lens in display order. */
export function lenses(): readonly Lens[] {
  return LENS_IDS.map(lensOf);
}

/**
 * Inline style of a decorative lens mark (`<span aria-hidden="true" style=…>` in a button,
 * segment or row). `scale` multiplies the default size (logo, large tiles).
 */
export function lensMarkStyle(lens: Lens, scale = 1): string {
  const { width, height, radius } = lens.mark;
  return `display:inline-block;flex:none;inline-size:${width * scale}px;block-size:${height * scale}px;border-radius:${radius * scale}px;background:${lens.color}`;
}

/** Props of a solid lens type tag (`<sf-tag .color=${p.color} .ink=${p.ink}>`). */
export function lensTag(lens: Lens): { readonly color: string; readonly ink: string } {
  return { color: lens.color, ink: lens.onColor };
}
