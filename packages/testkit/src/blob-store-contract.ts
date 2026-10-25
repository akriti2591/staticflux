/**
 * `BlobStore` contract suite (SF-Δ1, IF-3.4/3.5/3.12). Every `@staticflux/blob`
 * backend (memory, OPFS directory, folder) must pass it, in Node over the
 * in-memory file system and in Chromium over real OPFS.
 *
 * @example
 * import { describe, it } from 'vitest';
 * runBlobStoreContract('memory', () => {
 *   const objects = createMemoryObjectStore();
 *   return { store: createBlobStore(objects), corrupt: (d, b) => objects.corrupt(d, b) };
 * }, { describe, it });
 */
import {
  type BlobRef,
  type BlobStore,
  CHUNK_MANIFEST_SCHEMA,
  CHUNK_SIZE,
  deflateRaw,
  type Digest,
  inflateRaw,
  parseChunkManifest,
  sha256,
  WHOLE_BLOB_LIMIT,
} from '@staticflux/blob';
import { assertEqual, assertTrue, type ContractCaseBase, type ContractRunner, errOf, okValue } from './contract-runner.js';

export interface BlobStoreFixture {
  readonly store: BlobStore;
  /** Overwrite a stored object's bytes behind the store's back (enables the quarantine cases). */
  readonly corrupt?: (digest: Digest, bytes: Uint8Array) => Promise<void> | void;
  /** Release backend resources after the case (e.g. delete an OPFS directory). */
  readonly cleanup?: () => Promise<void> | void;
}

export type BlobStoreFactory = () => Promise<BlobStoreFixture> | BlobStoreFixture;

export type BlobStoreContractCase = ContractCaseBase<BlobStoreFixture> & { readonly needs?: 'corrupt' };

export interface BlobStoreContractOptions {
  /** Case names to skip (document why at the call site). */
  readonly skip?: readonly string[];
}

const EMPTY_DIGEST: Digest = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function bytesOf(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function streamOf(bytes: Uint8Array, pieces: readonly number[]): ReadableStream<Uint8Array> {
  let offset = 0;
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const size = pieces[index % pieces.length] ?? 1;
      index += 1;
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

async function listed(store: BlobStore): Promise<Digest[]> {
  const out: Digest[] = [];
  for await (const item of store.list()) out.push(okValue(item, 'list'));
  return out.sort();
}

const MIB = 1024 * 1024;

export const blobStoreContractCases: readonly BlobStoreContractCase[] = [
  {
    name: 'put returns a ref whose digest is the SHA-256 of the content; get(ref) and get(digest) return it',
    async run({ store }) {
      const content = bytesOf(1000);
      const ref = okValue(await store.put(content), 'put');
      assertEqual(ref.digest, await sha256(content), 'digest');
      assertEqual(ref.size, 1000, 'size');
      assertEqual(ref.mime, 'application/octet-stream', 'default mime');
      assertTrue(ref.chunked === undefined && ref.encoding === undefined, 'plain whole blob');
      assertTrue(sameBytes(okValue(await store.get(ref), 'get ref'), content), 'get(ref) content');
      assertTrue(sameBytes(okValue(await store.get(ref.digest), 'get digest'), content), 'get(digest) content');
    },
  },
  {
    name: 'put dedupes by digest: same ref, one object',
    async run({ store }) {
      const content = bytesOf(4096, 7);
      const a = okValue(await store.put(content, { mime: 'image/png' }), 'first put');
      const b = okValue(await store.put(content.slice(), { mime: 'image/png' }), 'second put');
      assertEqual(b, a, 'same ref');
      assertTrue(okValue(await store.has(a.digest), 'has'), 'has after put');
      assertEqual(await listed(store), [a.digest], 'one object listed');
    },
  },
  {
    name: 'an empty blob has the empty digest and size 0',
    async run({ store }) {
      const ref = okValue(await store.put(new Uint8Array(0)), 'put empty');
      assertEqual(ref.digest, EMPTY_DIGEST, 'empty digest');
      assertEqual(ref.size, 0, 'size');
      assertEqual(okValue(await store.get(ref), 'get').length, 0, 'empty content');
    },
  },
  {
    name: 'a stream in irregular pieces yields the same ref as one buffer, and keeps the mime',
    async run({ store }) {
      const content = bytesOf(70_001, 3);
      const whole = okValue(await store.put(content, { mime: 'text/plain' }), 'buffer put');
      const streamed = okValue(await store.put(streamOf(content, [1, 4093, 17, 65_536]), { mime: 'text/plain' }), 'stream put');
      assertEqual(streamed, whole, 'same ref');
    },
  },
  {
    name: 'deflate-raw encoding stores compressed bytes but get(ref) returns the content',
    async run({ store }) {
      const content = new TextEncoder().encode('canonical part '.repeat(2000));
      const ref = okValue(await store.put(content, { encoding: 'deflate-raw', mime: 'application/json' }), 'put');
      assertEqual(ref.encoding, 'deflate-raw', 'encoding');
      assertEqual(ref.digest, await sha256(content), 'digest of decoded content');
      assertTrue(sameBytes(okValue(await store.get(ref), 'get'), content), 'decoded');
      const stored = okValue(await store.get(ref.digest), 'get stored');
      assertTrue(stored.length < content.length, 'stored smaller');
      assertTrue(sameBytes(await inflateRaw(stored), content), 'stored is deflate-raw');
      assertTrue(sameBytes(okValue(await store.get(ref, { range: { start: 15, end: 30 } }), 'range'), content.slice(15, 30)), 'range of decoded');
      assertEqual(okValue(await store.verify(ref), 'verify ref').objects, 1, 'verify ref');
      assertEqual(okValue(await store.verify(ref.digest), 'verify digest').objects, 1, 'verify bare digest accepts deflate');
    },
  },
  {
    name: 'exactly 8 MiB is one whole object',
    async run({ store }) {
      const content = bytesOf(WHOLE_BLOB_LIMIT, 11);
      const ref = okValue(await store.put(content), 'put');
      assertTrue(ref.chunked === undefined, 'not chunked');
      assertEqual(ref.digest, await sha256(content), 'whole digest');
    },
  },
  {
    name: 'above 8 MiB: 4 MiB chunks plus a manifest whose digest is the blob digest; reads, ranges and streams reassemble',
    async run({ store }) {
      const size = WHOLE_BLOB_LIMIT + 5;
      const content = bytesOf(size, 13);
      let lastProgress = 0;
      const ref = okValue(await store.put(streamOf(content, [MIB + 3]), { mime: 'video/mp4', onProgress: (p) => (lastProgress = p.bytesRead) }), 'put');
      assertEqual(lastProgress, size, 'progress reports every byte');
      assertEqual(ref.chunked, true, 'chunked');
      assertEqual(ref.size, size, 'size');
      const manifestBytes = okValue(await store.get(ref.digest), 'manifest object');
      assertEqual(ref.digest, await sha256(manifestBytes), 'digest names the manifest');
      const manifest = okValue(parseChunkManifest(manifestBytes), 'manifest parses');
      assertEqual(manifest.schema, CHUNK_MANIFEST_SCHEMA, 'schema');
      assertEqual(manifest.chunkSize, CHUNK_SIZE, 'chunk size');
      assertEqual(manifest.chunks.length, 3, 'three chunks');
      assertEqual(manifest.chunks[0], await sha256(content.slice(0, CHUNK_SIZE)), 'chunk 0 digest');
      assertTrue(sameBytes(okValue(await store.get(ref), 'get'), content), 'reassembled');
      const range = { start: CHUNK_SIZE - 10, end: 2 * CHUNK_SIZE + 3 };
      assertTrue(sameBytes(okValue(await store.get(ref, { range }), 'range'), content.slice(range.start, range.end)), 'range across chunks');
      assertTrue(sameBytes(await readAll(okValue(store.stream(ref), 'stream')), content), 'stream');
      assertEqual(okValue(await store.verify(ref), 'verify').objects, 4, 'verify manifest + chunks');
      // The manifest names the mime, so the same content under another mime is another blob (sharing every chunk).
      const again = okValue(await store.put(streamOf(content, [7_777_777]), { mime: 'video/mp4' }), 'put again in other pieces');
      assertEqual(again.digest, ref.digest, 'chunking is independent of input piece sizes');
    },
  },
  {
    name: 'range reads of a whole blob; out-of-bounds ranges are SF-BLOB-008',
    async run({ store }) {
      const content = bytesOf(5000, 5);
      const ref = okValue(await store.put(content), 'put');
      assertTrue(sameBytes(okValue(await store.get(ref, { range: { start: 100, end: 4000 } }), 'range'), content.slice(100, 4000)), 'range');
      assertTrue(sameBytes(okValue(await store.get(ref.digest, { range: { start: 4990, end: 5000 } }), 'digest range'), content.slice(4990)), 'digest range');
      assertEqual(okValue(await store.get(ref, { range: { start: 5000, end: 5000 } }), 'empty range').length, 0, 'empty range at end');
      assertEqual(errOf(await store.get(ref, { range: { start: 10, end: 5001 } }), 'past end').code, 'SF-BLOB-008', 'past end');
      assertEqual(errOf(await store.get(ref, { range: { start: 20, end: 10 } }), 'reversed').code, 'SF-BLOB-008', 'reversed');
    },
  },
  {
    name: 'missing objects: get and stat are SF-BLOB-005, has is false',
    async run({ store }) {
      const digest = await sha256(bytesOf(10, 99));
      assertEqual(errOf(await store.get(digest), 'get').code, 'SF-BLOB-005', 'get missing');
      assertEqual(errOf(await store.stat(digest), 'stat').code, 'SF-BLOB-005', 'stat missing');
      assertEqual(okValue(await store.has(digest), 'has'), false, 'has missing');
    },
  },
  {
    name: 'malformed digests are SF-BLOB-008',
    async run({ store }) {
      const bad = 'sha256:XYZ' as Digest;
      assertEqual(errOf(await store.get(bad), 'get').code, 'SF-BLOB-008', 'get');
      assertEqual(errOf(await store.has(bad), 'has').code, 'SF-BLOB-008', 'has');
      assertEqual(errOf(await store.stat(bad), 'stat').code, 'SF-BLOB-008', 'stat');
      assertEqual(errOf(await store.delete(bad), 'delete').code, 'SF-BLOB-008', 'delete');
    },
  },
  {
    name: 'stat reports the stored size and a modification time',
    async run({ store }) {
      const ref = okValue(await store.put(bytesOf(321, 4)), 'put');
      const stat = okValue(await store.stat(ref.digest), 'stat');
      assertEqual(stat.digest, ref.digest, 'digest');
      assertEqual(stat.storedSize, 321, 'stored size');
      assertTrue(Number.isFinite(stat.modifiedAt) && stat.modifiedAt > 0, 'modifiedAt');
    },
  },
  {
    name: 'verify quarantines an object that no longer matches its digest (SF-BLOB-002)',
    needs: 'corrupt',
    async run({ store, corrupt }) {
      const ref = okValue(await store.put(bytesOf(2048, 21)), 'put');
      await corrupt?.(ref.digest, bytesOf(2048, 22));
      const failure = errOf(await store.verify(ref), 'verify');
      assertEqual(failure.code, 'SF-BLOB-002', 'mismatch');
      assertEqual(errOf(await store.get(ref.digest), 'get after quarantine').code, 'SF-BLOB-005', 'no longer served');
      assertEqual(okValue(await store.put(bytesOf(2048, 21)), 're-put').digest, ref.digest, 'a re-put restores it');
      assertEqual(okValue(await store.verify(ref), 'verify restored').objects, 1, 'restored verifies');
    },
  },
  {
    name: 'an aborted put returns SF-BLOB-006 and publishes nothing',
    async run({ store }) {
      const before = await listed(store);
      const controller = new AbortController();
      controller.abort();
      assertEqual(errOf(await store.put(bytesOf(100), { signal: controller.signal }), 'pre-aborted').code, 'SF-BLOB-006', 'pre-aborted');
      const mid = new AbortController();
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          sent += 1;
          if (sent === 3) mid.abort();
          c.enqueue(bytesOf(1000, sent));
        },
      });
      assertEqual(errOf(await store.put(stream, { signal: mid.signal }), 'mid-stream').code, 'SF-BLOB-006', 'aborted mid-stream');
      assertEqual(await listed(store), before, 'nothing published');
    },
  },
  {
    name: 'delete removes an object (GC only); deleting a missing object is ok',
    async run({ store }) {
      const ref = okValue(await store.put(bytesOf(64, 8)), 'put');
      okValue(await store.delete(ref.digest), 'delete');
      assertEqual(okValue(await store.has(ref.digest), 'has'), false, 'gone');
      okValue(await store.delete(ref.digest), 'delete again');
      assertEqual(await listed(store), [], 'nothing listed');
    },
  },
  {
    name: 'putEncoded adopts deflate-raw bytes as stored; a wrong digest is SF-BLOB-002',
    async run({ store }) {
      const content = new TextEncoder().encode('{"schema":"instaflow.part/1"}'.repeat(50));
      const stored = await deflateRaw(content);
      const ref: BlobRef = { digest: await sha256(content), size: content.length, mime: 'application/json', encoding: 'deflate-raw' };
      assertEqual(okValue(await store.putEncoded(stored, ref), 'adopt'), ref, 'ref back');
      assertTrue(sameBytes(okValue(await store.get(ref.digest), 'stored'), stored), 'stored bytes kept as they are');
      assertTrue(sameBytes(okValue(await store.get(ref), 'decoded'), content), 'decodes');
      const wrong: BlobRef = { ...ref, digest: await sha256(bytesOf(5)) };
      assertEqual(errOf(await store.putEncoded(stored, wrong), 'wrong').code, 'SF-BLOB-002', 'wrong digest');
    },
  },
  {
    name: 'operations after dispose are SF-BLOB-013',
    async run({ store }) {
      const ref = okValue(await store.put(bytesOf(10)), 'put');
      store.dispose();
      assertEqual(errOf(await store.get(ref), 'get').code, 'SF-BLOB-013', 'get after dispose');
      assertEqual(errOf(await store.put(bytesOf(10)), 'put').code, 'SF-BLOB-013', 'put after dispose');
    },
  },
];

/** Register every case with the runner (`describe`/`it` from Vitest or the browser harness). */
export function runBlobStoreContract(name: string, factory: BlobStoreFactory, runner: ContractRunner, options: BlobStoreContractOptions = {}): void {
  runner.describe(`BlobStore contract: ${name}`, () => {
    for (const testCase of blobStoreContractCases) {
      if (options.skip?.includes(testCase.name) === true) continue;
      runner.it(testCase.name, async () => {
        const fixture = await factory();
        if (testCase.needs === 'corrupt' && fixture.corrupt === undefined) return;
        try {
          await testCase.run(fixture);
        } finally {
          await fixture.cleanup?.();
        }
      });
    }
  });
}
