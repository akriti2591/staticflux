import { describe, expect, it } from 'vitest';
import { boxBlur, createImage, mapPixels, shiftImage, syntheticImage } from './image.js';
import { gaussianKernel, ssim, SSIM_DEFAULTS } from './ssim.js';

const C1 = (0.01 * 255) ** 2; // 6.5025
const C2 = (0.03 * 255) ** 2; // 58.5225

function value(r: ReturnType<typeof ssim>): number {
  if (!r.ok) throw r.error;
  return r.value.mssim;
}

describe('gaussianKernel', () => {
  it('is the normalized 11-tap σ = 1.5 Gaussian of the SSIM paper', () => {
    expect(SSIM_DEFAULTS).toEqual({ windowSize: 11, sigma: 1.5, k1: 0.01, k2: 0.03, dynamicRange: 255 });
    const k = gaussianKernel();
    expect(k.length).toBe(11);
    expect(k.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 12);
    for (let i = 0; i < 5; i++) expect(k[i]).toBeCloseTo(k[10 - i]!, 15);
    expect(k[5]).toBeCloseTo(0.2660117, 7);
    // 2-D center weight = MATLAB fspecial('gaussian', 11, 1.5) center ≈ 0.0708.
    expect(k[5]! * k[5]!).toBeCloseTo(0.070762, 6);
  });

  it('rejects even or non-positive sizes and sigma ≤ 0', () => {
    expect(() => gaussianKernel(10, 1.5)).toThrow(expect.objectContaining({ code: 'SF-TEST-006' }));
    expect(() => gaussianKernel(0, 1.5)).toThrow(expect.objectContaining({ code: 'SF-TEST-006' }));
    expect(() => gaussianKernel(11, 0)).toThrow(expect.objectContaining({ code: 'SF-TEST-006' }));
  });
});

describe('ssim — analytic values', () => {
  it('is exactly 1 for identical images', () => {
    const image = syntheticImage('noise', 32, 32, { seed: 5 });
    const r = ssim(image, image);
    expect(r.ok && r.value.mssim).toBe(1);
    expect(r.ok && r.value.worst.value).toBe(1);
  });

  it('reduces to the luminance term for two flat images: (2ab + C1) / (a² + b² + C1)', () => {
    const a = createImage(16, 16, [100, 100, 100, 255]);
    const b = createImage(16, 16, [110, 110, 110, 255]);
    const expected = (2 * 100 * 110 + C1) / (100 ** 2 + 110 ** 2 + C1);
    expect(value(ssim(a, b))).toBeCloseTo(expected, 12);
    expect(expected).toBeCloseTo(0.9954764, 7);
    // Black vs white: C1 / (255² + C1).
    expect(value(ssim(createImage(11, 11, [0, 0, 0, 255]), createImage(11, 11, [255, 255, 255, 255])))).toBeCloseTo(C1 / (255 ** 2 + C1), 12);
  });

  it('approaches −1 when structure flips (inverted 1-px checker: same means and contrast, covariance −σ²)', () => {
    const checker = syntheticImage('checker', 21, 21, { cell: 1 });
    const inverted = mapPixels(checker, ([r, g, b, a]) => [255 - r, 255 - g, 255 - b, a]);
    const r = ssim(checker, inverted);
    expect(r.ok && r.value.mssim).toBeLessThan(-0.9);
    expect(r.ok && r.value.mssim).toBeGreaterThanOrEqual(-1);
    expect(C2).toBeCloseTo(58.5225, 10);
  });

  it('is symmetric', () => {
    const a = syntheticImage('rings', 40, 40);
    const b = boxBlur(a, 1);
    expect(value(ssim(a, b))).toBeCloseTo(value(ssim(b, a)), 14);
  });
});

/**
 * Pinned against an independent NumPy implementation (direct 2-D Gaussian window via sliding windows,
 * no separable filtering) on the same synthetic images; agreement was < 1e-14 on every case.
 */
describe('ssim — pinned reference values', () => {
  const noise = syntheticImage('noise', 48, 48, { seed: 7 });
  const rings = syntheticImage('rings', 64, 64, { cell: 4 });
  const gradient = syntheticImage('gradient', 64, 64);
  const checker = syntheticImage('checker', 32, 32, { cell: 4 });
  const redShift = mapPixels(gradient, ([r, g, b, a]) => [r + 40, g, b, a]);

  it('shifted: 1 px of noise decorrelates completely; 2×1 px of rings drops to 0.25', () => {
    expect(value(ssim(noise, shiftImage(noise, 1, 0, [0, 0, 0, 255])))).toBeCloseTo(-0.0313808444, 9);
    expect(value(ssim(rings, shiftImage(rings, 2, 1, [0, 0, 0, 255])))).toBeCloseTo(0.253324719, 9);
  });

  it('blurred (3×3 box)', () => {
    expect(value(ssim(rings, boxBlur(rings, 1)))).toBeCloseTo(0.8221997061, 9);
    expect(value(ssim(checker, boxBlur(checker, 1)))).toBeCloseTo(0.6674648398, 9);
  });

  it('color-shifted (+40 red): luma SSIM barely notices; per-channel SSIM does', () => {
    expect(value(ssim(gradient, redShift))).toBeCloseTo(0.9902904262, 9);
    const rgb = ssim(gradient, redShift, { channels: 'rgb' });
    expect(rgb.ok && rgb.value.mssim).toBeCloseTo(0.9646428066, 9);
    expect(rgb.ok && rgb.value.perChannel[0]).toBeCloseTo(0.8939284198, 9);
    expect(rgb.ok && rgb.value.perChannel.slice(1)).toEqual([1, 1]);
    const noiseRgb = ssim(noise, mapPixels(noise, ([r, g, b, a]) => [r + 40, g, b, a]), { channels: 'rgb' });
    expect(noiseRgb.ok && noiseRgb.value.mssim).toBeCloseTo(0.9862585978, 9);
  });
});

describe('ssim — report and options', () => {
  it('reports the map size and the worst window center', () => {
    const base = createImage(40, 30, [128, 128, 128, 255]);
    const spot = mapPixels(base, (p, x, y) => (x >= 30 && x < 34 && y >= 4 && y < 8 ? [255, 255, 255, 255] : p));
    const r = ssim(base, spot);
    if (!r.ok) throw r.error;
    expect([r.value.mapWidth, r.value.mapHeight, r.value.map.length]).toEqual([30, 20, 600]);
    expect(Math.abs(r.value.worst.x - 31.5)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(r.value.worst.y - 5.5)).toBeLessThanOrEqual(1.5);
    expect(r.value.worst.value).toBeLessThan(r.value.mssim);
  });

  it('composites translucency over the background before comparing', () => {
    const transparent = createImage(12, 12, [0, 0, 0, 0]);
    const white = createImage(12, 12, [255, 255, 255, 255]);
    expect(value(ssim(transparent, white))).toBe(1);
    expect(value(ssim(transparent, white, { background: [0, 0, 0] }))).toBeLessThan(0.01);
  });

  it('accepts a smaller window for tiny images', () => {
    const a = syntheticImage('gradient', 8, 8);
    const tooSmall = ssim(a, a);
    expect(!tooSmall.ok && tooSmall.error.code).toBe('SF-TEST-006');
    expect(!tooSmall.ok && tooSmall.error.message).toContain('smaller than the 11×11 SSIM window');
    expect(value(ssim(a, a, { window: { size: 7, sigma: 1 } }))).toBe(1);
    const even = ssim(a, a, { window: { size: 6 } });
    expect(!even.ok && even.error.code).toBe('SF-TEST-006');
  });

  it('honours custom constants', () => {
    const a = createImage(11, 11, [100, 100, 100, 255]);
    const b = createImage(11, 11, [110, 110, 110, 255]);
    const c1 = (0.05 * 255) ** 2;
    expect(value(ssim(a, b, { k1: 0.05 }))).toBeCloseTo((2 * 100 * 110 + c1) / (100 ** 2 + 110 ** 2 + c1), 12);
  });

  it('returns errors for malformed or mismatched images', () => {
    const mismatch = ssim(createImage(12, 12), createImage(12, 13));
    expect(!mismatch.ok && mismatch.error.code).toBe('SF-TEST-006');
    const malformed = ssim({ width: 12, height: 12, data: new Uint8Array(3) }, createImage(12, 12));
    expect(!malformed.ok && malformed.error.code).toBe('SF-TEST-006');
  });
});
