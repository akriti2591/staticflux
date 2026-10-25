/**
 * In-memory backend: an `ObjectStore` over a `Map`, and `createMemoryBlobStore`
 * on top. Used for tests, previews and stores that never persist. Runs the
 * same `BlobStore` contract suite as the OPFS backend.
 */
import { err, ok } from '@staticflux/core';
import { createBlobStore, type BlobStoreOptions } from './blob-store.js';
import { abortedError, BlobDisposedError, BlobInvalidInputError, BlobNotFoundError } from './errors.js';
import type { BlobStore, Digest, ObjectStore } from './types.js';

export interface MemoryObjectStore extends ObjectStore {
  /** Replace an object's bytes without re-hashing (fault injection for verify tests). */
  corrupt(digest: Digest, bytes: Uint8Array): void;
  /** Digests currently quarantined. */
  quarantined(): readonly Digest[];
}

export interface MemoryObjectStoreOptions {
  readonly id?: string;
  readonly now?: () => number;
}

export function createMemoryObjectStore(options: MemoryObjectStoreOptions = {}): MemoryObjectStore {
  const id = options.id ?? 'memory';
  const now = options.now ?? Date.now;
  const objects = new Map<Digest, { bytes: Uint8Array; at: number }>();
  const quarantine = new Map<Digest, Uint8Array>();
  let disposed = false;
  const guard = (signal: AbortSignal | undefined) => (disposed ? BlobDisposedError({ details: { store: id } }) : abortedError(signal));
  const missing = (digest: Digest) => BlobNotFoundError({ message: `No object ${digest} in ${id}.`, details: { digest } });

  return {
    id,
    capabilities: { persistent: false, rangeReads: true },
    hasObject(digest, signal) {
      const stopped = guard(signal);
      return Promise.resolve(stopped === undefined ? ok(objects.has(digest)) : err(stopped));
    },
    writeObject(digest, bytes, signal) {
      const stopped = guard(signal);
      if (stopped !== undefined) return Promise.resolve(err(stopped));
      if (!objects.has(digest)) objects.set(digest, { bytes: bytes.slice(), at: now() });
      return Promise.resolve(ok());
    },
    readObject(digest, range, signal) {
      const stopped = guard(signal);
      if (stopped !== undefined) return Promise.resolve(err(stopped));
      const entry = objects.get(digest);
      if (entry === undefined) return Promise.resolve(err(missing(digest)));
      if (range === undefined) return Promise.resolve(ok(entry.bytes.slice()));
      const { start, end } = range;
      if (start < 0 || end < start || end > entry.bytes.length) {
        return Promise.resolve(err(BlobInvalidInputError({ message: `Range [${start}, ${end}) is outside [0, ${entry.bytes.length}).` })));
      }
      return Promise.resolve(ok(entry.bytes.slice(start, end)));
    },
    statObject(digest, signal) {
      const stopped = guard(signal);
      if (stopped !== undefined) return Promise.resolve(err(stopped));
      const entry = objects.get(digest);
      return Promise.resolve(entry === undefined ? err(missing(digest)) : ok({ digest, storedSize: entry.bytes.length, modifiedAt: entry.at }));
    },
    deleteObject(digest, signal) {
      const stopped = guard(signal);
      if (stopped !== undefined) return Promise.resolve(err(stopped));
      objects.delete(digest);
      return Promise.resolve(ok());
    },
    quarantineObject(digest, signal) {
      const stopped = guard(signal);
      if (stopped !== undefined) return Promise.resolve(err(stopped));
      const entry = objects.get(digest);
      if (entry === undefined) return Promise.resolve(err(missing(digest)));
      objects.delete(digest);
      quarantine.set(digest, entry.bytes);
      return Promise.resolve(ok(`quarantine/${digest.slice(7)}`));
    },
    async *listObjects(signal) {
      for (const digest of [...objects.keys()]) {
        const stopped = guard(signal);
        if (stopped !== undefined) {
          yield err(stopped);
          return;
        }
        yield ok(digest);
      }
    },
    corrupt(digest, bytes) {
      const entry = objects.get(digest);
      if (entry !== undefined) entry.bytes = bytes.slice();
    },
    quarantined() {
      return [...quarantine.keys()];
    },
    dispose() {
      disposed = true;
    },
  };
}

/** A `BlobStore` kept in memory. */
export function createMemoryBlobStore(options: BlobStoreOptions & MemoryObjectStoreOptions = {}): BlobStore {
  return createBlobStore(createMemoryObjectStore(options), options);
}
