import { describe, expect, it } from 'vitest';
import { StudioIds } from '../spec/studio-contributions.js';
import { FIT_PADDING, fitCamera, fitsAt, frameAtPoint, frameOf, type LensArrangement, MAX_ZOOM, MIN_ZOOM, stepFrame, unionRects } from './lens-feature.js';

const frame = (page: string, index: number, x: number, y = 0) => ({ page, index, rect: { x, y, w: 100, h: 100 } });
const arrangement: LensArrangement = { lens: StudioIds.lens.pages, frames: [frame('a', 0, 0), frame('b', 1, 50), frame('c', 2, 300)], loose: [], bounds: { x: 0, y: 0, w: 400, h: 100 } };

describe('geometry', () => {
  it('unionRects covers every rect, undefined for none', () => {
    expect(unionRects([])).toBeUndefined();
    expect(unionRects([{ x: 0, y: 0, w: 10, h: 10 }, { x: -5, y: 20, w: 5, h: 5 }])).toEqual({ x: -5, y: 0, w: 15, h: 25 });
  });

  it('fitCamera centres the rect with padding and clamps the zoom', () => {
    expect(fitCamera({ x: 0, y: 0, w: 100, h: 50 }, { width: 100 + FIT_PADDING * 2, height: 1000 })).toEqual({ x: 50, y: 25, zoom: 1 });
    expect(fitCamera({ x: 0, y: 0, w: 1, h: 1 }, { width: 10_000, height: 10_000 }).zoom).toBe(MAX_ZOOM);
    expect(fitCamera({ x: 0, y: 0, w: 1e9, h: 1 }, { width: 200, height: 200 }).zoom).toBe(MIN_ZOOM);
    expect(fitCamera({ x: 0, y: 0, w: 0, h: 0 }, { width: 10, height: 10 }).zoom).toBe(1);
  });

  it('fitsAt checks the rect against the padded viewport at a zoom', () => {
    expect(fitsAt({ x: 0, y: 0, w: 100, h: 100 }, { width: 196, height: 196 }, 1)).toBe(true);
    expect(fitsAt({ x: 0, y: 0, w: 100, h: 100 }, { width: 196, height: 196 }, 1.1)).toBe(false);
  });
});

describe('navigation helpers', () => {
  it('frameOf and stepFrame follow navigation order and clamp at the ends', () => {
    expect(frameOf(arrangement, 'b')?.index).toBe(1);
    expect(frameOf(arrangement, 'z')).toBeUndefined();
    expect(stepFrame(arrangement, 'a', 1)?.page).toBe('b');
    expect(stepFrame(arrangement, 'c', 1)?.page).toBe('c');
    expect(stepFrame(arrangement, 'a', -5)?.page).toBe('a');
    expect(stepFrame(arrangement, undefined, 1)?.page).toBe('a');
    expect(stepFrame(arrangement, 'zz', -1)?.page).toBe('c');
    expect(stepFrame({ ...arrangement, frames: [] }, 'a', 1)).toBeUndefined();
  });

  it('frameAtPoint hits the topmost frame, half-open on the far edges', () => {
    expect(frameAtPoint(arrangement, 75, 10)?.page).toBe('b');
    expect(frameAtPoint(arrangement, 10, 10)?.page).toBe('a');
    expect(frameAtPoint(arrangement, 400, 10)).toBeUndefined();
    expect(frameAtPoint(arrangement, 200, 10)).toBeUndefined();
  });
});
