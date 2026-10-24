/**
 * Cookie adapter (`document.cookie`). For small values that must reach the
 * server or survive where Web Storage is partitioned. Values go through a
 * string codec and `encodeURIComponent`; names are `prefix + encoded key`.
 *
 * Limits: browsers cap one cookie (name + value + attributes) at ~4096 bytes
 * and ~50 cookies per domain → `SF-STORE-001`. `ttlMs` maps to `max-age`.
 * Cookies are visible to the server — never store tokens or secrets here
 * (client gating is not security).
 */
import { err, ok, type Result } from '@staticflux/core';
import { storeFromDriver, utf8Bytes } from './base.js';
import { type Codec, jsonCodec } from './codec.js';
import { StoreQuotaError, StoreUnavailableError } from './errors.js';
import type { AsyncStore, Entry } from './types.js';

/** The subset of `Document` the adapter uses. */
export interface CookieDocumentLike {
  cookie: string;
}

export type SameSite = 'Strict' | 'Lax' | 'None';

export interface CookieAttributes {
  /** Default `/`. */
  readonly path?: string;
  readonly domain?: string;
  /** Default `Lax`. `None` requires `secure`. */
  readonly sameSite?: SameSite;
  /** Default: true on https pages. */
  readonly secure?: boolean;
  /** Default lifetime in seconds; omitted = session cookie. */
  readonly maxAgeSeconds?: number;
}

export interface CookieStoreOptions<V> extends CookieAttributes {
  readonly document?: CookieDocumentLike | null;
  /** Name prefix (default `sf_`). */
  readonly prefix?: string;
  readonly codec?: Codec<V, string>;
  /** Max bytes per cookie (name + value), default 4096. */
  readonly maxCookieBytes?: number;
  /** Max cookies this store writes, default 50. */
  readonly maxCookies?: number;
}

export const COOKIE_PREFIX = 'sf_';
export const MAX_COOKIE_BYTES = 4096;

export function parseCookies(header: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (name !== '' && !out.has(name)) out.set(name, part.slice(index + 1).trim());
  }
  return out;
}

export function serializeCookie(name: string, value: string, attributes: CookieAttributes & { readonly maxAgeSeconds?: number }): string {
  let cookie = `${name}=${value}; Path=${attributes.path ?? '/'}`;
  if (attributes.domain !== undefined) cookie += `; Domain=${attributes.domain}`;
  if (attributes.maxAgeSeconds !== undefined) cookie += `; Max-Age=${Math.max(0, Math.floor(attributes.maxAgeSeconds))}`;
  cookie += `; SameSite=${attributes.sameSite ?? 'Lax'}`;
  if (attributes.secure === true || attributes.sameSite === 'None') cookie += '; Secure';
  return cookie;
}

function defaultDocument(): CookieDocumentLike | undefined {
  const doc = (globalThis as { document?: CookieDocumentLike }).document;
  return doc !== undefined && typeof doc.cookie === 'string' ? doc : undefined;
}

function defaultSecure(): boolean {
  return (globalThis as { location?: { protocol?: string } }).location?.protocol === 'https:';
}

/** Probe that cookies can be written and read back (disabled cookies, sandboxed iframes). */
export function probeCookies(doc: CookieDocumentLike | undefined, attributes: CookieAttributes = {}): boolean {
  if (doc === undefined) return false;
  try {
    const name = `${COOKIE_PREFIX}__probe__`;
    doc.cookie = serializeCookie(name, '1', { ...attributes, maxAgeSeconds: 60 });
    const found = parseCookies(doc.cookie).get(name) === '1';
    doc.cookie = serializeCookie(name, '', { ...attributes, maxAgeSeconds: 0 });
    return found;
  } catch {
    return false;
  }
}

export function createCookieStore<V = unknown>(options: CookieStoreOptions<V> = {}): Result<AsyncStore<V>> {
  const doc = options.document === undefined ? defaultDocument() : (options.document ?? undefined);
  const attributes: CookieAttributes = {
    path: options.path ?? '/',
    sameSite: options.sameSite ?? 'Lax',
    secure: options.secure ?? defaultSecure(),
    ...(options.domain === undefined ? {} : { domain: options.domain }),
    ...(options.maxAgeSeconds === undefined ? {} : { maxAgeSeconds: options.maxAgeSeconds }),
  };
  if (doc === undefined || !probeCookies(doc, attributes)) {
    return err(StoreUnavailableError({ message: 'Cookies are not available.', details: { backend: 'cookie' } }));
  }
  const prefix = options.prefix ?? COOKIE_PREFIX;
  const codec = options.codec ?? jsonCodec<V>();
  const maxBytes = options.maxCookieBytes ?? MAX_COOKIE_BYTES;
  const maxCookies = options.maxCookies ?? 50;
  const nameOf = (key: string): string => `${prefix}${encodeURIComponent(key)}`;
  const own = (): Map<string, string> => {
    const out = new Map<string, string>();
    for (const [name, raw] of parseCookies(doc.cookie)) {
      if (!name.startsWith(prefix) || name === `${COOKIE_PREFIX}__probe__`) continue;
      try {
        out.set(decodeURIComponent(name.slice(prefix.length)), raw);
      } catch {
        // foreign cookie with an undecodable name; not ours
      }
    }
    return out;
  };
  const decodeRaw = (key: string, raw: string): Result<V> => {
    let text: string;
    try {
      text = decodeURIComponent(raw);
    } catch {
      text = raw;
    }
    return codec.decode(text, key);
  };
  const remove = (key: string): void => {
    doc.cookie = serializeCookie(nameOf(key), '', { ...attributes, maxAgeSeconds: 0 });
  };

  return ok(
    storeFromDriver<V>({
      id: 'cookie',
      capabilities: {
        atomicBatch: false,
        ordered: false,
        crossTabEvents: false,
        persistent: options.maxAgeSeconds !== undefined,
        ttl: true,
        maxValueBytes: maxBytes,
      },
      get(key) {
        const raw = own().get(key);
        return raw === undefined ? ok(undefined) : decodeRaw(key, raw);
      },
      has: (key) => ok(own().has(key)),
      set(key, value, ttlMs) {
        const encoded = codec.encode(value, key);
        if (!encoded.ok) return encoded;
        const name = nameOf(key);
        const raw = encodeURIComponent(encoded.value);
        const bytes = utf8Bytes(name) + 1 + utf8Bytes(raw);
        if (bytes > maxBytes) {
          return err(StoreQuotaError({ message: `Cookie "${key}" would be ${bytes} bytes (limit ${maxBytes}).`, details: { backend: 'cookie', key, bytes } }));
        }
        const existing = own();
        if (!existing.has(key) && existing.size >= maxCookies) {
          return err(StoreQuotaError({ message: `Cookie store already holds ${maxCookies} cookies.`, details: { backend: 'cookie', key } }));
        }
        const cookieAttributes = ttlMs === undefined ? attributes : { ...attributes, maxAgeSeconds: Math.ceil(ttlMs / 1000) };
        doc.cookie = serializeCookie(name, raw, cookieAttributes);
        return ok();
      },
      delete(key) {
        remove(key);
        return ok();
      },
      clear() {
        for (const key of own().keys()) remove(key);
        return ok();
      },
      entries() {
        const out: Entry<V>[] = [];
        for (const [key, raw] of own()) {
          const value = decodeRaw(key, raw);
          if (!value.ok) return value;
          out.push([key, value.value]);
        }
        return ok(out);
      },
    }),
  );
}

/**
 * Minimal in-memory cookie jar implementing `document.cookie` semantics the
 * adapter relies on (Max-Age expiry with an injectable clock, deletion with
 * Max-Age=0, attribute capture). For tests and non-browser hosts.
 */
export interface FakeCookieDocument extends CookieDocumentLike {
  /** Raw `Set-Cookie`-style strings written, in order. */
  readonly writes: readonly string[];
}

export function createFakeCookieDocument(now: () => number = Date.now): FakeCookieDocument {
  const jar = new Map<string, { value: string; expiresAt: number | undefined }>();
  const writes: string[] = [];
  return {
    writes,
    get cookie() {
      const parts: string[] = [];
      for (const [name, entry] of jar) {
        if (entry.expiresAt !== undefined && entry.expiresAt <= now()) {
          jar.delete(name);
          continue;
        }
        parts.push(`${name}=${entry.value}`);
      }
      return parts.join('; ');
    },
    set cookie(text: string) {
      writes.push(text);
      const [pair = '', ...attrs] = text.split(';');
      const index = pair.indexOf('=');
      if (index < 0) return;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      let expiresAt: number | undefined;
      for (const attr of attrs) {
        const [k = '', v = ''] = attr.split('=');
        if (k.trim().toLowerCase() === 'max-age') expiresAt = now() + Number(v.trim()) * 1000;
      }
      if (expiresAt !== undefined && expiresAt <= now()) jar.delete(name);
      else jar.set(name, { value, expiresAt });
    },
  };
}
