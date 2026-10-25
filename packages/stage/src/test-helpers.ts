import { createLoroEngine } from '@staticflux/document/loro-crdt';
import { createDocumentRepo, createMemoryDocumentStore, type DocumentCRDTv2, type DocumentStore, type OpenDocument, type PartOp, type PeerId } from '@staticflux/document/v2';
import type { Actor } from './actor.js';
import { createPartsDocument, type PartsDocument } from './source.js';

export const engine = createLoroEngine();
export const signal = new AbortController().signal;

export const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};

export const alice: Actor = { kind: 'human', id: 'g-alice', displayName: 'Alice', via: 'direct' };
export const bob: Actor = { kind: 'human', id: 'g-bob', displayName: 'Bob', via: 'direct' };
export const agent: Actor = { kind: 'agent', id: 'ag-1', displayName: 'Helper', model: 'claude-test', via: 'chat', onBehalfOf: 'g-alice' };

let peer = 1000;
export const nextPeer = (): PeerId => `${(peer += 1)}` as PeerId;

/** A part with the given ops applied (one commit). */
export function part(ops: readonly PartOp[] = []): DocumentCRDTv2 {
  const crdt = engine.create({ peer: nextPeer() });
  if (ops.length > 0) unwrap(crdt.transact({ actor: { kind: 'human', id: 'seed' }, label: 'Seed' }, ops));
  return crdt;
}

/** A stage document over one part. */
export function docOf(key: string, ops: readonly PartOp[]): { doc: PartsDocument; part: DocumentCRDTv2 } {
  const crdt = part(ops);
  const doc = createPartsDocument(key);
  doc.attach(crdt, { id: 'root' });
  return { doc, part: crdt };
}

export const seedMeta = { actor: { kind: 'human', id: 'seed' }, label: 'Seed', txn: 'seed-txn' };

/** An asset with a root part and one page part (`page:p1` holding `box` and `card`), opened in a repo. */
export async function openSeeded(store: DocumentStore = createMemoryDocumentStore()): Promise<{ store: DocumentStore; doc: OpenDocument }> {
  const repo = createDocumentRepo({ store, engine, peer: nextPeer });
  const doc = unwrap(await repo.create('as_s', { treeSchema: 1, parts: ['root', 'page:p1', 'page:p2'] }, signal));
  for (const id of doc.partIds()) unwrap(await doc.part(id, signal));
  unwrap(
    await doc.transact(
      seedMeta,
      {
        root: [{ op: 'create', node: 'comp', kind: 'composition', parent: null }],
        'page:p1': [
          { op: 'create', node: 'p1', kind: 'page', parent: null },
          { op: 'create', node: 'box', kind: 'shape', parent: 'p1', props: { 'spatial.x': 0, 'spatial.y': 0 } },
          { op: 'create', node: 'card', kind: 'shape', parent: 'p1', props: { 'spatial.x': 100 } },
        ],
        'page:p2': [{ op: 'create', node: 'p2', kind: 'page', parent: null }],
      },
      signal,
    ),
  );
  return { store, doc };
}

/** Reopen the asset as another session (a new peer, another tab or a reload). */
export async function reopen(store: DocumentStore): Promise<OpenDocument> {
  const doc = unwrap(await createDocumentRepo({ store, engine, peer: nextPeer }).open('as_s', signal));
  for (const id of doc.partIds()) unwrap(await doc.part(id, signal));
  return doc;
}

export const x = (doc: OpenDocument, node = 'box', path = 'spatial.x'): unknown => doc.loadedPart('page:p1')?.prop(node, path);
export const setX = (node: string, value: number, path = 'spatial.x'): Record<string, readonly PartOp[]> => ({ 'page:p1': [{ op: 'set', node, path, value }] });
