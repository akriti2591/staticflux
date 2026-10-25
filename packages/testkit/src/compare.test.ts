import { describe, expect, it } from 'vitest';
import { compareImages, diffHeatmap, diffImages, RENDER_THRESHOLDS } from './compare.js';
import { boxBlur, createImage, mapPixels, shiftImage, syntheticImage } from './image.js';

describe('diffImages', () => {
  it('reports the max channel delta (any channel, alpha included), its location and differing pixels', () => {
    const a = createImage(4, 2, [10, 10, 10, 255]);
    const b = mapPixels(a, (p, x, y) => (x === 3 && y === 1 ? [10, 10, 10, 200] : x === 0 ? [12, 10, 10, 255] : p));
    const r = diffImages(a, b);
    if (!r.ok) throw r.error;
    expect(r.value.maxChannelDelta).toBe(55);
    expect(r.value.maxDeltaAt).toEqual({ x: 3, y: 1, channel: 3 });
    // Delta 2 in column 0 is within the default tolerance (2); only the alpha pixel differs.
    expect(r.value.differingPixels).toBe(1);
    expect(r.value.differingFraction).toBe(1 / 8);
    expect(r.value.meanAbsDelta).toBeCloseTo((2 * 2 + 55) / 32, 12);
    const strict = diffImages(a, b, { tolerance: 0 });
    expect(strict.ok && strict.value.differingPixels).toBe(3);
  });

  it('is all zeros for identical images', () => {
    const a = syntheticImage('noise', 8, 8);
    expect(diffImages(a, a)).toEqual({ ok: true, value: { maxChannelDelta: 0, maxDeltaAt: null, differingPixels: 0, differingFraction: 0, meanAbsDelta: 0, tolerance: 2 } });
  });

  it('errors on mismatched sizes', () => {
    const r = diffImages(createImage(2, 2), createImage(3, 2));
    expect(!r.ok && r.error.code).toBe('SF-TEST-006');
  });
});

describe('RENDER_THRESHOLDS', () => {
  it('encodes the S1/S7 spike measurements', () => {
    expect(RENDER_THRESHOLDS).toEqual({
      sameBackend: { minSsim: 0.9999, maxChannelDelta: 2 },
      gpuVsCpu: { minSsim: 0.999, maxChannelDelta: 4 },
      crossRasterizer: { minSsim: 0.98, maxChannelDelta: 255, minBlurredSsim: 0.99, blurRadius: 1 },
    });
  });
});

describe('compareImages', () => {
  const gradient = syntheticImage('gradient', 64, 64);

  it('passes identical images under every preset', () => {
    for (const preset of Object.values(RENDER_THRESHOLDS)) {
      const r = compareImages(gradient, gradient, preset);
      expect(r.ok && r.value.pass).toBe(true);
      expect(r.ok && r.value.failures).toEqual([]);
    }
  });

  it('passes ±1 noise (anti-aliasing-level differences) for gpuVsCpu', () => {
    const noisy = mapPixels(gradient, ([r, g, b, a], x, y) => [r + ((x + y) % 3) - 1, g, b, a]);
    const r = compareImages(noisy, gradient, RENDER_THRESHOLDS.gpuVsCpu);
    expect(r.ok && r.value.pass).toBe(true);
  });

  it('catches a one-channel color shift that luma SSIM alone would pass', () => {
    const redShift = mapPixels(gradient, ([r, g, b, a]) => [r + 40, g, b, a]);
    const r = compareImages(redShift, gradient, { minSsim: 0.98, maxChannelDelta: 4 });
    if (!r.ok) throw r.error;
    expect(r.value.ssim).toBeGreaterThan(0.98);
    expect(r.value.pass).toBe(false);
    expect(r.value.failures).toEqual(['max channel delta 40 > 4 at (0, 0) channel R']);
  });

  it('fails a shifted image on SSIM and reports the worst window', () => {
    const rings = syntheticImage('rings', 64, 64);
    const r = compareImages(shiftImage(rings, 2, 1, [0, 0, 0, 255]), rings, RENDER_THRESHOLDS.gpuVsCpu);
    if (!r.ok) throw r.error;
    expect(r.value.pass).toBe(false);
    expect(r.value.failures[0]).toBe('ssim 0.25332 < 0.999');
    expect(r.value.worstWindow.value).toBeLessThan(r.value.ssim);
  });

  it('computes blurred SSIM when configured (cross-rasterizer metric)', () => {
    const rings = syntheticImage('rings', 64, 64);
    const softened = boxBlur(rings, 1);
    const r = compareImages(softened, rings, RENDER_THRESHOLDS.crossRasterizer);
    if (!r.ok) throw r.error;
    expect(r.value.blurredSsim).toBeGreaterThan(r.value.ssim); // blurring both hides edge (AA) differences
    expect(r.value.failures.some((f) => f.startsWith('ssim'))).toBe(true);
    const unblurred = compareImages(rings, rings, RENDER_THRESHOLDS.gpuVsCpu);
    expect(unblurred.ok && unblurred.value.blurredSsim).toBeUndefined();
  });

  it('enforces maxDifferingFraction with its tolerance', () => {
    const half = mapPixels(gradient, ([r, g, b, a], x) => (x < 32 ? [r, g, b + 3, a] : [r, g, b, a]));
    const r = compareImages(half, gradient, { minSsim: 0, maxChannelDelta: 255, maxDifferingFraction: 0.1 });
    expect(r.ok && r.value.failures).toEqual(['differing pixels 0.50000 > 0.1 (delta > 2)']);
    const tolerant = compareImages(half, gradient, { minSsim: 0, maxChannelDelta: 255, maxDifferingFraction: 0.1, tolerance: 3 });
    expect(tolerant.ok && tolerant.value.pass).toBe(true);
  });

  it('propagates image errors', () => {
    const r = compareImages(createImage(8, 8), createImage(9, 8), RENDER_THRESHOLDS.sameBackend);
    expect(!r.ok && r.error.code).toBe('SF-TEST-006');
    const tiny = compareImages(createImage(4, 4), createImage(4, 4), RENDER_THRESHOLDS.sameBackend);
    expect(!tiny.ok && tiny.error.code).toBe('SF-TEST-006');
    expect(compareImages(createImage(4, 4), createImage(4, 4), RENDER_THRESHOLDS.sameBackend, { window: { size: 3 } }).ok).toBe(true);
  });
});

describe('diffHeatmap', () => {
  it('paints differing pixels red (×amplify) over a dimmed expected image', () => {
    const a = createImage(2, 1, [100, 100, 100, 255]);
    const b = mapPixels(a, (p, x) => (x === 1 ? [110, 100, 100, 255] : p));
    const r = diffHeatmap(b, a);
    if (!r.ok) throw r.error;
    expect([...r.value.data]).toEqual([30, 30, 30, 255, 80, 30, 30, 255]);
    const capped = diffHeatmap(b, a, { amplify: 100 });
    expect(capped.ok && capped.value.data[4]).toBe(255);
    const tolerant = diffHeatmap(b, a, { tolerance: 10 });
    expect(tolerant.ok && tolerant.value.data[4]).toBe(30);
    expect(diffHeatmap(a, createImage(1, 1)).ok).toBe(false);
  });
});
