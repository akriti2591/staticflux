/**
 * The **Pages** lens feature (UX §4: "the story: pages in order"): every page at its own size, one
 * after another down a centred column in story order, with no loose elements. Page positions on the
 * canvas are ignored, so reordering the story is all that moves a page here. Focusing a page always
 * fits it (page view); next/previous follow the story.
 */
import { StudioIds } from '../spec/studio-contributions.js';
import { fitCamera, type LensArrangement, type LensFeature, type PageFrame, unionRects } from './lens-feature.js';

/** World units between pages in the column. */
export const PAGES_GAP = 96;

export const pagesLensFeature: LensFeature = Object.freeze<LensFeature>({
  lens: StudioIds.lens.pages,
  arrange(structure): LensArrangement {
    let y = 0;
    const frames: PageFrame[] = structure.pages.map((page) => {
      const frame: PageFrame = { page: page.id, index: page.index, ...(page.name === undefined ? {} : { name: page.name }), rect: { x: -page.width / 2, y, w: page.width, h: page.height } };
      y += page.height + PAGES_GAP;
      return frame;
    });
    return { lens: StudioIds.lens.pages, frames, loose: [], bounds: unionRects(frames.map((f) => f.rect)) };
  },
  focus: (frame, viewport) => fitCamera(frame.rect, viewport),
  overview: (arrangement, viewport) => (arrangement.bounds === undefined ? { x: 0, y: 0, zoom: 1 } : fitCamera(arrangement.bounds, viewport)),
});
