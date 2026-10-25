/**
 * RGBA images for render tests: the one image shape every testkit image helper takes
 * (`ssim`, `compareImages`, goldens, GPU readback, the PNG codec).
 *
 * Pixels are 8-bit, non-premultiplied RGBA, row-major, top row first, no row padding —
 * what `ImageData`, `GPUTexture` readback (after unpadding) and `vello_cpu` produce.
 * Pure and environment-free: runs in Node, workers and browsers.
 */
import { err, ok, type Result, type SfError } from '@staticflux/core';
import { InvalidImageError } from './errors.js';

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** `width * height * 4` bytes, RGBA order. */
  readonly data: Uint8Array | Uint8ClampedArray;
}

export type Rgba = readonly [r: number, g: number, b: number, a: number];
export type Rgb = readonly [r: number, g: number, b: number];

const TRANSPARENT: Rgba = [0, 0, 0, 0];

/** Check dimensions and buffer length. Returns the image unchanged when valid. */
export function validateImage(image: RgbaImage, role = 'image'): Result<RgbaImage, SfError> {
  const { width, height, data } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return err(InvalidImageError({ message: `${role}: width and height must be positive integers (got ${width}×${height}).`, details: { role, width, height } }));
  }
  if (data.length !== width * height * 4) {
    return err(
      InvalidImageError({
        message: `${role}: data has ${data.length} bytes, expected width × height × 4 = ${width * height * 4}.`,
        details: { role, width, height, bytes: data.length },
      }),
    );
  }
  return ok(image);
}

/** Validate two images and require equal dimensions. */
export function validatePair(a: RgbaImage, b: RgbaImage): Result<void, SfError> {
  const va = validateImage(a, 'actual');
  if (!va.ok) return va;
  const vb = validateImage(b, 'expected');
  if (!vb.ok) return vb;
  if (a.width !== b.width || a.height !== b.height) {
    return err(
      InvalidImageError({
        message: `Images differ in size: ${a.width}×${a.height} vs ${b.width}×${b.height}.`,
        details: { actual: [a.width, a.height], expected: [b.width, b.height] },
      }),
    );
  }
  return ok();
}

function assertValid(image: RgbaImage, role: string): void {
  const v = validateImage(image, role);
  if (!v.ok) throw v.error;
}

/** A new image filled with one color (default transparent black). Throws SF-TEST-006 on bad dimensions. */
export function createImage(width: number, height: number, fill: Rgba = TRANSPARENT): RgbaImage {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw InvalidImageError({ message: `createImage: width and height must be positive integers (got ${width}×${height}).`, details: { width, height } });
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill[0];
    data[i + 1] = fill[1];
    data[i + 2] = fill[2];
    data[i + 3] = fill[3];
  }
  return { width, height, data };
}

/** Per-pixel map; `fn` gets the pixel and its coordinates and returns the new pixel. */
export function mapPixels(image: RgbaImage, fn: (pixel: Rgba, x: number, y: number) => Rgba): RgbaImage {
  assertValid(image, 'image');
  const { width, height, data } = image;
  const out = new Uint8Array(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const p = fn([data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!], x, y);
      out[i] = clampByte(p[0]);
      out[i + 1] = clampByte(p[1]);
      out[i + 2] = clampByte(p[2]);
      out[i + 3] = clampByte(p[3]);
    }
  }
  return { width, height, data: out };
}

/** Translate by whole pixels; uncovered pixels get `fill` (default transparent). */
export function shiftImage(image: RgbaImage, dx: number, dy: number, fill: Rgba = TRANSPARENT): RgbaImage {
  assertValid(image, 'image');
  const { width, height, data } = image;
  return mapPixels(image, (_p, x, y) => {
    const sx = x - dx;
    const sy = y - dy;
    if (sx < 0 || sy < 0 || sx >= width || sy >= height) return fill;
    const i = (sy * width + sx) * 4;
    return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
  });
}

/**
 * Box blur over a (2·radius+1)² window, all four channels, edges clamped, rounded to the nearest byte.
 * `radius: 1` is the 3×3 blur S7 used to separate anti-aliasing differences from missing content.
 */
export function boxBlur(image: RgbaImage, radius: number): RgbaImage {
  assertValid(image, 'image');
  if (!Number.isInteger(radius) || radius < 0) throw InvalidImageError({ message: `boxBlur radius must be a non-negative integer (got ${radius}).` });
  if (radius === 0) return { width: image.width, height: image.height, data: Uint8Array.from(image.data) };
  const { width, height, data } = image;
  const span = 2 * radius + 1;
  const horizontal = new Float64Array(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) sum += data[(y * width + clampIndex(x + k, width)) * 4 + c]!;
        horizontal[(y * width + x) * 4 + c] = sum;
      }
    }
  }
  const out = new Uint8Array(data.length);
  const area = span * span;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) sum += horizontal[(clampIndex(y + k, height) * width + x) * 4 + c]!;
        out[(y * width + x) * 4 + c] = Math.round(sum / area);
      }
    }
  }
  return { width, height, data: out };
}

/** Rec. 601 luma weights on gamma-encoded RGB (as MATLAB `rgb2gray` and the SSIM reference code). */
export const LUMA_WEIGHTS: Rgb = [0.299, 0.587, 0.114];

/**
 * One channel as floats in [0, 255], after compositing over `background` (straight alpha):
 * `c' = c·α + bg·(1 − α)`. `channel` is `'luma'` (Rec. 601) or an RGB index.
 */
export function channelPlane(image: RgbaImage, channel: 'luma' | 0 | 1 | 2, background: Rgb = [255, 255, 255]): Float64Array {
  assertValid(image, 'image');
  const { data } = image;
  const n = image.width * image.height;
  const out = new Float64Array(n);
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const alpha = data[i + 3]! / 255;
    const r = data[i]! * alpha + background[0] * (1 - alpha);
    const g = data[i + 1]! * alpha + background[1] * (1 - alpha);
    const b = data[i + 2]! * alpha + background[2] * (1 - alpha);
    out[p] = channel === 'luma' ? LUMA_WEIGHTS[0] * r + LUMA_WEIGHTS[1] * g + LUMA_WEIGHTS[2] * b : channel === 0 ? r : channel === 1 ? g : b;
  }
  return out;
}

export type SyntheticPattern = 'gradient' | 'checker' | 'rings' | 'noise';

export interface SyntheticImageOptions {
  /** Seed for `noise` (mulberry32). Default 1. */
  readonly seed?: number;
  /** Cell size in pixels for `checker`, ring period for `rings`. Default 4. */
  readonly cell?: number;
}

/**
 * Deterministic test images (opaque), defined by integer formulas so other tools can reproduce them:
 * - `gradient`: r = ⌊255·x/(w−1)⌋, g = ⌊255·y/(h−1)⌋, b = ⌊255·(x+y)/(w+h−2)⌋
 * - `checker`:  black/white cells of `cell` px; white when ⌊x/cell⌋ + ⌊y/cell⌋ is even
 * - `rings`:    gray = 255 when ⌊√((x−cx)²+(y−cy)²)/cell⌋ is even else 32, cx = (w−1)/2, cy = (h−1)/2
 * - `noise`:    each of r, g, b = ⌊mulberry32(seed)·256⌋ in pixel order (r, g, b per pixel)
 */
export function syntheticImage(pattern: SyntheticPattern, width: number, height: number, options: SyntheticImageOptions = {}): RgbaImage {
  const cell = options.cell ?? 4;
  const base = createImage(width, height, [0, 0, 0, 255]);
  const random = mulberry32(options.seed ?? 1);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  return mapPixels(base, (_p, x, y) => {
    switch (pattern) {
      case 'gradient':
        return [
          Math.floor((255 * x) / Math.max(1, width - 1)),
          Math.floor((255 * y) / Math.max(1, height - 1)),
          Math.floor((255 * (x + y)) / Math.max(1, width + height - 2)),
          255,
        ];
      case 'checker': {
        const v = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? 255 : 0;
        return [v, v, v, 255];
      }
      case 'rings': {
        const v = Math.floor(Math.hypot(x - cx, y - cy) / cell) % 2 === 0 ? 255 : 32;
        return [v, v, v, 255];
      }
      case 'noise':
        return [Math.floor(random() * 256), Math.floor(random() * 256), Math.floor(random() * 256), 255];
    }
  });
}

/** mulberry32 PRNG in [0, 1) — tiny, seedable, reproducible in any language with 32-bit integer ops. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clampByte(v: number): number {
  return v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
}

function clampIndex(i: number, n: number): number {
  return i < 0 ? 0 : i >= n ? n - 1 : i;
}
