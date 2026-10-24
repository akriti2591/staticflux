/**
 * Codecs translate values for backends that need another representation
 * (strings for Web Storage/cookies, envelopes for versioned data, base64 for
 * binary). `withCodec(codec)` turns an `AsyncStore<Encoded>` into an
 * `AsyncStore<Value>`; decode failures are `SF-STORE-003` (corrupt).
 *
 * `envelopeCodec` writes the handoff `SnapshotEnvelope` format
 * (`{ v: 1, key, version, createdAt, expiresAt?, data }`, R19.3) so entries
 * written through storage are readable by `@staticflux/handoff` and vice versa.
 */
import { err, ok, type Result, type SfError } from '@staticflux/core';
import { createCursor, createWatchers, guard, validateBatch, validateKey, validateValue } from './base.js';
import { StoreCorruptError, StoreInvalidInputError } from './errors.js';
import type { AsyncStore, BatchOp, Entry, StoreChange, StoreMiddleware } from './types.js';

export interface Codec<V, E> {
  /** Short name used in store ids (`json`, `envelope`, `base64`). */
  readonly id: string;
  encode(value: V, key: string): Result<E>;
  decode(encoded: E, key: string): Result<V>;
}

function corrupt(key: string, codec: string, cause?: unknown, message?: string): SfError {
  return StoreCorruptError({ cause, details: { key, codec }, ...(message === undefined ? {} : { message }) });
}

// ---------------------------------------------------------------- json

/** JSON text. Non-serializable values (cycles, BigInt) → SF-STORE-006; unparsable text → SF-STORE-003. */
export function jsonCodec<V = unknown>(): Codec<V, string> {
  return {
    id: 'json',
    encode(value, key) {
      try {
        const text = JSON.stringify(value);
        if (text === undefined) return err(StoreInvalidInputError({ message: `Value for "${key}" is not JSON-serializable.`, details: { key } }));
        return ok(text);
      } catch (error) {
        return err(StoreInvalidInputError({ cause: error, message: `Value for "${key}" is not JSON-serializable.`, details: { key } }));
      }
    },
    decode(encoded, key) {
      if (typeof encoded !== 'string') return err(corrupt(key, 'json', undefined, `Entry "${key}" is not JSON text.`));
      try {
        return ok(JSON.parse(encoded) as V);
      } catch (error) {
        return err(corrupt(key, 'json', error, `Entry "${key}" is not valid JSON.`));
      }
    },
  };
}

/** Identity codec (structured-clone backends). */
export function identityCodec<V>(): Codec<V, V> {
  return { id: 'identity', encode: (value) => ok(value), decode: (encoded) => ok(encoded) };
}

// ---------------------------------------------------------------- envelope (handoff-compatible)

export const ENVELOPE_FORMAT = 1;

/** Same shape as `@staticflux/handoff`'s `SnapshotEnvelope`. */
export interface StoredEnvelope<T = unknown> {
  readonly v: typeof ENVELOPE_FORMAT;
  readonly key: string;
  readonly version: number;
  readonly createdAt: number;
  readonly expiresAt?: number;
  readonly data: T;
}

export function isStoredEnvelope(value: unknown): value is StoredEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v['v'] === ENVELOPE_FORMAT &&
    typeof v['key'] === 'string' &&
    typeof v['version'] === 'number' &&
    Number.isInteger(v['version']) &&
    typeof v['createdAt'] === 'number' &&
    (v['expiresAt'] === undefined || typeof v['expiresAt'] === 'number') &&
    'data' in v
  );
}

export interface EnvelopeCodecOptions<V> {
  /** Payload schema version written; older entries are migrated on read. */
  readonly version: number;
  /** `migrations[n]` upgrades data from version n to n + 1. */
  readonly migrations?: Readonly<Record<number, (data: unknown) => unknown>>;
  /** Payload validation after migration. */
  readonly validate?: (data: unknown) => data is V;
  /** Envelope key for a store key (default: the store key). */
  readonly keyOf?: (storeKey: string) => string;
  /** Expire entries `ttlMs` after writing (envelope `expiresAt`); expired entries decode as corrupt-free `expired` errors. */
  readonly ttlMs?: number;
  readonly now?: () => number;
}

/**
 * Versioned envelope codec. Decoding checks shape and key, rejects newer
 * versions, migrates older ones and validates. Expired envelopes → SF-STORE-003
 * with `details.expired = true` (wrap with `withTtl()` for silent expiry instead).
 */
export function envelopeCodec<V>(options: EnvelopeCodecOptions<V>): Codec<V, StoredEnvelope<unknown>> {
  const now = options.now ?? Date.now;
  const keyOf = options.keyOf ?? ((key: string) => key);
  return {
    id: `envelope@${options.version}`,
    encode(value, key) {
      const createdAt = now();
      const base = { v: ENVELOPE_FORMAT, key: keyOf(key), version: options.version, createdAt, data: value } as const;
      return ok(options.ttlMs === undefined ? base : { ...base, expiresAt: createdAt + options.ttlMs });
    },
    decode(raw, key) {
      if (!isStoredEnvelope(raw)) return err(corrupt(key, 'envelope', undefined, `Entry "${key}" is not a snapshot envelope.`));
      const expected = keyOf(key);
      if (raw.key !== expected) return err(corrupt(key, 'envelope', undefined, `Envelope key "${raw.key}" does not match "${expected}".`));
      if (raw.expiresAt !== undefined && raw.expiresAt <= now()) {
        return err(StoreCorruptError({ message: `Envelope "${raw.key}" has expired.`, details: { key, codec: 'envelope', expired: true } }));
      }
      if (raw.version > options.version) {
        return err(corrupt(key, 'envelope', undefined, `Envelope "${raw.key}" has version ${raw.version}, newer than ${options.version}.`));
      }
      let data: unknown = raw.data;
      for (let version = raw.version; version < options.version; version += 1) {
        const migrate = options.migrations?.[version];
        if (migrate === undefined) return err(corrupt(key, 'envelope', undefined, `No migration from version ${version} for "${raw.key}".`));
        try {
          data = migrate(data);
        } catch (error) {
          return err(corrupt(key, 'envelope', error, `Migration from version ${version} for "${raw.key}" threw.`));
        }
      }
      if (options.validate !== undefined && !options.validate(data)) {
        return err(corrupt(key, 'envelope', undefined, `Payload of "${raw.key}" failed validation.`));
      }
      return ok(data as V);
    },
  };
}

// ---------------------------------------------------------------- binary

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Binary values (Uint8Array / ArrayBuffer) as base64 text for string-only backends. Decodes to Uint8Array. */
export function binaryCodec(): Codec<Uint8Array | ArrayBuffer, string> {
  return {
    id: 'base64',
    encode(value, key) {
      if (value instanceof Uint8Array) return ok(bytesToBase64(value));
      if (value instanceof ArrayBuffer) return ok(bytesToBase64(new Uint8Array(value)));
      return err(StoreInvalidInputError({ message: `Value for "${key}" is not binary.`, details: { key } }));
    },
    decode(encoded, key) {
      if (typeof encoded !== 'string') return err(corrupt(key, 'base64'));
      try {
        return ok(base64ToBytes(encoded));
      } catch (error) {
        return err(corrupt(key, 'base64', error, `Entry "${key}" is not valid base64.`));
      }
    },
  };
}

// ---------------------------------------------------------------- value-mapping middleware

export interface ValueMapper<In, Out> {
  readonly name: string;
  encode(value: Out, key: string, signal: AbortSignal | undefined): Promise<Result<In>> | Result<In>;
  decode(raw: In, key: string, signal: AbortSignal | undefined): Promise<Result<Out>> | Result<Out>;
  /** Decode values carried by change events (default true). */
  readonly decodeChanges?: boolean;
}

/**
 * Wrap a store, mapping values in and out. Keys, capabilities and atomicity are
 * those of the inner store. Used by `withCodec` and `encrypted`.
 */
export function mapValues<In, Out>(inner: AsyncStore<In>, mapper: ValueMapper<In, Out>): AsyncStore<Out> {
  let disposed = false;
  const id = `${mapper.name}(${inner.id})`;
  let unsubscribe: (() => void) | undefined;
  let queue: Promise<void> = Promise.resolve();
  const watchers = createWatchers<Out>(
    () => {
      unsubscribe = inner.watch((change) => {
        if (change.type !== 'set' || change.value === undefined || mapper.decodeChanges === false) {
          const { type } = change;
          const plain: StoreChange<Out> =
            type === 'clear' ? change : type === 'delete' ? change : { type: 'set', key: change.key, origin: change.origin };
          queue = queue.then(() => watchers.emit(plain));
          return;
        }
        const raw = change.value;
        queue = queue.then(async () => {
          const decoded = await mapper.decode(raw, change.key, undefined);
          watchers.emit(
            decoded.ok
              ? { type: 'set', key: change.key, value: decoded.value, origin: change.origin }
              : { type: 'set', key: change.key, origin: change.origin },
          );
        });
      });
    },
    () => {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  );
  const encodeOps = async (ops: readonly BatchOp<Out>[], signal: AbortSignal | undefined): Promise<Result<BatchOp<In>[]>> => {
    const out: BatchOp<In>[] = [];
    for (const op of ops) {
      if (op.type === 'delete') {
        out.push(op);
        continue;
      }
      const encoded = await mapper.encode(op.value, op.key, signal);
      if (!encoded.ok) return encoded;
      out.push(op.ttlMs === undefined ? { type: 'set', key: op.key, value: encoded.value } : { type: 'set', key: op.key, value: encoded.value, ttlMs: op.ttlMs });
    }
    return ok(out);
  };
  return {
    id,
    capabilities: inner.capabilities,
    async get(key, options = {}) {
      const ready = guard(disposed, id, options.signal);
      if (!ready.ok) return ready;
      const raw = await inner.get(key, options);
      if (!raw.ok || raw.value === undefined) return raw as Result<undefined>;
      return mapper.decode(raw.value, key, options.signal);
    },
    async set(key, value, options = {}) {
      const ready = guard(disposed, id, options.signal);
      if (!ready.ok) return ready;
      const validKey = validateKey(key);
      if (!validKey.ok) return validKey;
      const validValue = validateValue(key, value);
      if (!validValue.ok) return validValue;
      const encoded = await mapper.encode(value, key, options.signal);
      if (!encoded.ok) return encoded;
      return inner.set(key, encoded.value, options);
    },
    delete: (key, options = {}) => (disposed ? Promise.resolve(guard(true, id, undefined)) : inner.delete(key, options)),
    has: (key, options = {}) => (disposed ? Promise.resolve(guard(true, id, undefined) as Result<never>) : inner.has(key, options)),
    clear: (options = {}) => (disposed ? Promise.resolve(guard(true, id, undefined)) : inner.clear(options)),
    seek(options = {}) {
      return createCursor(async () => {
        const ready = guard(disposed, id, options.signal);
        if (!ready.ok) return ready;
        const raw = await inner.seek(options).toArray();
        if (!raw.ok) return raw;
        const out: Entry<Out>[] = [];
        for (const [key, value] of raw.value) {
          const decoded = await mapper.decode(value, key, options.signal);
          if (!decoded.ok) return decoded;
          out.push([key, decoded.value]);
        }
        return ok(out);
      });
    },
    async batch(ops, options = {}) {
      const ready = guard(disposed, id, options.signal);
      if (!ready.ok) return ready;
      const valid = validateBatch(ops);
      if (!valid.ok) return valid;
      const encoded = await encodeOps(ops, options.signal);
      if (!encoded.ok) return encoded;
      return inner.batch(encoded.value, options);
    },
    watch(listener, options) {
      return disposed ? () => undefined : watchers.add(listener, options);
    },
    async dispose() {
      if (disposed) return ok();
      disposed = true;
      watchers.clear();
      return inner.dispose();
    },
  };
}

/** Middleware: store values through `codec` (e.g. `withCodec(jsonCodec())` over a string store). */
export function withCodec<V, E>(codec: Codec<V, E>): StoreMiddleware<E, V> {
  return (inner) =>
    mapValues<E, V>(inner, {
      name: codec.id,
      encode: (value, key) => codec.encode(value, key),
      decode: (raw, key) => codec.decode(raw, key),
    });
}
