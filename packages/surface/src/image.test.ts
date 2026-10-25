import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32, encodePng, fitWithin, PNG_MIME, scaleImage } from './image.js';

const solid = (width: number, height: number, rgba: readonly number[]) => {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { width, height, data };
};

/** Parse our own PNG output back (chunks, IHDR, inflated rows) to check it round-trips. */
function parsePng(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: { type: string; data: Uint8Array; crcOk: boolean }[] = [];
  for (let at = 8; at < bytes.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const data = bytes.subarray(at + 8, at + 8 + length);
    chunks.push({ type, data, crcOk: view.getUint32(at + 8 + length) === crc32(bytes.subarray(at + 4, at + 8 + length)) });
    at += 12 + length;
  }
  const ihdr = chunks[0]?.data as Uint8Array;
  const h = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength);
  const width = h.getUint32(0);
  const height = h.getUint32(4);
  const raw = inflateSync(chunks.find((c) => c.type === 'IDAT')?.data as Uint8Array);
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    expect(raw[y * (width * 4 + 1)]).toBe(0);
    pixels.set(raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)), y * width * 4);
  }
  return { signature: [...bytes.subarray(0, 8)], chunks, width, height, depth: ihdr[8], colour: ihdr[9], pixels };
}

describe('crc32', () => {
  it('matches the reference check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('fitWithin', () => {
  it('keeps the aspect ratio inside the box and never upscales', () => {
    expect(fitWithin(4000, 3000, 256)).toEqual({ width: 256, height: 192 });
    expect(fitWithin(1000, 4000, 256)).toEqual({ width: 64, height: 256 });
    expect(fitWithin(120, 80, 256)).toEqual({ width: 120, height: 80 });
    expect(fitWithin(10000, 1, 256)).toEqual({ width: 256, height: 1 });
  });
});

describe('scaleImage', () => {
  it('averages areas exactly on integer factors', () => {
    const image = { width: 2, height: 2, data: Uint8Array.of(0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255) };
    const scaled = scaleImage(image, 1, 1);
    expect(scaled.ok && [...scaled.value.data]).toEqual([128, 128, 128, 255]);
  });

  it('weights in premultiplied space, so transparent pixels never darken colour', () => {
    const image = { width: 2, height: 1, data: Uint8Array.of(255, 0, 0, 255, 0, 0, 0, 0) };
    const scaled = scaleImage(image, 1, 1);
    expect(scaled.ok && [...scaled.value.data]).toEqual([255, 0, 0, 128]);
  });

  it('handles fractional factors and keeps solid colours solid', () => {
    const scaled = scaleImage(solid(7, 5, [10, 20, 30, 255]), 3, 2);
    expect(scaled.ok && scaled.value.width).toBe(3);
    expect(scaled.ok && [...new Set(scaled.value.data)]).toEqual([10, 20, 30, 255]);
  });

  it('returns a copy at the same size and rejects bad input with SF-SURF-016', () => {
    const image = solid(2, 2, [1, 2, 3, 4]);
    const same = scaleImage(image, 2, 2);
    expect(same.ok && same.value.data).not.toBe(image.data);
    expect(scaleImage(image, 0, 2).ok).toBe(false);
    const bad = scaleImage({ width: 2, height: 2, data: new Uint8Array(3) }, 1, 1);
    expect(!bad.ok && bad.error.code).toBe('SF-SURF-016');
  });
});

describe('encodePng', () => {
  it('writes a valid 8-bit RGBA PNG whose pixels round-trip', async () => {
    const image = { width: 3, height: 2, data: Uint8Array.from({ length: 24 }, (_, i) => i * 10) };
    const png = await encodePng(image);
    expect(png.ok).toBe(true);
    const parsed = parsePng(png.ok ? png.value : new Uint8Array());
    expect(parsed.signature).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(parsed.chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(parsed.chunks.every((c) => c.crcOk)).toBe(true);
    expect([parsed.width, parsed.height, parsed.depth, parsed.colour]).toEqual([3, 2, 8, 6]);
    expect([...parsed.pixels]).toEqual([...image.data]);
    expect(PNG_MIME).toBe('image/png');
  });

  it('is deterministic (same pixels, same bytes)', async () => {
    const a = await encodePng(solid(16, 16, [255, 92, 57, 255]));
    const b = await encodePng(solid(16, 16, [255, 92, 57, 255]));
    expect(a.ok && b.ok && Buffer.from(a.value).equals(Buffer.from(b.value))).toBe(true);
  });

  it('rejects malformed images and honours an aborted signal', async () => {
    const bad = await encodePng({ width: 1, height: 1, data: new Uint8Array(2) });
    expect(!bad.ok && bad.error.code).toBe('SF-SURF-016');
    const controller = new AbortController();
    controller.abort();
    const aborted = await encodePng(solid(1, 1, [0, 0, 0, 0]), { signal: controller.signal });
    expect(!aborted.ok && aborted.error.code).toBe('SF-CORE-002');
  });
});
