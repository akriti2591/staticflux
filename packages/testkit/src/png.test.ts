// @vitest-environment node
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createImage, syntheticImage } from './image.js';
import { crc32, decodePng, encodePng } from './png.js';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Independent PNG writer for decoder tests: explicit color type, bit depth, filter per row. */
function craftPng(options: { width: number; height: number; colorType: number; depth?: number; interlace?: number; rows: number[][]; filters?: number[]; extra?: [string, number[]][] }): Uint8Array {
  const chunk = (type: string, body: Uint8Array): number[] => {
    const typeBytes = [...type].map((c) => c.charCodeAt(0));
    const len = [body.length >>> 24, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255];
    const crc = crc32(Uint8Array.from([...typeBytes, ...body]));
    return [...len, ...typeBytes, ...body, crc >>> 24, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255];
  };
  const ihdr = [0, 0, 0, options.width, 0, 0, 0, options.height, options.depth ?? 8, options.colorType, 0, 0, options.interlace ?? 0];
  const bpp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[options.colorType] ?? 1;
  const raw: number[] = [];
  options.rows.forEach((row, y) => {
    const filter = options.filters?.[y] ?? 0;
    raw.push(filter);
    const prev = y > 0 ? options.rows[y - 1]! : row.map(() => 0);
    row.forEach((v, x) => {
      const left = x >= bpp ? row[x - bpp]! : 0;
      const up = prev[x]!;
      const upLeft = x >= bpp ? prev[x - bpp]! : 0;
      const p = left + up - upLeft;
      const paeth = Math.abs(p - left) <= Math.abs(p - up) && Math.abs(p - left) <= Math.abs(p - upLeft) ? left : Math.abs(p - up) <= Math.abs(p - upLeft) ? up : upLeft;
      const predicted = [0, left, up, (left + up) >> 1, paeth][filter]!;
      raw.push((v - predicted) & 255);
    });
  });
  const bytes = [
    ...SIGNATURE,
    ...chunk('IHDR', Uint8Array.from(ihdr)),
    ...(options.extra ?? []).flatMap(([type, body]) => chunk(type, Uint8Array.from(body))),
    ...chunk('IDAT', deflateSync(Uint8Array.from(raw))),
    ...chunk('IEND', new Uint8Array(0)),
  ];
  return Uint8Array.from(bytes);
}

describe('crc32', () => {
  it('matches the standard check value and chains', () => {
    const digits = new TextEncoder().encode('123456789');
    expect(crc32(digits)).toBe(0xcbf43926);
    expect(crc32(digits.subarray(4), crc32(digits.subarray(0, 4)))).toBe(0xcbf43926);
  });
});

describe('encodePng / decodePng', () => {
  it('round-trips every synthetic pattern losslessly, including alpha', () => {
    for (const pattern of ['gradient', 'checker', 'rings', 'noise'] as const) {
      const image = syntheticImage(pattern, 37, 23, { seed: 9 });
      const decoded = decodePng(encodePng(image));
      expect(decoded.ok && decoded.value).toEqual({ width: 37, height: 23, data: image.data });
    }
    const translucent = createImage(3, 3, [10, 20, 30, 40]);
    const decoded = decodePng(encodePng(translucent));
    expect(decoded.ok && [...decoded.value.data.subarray(0, 4)]).toEqual([10, 20, 30, 40]);
  });

  it('writes deterministic bytes with the signature and no metadata', () => {
    const image = syntheticImage('rings', 32, 32);
    const a = encodePng(image);
    expect(encodePng(image)).toEqual(a);
    expect([...a.subarray(0, 8)]).toEqual(SIGNATURE);
    const text = new TextDecoder('latin1').decode(a);
    expect(['IHDR', 'IDAT', 'IEND'].every((t) => text.includes(t))).toBe(true);
    expect(['tEXt', 'tIME', 'pHYs', 'gAMA'].some((t) => text.includes(t))).toBe(false);
  });

  it('compresses flat images well (adaptive filtering)', () => {
    expect(encodePng(createImage(256, 256, [200, 100, 50, 255])).length).toBeLessThan(1024); // 256 KiB raw
    expect(encodePng(syntheticImage('gradient', 128, 128)).length).toBeLessThan(2_000);
  });

  it('decodes all five filter types', () => {
    const rows = [
      [1, 2, 3, 250, 200, 100],
      [4, 5, 6, 7, 8, 9],
      [255, 0, 255, 0, 255, 0],
      [9, 9, 9, 100, 110, 120],
      [3, 1, 4, 1, 5, 9],
    ];
    const png = craftPng({ width: 2, height: 5, colorType: 2, rows, filters: [0, 1, 2, 3, 4] });
    const decoded = decodePng(png);
    if (!decoded.ok) throw decoded.error;
    const rgb = [...decoded.value.data].filter((_v, i) => i % 4 !== 3);
    expect(rgb).toEqual(rows.flat());
    expect([...decoded.value.data].filter((_v, i) => i % 4 === 3).every((a) => a === 255)).toBe(true);
  });

  it('decodes grayscale, gray+alpha, palette (with tRNS) and RGB color-key transparency', () => {
    const gray = decodePng(craftPng({ width: 2, height: 1, colorType: 0, rows: [[0, 128]], extra: [['tRNS', [0, 128]]] }));
    expect(gray.ok && [...gray.value.data]).toEqual([0, 0, 0, 255, 128, 128, 128, 0]);
    const grayAlpha = decodePng(craftPng({ width: 1, height: 1, colorType: 4, rows: [[77, 9]] }));
    expect(grayAlpha.ok && [...grayAlpha.value.data]).toEqual([77, 77, 77, 9]);
    const palette = decodePng(craftPng({ width: 3, height: 1, colorType: 3, rows: [[1, 0, 1]], extra: [['PLTE', [10, 20, 30, 40, 50, 60]], ['tRNS', [128]]] }));
    expect(palette.ok && [...palette.value.data]).toEqual([40, 50, 60, 255, 10, 20, 30, 128, 40, 50, 60, 255]);
    const keyed = decodePng(craftPng({ width: 2, height: 1, colorType: 2, rows: [[1, 2, 3, 4, 5, 6]], extra: [['tRNS', [0, 4, 0, 5, 0, 6]]] }));
    expect(keyed.ok && [...keyed.value.data]).toEqual([1, 2, 3, 255, 4, 5, 6, 0]);
  });

  it('rejects corrupt and unsupported files with SF-TEST-007', () => {
    const good = encodePng(createImage(2, 2, [1, 2, 3, 4]));
    const corrupt = good.slice();
    corrupt[20] = corrupt[20]! ^ 0xff; // inside IHDR → CRC mismatch
    const cases: [Uint8Array, string][] = [
      [Uint8Array.from([1, 2, 3]), 'missing PNG signature'],
      [corrupt, 'bad CRC in chunk IHDR'],
      [good.slice(0, good.length - 12), 'missing IEND'],
      [good.slice(0, 30), 'chunk IHDR is truncated'],
      [craftPng({ width: 1, height: 1, colorType: 0, depth: 16, rows: [[0, 0]] }), 'bit depth 16 is not supported (8 only)'],
      [craftPng({ width: 1, height: 1, colorType: 6, interlace: 1, rows: [[0, 0, 0, 0]] }), 'interlaced PNGs are not supported'],
      [craftPng({ width: 1, height: 1, colorType: 5, rows: [[0]] }), 'unknown color type 5'],
      [craftPng({ width: 1, height: 1, colorType: 3, rows: [[0]] }), 'palette image without PLTE'],
      [craftPng({ width: 1, height: 1, colorType: 3, rows: [[2]], extra: [['PLTE', [1, 2, 3]]] }), 'palette index 2 out of range'],
      [craftPng({ width: 1, height: 1, colorType: 0, rows: [[0]], filters: [7] }), 'unknown filter type 7 on row 0'],
    ];
    for (const [bytes, reason] of cases) {
      const r = decodePng(bytes);
      expect(!r.ok && r.error.code).toBe('SF-TEST-007');
      expect(!r.ok && r.error.details['reason']).toBe(reason);
    }
  });

  it('encodePng throws SF-TEST-006 on a malformed image', () => {
    expect(() => encodePng({ width: 2, height: 2, data: new Uint8Array(3) })).toThrow(expect.objectContaining({ code: 'SF-TEST-006' }));
  });
});
