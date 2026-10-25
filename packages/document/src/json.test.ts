import { describe, expect, it } from 'vitest';
import { canonicalJson, canonicalJsonBytes, isJsonValue, sha256Digest } from './json.js';

const text = (value: unknown): string => {
  const r = canonicalJson(value);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

describe('canonicalJson (RFC 8785)', () => {
  it('sorts keys by UTF-16 code units, recursively, with no whitespace', () => {
    expect(text({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
    // RFC 8785 §3.2.3 sorting example (code-unit order, not code-point order)
    expect(text({ '€': 'Euro Sign', '\r': 'Carriage Return', 'דּ': 'Hebrew Letter Dalet With Dagesh', '1': 'One', '😀': 'Emoji: Grinning Face', '\u0080': 'Control', 'ö': 'Latin Small Letter O With Diaeresis' })).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  it('serializes numbers in ECMAScript shortest round-trip form', () => {
    expect(text([0, -0, 1, -1, 4.5, 0.002, 1e-7, 1e21, 1e30, 333333333.3333333, 9007199254740991, 2 ** 53 + 2, 5e-324])).toBe(
      '[0,0,1,-1,4.5,0.002,1e-7,1e+21,1e+30,333333333.3333333,9007199254740991,9007199254740994,5e-324]',
    );
  });

  it('escapes strings minimally', () => {
    expect(text('\u000f\n\t"\\/\u007f€')).toBe('"\\u000f\\n\\t\\"\\\\/\u007f€"');
  });

  it('omits undefined properties and rejects non-JSON data', () => {
    expect(text({ a: undefined, b: 1 })).toBe('{"b":1}');
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '\ud800', { k: '\udc00x' }, new Date(0), () => 1, 1n]) {
      const r = canonicalJson(bad);
      expect(r.ok ? 'ok' : r.error.code).toBe('SF-DOC-017');
    }
    const lone = canonicalJson({ ['\ud800']: 1 });
    expect(lone.ok).toBe(false);
  });

  it('produces UTF-8 bytes', () => {
    const r = canonicalJsonBytes({ b: '€', a: 1 });
    expect(r.ok && new TextDecoder().decode(r.value)).toBe('{"a":1,"b":"€"}');
    expect(canonicalJsonBytes(Number.NaN).ok).toBe(false);
  });
});

describe('isJsonValue', () => {
  it('accepts plain JSON data only', () => {
    expect(isJsonValue({ a: [1, 'x', true, null, { b: 2 }] })).toBe(true);
    expect(isJsonValue(Object.create(null))).toBe(true);
    for (const bad of [undefined, Number.NaN, new Map(), [undefined], { a: () => 1 }, Symbol('x')]) expect(isJsonValue(bad)).toBe(false);
  });
});

describe('sha256Digest', () => {
  it('matches the FIPS 180-2 test vector', async () => {
    expect(await sha256Digest(new TextEncoder().encode('abc'))).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
