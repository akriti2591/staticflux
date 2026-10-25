/**
 * `createBlobStore(objects)` — the `BlobStore` contract on top of any
 * `ObjectStore` backend (memory, OPFS directory, folder). Hashing, chunking
 * (IF-3.5), encoding, ranges, streaming and verification live here once, so
 * every backend behaves identically and runs the same contract suite.
 */
import { err, metric, ok, type Result, type SfError, type Telemetry } from '@staticflux/core';
import type { BlobCatalog } from './catalog.js';
import { canonicalJson, concatBytes, deflateRaw, type DigestLike, defaultSubtle, fromUtf8, inflateRaw, isDigest, sha256, utf8 } from './codec.js';
import { abortedError, BlobDigestMismatchError, BlobDisposedError, BlobInvalidInputError, toBlobError } from './errors.js';
import {
  type BlobRange,
  type BlobRef,
  type BlobStore,
  CHUNK_MANIFEST_SCHEMA,
  CHUNK_SIZE,
  type ChunkManifest,
  type Digest,
  type GetOptions,
  type ObjectStore,
  type PutOptions,
  type VerifyResult,
  WHOLE_BLOB_LIMIT,
} from './types.js';

export const BlobMetrics = {
  bytesWritten: /* @__PURE__ */ metric.counter('blob/bytes-written', { unit: 'By', description: 'Stored bytes written by put().' }),
  objectsWritten: /* @__PURE__ */ metric.counter('blob/objects-written', { description: 'Objects created by put() (chunks and manifests count).' }),
  dedupeHits: /* @__PURE__ */ metric.counter('blob/dedupe-hits', { description: 'Objects put() did not write because the digest existed.' }),
  quarantined: /* @__PURE__ */ metric.counter('blob/quarantined', { description: 'Objects moved to quarantine by verify().' }),
} as const;

export interface BlobStoreOptions {
  readonly subtle?: DigestLike;
  /** Records writes and dedupe hits for catalog-driven GC. */
  readonly catalog?: BlobCatalog;
  readonly telemetry?: Telemetry;
  readonly now?: () => number;
  /** Override the whole-blob limit and chunk size (tests only; production uses 8 MiB / 4 MiB). */
  readonly limits?: { readonly whole: number; readonly chunk: number };
}

/** A byte queue that hands out exact-size pieces. */
function createByteQueue(): { push(bytes: Uint8Array): void; take(n: number): Uint8Array; readonly length: number } {
  const parts: Uint8Array[] = [];
  let length = 0;
  return {
    get length() {
      return length;
    },
    push(bytes) {
      if (bytes.length === 0) return;
      parts.push(bytes);
      length += bytes.length;
    },
    take(n) {
      const out = new Uint8Array(Math.min(n, length));
      let offset = 0;
      while (offset < out.length) {
        const head = parts[0];
        if (head === undefined) break;
        const need = out.length - offset;
        if (head.length <= need) {
          out.set(head, offset);
          offset += head.length;
          parts.shift();
        } else {
          out.set(head.subarray(0, need), offset);
          parts[0] = head.subarray(need);
          offset += need;
        }
      }
      length -= out.length;
      return out;
    },
  };
}

function toStream(input: ReadableStream<Uint8Array> | Uint8Array): ReadableStream<Uint8Array> {
  if (!(input instanceof Uint8Array)) return input;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (input.length > 0) controller.enqueue(input);
      controller.close();
    },
  });
}

/** Parse and validate a chunk manifest object. */
export function parseChunkManifest(bytes: Uint8Array): Result<ChunkManifest> {
  let value: unknown;
  try {
    value = JSON.parse(fromUtf8(bytes));
  } catch (cause) {
    return err(BlobInvalidInputError({ cause, message: 'Chunk manifest is not JSON.' }));
  }
  const manifest = value as Partial<ChunkManifest> | null;
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    manifest.schema !== CHUNK_MANIFEST_SCHEMA ||
    typeof manifest.size !== 'number' ||
    typeof manifest.mime !== 'string' ||
    typeof manifest.chunkSize !== 'number' ||
    !Array.isArray(manifest.chunks) ||
    !manifest.chunks.every(isDigest)
  ) {
    return err(BlobInvalidInputError({ message: `Object is not an ${CHUNK_MANIFEST_SCHEMA} chunk manifest.` }));
  }
  return ok(manifest as ChunkManifest);
}

/** Encode a chunk manifest canonically (its digest is the blob digest). */
export function encodeChunkManifest(manifest: ChunkManifest): Uint8Array {
  return utf8(canonicalJson(manifest));
}

function checkRange(range: BlobRange | undefined, size: number): Result<BlobRange> {
  if (range === undefined) return ok({ start: 0, end: size });
  const { start, end } = range;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > size) {
    return err(BlobInvalidInputError({ message: `Range [${start}, ${end}) is outside [0, ${size}).`, details: { start, end, size } }));
  }
  return ok(range);
}

export function createBlobStore(objects: ObjectStore, options: BlobStoreOptions = {}): BlobStore {
  const subtle = options.subtle ?? defaultSubtle();
  const now = options.now ?? Date.now;
  const telemetry = options.telemetry;
  const wholeLimit = options.limits?.whole ?? WHOLE_BLOB_LIMIT;
  const chunkSize = options.limits?.chunk ?? CHUNK_SIZE;
  let disposed = false;

  const guard = (signal: AbortSignal | undefined): SfError | undefined =>
    disposed ? BlobDisposedError({ details: { store: objects.id } }) : abortedError(signal);

  const record = async (digest: Digest, size: number): Promise<Result<void>> =>
    options.catalog === undefined ? ok() : options.catalog.record([{ digest, size, at: now() }]);

  /** Write one object unless present. */
  const writeOnce = async (
    digest: Digest,
    produce: () => Promise<Uint8Array> | Uint8Array,
    signal: AbortSignal | undefined,
  ): Promise<Result<void>> => {
    const present = await objects.hasObject(digest, signal);
    if (!present.ok) return present;
    if (present.value) {
      if (telemetry !== undefined) telemetry.record(BlobMetrics.dedupeHits, 1, { store: objects.id });
      return record(digest, 0);
    }
    const bytes = await produce();
    const aborted = guard(signal);
    if (aborted !== undefined) return err(aborted);
    const written = await objects.writeObject(digest, bytes, signal);
    if (!written.ok) return written;
    if (telemetry !== undefined) {
      telemetry.record(BlobMetrics.objectsWritten, 1, { store: objects.id });
      telemetry.record(BlobMetrics.bytesWritten, bytes.length, { store: objects.id });
    }
    return record(digest, bytes.length);
  };

  const readManifest = async (digest: Digest, signal: AbortSignal | undefined): Promise<Result<ChunkManifest>> => {
    const bytes = await objects.readObject(digest, undefined, signal);
    return bytes.ok ? parseChunkManifest(bytes.value) : bytes;
  };

  const readChunked = async (ref: BlobRef, range: BlobRange, signal: AbortSignal | undefined): Promise<Result<Uint8Array>> => {
    const manifest = await readManifest(ref.digest, signal);
    if (!manifest.ok) return manifest;
    const { chunkSize: size, chunks } = manifest.value;
    const parts: Uint8Array[] = [];
    for (let index = Math.floor(range.start / size); index < chunks.length && index * size < range.end; index++) {
      const chunkStart = index * size;
      const from = Math.max(range.start, chunkStart) - chunkStart;
      const to = Math.min(range.end, chunkStart + size) - chunkStart;
      const chunk = chunks[index];
      if (chunk === undefined) break;
      const bytes = await objects.readObject(chunk, { start: from, end: to }, signal);
      if (!bytes.ok) return bytes;
      parts.push(bytes.value);
    }
    return ok(concatBytes(parts));
  };

  const quarantine = async (digest: Digest, reason: string, signal: AbortSignal | undefined): Promise<SfError> => {
    const moved = await objects.quarantineObject(digest, signal);
    if (telemetry !== undefined) {
      telemetry.record(BlobMetrics.quarantined, 1, { store: objects.id });
      telemetry.event('blob.quarantined', { subsystem: 'blob/store', level: 'critical', attrs: { digest, reason } });
    }
    return BlobDigestMismatchError({
      message: `Object ${digest} does not match its digest (${reason}); it was quarantined.`,
      details: { digest, reason, quarantined: moved.ok ? moved.value : null },
    });
  };

  const verifyObject = async (digest: Digest, decode: 'raw' | 'deflate-raw' | 'either', signal: AbortSignal | undefined): Promise<Result<void>> => {
    const bytes = await objects.readObject(digest, undefined, signal);
    if (!bytes.ok) return bytes;
    if (decode !== 'deflate-raw' && (await sha256(bytes.value, subtle)) === digest) return ok();
    if (decode !== 'raw') {
      try {
        if ((await sha256(await inflateRaw(bytes.value), subtle)) === digest) return ok();
      } catch {
        // not deflate-raw: falls through to a mismatch
      }
    }
    return err(await quarantine(digest, decode === 'deflate-raw' ? 'decoded content' : 'stored bytes', signal));
  };

  const store: BlobStore = {
    id: objects.id,
    capabilities: objects.capabilities,

    async put(input, putOptions: PutOptions = {}) {
      const signal = putOptions.signal;
      const stopped = guard(signal);
      if (stopped !== undefined) return err(stopped);
      const mime = putOptions.mime ?? 'application/octet-stream';
      const reader = toStream(input).getReader();
      const queue = createByteQueue();
      const chunks: Digest[] = [];
      let bytesRead = 0;
      let chunked = false;
      const progress = (): void => putOptions.onProgress?.({ bytesRead, chunksWritten: chunks.length });
      const writeChunk = async (bytes: Uint8Array): Promise<Result<void>> => {
        const digest = await sha256(bytes, subtle);
        const written = await writeOnce(digest, () => bytes, signal);
        if (!written.ok) return written;
        chunks.push(digest);
        progress();
        return ok();
      };
      try {
        for (;;) {
          const aborted = guard(signal);
          if (aborted !== undefined) {
            await reader.cancel(aborted).catch(() => undefined);
            return err(aborted);
          }
          const { done, value } = await reader.read();
          if (done) break;
          queue.push(value);
          bytesRead += value.length;
          progress();
          if (!chunked && queue.length > wholeLimit) chunked = true;
          while (chunked && queue.length >= chunkSize) {
            const written = await writeChunk(queue.take(chunkSize));
            if (!written.ok) {
              await reader.cancel(written.error).catch(() => undefined);
              return written;
            }
          }
        }
      } catch (cause) {
        return err(toBlobError(cause, 'put/read'));
      } finally {
        reader.releaseLock();
      }
      if (!chunked) {
        const bytes = queue.take(queue.length);
        const digest = await sha256(bytes, subtle);
        const encode = putOptions.encoding === 'deflate-raw';
        const written = await writeOnce(digest, () => (encode ? deflateRaw(bytes) : bytes), signal);
        if (!written.ok) return written;
        const ref: BlobRef = encode ? { digest, size: bytes.length, mime, encoding: 'deflate-raw' } : { digest, size: bytes.length, mime };
        return ok(ref);
      }
      if (queue.length > 0) {
        const written = await writeChunk(queue.take(queue.length));
        if (!written.ok) return written;
      }
      const manifest: ChunkManifest = { schema: CHUNK_MANIFEST_SCHEMA, size: bytesRead, mime, chunkSize: chunkSize as typeof CHUNK_SIZE, chunks };
      const manifestBytes = encodeChunkManifest(manifest);
      const digest = await sha256(manifestBytes, subtle);
      const written = await writeOnce(digest, () => manifestBytes, signal);
      if (!written.ok) return written;
      return ok({ digest, size: bytesRead, mime, chunked: true });
    },

    async putEncoded(stored, ref, putOptions = {}) {
      const signal = putOptions.signal;
      const stopped = guard(signal);
      if (stopped !== undefined) return err(stopped);
      if (!isDigest(ref.digest) || ref.chunked === true) {
        return err(BlobInvalidInputError({ message: 'putEncoded takes a whole (not chunked) BlobRef with a sha256 digest.' }));
      }
      let decoded: Uint8Array;
      try {
        decoded = ref.encoding === 'deflate-raw' ? await inflateRaw(stored) : stored;
      } catch (cause) {
        return err(BlobDigestMismatchError({ cause, message: `Encoded bytes for ${ref.digest} do not decode.`, details: { digest: ref.digest } }));
      }
      const digest = await sha256(decoded, subtle);
      if (digest !== ref.digest || decoded.length !== ref.size) {
        return err(
          BlobDigestMismatchError({
            message: `Encoded bytes decode to ${digest} (${decoded.length} bytes), not ${ref.digest} (${ref.size} bytes).`,
            details: { digest: ref.digest, actual: digest },
          }),
        );
      }
      const written = await writeOnce(digest, () => stored, signal);
      return written.ok ? ok(ref) : written;
    },

    async get(target, getOptions: GetOptions = {}) {
      const signal = getOptions.signal;
      const stopped = guard(signal);
      if (stopped !== undefined) return err(stopped);
      if (typeof target === 'string') {
        if (!isDigest(target)) return err(BlobInvalidInputError({ message: `Not a sha256 digest: "${String(target).slice(0, 80)}"` }));
        return objects.readObject(target, getOptions.range, signal);
      }
      const range = checkRange(getOptions.range, target.size);
      if (!range.ok) return range;
      if (target.chunked === true) return readChunked(target, range.value, signal);
      if (target.encoding === 'deflate-raw') {
        const stored = await objects.readObject(target.digest, undefined, signal);
        if (!stored.ok) return stored;
        try {
          const decoded = await inflateRaw(stored.value);
          return ok(getOptions.range === undefined ? decoded : decoded.slice(range.value.start, range.value.end));
        } catch (cause) {
          return err(await quarantine(target.digest, `undecodable deflate-raw: ${String(cause)}`, signal));
        }
      }
      return objects.readObject(target.digest, getOptions.range, signal);
    },

    stream(ref, streamOptions = {}) {
      const signal = streamOptions.signal;
      const stopped = guard(signal);
      if (stopped !== undefined) return err(stopped);
      let pieces: (() => Promise<Result<Uint8Array>>)[] | undefined;
      return ok(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (pieces === undefined) {
              if (ref.chunked === true) {
                const manifest = await readManifest(ref.digest, signal);
                if (!manifest.ok) {
                  controller.error(manifest.error);
                  return;
                }
                pieces = manifest.value.chunks.map((chunk) => () => objects.readObject(chunk, undefined, signal));
              } else {
                pieces = [() => store.get(ref, signal === undefined ? {} : { signal })];
              }
            }
            const next = pieces.shift();
            if (next === undefined) {
              controller.close();
              return;
            }
            const aborted = guard(signal);
            const bytes = aborted === undefined ? await next() : err(aborted);
            if (!bytes.ok) controller.error(bytes.error);
            else controller.enqueue(bytes.value);
          },
        }),
      );
    },

    async has(digest, hasOptions = {}) {
      const stopped = guard(hasOptions.signal);
      if (stopped !== undefined) return err(stopped);
      if (!isDigest(digest)) return err(BlobInvalidInputError({ message: `Not a sha256 digest: "${String(digest).slice(0, 80)}"` }));
      return objects.hasObject(digest, hasOptions.signal);
    },

    async stat(digest, statOptions = {}) {
      const stopped = guard(statOptions.signal);
      if (stopped !== undefined) return err(stopped);
      if (!isDigest(digest)) return err(BlobInvalidInputError({ message: `Not a sha256 digest: "${String(digest).slice(0, 80)}"` }));
      return objects.statObject(digest, statOptions.signal);
    },

    async verify(target, verifyOptions = {}): Promise<Result<VerifyResult>> {
      const signal = verifyOptions.signal;
      const stopped = guard(signal);
      if (stopped !== undefined) return err(stopped);
      if (typeof target === 'string') {
        if (!isDigest(target)) return err(BlobInvalidInputError({ message: `Not a sha256 digest: "${String(target).slice(0, 80)}"` }));
        const checked = await verifyObject(target, 'either', signal);
        return checked.ok ? ok({ digest: target, objects: 1 }) : checked;
      }
      if (target.chunked !== true) {
        const checked = await verifyObject(target.digest, target.encoding === 'deflate-raw' ? 'deflate-raw' : 'raw', signal);
        return checked.ok ? ok({ digest: target.digest, objects: 1 }) : checked;
      }
      const manifestChecked = await verifyObject(target.digest, 'raw', signal);
      if (!manifestChecked.ok) return manifestChecked;
      const manifest = await readManifest(target.digest, signal);
      if (!manifest.ok) return manifest;
      for (const chunk of manifest.value.chunks) {
        const aborted = guard(signal);
        if (aborted !== undefined) return err(aborted);
        const checked = await verifyObject(chunk, 'raw', signal);
        if (!checked.ok) return checked;
      }
      return ok({ digest: target.digest, objects: 1 + manifest.value.chunks.length });
    },

    async delete(digest, deleteOptions = {}) {
      const stopped = guard(deleteOptions.signal);
      if (stopped !== undefined) return err(stopped);
      if (!isDigest(digest)) return err(BlobInvalidInputError({ message: `Not a sha256 digest: "${String(digest).slice(0, 80)}"` }));
      const removed = await objects.deleteObject(digest, deleteOptions.signal);
      if (!removed.ok) return removed;
      return options.catalog === undefined ? ok() : options.catalog.forget([digest]);
    },

    async *list(listOptions = {}) {
      if (disposed) {
        yield err(BlobDisposedError({ details: { store: objects.id } }));
        return;
      }
      yield* objects.listObjects(listOptions.signal);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      objects.dispose();
    },
  };
  return store;
}
