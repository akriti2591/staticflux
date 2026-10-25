// @vitest-environment node
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EMPTY_OVERLAY } from './overlay.js';
import { createViewState, createViewStates, fitCamera, IDENTITY_CAMERA, stepZoom, toPage, toScreen, ZOOM_RANGE, ZOOM_STEPS, zoomAbout } from './view-state.js';

describe('camera maths', () => {
  it('maps screen ↔ page and zooms about a fixed screen point', () => {
    const camera = { tx: 100, ty: -40, zoom: 2 };
    expect(toPage(camera, 300, 160)).toEqual([100, 100]);
    expect(toScreen(camera, 100, 100)).toEqual([300, 160]);
    fc.assert(
      fc.property(fc.double({ min: 0.05, max: 100, noNaN: true }), fc.double({ min: -500, max: 500, noNaN: true }), fc.double({ min: -500, max: 500, noNaN: true }), (zoom, sx, sy) => {
        const before = toPage(camera, sx, sy);
        const after = toPage(zoomAbout(camera, zoom, sx, sy), sx, sy);
        expect(after[0]).toBeCloseTo(before[0], 6);
        expect(after[1]).toBeCloseTo(before[1], 6);
      }),
    );
    expect(zoomAbout(camera, 1e6, 0, 0).zoom).toBe(ZOOM_RANGE.max);
    expect(zoomAbout(camera, 0, 0, 0).zoom).toBe(ZOOM_RANGE.min);
  });

  it('fits a box with padding and steps through the zoom ladder', () => {
    const c = fitCamera({ minX: 0, minY: 0, maxX: 100, maxY: 50 }, { width: 296, height: 296 }, 48);
    expect(c.zoom).toBe(2);
    expect(toScreen(c, 50, 25)).toEqual([148, 148]);
    expect(stepZoom(1, 1)).toBe(1.5);
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(1.2, 1)).toBe(1.5);
    expect(stepZoom(ZOOM_RANGE.max, 1)).toBe(ZOOM_RANGE.max);
    expect(stepZoom(ZOOM_RANGE.min, -1)).toBe(ZOOM_RANGE.min);
    expect([...ZOOM_STEPS].sort((a, b) => a - b)).toEqual(ZOOM_STEPS);
  });
});

describe('per-tab view state (IF-7.2)', () => {
  it('holds camera, selection, context, tool, hover and overlay; rejects bad cameras', () => {
    const v = createViewState({ tab: 't1', root: 'p1' });
    expect(v.camera).toEqual(IDENTITY_CAMERA);
    expect(v.context).toBe('p1');
    expect(v.tool).toBe('instaflow/select');
    expect(v.overlay).toBe(EMPTY_OVERLAY);
    v.select(['a', 'b', 'a']);
    expect(v.selection).toEqual(['a', 'b']);
    v.toggle('a');
    v.toggle('c');
    expect(v.selection).toEqual(['b', 'c']);
    v.clear();
    expect(v.selection).toEqual([]);
    v.setContext('g');
    v.setTool('instaflow/hand');
    v.setHover('x');
    expect([v.context, v.tool, v.hover]).toEqual(['g', 'instaflow/hand', 'x']);
    expect(v.panBy(10, 5).ok).toBe(true);
    expect(v.camera).toEqual({ tx: 10, ty: 5, zoom: 1 });
    v.setViewport(200, 100);
    expect(v.zoomBy(2).ok).toBe(true);
    expect(v.camera.zoom).toBe(2);
    expect(toPage(v.camera, 100, 50)).toEqual(toPage({ tx: 10, ty: 5, zoom: 1 }, 100, 50));
    const bad = v.setCamera({ tx: Number.NaN, ty: 0, zoom: 1 });
    expect(!bad.ok && bad.error.code).toBe('IF-TOOL-003');
    const far = v.setCamera({ tx: 0, ty: 0, zoom: 1000 });
    expect(!far.ok && far.error.details).toMatchObject({ range: ZOOM_RANGE });
    expect(v.zoomBy(-1).ok).toBe(false);
  });

  it('keeps tabs independent and reports unknown tabs', () => {
    const tabs = createViewStates();
    const a = tabs.open({ tab: 'a', root: 'p1' });
    const b = tabs.open({ tab: 'b', root: 'p1', camera: { tx: 0, ty: 0, zoom: 4 } });
    expect(tabs.open({ tab: 'a', root: 'p1' })).toBe(a);
    a.select(['x']);
    void a.panBy(50, 0);
    expect(b.selection).toEqual([]);
    expect(b.camera.zoom).toBe(4);
    expect(tabs.tabs()).toEqual(['a', 'b']);
    expect(tabs.get('b').ok).toBe(true);
    expect(tabs.close('a')).toBe(true);
    const gone = tabs.get('a');
    expect(!gone.ok && gone.error.code).toBe('IF-TOOL-003');
  });
});
