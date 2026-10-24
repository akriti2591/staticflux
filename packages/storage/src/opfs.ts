/**
 * Origin Private File System adapter: one directory per namespace, one file per
 * key (name = URI-encoded key), values through a string codec (JSON default).
 * For large blobs/documents where IndexedDB is slow. Writes go through
 * `createWritable()` (atomic per file: the swap file replaces the old one on
 * close) and are serialized per store. Batches are NOT atomic.
 *
 * Detection: `navigator.storage.getDirectory` missing → `err(SF-STORE-002)`.
 * Safari only exposes `createWritable` from v17 (main thread): when missing,
 * writes return `SF-STORE-002` so `fallback([...])` can switch backends.
 */
import { err, ok, type Result } from '@staticflux/core';
import { storeFromDriver } from './base.js';
import { createChangeBroadcast } from './broadcast.js';
import { type Codec, jsonCodec } from './codec.js';
import { StoreUnavailableError } from './errors.js';
import { type AsyncStore, type BroadcastChannelFactory, type Entry, globalBroadcastFactory } from './types.js';

export interface OpfsWritableLike {
  write(data: string): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

export interface OpfsFileHandleLike {
  getFile(): Promise<{ text(): Promise<string> }>;
  createWritable?(): Promise<OpfsWritableLike>;
}

export interface OpfsDirectoryHandleLike {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryHandleLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandleLike>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  keys(): AsyncIterable<string>;
}

export interface OpfsStoreOptions<V> {
  /** Directory name under the OPFS root (one per namespace). */
  readonly namespace: string;
  /** Injectable root (default `navigator.storage.getDirectory()`). */
  readonly root?: (() => Promise<OpfsDirectoryHandleLike>) | null;
  readonly codec?: Codec<V, string>;
  readonly broadcast?: BroadcastChannelFactory | null;
}

/** File name for a key: URI-encoded, with `.` escaped so `.`/`..` can never occur. */
export function opfsFileName(key: string): string {
  return encodeURIComponent(key).replace(/\./g, '%2E').replace(/\*/g, '%2A');
}

export function opfsKeyOf(fileName: string): string | undefined {
  try {
    return decodeURIComponent(fileName);
  } catch {
    return undefined;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'NotFoundError';
}

function defaultRoot(): (() => Promise<OpfsDirectoryHandleLike>) | undefined {
  const storage = (globalThis as { navigator?: { storage?: { getDirectory?: () => Promise<unknown> } } }).navigator?.storage;
  if (typeof storage?.getDirectory !== 'function') return undefined;
  return () => storage.getDirectory?.() as Promise<OpfsDirectoryHandleLike>;
}

export function createOpfsStore<V = unknown>(options: OpfsStoreOptions<V>): Result<AsyncStore<V>> {
  const getRoot = options.root === undefined ? defaultRoot() : (options.root ?? undefined);
  if (getRoot === undefined) {
    return err(StoreUnavailableError({ message: 'The Origin Private File System is not available.', details: { backend: 'opfs' } }));
  }
  const codec = options.codec ?? jsonCodec<V>();
  let directory: Promise<OpfsDirectoryHandleLike> | undefined;
  const dir = (): Promise<OpfsDirectoryHandleLike> => {
    directory ??= getRoot()
      .then((root) => root.getDirectoryHandle(opfsFileName(options.namespace), { create: true }))
      .catch((error: unknown) => {
        directory = undefined;
        throw StoreUnavailableError({ cause: error, message: 'Could not open the OPFS directory.', details: { backend: 'opfs', op: 'open' } });
      });
    return directory;
  };
  let writes: Promise<unknown> = Promise.resolve();
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = writes.then(fn, fn);
    writes = next.catch(() => undefined);
    return next;
  };
  const readFile = async (key: string): Promise<Result<V | undefined>> => {
    let handle: OpfsFileHandleLike;
    try {
      handle = await (await dir()).getFileHandle(opfsFileName(key));
    } catch (error) {
      if (isNotFound(error)) return ok(undefined);
      throw error;
    }
    const text = await (await handle.getFile()).text();
    return codec.decode(text, key);
  };
  const writeFile = (key: string, value: V): Promise<Result<void>> => {
    const encoded = codec.encode(value, key);
    if (!encoded.ok) return Promise.resolve(encoded);
    return serialized(async () => {
      const handle = await (await dir()).getFileHandle(opfsFileName(key), { create: true });
      if (typeof handle.createWritable !== 'function') {
        return err(StoreUnavailableError({ message: 'OPFS writes need createWritable() (Safari < 17 lacks it on the main thread).', details: { backend: 'opfs', op: 'set' } }));
      }
      const writable = await handle.createWritable();
      try {
        await writable.write(encoded.value);
        await writable.close();
      } catch (error) {
        await writable.abort?.().catch(() => undefined);
        throw error;
      }
      return ok();
    });
  };
  const removeFile = (key: string): Promise<Result<void>> =>
    serialized(async () => {
      try {
        await (await dir()).removeEntry(opfsFileName(key));
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      return ok();
    });
  const listKeys = async (): Promise<string[]> => {
    const out: string[] = [];
    for await (const name of (await dir()).keys()) {
      const key = opfsKeyOf(name);
      if (key !== undefined && !name.endsWith('.crswap')) out.push(key);
    }
    return out;
  };
  const broadcast = createChangeBroadcast<V>(
    options.broadcast === undefined ? globalBroadcastFactory() : (options.broadcast ?? undefined),
    `sf-store:opfs/${options.namespace}`,
  );

  return ok(
    storeFromDriver<V>({
      id: 'opfs',
      capabilities: { atomicBatch: false, ordered: false, crossTabEvents: broadcast.available, persistent: true, ttl: false },
      get: (key) => readFile(key),
      set: (key, value) => writeFile(key, value),
      delete: (key) => removeFile(key),
      async clear() {
        for (const key of await listKeys()) {
          const removed = await removeFile(key);
          if (!removed.ok) return removed;
        }
        return ok();
      },
      async entries(seek) {
        const out: Entry<V>[] = [];
        for (const key of await listKeys()) {
          if (seek.prefix !== undefined && !key.startsWith(seek.prefix)) continue;
          const value = await readFile(key);
          if (!value.ok) return value;
          if (value.value !== undefined) out.push([key, value.value]);
        }
        return ok(out);
      },
      afterChange: (change) => broadcast.publish(change),
      listen: (emit) => broadcast.listen(emit),
      dispose: () => broadcast.close(),
    }),
  );
}

/** In-memory OPFS directory for tests. `writable: false` simulates Safari without createWritable. */
export function createFakeOpfsRoot(options: { readonly writable?: boolean } = {}): OpfsDirectoryHandleLike & { readonly tree: Map<string, unknown> } {
  const notFound = (name: string): Error => Object.assign(new Error(`${name} not found`), { name: 'NotFoundError' });
  const makeDir = (tree: Map<string, unknown>): OpfsDirectoryHandleLike & { readonly tree: Map<string, unknown> } => ({
    tree,
    async getDirectoryHandle(name, opts = {}) {
      let child = tree.get(name);
      if (child === undefined) {
        if (opts.create !== true) throw notFound(name);
        child = new Map<string, unknown>();
        tree.set(name, child);
      }
      if (!(child instanceof Map)) throw Object.assign(new Error('not a directory'), { name: 'TypeMismatchError' });
      return makeDir(child as Map<string, unknown>);
    },
    async getFileHandle(name, opts = {}) {
      if (!tree.has(name)) {
        if (opts.create !== true) throw notFound(name);
        tree.set(name, '');
      }
      const handle: OpfsFileHandleLike = {
        async getFile() {
          const content = tree.get(name);
          if (typeof content !== 'string') throw notFound(name);
          return { text: async () => content };
        },
      };
      if (options.writable !== false) {
        handle.createWritable = async () => {
          let buffer = '';
          return {
            async write(data: string) {
              buffer += data;
            },
            async close() {
              tree.set(name, buffer);
            },
            async abort() {
              buffer = '';
            },
          };
        };
      }
      return handle;
    },
    async removeEntry(name) {
      if (!tree.delete(name)) throw notFound(name);
    },
    async *keys() {
      yield* [...tree.keys()];
    },
  });
  return makeDir(new Map());
}
