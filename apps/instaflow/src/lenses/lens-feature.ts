/**
 * A **lens feature** (IF-1.3, D4, D19): how one lens shows the one document tree. Pages and Canvas are
 * two implementations of this interface (`pages-lens.ts`, `canvas-lens.ts`), looked up by lens id from
 * the feature registry. Nothing outside a feature asks which lens is active: the controller calls the
 * current feature, and lens chrome (tools, HUD, panels) comes from the editor spec's variant tables.
 *
 * A feature answers three questions:
 * - `arrange` — where each page frame sits in world space, in the lens's **navigation order**, and
 *   which loose elements it shows;
 * - `focus` — the camera that shows one page;
 * - `overview` — the camera that shows everything the lens shows.
 */
import type { LensContributionId } from '../spec/contributions.js';
import type { NodeId } from '@staticflux/document/v2';
import type { CompositionStructure, LooseElement, Rect } from './structure.js';

export interface PageFrame {
  readonly page: NodeId;
  /** Story index (Pages order), whatever the navigation order. */
  readonly index: number;
  readonly name?: string;
  readonly rect: Rect;
}

export interface LensArrangement {
  readonly lens: LensContributionId;
  /** In navigation order (next / previous page). */
  readonly frames: readonly PageFrame[];
  /** Loose elements the lens shows (Canvas only). */
  readonly loose: readonly LooseElement[];
  /** Union of frames and loose elements; undefined when empty. */
  readonly bounds: Rect | undefined;
}

/** A 2D camera: the world point at the viewport centre and the zoom (device-independent px per unit). */
export interface Camera {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export interface LensFeature {
  readonly lens: LensContributionId;
  arrange(structure: CompositionStructure): LensArrangement;
  focus(frame: PageFrame, viewport: Viewport, current: Camera | undefined): Camera;
  overview(arrangement: LensArrangement, viewport: Viewport): Camera;
}

/** Space around what a camera fits, in viewport px. */
export const FIT_PADDING = 48;
export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 8;

/** Union of rects (undefined for none). */
export function unionRects(rects: readonly Rect[]): Rect | undefined {
  if (rects.length === 0) return undefined;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const clampZoom = (zoom: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

/** The camera that fits `rect` in `viewport` with `padding` px around it (centred). */
export function fitCamera(rect: Rect, viewport: Viewport, padding = FIT_PADDING): Camera {
  const width = Math.max(1, viewport.width - padding * 2);
  const height = Math.max(1, viewport.height - padding * 2);
  const zoom = rect.w <= 0 || rect.h <= 0 ? 1 : Math.min(width / rect.w, height / rect.h);
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, zoom: clampZoom(zoom) };
}

/** Whether `rect` is fully visible through `camera` (with `padding`). */
export function fitsAt(rect: Rect, viewport: Viewport, zoom: number, padding = FIT_PADDING): boolean {
  return rect.w * zoom <= viewport.width - padding * 2 && rect.h * zoom <= viewport.height - padding * 2;
}

/** The frame of a page, if the lens shows it. */
export function frameOf(arrangement: LensArrangement, page: NodeId): PageFrame | undefined {
  return arrangement.frames.find((f) => f.page === page);
}

/** The frame `delta` steps from `page` in navigation order, clamped to the ends (the first frame when `page` is unknown). */
export function stepFrame(arrangement: LensArrangement, page: NodeId | undefined, delta: number): PageFrame | undefined {
  const { frames } = arrangement;
  if (frames.length === 0) return undefined;
  const at = page === undefined ? -1 : frames.findIndex((f) => f.page === page);
  if (at < 0) return delta < 0 ? frames[frames.length - 1] : frames[0];
  return frames[Math.min(frames.length - 1, Math.max(0, at + delta))];
}

/** The frame under a world point (topmost = last in story order). */
export function frameAtPoint(arrangement: LensArrangement, x: number, y: number): PageFrame | undefined {
  let hit: PageFrame | undefined;
  for (const frame of arrangement.frames) {
    const { rect } = frame;
    if (x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h && (hit === undefined || frame.index > hit.index)) hit = frame;
  }
  return hit;
}
