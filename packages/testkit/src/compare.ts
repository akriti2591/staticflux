/**
 * Image comparison for render tests: SSIM (perceptual structure) plus exact per-channel deltas.
 * SSIM alone misses a uniform color shift on one channel (luma barely moves); a max channel delta alone
 * fails on harmless anti-aliasing. A comparison passes only when every configured threshold holds.
 */
import { ok, type Result, type SfError } from '@staticflux/core';
import { boxBlur, validatePair, type RgbaImage } from './image.js';
import { ssim, type SsimOptions } from './ssim.js';

export interface PixelDiff {
  /** Largest absolute difference on any channel (R, G, B or A), 0–255. */
  readonly maxChannelDelta: number;
  /** Where the largest delta is (first occurrence in row-major order); `channel` 0–3 = R, G, B, A. */
  readonly maxDeltaAt: { readonly x: number; readonly y: number; readonly channel: number } | null;
  /** Pixels with any channel delta above `tolerance`. */
  readonly differingPixels: number;
  readonly differingFraction: number;
  /** Mean absolute delta over all channels of all pixels. */
  readonly meanAbsDelta: number;
  readonly tolerance: number;
}

/** Exact per-channel difference. `tolerance` (default 2, as the S1 spike's "diff > 2") decides which pixels count as differing. */
export function diffImages(a: RgbaImage, b: RgbaImage, options: { readonly tolerance?: number } = {}): Result<PixelDiff, SfError> {
  const pair = validatePair(a, b);
  if (!pair.ok) return pair;
  const tolerance = options.tolerance ?? 2;
  let max = 0;
  let at: PixelDiff['maxDeltaAt'] = null;
  let differing = 0;
  let total = 0;
  const pixels = a.width * a.height;
  for (let p = 0; p < pixels; p++) {
    let pixelMax = 0;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(a.data[p * 4 + c]! - b.data[p * 4 + c]!);
      total += d;
      if (d > pixelMax) pixelMax = d;
      if (d > max) {
        max = d;
        at = { x: p % a.width, y: Math.floor(p / a.width), channel: c };
      }
    }
    if (pixelMax > tolerance) differing++;
  }
  return ok({ maxChannelDelta: max, maxDeltaAt: at, differingPixels: differing, differingFraction: differing / pixels, meanAbsDelta: total / (pixels * 4), tolerance });
}

export interface ImageThresholds {
  /** Minimum MSSIM (default options: luma, 11×11 Gaussian σ 1.5). */
  readonly minSsim: number;
  /** Maximum absolute delta on any channel. */
  readonly maxChannelDelta: number;
  /** Optional: maximum fraction of pixels with any delta above `tolerance`. */
  readonly maxDifferingFraction?: number;
  /** Delta at or below which a pixel does not count as differing. Default 2. */
  readonly tolerance?: number;
  /** Optional: minimum MSSIM after a box blur of `blurRadius` (default 1 → 3×3) on both images. */
  readonly minBlurredSsim?: number;
  readonly blurRadius?: number;
}

/**
 * Threshold presets, from measurements in the S1/S7 render spike (apps/instaflow/spikes/s1-s7-render):
 * - `sameBackend`: one rasterizer against its own earlier output (goldens). Tiled vs full raster measured
 *   max delta 1, SSIM 1.0, so anything beyond that is a real change.
 * - `gpuVsCpu`: Vello GPU vs `vello_cpu` reference. Measured SSIM min 0.99955 over 200 scenes, max delta 4;
 *   the spike recommends gating at SSIM ≥ 0.999.
 * - `crossRasterizer`: our SVG/PDF rendered by another rasterizer (Chrome, resvg, poppler) vs `vello_cpu`.
 *   Anti-aliasing alone fails 0.99, so the S7 recommendation: SSIM ≥ 0.98 plus SSIM-after-3×3-blur ≥ 0.99.
 *   Max delta is unbounded (edge pixels differ freely); missing content shows in the blurred SSIM.
 */
export const RENDER_THRESHOLDS = {
  sameBackend: { minSsim: 0.9999, maxChannelDelta: 2 },
  gpuVsCpu: { minSsim: 0.999, maxChannelDelta: 4 },
  crossRasterizer: { minSsim: 0.98, maxChannelDelta: 255, minBlurredSsim: 0.99, blurRadius: 1 },
} as const satisfies Record<string, ImageThresholds>;

export interface ImageComparison {
  readonly pass: boolean;
  /** One line per failed threshold, e.g. `ssim 0.9871 < 0.999`. Empty when `pass`. */
  readonly failures: readonly string[];
  readonly ssim: number;
  readonly worstWindow: { readonly value: number; readonly x: number; readonly y: number };
  readonly blurredSsim: number | undefined;
  readonly diff: PixelDiff;
  readonly thresholds: ImageThresholds;
}

/** Compare `actual` against `expected` with SSIM, channel deltas and (optionally) blurred SSIM. */
export function compareImages(actual: RgbaImage, expected: RgbaImage, thresholds: ImageThresholds, ssimOptions: SsimOptions = {}): Result<ImageComparison, SfError> {
  const tolerance = thresholds.tolerance ?? 2;
  const diff = diffImages(actual, expected, { tolerance });
  if (!diff.ok) return diff;
  const structural = ssim(actual, expected, ssimOptions);
  if (!structural.ok) return structural;
  let blurredSsim: number | undefined;
  if (thresholds.minBlurredSsim !== undefined) {
    const radius = thresholds.blurRadius ?? 1;
    const blurred = ssim(boxBlur(actual, radius), boxBlur(expected, radius), ssimOptions);
    if (!blurred.ok) return blurred;
    blurredSsim = blurred.value.mssim;
  }
  const failures: string[] = [];
  const s = structural.value.mssim;
  if (s < thresholds.minSsim) failures.push(`ssim ${fmt(s)} < ${thresholds.minSsim}`);
  if (diff.value.maxChannelDelta > thresholds.maxChannelDelta) {
    const at = diff.value.maxDeltaAt;
    failures.push(`max channel delta ${diff.value.maxChannelDelta} > ${thresholds.maxChannelDelta}${at ? ` at (${at.x}, ${at.y}) channel ${'RGBA'[at.channel]}` : ''}`);
  }
  if (thresholds.maxDifferingFraction !== undefined && diff.value.differingFraction > thresholds.maxDifferingFraction) {
    failures.push(`differing pixels ${fmt(diff.value.differingFraction)} > ${thresholds.maxDifferingFraction} (delta > ${tolerance})`);
  }
  if (thresholds.minBlurredSsim !== undefined && blurredSsim !== undefined && blurredSsim < thresholds.minBlurredSsim) {
    failures.push(`blurred ssim ${fmt(blurredSsim)} < ${thresholds.minBlurredSsim}`);
  }
  return ok({ pass: failures.length === 0, failures, ssim: s, worstWindow: structural.value.worst, blurredSsim, diff: diff.value, thresholds });
}

/**
 * A diff picture for humans: `expected` dimmed to gray, pixels whose delta exceeds `tolerance` painted red
 * with intensity `min(255, delta × amplify)` (default ×8, as the spike's diff images).
 */
export function diffHeatmap(actual: RgbaImage, expected: RgbaImage, options: { readonly amplify?: number; readonly tolerance?: number } = {}): Result<RgbaImage, SfError> {
  const pair = validatePair(actual, expected);
  if (!pair.ok) return pair;
  const amplify = options.amplify ?? 8;
  const tolerance = options.tolerance ?? 0;
  const out = new Uint8Array(actual.data.length);
  for (let i = 0; i < out.length; i += 4) {
    let delta = 0;
    for (let c = 0; c < 4; c++) delta = Math.max(delta, Math.abs(actual.data[i + c]! - expected.data[i + c]!));
    const gray = Math.round((0.299 * expected.data[i]! + 0.587 * expected.data[i + 1]! + 0.114 * expected.data[i + 2]!) * 0.3);
    if (delta > tolerance) {
      out[i] = Math.min(255, Math.max(gray, delta * amplify));
      out[i + 1] = gray;
      out[i + 2] = gray;
    } else {
      out[i] = gray;
      out[i + 1] = gray;
      out[i + 2] = gray;
    }
    out[i + 3] = 255;
  }
  return ok({ width: actual.width, height: actual.height, data: out });
}

function fmt(v: number): string {
  return v.toFixed(5);
}
