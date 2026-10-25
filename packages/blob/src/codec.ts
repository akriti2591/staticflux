/**
 * Byte-level codecs shared by the store: hex digests (Web Crypto SHA-256),
 * CRC-32 (zip, log frames, head checksums), RFC 8785-style canonical JSON and
 * deflate-raw through Compression Streams.
 */
import { err, ok, type Result } from '@staticflux/core';
import { BlobInvalidInputError } from './errors.js';
import type { Digest } from './types.js';

/** The part of `SubtleCrypto` the store needs (injectable for tests and workers). */
export interface DigestLike {
  digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer>;
}

/** `crypto.subtle` of this realm. */
export function defaultSubtle(): DigestLike {
  const subtle = (globalThis as { crypto?: { subtle?: DigestLike } }).crypto?.subtle;
  if (subtle === undefined) throw new Error('Web Crypto (crypto.subtle) is not available in this context.');
  return subtle;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i] ?? 0];
  return out;
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function isDigest(value: unknown): value is Digest {
  return typeof value === 'string' && DIGEST_PATTERN.test(value);
}

/** Validate a digest (`SF-BLOB-008` when malformed). */
export function parseDigest(value: string): Result<Digest> {
  return isDigest(value)
    ? ok(value)
    : err(BlobInvalidInputError({ message: `Not a sha256 digest: "${value.slice(0, 80)}"`, details: { value: value.slice(0, 80) } }));
}

/** The 64 hex characters of a digest. */
export function digestHex(digest: Digest): string {
  return digest.slice(7);
}

export function digestFromHex(hex: string): Digest {
  return `sha256:${hex}`;
}

/** SHA-256 of `bytes` as a `Digest`. */
export async function sha256(bytes: Uint8Array, subtle: DigestLike = defaultSubtle()): Promise<Digest> {
  return digestFromHex(toHex(new Uint8Array(await subtle.digest('SHA-256', bytes))));
}

const CRC_TABLE = /* @__PURE__ */ (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE, as in zip). Pass the previous value to continue over several buffers. */
export function crc32(bytes: Uint8Array, previous = 0): number {
  let c = (previous ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = (CRC_TABLE[(c ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const encoder = /* @__PURE__ */ new TextEncoder();
const decoder = /* @__PURE__ */ new TextDecoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/**
 * RFC 8785-style canonical JSON: object keys sorted by UTF-16 code units,
 * `undefined` members dropped, ECMAScript number serialization (shortest
 * round trip), no whitespace. Non-finite numbers are rejected.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite numbers have no JSON form.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item: unknown) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new TypeError(`canonicalJson: ${typeof value} has no JSON form.`);
}

/** Concatenate buffers. */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function pump(bytes: Uint8Array, transform: ReadableWritablePair<Uint8Array, Uint8Array>): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const reader = source.pipeThrough(transform).getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return concatBytes(parts);
}

/** Compress with deflate-raw (zip method 8 payload). */
export function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  return pump(bytes, new CompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
}

/** Decompress deflate-raw. Rejects on corrupt input. */
export function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  return pump(bytes, new DecompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
}
