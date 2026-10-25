import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  concatBytes,
  crc32,
  defaultSubtle,
  deflateRaw,
  digestFromHex,
  digestHex,
  fromUtf8,
  inflateRaw,
  isDigest,
  parseDigest,
  sha256,
  toHex,
  utf8,
} from './codec.js';

const ABC_DIGEST = 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('hex and digests', () => {
  it('toHex encodes bytes as lowercase hex', () => {
    expect(toHex(new Uint8Array([0, 1, 15, 16, 255]))).toBe('00010f10ff');
    expect(toHex(new Uint8Array(0))).toBe('');
  });

  it('isDigest / parseDigest accept only sha256: plus 64 lowercase hex', () => {
    expect(isDigest(ABC_DIGEST)).toBe(true);
    expect(isDigest(ABC_DIGEST.toUpperCase())).toBe(false);
    expect(isDigest('sha256:abc')).toBe(false);
    expect(isDigest(42)).toBe(false);
    expect(parseDigest(ABC_DIGEST)).toEqual({ ok: true, value: ABC_DIGEST });
    const bad = parseDigest('b3:00');
    expect(bad.ok ? '' : bad.error.code).toBe('SF-BLOB-008');
  });

  it('digestHex and digestFromHex convert both ways', () => {
    expect(digestHex(ABC_DIGEST)).toBe(ABC_DIGEST.slice(7));
    expect(digestFromHex(ABC_DIGEST.slice(7))).toBe(ABC_DIGEST);
  });

  it('sha256 hashes with Web Crypto (default or injected)', async () => {
    expect(await sha256(utf8('abc'))).toBe(ABC_DIGEST);
    expect(await sha256(utf8('abc'), defaultSubtle())).toBe(ABC_DIGEST);
    const calls: number[] = [];
    const fake = { digest: async (_a: 'SHA-256', data: Uint8Array) => (calls.push(data.length), new Uint8Array(32).buffer) };
    expect(await sha256(utf8('hello'), fake)).toBe(`sha256:${'0'.repeat(64)}`);
    expect(calls).toEqual([5]);
  });
});

describe('crc32', () => {
  it('matches the IEEE check value and continues across buffers', () => {
    expect(crc32(utf8('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
    const whole = crc32(utf8('hello world'));
    expect(crc32(utf8(' world'), crc32(utf8('hello')))).toBe(whole);
  });
});

describe('utf8', () => {
  it('round-trips text including non-ASCII', () => {
    expect(fromUtf8(utf8('दिवाली ✓'))).toBe('दिवाली ✓');
  });
});

describe('canonicalJson', () => {
  it('sorts keys, drops undefined members and has no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 'x', null], c: true }, z: undefined })).toBe('{"a":{"c":true,"d":[1,"x",null]},"b":1}');
  });

  it('uses shortest round-trip numbers and null for undefined array items', () => {
    expect(canonicalJson([1e21, 0.1, -0, 5, undefined])).toBe('[1e+21,0.1,0,5,null]');
  });

  it('rejects values without a JSON form', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(() => 1)).toThrow(TypeError);
  });
});

describe('bytes', () => {
  it('concatBytes joins buffers in order', () => {
    expect([...concatBytes([new Uint8Array([1]), new Uint8Array(0), new Uint8Array([2, 3])])]).toEqual([1, 2, 3]);
  });

  it('deflateRaw / inflateRaw round-trip and inflate rejects garbage', async () => {
    const content = utf8('part '.repeat(500));
    const packed = await deflateRaw(content);
    expect(packed.length).toBeLessThan(content.length);
    expect(fromUtf8(await inflateRaw(packed))).toBe(fromUtf8(content));
    await expect(inflateRaw(new Uint8Array([0xff, 0xff, 0xff, 0xff]))).rejects.toBeDefined();
  });
});
