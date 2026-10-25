/**
 * Structural similarity (SSIM) on RGBA buffers — Wang, Bovik, Sheikh & Simoncelli,
 * "Image Quality Assessment: From Error Visibility to Structural Similarity", IEEE TIP 13(4), 2004.
 *
 * For each window position, with x and y the two images' pixel values in the window:
 *
 *   SSIM(x, y) = ((2·μx·μy + C1) · (2·σxy + C2)) / ((μx² + μy² + C1) · (σx² + σy² + C2))
 *
 *   μ  = Gaussian-weighted mean,  σ² = weighted variance,  σxy = weighted covariance
 *   C1 = (K1·L)²,  C2 = (K2·L)²,  K1 = 0.01, K2 = 0.03, L = 255 (8-bit dynamic range)
 *
 * Window: 11×11 circular-symmetric Gaussian, σ = 1.5, normalized to sum 1 (the paper's choice,
 * MATLAB `fspecial('gaussian', 11, 1.5)`). Statistics are taken only where the window fits inside
 * the image ("valid" filtering, no padding), and the reported value (MSSIM) is the mean over those
 * windows. Variances use the population form E[x²] − μ² (no N−1 correction), as in the paper.
 * This matches the authors' `ssim_index.m` without its automatic downsampling, and scikit-image
 * `structural_similarity(gaussian_weights=True, sigma=1.5, use_sample_covariance=False, data_range=255)`.
 *
 * Channels: by default SSIM runs on Rec. 601 luma of the image composited over an opaque background
 * (white by default), so translucent pixels compare as they would appear. `channels: 'rgb'` runs on
 * R, G and B separately and reports their mean (and each channel). Alpha is never compared by SSIM;
 * `diffImages` / `compareImages` cover every channel including alpha with a max channel delta.
 *
 * Ported from the S1/S7 spike's approach (luma SSIM on RGBA readbacks, a 3×3 blur variant for
 * cross-rasterizer parity); unlike the spike's 8×8 uniform window with stride 4, this is the
 * reference Gaussian SSIM so its values are comparable with published tools.
 */
import { err, ok, type Result, type SfError } from '@staticflux/core';
import { InvalidImageError } from './errors.js';
import { channelPlane, validatePair, type RgbaImage, type Rgb } from './image.js';

export interface SsimOptions {
  /** `'luma'` (default) or `'rgb'` (mean of per-channel SSIM). */
  readonly channels?: 'luma' | 'rgb';
  /** Opaque color translucent pixels are composited over before comparing. Default white. */
  readonly background?: Rgb;
  /** Gaussian window: odd `size` (default 11) and `sigma` (default 1.5). */
  readonly window?: { readonly size?: number; readonly sigma?: number };
  /** Stabilizing constants' factors (defaults 0.01 and 0.03) and dynamic range (default 255). */
  readonly k1?: number;
  readonly k2?: number;
  readonly dynamicRange?: number;
}

export const SSIM_DEFAULTS = {
  windowSize: 11,
  sigma: 1.5,
  k1: 0.01,
  k2: 0.03,
  dynamicRange: 255,
} as const;

export interface SsimReport {
  /** Mean SSIM over all window positions (and channels, for `'rgb'`). 1 means identical. */
  readonly mssim: number;
  /** The worst window: its SSIM and the image coordinates of its center. */
  readonly worst: { readonly value: number; readonly x: number; readonly y: number };
  /** Per-channel MSSIM (`[luma]` or `[r, g, b]`). */
  readonly perChannel: readonly number[];
  /** Per-window SSIM (minimum over channels), `mapWidth × mapHeight`, offset by `(size − 1) / 2` from the image origin. */
  readonly map: Float32Array;
  readonly mapWidth: number;
  readonly mapHeight: number;
}

/** Normalized 1-D Gaussian of odd `size` — the 2-D window is its outer product. */
export function gaussianKernel(size: number = SSIM_DEFAULTS.windowSize, sigma: number = SSIM_DEFAULTS.sigma): Float64Array {
  if (!Number.isInteger(size) || size < 1 || size % 2 === 0) throw InvalidImageError({ message: `SSIM window size must be a positive odd integer (got ${size}).` });
  if (!(sigma > 0)) throw InvalidImageError({ message: `SSIM window sigma must be > 0 (got ${sigma}).` });
  const half = (size - 1) / 2;
  const kernel = new Float64Array(size);
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const d = i - half;
    kernel[i] = Math.exp(-(d * d) / (2 * sigma * sigma));
    sum += kernel[i]!;
  }
  for (let i = 0; i < size; i++) kernel[i] = kernel[i]! / sum;
  return kernel;
}

/** SSIM between two equally sized RGBA images. Errors (SF-TEST-006) on malformed or mismatched images. */
export function ssim(a: RgbaImage, b: RgbaImage, options: SsimOptions = {}): Result<SsimReport, SfError> {
  const pair = validatePair(a, b);
  if (!pair.ok) return pair;
  const size = options.window?.size ?? SSIM_DEFAULTS.windowSize;
  const sigma = options.window?.sigma ?? SSIM_DEFAULTS.sigma;
  let kernel: Float64Array;
  try {
    kernel = gaussianKernel(size, sigma);
  } catch (e) {
    return err(e as SfError);
  }
  const { width, height } = a;
  if (width < size || height < size) {
    return err(
      InvalidImageError({
        message: `Images (${width}×${height}) are smaller than the ${size}×${size} SSIM window; pass a smaller \`window.size\` or render a larger image.`,
        details: { width, height, windowSize: size },
      }),
    );
  }
  const range = options.dynamicRange ?? SSIM_DEFAULTS.dynamicRange;
  const c1 = ((options.k1 ?? SSIM_DEFAULTS.k1) * range) ** 2;
  const c2 = ((options.k2 ?? SSIM_DEFAULTS.k2) * range) ** 2;
  const background = options.background ?? [255, 255, 255];
  const channels = options.channels === 'rgb' ? ([0, 1, 2] as const) : (['luma'] as const);

  const mapWidth = width - size + 1;
  const mapHeight = height - size + 1;
  const map = new Float32Array(mapWidth * mapHeight).fill(Number.POSITIVE_INFINITY);
  const perChannel: number[] = [];
  for (const channel of channels) {
    const x = channelPlane(a, channel, background);
    const y = channelPlane(b, channel, background);
    const n = width * height;
    const xx = new Float64Array(n);
    const yy = new Float64Array(n);
    const xy = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      xx[i] = x[i]! * x[i]!;
      yy[i] = y[i]! * y[i]!;
      xy[i] = x[i]! * y[i]!;
    }
    const mx = filterValid(x, width, height, kernel);
    const my = filterValid(y, width, height, kernel);
    const exx = filterValid(xx, width, height, kernel);
    const eyy = filterValid(yy, width, height, kernel);
    const exy = filterValid(xy, width, height, kernel);
    let sum = 0;
    for (let i = 0; i < mapWidth * mapHeight; i++) {
      const ux = mx[i]!;
      const uy = my[i]!;
      const vx = exx[i]! - ux * ux;
      const vy = eyy[i]! - uy * uy;
      const cov = exy[i]! - ux * uy;
      const value = ((2 * ux * uy + c1) * (2 * cov + c2)) / ((ux * ux + uy * uy + c1) * (vx + vy + c2));
      sum += value;
      if (value < map[i]!) map[i] = value;
    }
    perChannel.push(sum / (mapWidth * mapHeight));
  }
  let worstIndex = 0;
  for (let i = 1; i < map.length; i++) if (map[i]! < map[worstIndex]!) worstIndex = i;
  const half = (size - 1) / 2;
  return ok({
    mssim: perChannel.reduce((s, v) => s + v, 0) / perChannel.length,
    worst: { value: map[worstIndex]!, x: (worstIndex % mapWidth) + half, y: Math.floor(worstIndex / mapWidth) + half },
    perChannel,
    map,
    mapWidth,
    mapHeight,
  });
}

/** Separable 2-D filtering with the outer product of `kernel`, keeping only positions where the window fits. */
function filterValid(plane: Float64Array, width: number, height: number, kernel: Float64Array): Float64Array {
  const size = kernel.length;
  const outW = width - size + 1;
  const outH = height - size + 1;
  const rows = new Float64Array(outW * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < outW; x++) {
      let s = 0;
      for (let k = 0; k < size; k++) s += kernel[k]! * plane[row + x + k]!;
      rows[y * outW + x] = s;
    }
  }
  const out = new Float64Array(outW * outH);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let s = 0;
      for (let k = 0; k < size; k++) s += kernel[k]! * rows[(y + k) * outW + x]!;
      out[y * outW + x] = s;
    }
  }
  return out;
}
