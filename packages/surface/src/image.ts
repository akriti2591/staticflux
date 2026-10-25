/**
 * `@staticflux/surface/image` — small, dependency-free image utilities for renditions and exports
 * (R11.54–R11.55): area-average scaling of straight RGBA pixels and a PNG encoder over the platform's
 * `CompressionStream`. Both run in any worker and in Node (no canvas), so thumbnails and goldens are
 * deterministic: the same pixels always give the same bytes (and the same content digest).
 *
 * ```ts
 * const small = scaleImage(pixels, 256, 144);
 * if (small.ok) { const png = await encodePng(small.value, { signal }); }
 * ```
 */
import { AbortedError, err, ok, type Result } from '@staticflux/core';
import type { RasterImage } from './raster-backend.js';
import { ImageEncodeError } from './image-errors.js';

export { ImageEncodeError } from './image-errors.js';
export type { RasterImage } from './raster-backend.js';

export const PNG_MIME = 'image/png';

const PNG_SIGNATURE = /* @__PURE__ */ Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function checkImage(image: RasterImage): Result<void> {
  const { width, height, data } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return err(ImageEncodeError({ message: `An image must have a positive integer size, got ${width}×${height}.`, details: { width, height } }));
  }
  if (data.length !== width * height * 4) {
    return err(ImageEncodeError({ message: `Expected ${width * height * 4} RGBA bytes, got ${data.length}.`, details: { width, height, bytes: data.length } }));
  }
  return ok();
}

/** Source spans (index, weight) covering each output index of an axis; weights sum to 1. */
function axisWeights(source: number, target: number): readonly (readonly [number, number])[][] {
  const scale = source / target;
  const spans: (readonly [number, number])[][] = [];
  for (let i = 0; i < target; i += 1) {
    const start = i * scale;
    const end = Math.min(source, (i + 1) * scale);
    const span: (readonly [number, number])[] = [];
    for (let s = Math.floor(start); s < end; s += 1) {
      const covered = Math.min(end, s + 1) - Math.max(start, s);
      if (covered > 0) span.push([s, covered / (end - start)]);
    }
    spans.push(span);
  }
  return spans;
}

/**
 * Resample straight RGBA to `width × height` by area averaging (premultiplied, so transparent
 * pixels never darken edges). Downscales exactly; upscales by nearest coverage.
 */
export function scaleImage(image: RasterImage, width: number, height: number): Result<RasterImage> {
  const checked = checkImage(image);
  if (!checked.ok) return checked;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return err(ImageEncodeError({ message: `A scale target must have a positive integer size, got ${width}×${height}.`, details: { width, height } }));
  }
  if (width === image.width && height === image.height) return ok({ width, height, data: image.data.slice() });
  const columns = axisWeights(image.width, width);
  const rows = axisWeights(image.height, height);
  const src = image.data;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const rowSpan = rows[y] as (readonly [number, number])[];
    for (let x = 0; x < width; x += 1) {
      const columnSpan = columns[x] as (readonly [number, number])[];
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const [sy, wy] of rowSpan) {
        const base = sy * image.width;
        for (const [sx, wx] of columnSpan) {
          const i = (base + sx) * 4;
          const weight = wx * wy;
          const alpha = (src[i + 3] as number) * weight;
          r += (src[i] as number) * alpha;
          g += (src[i + 1] as number) * alpha;
          b += (src[i + 2] as number) * alpha;
          a += alpha;
        }
      }
      const o = (y * width + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(a);
    }
  }
  return ok({ width, height, data: out });
}

/** The largest size with the same aspect ratio that fits in `max × max` (never upscales; at least 1 px). */
export function fitWithin(width: number, height: number, max: number): { readonly width: number; readonly height: number } {
  if (width <= max && height <= max) return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  const scale = max / Math.max(width, height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

let crcTable: Uint32Array | undefined;

/** CRC-32 (ISO-HDLC, as PNG chunks use). */
export function crc32(bytes: Uint8Array, seed = 0): number {
  if (crcTable === undefined) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = (seed ^ 0xffffffff) >>> 0;
  for (const byte of bytes) c = (crcTable[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function deflate(bytes: Uint8Array, signal: AbortSignal | undefined): Promise<Result<Uint8Array>> {
  try {
    const stream = new CompressionStream('deflate');
    const writer = stream.writable.getWriter();
    void writer.write(bytes as Uint8Array<ArrayBuffer>).catch(() => undefined);
    void writer.close().catch(() => undefined);
    const reader = stream.readable.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      if (signal?.aborted === true) {
        await reader.cancel().catch(() => undefined);
        return err(AbortedError({ cause: signal.reason }));
      }
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      size += value.byteLength;
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.byteLength;
    }
    return ok(out);
  } catch (cause) {
    return err(ImageEncodeError({ message: 'Compressing the PNG data failed.', cause }));
  }
}

/**
 * Encode straight RGBA as an 8-bit RGBA PNG (no filters, no interlace, no ancillary chunks), so the
 * bytes depend only on the pixels. Cancellable while compressing.
 */
export async function encodePng(image: RasterImage, options: { readonly signal?: AbortSignal } = {}): Promise<Result<Uint8Array>> {
  const checked = checkImage(image);
  if (!checked.ok) return checked;
  if (options.signal?.aborted === true) return err(AbortedError({ cause: options.signal.reason }));
  const { width, height, data } = image;
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const compressed = await deflate(raw, options.signal);
  if (!compressed.ok) return compressed;
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  const parts = [PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', compressed.value), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return ok(out);
}
