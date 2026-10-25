/**
 * `DocumentStore` contract suite (SF-Δ3). Every backend that persists document
 * heads, blobs and logs (in-memory reference, the workspace `BlobStore` adapter
 * over OPFS or a folder, a cloud bucket later) runs it.
 *
 * @example
 * runDocumentStoreContract('memory', () => createMemoryDocumentStore(), { describe, it });
 */
import type { DocumentHead, DocumentStore } from '@staticflux/document/v2';
import { assertEqual, assertTrue, type ContractRunner, errOf, okValue } from './contract-runner.js';

export interface DocumentStoreContractOptions {
  readonly skip?: readonly string[];
}

export interface DocumentStoreContractCase {
  readonly name: string;
  run(store: DocumentStore): Promise<void>;
}

const signal = (): AbortSignal => new AbortController().signal;
const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

function head(asset: string, generation: number, extra: Partial<DocumentHead> = {}): DocumentHead {
  return { asset, generation, engine: 'test/1', treeSchema: 1, parts: {}, logFrom: 1, undoHorizon: 200, ...extra };
}

export const documentStoreContractCases: readonly DocumentStoreContractCase[] = [
  {
    name: 'heads: absent until written; compare-and-swap on generation',
    async run(store) {
      assertEqual(okValue(await store.readHead('as_a', signal()), 'read missing'), undefined, 'no head yet');
      okValue(await store.writeHead('as_a', head('as_a', 1, { app: { pinned: ['ms_1'] } }), null, signal()), 'create');
      assertEqual(okValue(await store.readHead('as_a', signal()), 'read')?.app, { pinned: ['ms_1'] }, 'app fields kept');
      assertEqual(errOf(await store.writeHead('as_a', head('as_a', 1), null, signal()), 'create twice').code, 'SF-DOC-011', 'exists');
      assertEqual(errOf(await store.writeHead('as_a', head('as_a', 3), 1, signal()), 'skip generation').code, 'SF-DOC-011', 'generation must be +1');
      okValue(await store.writeHead('as_a', head('as_a', 2, { logFrom: 5 }), 1, signal()), 'swap');
      assertEqual(errOf(await store.writeHead('as_a', head('as_a', 2), 1, signal()), 'stale').code, 'SF-DOC-011', 'stale expected generation');
      assertEqual(okValue(await store.readHead('as_a', signal()), 'read')?.logFrom, 5, 'swapped');
      assertEqual(okValue(await store.readHead('as_b', signal()), 'other asset'), undefined, 'heads are per asset');
    },
  },
  {
    name: 'heads: reads are copies (mutating a read head does not change the store)',
    async run(store) {
      okValue(await store.writeHead('as_c', head('as_c', 1, { parts: { root: { digest: 'sha256:00', size: 1 } } }), null, signal()), 'create');
      const read = okValue(await store.readHead('as_c', signal()), 'read') as { parts: Record<string, unknown> };
      read.parts['root'] = undefined;
      assertTrue(okValue(await store.readHead('as_c', signal()), 'reread')?.parts['root'] !== undefined, 'store unchanged');
    },
  },
  {
    name: 'blobs: content-addressed (sha256), idempotent, immutable; missing → SF-DOC-012',
    async run(store) {
      const data = bytes(1, 2, 3);
      const ref = okValue(await store.putBlob(data, signal()), 'put');
      assertEqual(ref, { digest: 'sha256:039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81', size: 3 }, 'ref');
      assertEqual(okValue(await store.putBlob(bytes(1, 2, 3), signal()), 'put again'), ref, 'idempotent');
      data[0] = 9;
      const back = okValue(await store.getBlob(ref, signal()), 'get');
      assertEqual([...back], [1, 2, 3], 'stored bytes immutable');
      back[1] = 9;
      assertEqual([...okValue(await store.getBlob(ref, signal()), 'get again')], [1, 2, 3], 'reads are copies');
      assertEqual(errOf(await store.getBlob({ digest: 'sha256:ffff', size: 1 }, signal()), 'missing').code, 'SF-DOC-012', 'missing blob');
    },
  },
  {
    name: 'log: strictly increasing seqs per asset, read from a seq, truncate below, never reuse seqs',
    async run(store) {
      const s1 = okValue(await store.appendLog('as_l', bytes(1), signal()), 'append 1');
      const s2 = okValue(await store.appendLog('as_l', bytes(2), signal()), 'append 2');
      const s3 = okValue(await store.appendLog('as_l', bytes(3), signal()), 'append 3');
      assertTrue(s1 >= 1 && s2 > s1 && s3 > s2, 'increasing');
      assertEqual(okValue(await store.readLog('as_l', s2, signal()), 'read').map((e) => [e.seq, [...e.bytes]]), [[s2, [2]], [s3, [3]]], 'from seq');
      okValue(await store.truncateLog('as_l', s3, signal()), 'truncate');
      assertEqual(okValue(await store.readLog('as_l', 0, signal()), 'read all').map((e) => e.seq), [s3], 'truncated');
      const s4 = okValue(await store.appendLog('as_l', bytes(4), signal()), 'append 4');
      assertTrue(s4 > s3, 'seq not reused after truncation');
      assertEqual(okValue(await store.readLog('as_other', 0, signal()), 'other asset'), [], 'logs are per asset');
    },
  },
  {
    name: 'every operation honours an aborted signal (SF-CORE-002)',
    async run(store) {
      const controller = new AbortController();
      controller.abort();
      const aborted = controller.signal;
      const results = [
        await store.readHead('as_x', aborted),
        await store.writeHead('as_x', head('as_x', 1), null, aborted),
        await store.putBlob(bytes(1), aborted),
        await store.getBlob({ digest: 'sha256:00', size: 0 }, aborted),
        await store.appendLog('as_x', bytes(1), aborted),
        await store.readLog('as_x', 0, aborted),
        await store.truncateLog('as_x', 1, aborted),
      ];
      assertEqual(results.map((r) => (r.ok ? 'ok' : r.error.code)), Array(7).fill('SF-CORE-002'), 'aborted');
      assertEqual(okValue(await store.readHead('as_x', signal()), 'after'), undefined, 'aborted write had no effect');
    },
  },
];

export function runDocumentStoreContract(
  name: string,
  factory: () => DocumentStore | Promise<DocumentStore>,
  runner: ContractRunner,
  options: DocumentStoreContractOptions = {},
): void {
  runner.describe(`DocumentStore contract: ${name}`, () => {
    for (const c of documentStoreContractCases) {
      if (options.skip?.includes(c.name) === true) continue;
      runner.it(c.name, async () => c.run(await factory()));
    }
  });
}
