import { createDocumentRepo, type PartOp } from '@staticflux/document/v2';
import { createLoroEngine } from '@staticflux/document/loro-crdt';
import { createFakeIndexedDb, createIndexedDbStore, createMemoryStore } from '@staticflux/storage';
import { runDocumentStoreContract } from '@staticflux/testkit';
import { describe, expect, it } from 'vitest';
import { DOCUMENT_STORE_KEYS, documentStoreFromAsyncStore, type WorkspaceLocks } from './document-store.js';

const signal = (): AbortSignal => new AbortController().signal;
const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
const idbStore = (idb = createFakeIndexedDb()) => unwrap(createIndexedDbStore<unknown>({ namespace: 'ws', indexedDB: idb, keyRange: idb.keyRange, broadcast: null }));

runDocumentStoreContract('AsyncStore adapter (memory)', () => documentStoreFromAsyncStore(createMemoryStore(), { locks: null }), { describe, it });
runDocumentStoreContract('AsyncStore adapter (IndexedDB)', () => documentStoreFromAsyncStore(idbStore(), { locks: null }), { describe, it });

describe('documentStoreFromAsyncStore', () => {
  it('persists: a second adapter over the same backend sees heads, blobs and the log (a reload)', async () => {
    const idb = createFakeIndexedDb();
    const first = documentStoreFromAsyncStore(idbStore(idb), { locks: null });
    const head = { asset: 'as_1', generation: 1, engine: 'loro/1', treeSchema: 1, parts: {}, logFrom: 1, undoHorizon: 200, app: { home: { n: 1 } } };
    unwrap(await first.writeHead('as_1', head, null, signal()));
    const ref = unwrap(await first.putBlob(new Uint8Array([7, 8]), signal()));
    expect(unwrap(await first.appendLog('as_1', new Uint8Array([1]), signal()))).toBe(1);
    const second = documentStoreFromAsyncStore(idbStore(idb), { locks: null });
    expect(unwrap(await second.readHead('as_1', signal()))).toEqual(head);
    expect([...unwrap(await second.getBlob(ref, signal()))]).toEqual([7, 8]);
    expect(unwrap(await second.appendLog('as_1', new Uint8Array([2]), signal()))).toBe(2);
    expect(unwrap(await second.readLog('as_1', 0, signal())).map((e) => e.seq)).toEqual([1, 2]);
  });

  it('keeps log keys in seq order past one digit (zero padded)', () => {
    expect(DOCUMENT_STORE_KEYS.log('as_1', 2) < DOCUMENT_STORE_KEYS.log('as_1', 10)).toBe(true);
    expect(DOCUMENT_STORE_KEYS.log('as_1', 10).startsWith(DOCUMENT_STORE_KEYS.logPrefix('as_1'))).toBe(true);
  });

  it('serializes concurrent appends and swaps of one asset (no seq reused, one CAS winner)', async () => {
    const store = documentStoreFromAsyncStore(createMemoryStore(), { locks: null });
    const seqs = await Promise.all(Array.from({ length: 8 }, (_, i) => store.appendLog('as_c', new Uint8Array([i]), signal())));
    expect(seqs.map(unwrap).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const head = (generation: number) => ({ asset: 'as_c', generation, engine: 'loro/1', treeSchema: 1, parts: {}, logFrom: 1, undoHorizon: 200 });
    const racing = await Promise.all([store.writeHead('as_c', head(1), null, signal()), store.writeHead('as_c', head(1), null, signal())]);
    expect(racing.filter((r) => r.ok)).toHaveLength(1);
    expect(racing.find((r) => !r.ok)?.ok === false && (racing.find((r) => !r.ok) as { error: { code: string } }).error.code).toBe('SF-DOC-011');
  });

  it('takes the cross-tab lock named after the workspace and asset for read-modify-write steps', async () => {
    const names: string[] = [];
    const locks: WorkspaceLocks = { request: async (name, callback) => (names.push(name), callback()) };
    const store = documentStoreFromAsyncStore(createMemoryStore(), { locks, lockPrefix: 'instaflow/ws_test' });
    unwrap(await store.appendLog('as_l', new Uint8Array([1]), signal()));
    unwrap(await store.writeHead('as_l', { asset: 'as_l', generation: 1, engine: 'loro/1', treeSchema: 1, parts: {}, logFrom: 1, undoHorizon: 200 }, null, signal()));
    unwrap(await store.truncateLog('as_l', 2, signal()));
    unwrap(await store.readHead('as_l', signal()));
    expect(names).toEqual(['instaflow/ws_test/as_l', 'instaflow/ws_test/as_l', 'instaflow/ws_test/as_l']);
  });

  it('holds a real document across repo instances (create, commit, reopen)', async () => {
    const idb = createFakeIndexedDb();
    const engine = createLoroEngine();
    const create = createDocumentRepo({ store: documentStoreFromAsyncStore(idbStore(idb), { locks: null }), engine, peer: () => '11' as never });
    const doc = unwrap(await create.create('as_doc', { treeSchema: 1, parts: ['root'] }, signal()));
    unwrap(await doc.part('root', signal()));
    const ops: PartOp[] = [{ op: 'create', node: 'n1', kind: 'page', parent: null, props: { name: 'Hello' } }];
    const committed = unwrap(doc.commit({ actor: { kind: 'human', id: 'p' }, label: 'seed' }, { root: ops }));
    unwrap(await committed.durable);
    unwrap(await doc.close(signal(), { compact: false }));
    const reopen = createDocumentRepo({ store: documentStoreFromAsyncStore(idbStore(idb), { locks: null }), engine, peer: () => '22' as never });
    const again = unwrap(await reopen.open('as_doc', signal()));
    const root = unwrap(await again.part('root', signal()));
    expect(root.node('n1')?.kind).toBe('page');
  });
});
