/**
 * The Pages and Canvas lens features: the same structure arranged two ways, with no branch on the lens
 * anywhere (the registry looks the feature up; Pixel/Timeline/Flow fall back to Canvas).
 */
import { describe, expect, it } from 'vitest';
import { StudioIds } from '../spec/studio-contributions.js';
import { CANVAS_GAP, canvasLensFeature, readingOrder } from './canvas-lens.js';
import { fitCamera } from './lens-feature.js';
import { createLensFeatureRegistry, lensFeatureContribution, LensFeaturesToken } from './lens-features.js';
import { PAGES_GAP, pagesLensFeature } from './pages-lens.js';
import type { CompositionStructure } from './structure.js';

const structure: CompositionStructure = {
  composition: 'comp',
  format: { width: 100, height: 200 },
  pages: [
    { id: 'p1', index: 0, name: 'Cover', width: 100, height: 200, canvas: { x: 500, y: 0 } },
    { id: 'p2', index: 1, width: 100, height: 100, canvas: { x: 0, y: 0 } },
    { id: 'p3', index: 2, width: 100, height: 200, canvas: { x: 0, y: 400 } },
    { id: 'p4', index: 3, width: 50, height: 50 },
  ],
  loose: [{ id: 'sticker', kind: 'shape', box: { x: -200, y: 0, w: 10, h: 10 } }],
};
const viewport = { width: 1000, height: 800 };

// Invariants every lens feature keeps (the shared suite for the `LensFeature` port).
describe.each([
  ['Pages', pagesLensFeature],
  ['Canvas', canvasLensFeature],
])('LensFeature contract: %s', (_name, feature) => {
  it('shows every page exactly once at its size, with its story index, inside the bounds', () => {
    const a = feature.arrange(structure);
    expect(a.lens).toBe(feature.lens);
    expect(a.frames.map((f) => f.page).sort()).toEqual(structure.pages.map((p) => p.id).sort());
    for (const page of structure.pages) {
      const f = a.frames.find((x) => x.page === page.id);
      expect([f?.index, f?.rect.w, f?.rect.h]).toEqual([page.index, page.width, page.height]);
      const b = a.bounds ?? { x: 0, y: 0, w: 0, h: 0 };
      expect(f !== undefined && f.rect.x >= b.x && f.rect.y >= b.y && f.rect.x + f.rect.w <= b.x + b.w && f.rect.y + f.rect.h <= b.y + b.h).toBe(true);
    }
    expect(feature.arrange(structure)).toEqual(a); // deterministic
  });

  it('focus centres the page and keeps it in view; overview centres the bounds', () => {
    const a = feature.arrange(structure);
    for (const f of a.frames) {
      const camera = feature.focus(f, viewport, undefined);
      expect([camera.x, camera.y]).toEqual([f.rect.x + f.rect.w / 2, f.rect.y + f.rect.h / 2]);
      expect(f.rect.w * camera.zoom <= viewport.width && f.rect.h * camera.zoom <= viewport.height).toBe(true);
    }
    const overview = feature.overview(a, viewport);
    const b = a.bounds ?? { x: 0, y: 0, w: 0, h: 0 };
    expect([overview.x, overview.y]).toEqual([b.x + b.w / 2, b.y + b.h / 2]);
  });

  it('arranges an empty composition as nothing', () => {
    const a = feature.arrange({ ...structure, pages: [], loose: [] });
    expect([a.frames, a.loose, a.bounds]).toEqual([[], [], undefined]);
  });
});

describe('pagesLensFeature', () => {
  it('stacks pages in story order down a centred column, at their own sizes, without loose elements', () => {
    const a = pagesLensFeature.arrange(structure);
    expect(a.lens).toBe(StudioIds.lens.pages);
    expect(a.frames.map((f) => [f.page, f.rect])).toEqual([
      ['p1', { x: -50, y: 0, w: 100, h: 200 }],
      ['p2', { x: -50, y: 200 + PAGES_GAP, w: 100, h: 100 }],
      ['p3', { x: -50, y: 300 + 2 * PAGES_GAP, w: 100, h: 200 }],
      ['p4', { x: -25, y: 500 + 3 * PAGES_GAP, w: 50, h: 50 }],
    ]);
    expect(a.frames[0]?.name).toBe('Cover');
    expect(a.loose).toEqual([]);
    expect(a.bounds).toEqual({ x: -50, y: 0, w: 100, h: 550 + 3 * PAGES_GAP });
  });

  it('always fits the focused page; overview fits the column', () => {
    const a = pagesLensFeature.arrange(structure);
    const p2 = a.frames[1];
    if (p2 === undefined) throw new Error('no frame');
    expect(pagesLensFeature.focus(p2, viewport, { x: 0, y: 0, zoom: 0.1 })).toEqual(fitCamera(p2.rect, viewport));
    expect(pagesLensFeature.overview(a, viewport)).toEqual(fitCamera(a.bounds ?? p2.rect, viewport));
    expect(pagesLensFeature.overview({ ...a, frames: [], bounds: undefined }, viewport)).toEqual({ x: 0, y: 0, zoom: 1 });
  });
});

describe('canvasLensFeature', () => {
  it('places pages at their canvas positions, unplaced ones to the right, with loose elements, in reading order', () => {
    const a = canvasLensFeature.arrange(structure);
    expect(a.lens).toBe(StudioIds.lens.canvas);
    expect(a.frames.map((f) => f.page)).toEqual(['p2', 'p1', 'p4', 'p3']);
    expect(a.frames.find((f) => f.page === 'p4')?.rect).toEqual({ x: 600 + CANVAS_GAP, y: 0, w: 50, h: 50 });
    expect(a.loose.map((l) => l.id)).toEqual(['sticker']);
    expect(a.bounds).toEqual({ x: -200, y: 0, w: 850 + CANVAS_GAP, h: 600 });
  });

  it('auto-places from the origin when nothing is placed', () => {
    const a = canvasLensFeature.arrange({ ...structure, pages: structure.pages.map(({ canvas: _c, ...p }) => p), loose: [] });
    expect(a.frames.map((f) => f.rect.x)).toEqual([0, 100 + CANVAS_GAP, 200 + 2 * CANVAS_GAP, 300 + 3 * CANVAS_GAP]);
  });

  it('keeps the zoom when the page fits at it, otherwise fits it; overview fits everything', () => {
    const a = canvasLensFeature.arrange(structure);
    const p1 = a.frames.find((f) => f.page === 'p1');
    if (p1 === undefined) throw new Error('no frame');
    expect(canvasLensFeature.focus(p1, viewport, { x: 9, y: 9, zoom: 1 })).toEqual({ x: 550, y: 100, zoom: 1 });
    expect(canvasLensFeature.focus(p1, viewport, { x: 9, y: 9, zoom: 10 })).toEqual(fitCamera(p1.rect, viewport));
    expect(canvasLensFeature.focus(p1, viewport, undefined)).toEqual(fitCamera(p1.rect, viewport));
    expect(canvasLensFeature.overview(a, viewport)).toEqual(fitCamera(a.bounds ?? p1.rect, viewport));
    expect(canvasLensFeature.overview({ ...a, bounds: undefined }, viewport)).toEqual({ x: 0, y: 0, zoom: 1 });
  });
});

describe('readingOrder', () => {
  it('groups frames into rows by their tops and orders each row left to right', () => {
    const f = (page: string, x: number, y: number, h = 100, index = 0) => ({ page, index, rect: { x, y, w: 100, h } });
    expect(readingOrder([f('c', 0, 300), f('b', 200, 40), f('a', 0, 0), f('d', 200, 320)]).map((x) => x.page)).toEqual(['a', 'b', 'c', 'd']);
    expect(readingOrder([f('x', 0, 0, 100, 2), f('y', 0, 0, 100, 1)]).map((x) => x.page)).toEqual(['y', 'x']);
    expect(readingOrder([])).toEqual([]);
  });
});

describe('createLensFeatureRegistry', () => {
  it('looks features up by lens and falls back to Canvas for lenses without one (D19)', () => {
    const registry = createLensFeatureRegistry([pagesLensFeature, canvasLensFeature]);
    expect(registry.ok && registry.value.feature(StudioIds.lens.pages)).toBe(pagesLensFeature);
    expect(registry.ok && registry.value.feature(StudioIds.lens.pixel)).toBe(canvasLensFeature);
    expect(registry.ok && [registry.value.lenses, registry.value.fallback]).toEqual([[StudioIds.lens.pages, StudioIds.lens.canvas], StudioIds.lens.canvas]);
  });

  it('rejects duplicates and a missing fallback with IF-LIB-012', () => {
    const duplicate = createLensFeatureRegistry([canvasLensFeature, canvasLensFeature]);
    expect(!duplicate.ok && duplicate.error.code).toBe('IF-LIB-012');
    const noFallback = createLensFeatureRegistry([pagesLensFeature]);
    expect(!noFallback.ok && noFallback.error.code).toBe('IF-LIB-012');
  });

  it('lensFeatureContribution contributes to the multi token', () => {
    const unit = lensFeatureContribution(pagesLensFeature);
    expect(unit.provides).toBe(LensFeaturesToken);
    expect(unit.id).toBe(`${StudioIds.lens.pages}-feature`);
  });
});
