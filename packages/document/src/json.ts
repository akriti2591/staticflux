/**
 * JSON values and canonical JSON (RFC 8785, JSON Canonicalization Scheme).
 *
 * Canonical bytes are what milestones, digests and engine-independent parts are
 * built from (DOCUMENT-FORMAT §6.2): object keys sorted by UTF-16 code units,
 * numbers in ECMAScript shortest round-trip form, strings with the minimal JSON
 * escapes, no whitespace. Non-finite numbers and lone surrogates are rejected
 * (RFC 8785 §3.2.2, I-JSON).
 */
import { err, ok, type Result } from '@staticflux/core';
import { CanonicalEncodingError } from './errors.js';

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** True for plain JSON data (no undefined, functions, class instances, cycles are not checked). */
export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object': {
      if (Array.isArray(value)) return value.every(isJsonValue);
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) return false;
      return Object.values(value as Record<string, unknown>).every(isJsonValue);
    }
    default:
      return false;
  }
}

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

function compareUtf16(a: string, b: string): number {
  // RFC 8785 §3.2.3: sort by UTF-16 code units (JS string comparison already does this).
  return a < b ? -1 : a > b ? 1 : 0;
}

function write(value: unknown, out: string[], path: string): Result<void> {
  if (value === null) {
    out.push('null');
    return ok();
  }
  switch (typeof value) {
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return ok();
    case 'number':
      if (!Number.isFinite(value)) {
        return err(CanonicalEncodingError({ message: `Non-finite number at ${path}.`, details: { path } }));
      }
      // ECMAScript Number serialization == RFC 8785 number form (-0 serializes as 0).
      out.push(JSON.stringify(value));
      return ok();
    case 'string':
      if (hasLoneSurrogate(value)) {
        return err(CanonicalEncodingError({ message: `Lone surrogate in string at ${path}.`, details: { path } }));
      }
      // JSON.stringify escapes exactly ", \, \b \f \n \r \t and other C0 controls as \u00xx (lowercase).
      out.push(JSON.stringify(value));
      return ok();
    case 'object': {
      if (Array.isArray(value)) {
        out.push('[');
        for (let i = 0; i < value.length; i += 1) {
          if (i > 0) out.push(',');
          const r = write(value[i], out, `${path}[${i}]`);
          if (!r.ok) return r;
        }
        out.push(']');
        return ok();
      }
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) {
        return err(CanonicalEncodingError({ message: `Not plain JSON data at ${path}.`, details: { path } }));
      }
      const keys = Object.keys(value).filter((k) => (value as Record<string, unknown>)[k] !== undefined);
      keys.sort(compareUtf16);
      out.push('{');
      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i] as string;
        if (hasLoneSurrogate(key)) {
          return err(CanonicalEncodingError({ message: `Lone surrogate in key at ${path}.`, details: { path } }));
        }
        if (i > 0) out.push(',');
        out.push(JSON.stringify(key), ':');
        const r = write((value as Record<string, unknown>)[key], out, `${path}.${key}`);
        if (!r.ok) return r;
      }
      out.push('}');
      return ok();
    }
    default:
      return err(CanonicalEncodingError({ message: `Unsupported ${typeof value} at ${path}.`, details: { path } }));
  }
}

/**
 * Serialize JSON data per RFC 8785. Object properties whose value is `undefined`
 * are omitted (as in `JSON.stringify`); anything else that is not JSON is an error.
 */
export function canonicalJson(value: unknown): Result<string> {
  const out: string[] = [];
  const r = write(value, out, '$');
  return r.ok ? ok(out.join('')) : r;
}

const encoder = /* @__PURE__ */ new TextEncoder();

/** RFC 8785 canonical UTF-8 bytes. */
export function canonicalJsonBytes(value: unknown): Result<Uint8Array> {
  const text = canonicalJson(value);
  return text.ok ? ok(encoder.encode(text.value)) : text;
}

/** `sha256:<hex>` digest of bytes (WebCrypto). */
export async function sha256Digest(bytes: Uint8Array): Promise<`sha256:${string}`> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  let hex = '';
  for (const b of hash) hex += b.toString(16).padStart(2, '0');
  return `sha256:${hex}`;
}
