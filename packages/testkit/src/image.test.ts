import { describe, expect, it } from 'vitest';
import { boxBlur, channelPlane, createImage, LUMA_WEIGHTS, mapPixels, mulberry32, shiftImage, syntheticImage, validateImage, validatePair, type RgbaImage } from './image.js';

const px = (image: RgbaImage, x: number, y: number): number[] => [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];

describe('validateImage / validatePair', () => {
  it('accepts width × height × 4 bytes', () => {
    const image = createImage(3, 2);
    expect(validateImage(image)).toEqual({ ok: true, value: image });
  });

  it('rejects bad dimensions and wrong buffer lengths with SF-TEST-006', () => {
    const zero = validateImage({ width: 0, height: 2, data: new Uint8Array(0) });
    const fractional = validateImage({ width: 1.5, height: 2, data: new Uint8Array(12) });
    const short = validateImage({ width: 2, height: 2, data: new Uint8Array(15) }, 'golden');
    for (const r of [zero, fractional, short]) expect(!r.ok && r.error.code).toBe('SF-TEST-006');
    expect(!short.ok && short.error.message).toContain('golden: data has 15 bytes, expected width × height × 4 = 16');
  });

  it('requires equal sizes for a pair', () => {
    expect(validatePair(createImage(2, 2), createImage(2, 2)).ok).toBe(true);
    const r = validatePair(createImage(2, 2), createImage(2, 3));
    expect(!r.ok && r.error.message).toBe('Images differ in size: 2×2 vs 2×3.');
  });
});

describe('createImage / mapPixels / shiftImage', () => {
  it('fills with a color (default transparent black)', () => {
    expect(px(createImage(1, 1), 0, 0)).toEqual([0, 0, 0, 0]);
    expect(px(createImage(2, 1, [1, 2, 3, 4]), 1, 0)).toEqual([1, 2, 3, 4]);
    expect(() => createImage(0, 1)).toThrow(expect.objectContaining({ code: 'SF-TEST-006' }));
  });

  it('maps pixels with coordinates, clamping and rounding results', () => {
    const out = mapPixels(createImage(2, 1, [10, 10, 10, 255]), ([r, g, b, a], x) => [r + x * 300, g - 20, b + 0.6, a]);
    expect(px(out, 0, 0)).toEqual([10, 0, 11, 255]);
    expect(px(out, 1, 0)).toEqual([255, 0, 11, 255]);
  });

  it('shifts by whole pixels and fills uncovered pixels', () => {
    const image = mapPixels(createImage(3, 1), (_p, x) => [x * 10, 0, 0, 255]);
    const right = shiftImage(image, 1, 0, [9, 9, 9, 9]);
    expect([px(right, 0, 0), px(right, 1, 0), px(right, 2, 0)]).toEqual([
      [9, 9, 9, 9],
      [0, 0, 0, 255],
      [10, 0, 0, 255],
    ]);
    expect(px(shiftImage(image, -1, 0), 2, 0)).toEqual([0, 0, 0, 0]);
  });
});

describe('boxBlur', () => {
  it('averages a (2r+1)² window with clamped edges', () => {
    const dot = mapPixels(createImage(5, 5, [0, 0, 0, 255]), (p, x, y) => (x === 2 && y === 2 ? [255, 90, 9, 255] : p));
    const blurred = boxBlur(dot, 1);
    expect(px(blurred, 2, 2)).toEqual([28, 10, 1, 255]); // 255/9 = 28.3, 90/9 = 10, 9/9 = 1
    expect(px(blurred, 1, 1)).toEqual([28, 10, 1, 255]);
    expect(px(blurred, 0, 0)).toEqual([0, 0, 0, 255]);
    // Edge clamping: a uniform image stays uniform.
    expect(boxBlur(createImage(3, 3, [7, 7, 7, 7]), 2).data.every((v) => v === 7)).toBe(true);
  });

  it('radius 0 copies; negative radius throws', () => {
    const image = createImage(2, 2, [1, 2, 3, 4]);
    const copy = boxBlur(image, 0);
    expect(copy.data).toEqual(image.data);
    expect(copy.data).not.toBe(image.data);
    expect(() => boxBlur(image, -1)).toThrow(expect.objectContaining({ code: 'SF-TEST-006' }));
  });
});

describe('channelPlane', () => {
  it('computes Rec. 601 luma and composites translucent pixels over the background', () => {
    expect(LUMA_WEIGHTS).toEqual([0.299, 0.587, 0.114]);
    const red = createImage(1, 1, [255, 0, 0, 255]);
    expect(channelPlane(red, 'luma')[0]).toBeCloseTo(0.299 * 255, 10);
    const halfRed = createImage(1, 1, [255, 0, 0, 51]); // α = 0.2
    expect(channelPlane(halfRed, 0, [0, 0, 0])[0]).toBeCloseTo(51, 10);
    expect(channelPlane(halfRed, 1)[0]).toBeCloseTo(204, 10); // green over white: 0·0.2 + 255·0.8
    expect(channelPlane(createImage(1, 1), 'luma', [10, 10, 10])[0]).toBeCloseTo(10, 10);
  });
});

describe('syntheticImage / mulberry32', () => {
  it('follows the documented formulas', () => {
    const g = syntheticImage('gradient', 5, 3);
    expect(px(g, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(px(g, 4, 2)).toEqual([255, 255, 255, 255]);
    expect(px(g, 2, 1)).toEqual([127, 127, 127, 255]); // ⌊255·2/4⌋, ⌊255·1/2⌋, ⌊255·3/6⌋
    const c = syntheticImage('checker', 8, 8, { cell: 2 });
    expect([px(c, 0, 0)[0], px(c, 2, 0)[0], px(c, 2, 2)[0]]).toEqual([255, 0, 255]);
    const r = syntheticImage('rings', 9, 9, { cell: 2 });
    expect([px(r, 4, 4)[0], px(r, 6, 4)[0], px(r, 8, 4)[0]]).toEqual([255, 32, 255]);
  });

  it('is seeded and reproducible (mulberry32 reference values)', () => {
    const random = mulberry32(1);
    expect(random()).toBeCloseTo(0.6270739405881613, 15);
    expect(random()).toBeCloseTo(0.002735721180215478, 15);
    const a = syntheticImage('noise', 4, 4, { seed: 3 });
    expect(syntheticImage('noise', 4, 4, { seed: 3 }).data).toEqual(a.data);
    expect(syntheticImage('noise', 4, 4, { seed: 4 }).data).not.toEqual(a.data);
    expect(px(syntheticImage('noise', 1, 1, { seed: 1 }), 0, 0)).toEqual([160, 0, 135, 255]); // cross-checked with an independent Python port
  });
});
