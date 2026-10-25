/**
 * Minimal PNG codec for goldens (Node only: uses `node:zlib`). No dependency, deterministic output.
 *
 * - `encodePng`: 8-bit RGBA, non-interlaced, adaptive per-row filter (smallest sum of absolute
 *   differences), zlib level 9, no metadata chunks — the same pixels always give the same bytes.
 * - `decodePng`: 8-bit grayscale, gray+alpha, RGB, RGBA and palette (with `tRNS`) images, all five
 *   filter types, CRC-checked. 16-bit, sub-byte depths and Adam7 interlacing are rejected (SF-TEST-007).
 */
import { deflateSync, inflateSync } from 'node:zlib';
import { err, ok, type Result, type SfError } from '@staticflux/core';
import { PngDecodeError } from './errors.js';
import { validateImage, type RgbaImage } from './image.js';

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (ISO 3309 / PNG). */
export function crc32(bytes: Uint8Array, initial = 0): number {
  let c = (initial ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Encode an RGBA image as PNG bytes. Throws SF-TEST-006 on a malformed image. */
export function encodePng(image: RgbaImage): Uint8Array {
  const valid = validateImage(image);
  if (!valid.ok) throw valid.error;
  const { width, height, data } = image;
  const stride = width * 4;
  const filtered = new Uint8Array((stride + 1) * height);
  const candidate = new Uint8Array(stride);
  const best = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    let bestScore = Number.POSITIVE_INFINITY;
    let bestType = 0;
    for (let type = 0; type < 5; type++) {
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const raw = data[y * stride + x]!;
        const left = x >= 4 ? data[y * stride + x - 4]! : 0;
        const up = y > 0 ? data[(y - 1) * stride + x]! : 0;
        const upLeft = x >= 4 && y > 0 ? data[(y - 1) * stride + x - 4]! : 0;
        const predicted = type === 0 ? 0 : type === 1 ? left : type === 2 ? up : type === 3 ? (left + up) >> 1 : paeth(left, up, upLeft);
        const v = (raw - predicted) & 0xff;
        candidate[x] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        bestType = type;
        best.set(candidate);
      }
    }
    filtered[y * (stride + 1)] = bestType;
    filtered.set(best, y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const idat = new Uint8Array(deflateSync(filtered, { level: 9 }));
  return concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))]);
}

/** Decode PNG bytes into an RGBA image. */
export function decodePng(bytes: Uint8Array): Result<RgbaImage, SfError> {
  const fail = (reason: string): Result<RgbaImage, SfError> => err(PngDecodeError({ message: `PNG decode failed: ${reason}.`, details: { reason } }));
  if (bytes.length < SIGNATURE.length || !SIGNATURE.every((b, i) => bytes[i] === b)) return fail('missing PNG signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = SIGNATURE.length;
  let header: { width: number; height: number; depth: number; colorType: number; interlace: number } | undefined;
  let palette: Uint8Array | undefined;
  let transparency: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (offset + 12 + length > bytes.length) return fail(`chunk ${type} is truncated`);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    const stored = view.getUint32(offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== stored) return fail(`bad CRC in chunk ${type}`);
    offset += 12 + length;
    if (type === 'IHDR') {
      const h = new DataView(body.buffer, body.byteOffset, body.byteLength);
      header = { width: h.getUint32(0), height: h.getUint32(4), depth: body[8]!, colorType: body[9]!, interlace: body[12]! };
    } else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') transparency = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') {
      ended = true;
      break;
    }
  }
  if (header === undefined) return fail('missing IHDR');
  if (!ended) return fail('missing IEND');
  const { width, height, depth, colorType, interlace } = header;
  if (width === 0 || height === 0) return fail('zero width or height');
  if (depth !== 8) return fail(`bit depth ${depth} is not supported (8 only)`);
  if (interlace !== 0) return fail('interlaced PNGs are not supported');
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (channels === 0) return fail(`unknown color type ${colorType}`);
  if (colorType === 3 && palette === undefined) return fail('palette image without PLTE');
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(inflateSync(concat(idat)));
  } catch (e) {
    return err(PngDecodeError({ message: 'PNG decode failed: IDAT does not inflate.', cause: e, details: { reason: 'inflate' } }));
  }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return fail('image data is shorter than width × height');
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    if (filter > 4) return fail(`unknown filter type ${filter} on row ${y}`);
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x]!;
      const left = x >= channels ? pixels[y * stride + x - channels]! : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
      const upLeft = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels]! : 0;
      const predicted = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth(left, up, upLeft);
      pixels[y * stride + x] = (v + predicted) & 0xff;
    }
  }
  const out = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const o = p * 4;
    switch (colorType) {
      case 0: {
        const g = pixels[p]!;
        out.set([g, g, g, transparency !== undefined && transparency.length >= 2 && ((transparency[0]! << 8) | transparency[1]!) === g ? 0 : 255], o);
        break;
      }
      case 2: {
        const [r, g, b] = [pixels[p * 3]!, pixels[p * 3 + 1]!, pixels[p * 3 + 2]!];
        const keyed = transparency !== undefined && transparency.length >= 6 && transparency[1] === r && transparency[3] === g && transparency[5] === b;
        out.set([r, g, b, keyed ? 0 : 255], o);
        break;
      }
      case 3: {
        const index = pixels[p]!;
        if (index * 3 + 2 >= palette!.length) return fail(`palette index ${index} out of range`);
        out.set([palette![index * 3]!, palette![index * 3 + 1]!, palette![index * 3 + 2]!, transparency?.[index] ?? 255], o);
        break;
      }
      case 4:
        out.set([pixels[p * 2]!, pixels[p * 2]!, pixels[p * 2]!, pixels[p * 2 + 1]!], o);
        break;
      default:
        out.set(pixels.subarray(p * 4, p * 4 + 4), o);
    }
  }
  return ok({ width, height, data: out });
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
