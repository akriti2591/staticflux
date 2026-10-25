/**
 * The **Canvas** lens feature (UX §4, D19 canvas-first): pages at their `page.canvas` positions plus
 * the loose elements. A page not placed yet goes to the right of everything placed, in story order (so
 * a new page never lands on top of another). Navigation is **reading order** (rows top to bottom, left
 * to right within a row), not story order: next/previous move to the frame you would look at next.
 * Focusing a page centres it and keeps the zoom when the page fits at it, else fits the page.
 */
import { StudioIds } from '../spec/studio-contributions.js';
import { fitCamera, fitsAt, type LensArrangement, type LensFeature, type PageFrame, unionRects } from './lens-feature.js';
import type { Rect } from './structure.js';

/** World units between auto-placed pages. */
export const CANVAS_GAP = 160;

/** Sort frames into reading order: a frame starts a new row when its top is below half the row's tallest frame (pure). */
export function readingOrder(frames: readonly PageFrame[]): PageFrame[] {
  const byTop = [...frames].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  const rows: PageFrame[][] = [];
  let rowTop = Number.NEGATIVE_INFINITY;
  let rowHeight = 0;
  for (const frame of byTop) {
    if (rows.length === 0 || frame.rect.y >= rowTop + rowHeight / 2) {
      rows.push([frame]);
      rowTop = frame.rect.y;
      rowHeight = frame.rect.h;
    } else {
      rows[rows.length - 1]?.push(frame);
      rowHeight = Math.max(rowHeight, frame.rect.h);
    }
  }
  return rows.flatMap((row) => row.sort((a, b) => a.rect.x - b.rect.x || a.index - b.index));
}

export const canvasLensFeature: LensFeature = Object.freeze<LensFeature>({
  lens: StudioIds.lens.canvas,
  arrange(structure): LensArrangement {
    const placed = structure.pages.filter((p) => p.canvas !== undefined);
    const placedRects: Rect[] = [...placed.map((p) => ({ x: p.canvas?.x ?? 0, y: p.canvas?.y ?? 0, w: p.width, h: p.height })), ...structure.loose.map((l) => l.box)];
    const extent = unionRects(placedRects);
    let nextX = extent === undefined ? 0 : extent.x + extent.w + CANVAS_GAP;
    const top = extent?.y ?? 0;
    const frames: PageFrame[] = structure.pages.map((page) => {
      const name = page.name === undefined ? {} : { name: page.name };
      if (page.canvas !== undefined) return { page: page.id, index: page.index, ...name, rect: { x: page.canvas.x, y: page.canvas.y, w: page.width, h: page.height } };
      const rect = { x: nextX, y: top, w: page.width, h: page.height };
      nextX += page.width + CANVAS_GAP;
      return { page: page.id, index: page.index, ...name, rect };
    });
    return { lens: StudioIds.lens.canvas, frames: readingOrder(frames), loose: structure.loose, bounds: unionRects([...frames.map((f) => f.rect), ...structure.loose.map((l) => l.box)]) };
  },
  focus(frame, viewport, current) {
    const fitted = fitCamera(frame.rect, viewport);
    if (current === undefined || !fitsAt(frame.rect, viewport, current.zoom)) return fitted;
    return { x: fitted.x, y: fitted.y, zoom: current.zoom };
  },
  overview: (arrangement, viewport) => (arrangement.bounds === undefined ? { x: 0, y: 0, zoom: 1 } : fitCamera(arrangement.bounds, viewport)),
});
