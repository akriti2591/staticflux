/**
 * Test helpers for versioning (not built: excluded by name in tsconfig.json). A component
 * registry, a store that counts what is written and read, a seeded multi-page document on the
 * Loro engine, and an actor.
 */
import { createLoroEngine } from '@staticflux/document/loro-crdt';
import {
  type BlobRef,
  createComponentRegistry,
  createDocumentRepo,
  createMemoryDocumentStore,
  type CrdtEngine,
  defineComponent,
  type DocumentRepo,
  type DocumentStore,
  type MemoryDocumentStore,
  type OpenDocument,
  type PartOp,
  type PeerId,
} from '@staticflux/document/v2';
import type { Actor } from '@staticflux/stage';
import type { CompareSession } from './compare.js';
import { createMilestoneService } from './milestones.js';
import { createMilestonesPanelModel, type VersioningHost } from './panel-model.js';
import { createPartCapture } from './parts.js';
import type { ReadOnlyDocument } from './readonly.js';
import type { AssetId } from './records.js';
import { createExportSnapshotService } from './snapshot.js';
import { SlotComponent } from './templates.js';

export const engine: CrdtEngine = createLoroEngine();
export const signal: AbortSignal = new AbortController().signal;

export const Spatial = defineComponent('spatial', { x: 'f64', y: 'f64', w: 'f64', h: 'f64' });
export const Text = defineComponent('text', { content: 'richtext' });
export const Style = defineComponent('style', { fill: 'json' });
export const Source = defineComponent('source', { asset: 'json' });
export const registry = createComponentRegistry({ version: 1, components: [Spatial, Text, Style, Source, SlotComponent] });

export const priya: Actor = { kind: 'human', id: 'guest-priya', displayName: 'Priya', via: 'direct' };
export const sam: Actor = { kind: 'human', id: 'guest-sam', displayName: 'Sam', via: 'direct' };

export function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

export interface CountingStore extends DocumentStore {
  readonly inner: MemoryDocumentStore;
  /** Counters since the last `reset()`. */
  counts(): { readonly puts: number; readonly putBytes: number; readonly newBlobs: number; readonly newBytes: number; readonly gets: number; readonly getBytes: number; readonly headWrites: number; readonly headBytes: number };
  reset(): void;
  /** Digests read since the last reset. */
  readDigests(): ReadonlySet<string>;
  /** Make every later read of these digests fail (a deleted source). */
  forbid(digests: Iterable<string>): void;
}

export function createCountingStore(): CountingStore {
  const inner = createMemoryDocumentStore();
  let c = { puts: 0, putBytes: 0, newBlobs: 0, newBytes: 0, gets: 0, getBytes: 0, headWrites: 0, headBytes: 0 };
  let reads = new Set<string>();
  const forbidden = new Set<string>();
  return {
    inner,
    counts: () => ({ ...c }),
    reset() {
      c = { puts: 0, putBytes: 0, newBlobs: 0, newBytes: 0, gets: 0, getBytes: 0, headWrites: 0, headBytes: 0 };
      reads = new Set();
    },
    readDigests: () => reads,
    forbid(digests) {
      for (const d of digests) forbidden.add(d);
    },
    readHead: (asset, s) => inner.readHead(asset, s),
    async writeHead(asset, head, expected, s) {
      const result = await inner.writeHead(asset, head, expected, s);
      if (result.ok) {
        c.headWrites += 1;
        c.headBytes += JSON.stringify(head).length;
      }
      return result;
    },
    async putBlob(bytes, s) {
      const before = inner.stats();
      const result = await inner.putBlob(bytes, s);
      const after = inner.stats();
      c.puts += 1;
      c.putBytes += bytes.byteLength;
      c.newBlobs += after.blobs - before.blobs;
      c.newBytes += after.blobBytes - before.blobBytes;
      return result;
    },
    async getBlob(ref: BlobRef, s) {
      if (forbidden.has(ref.digest)) return inner.getBlob({ digest: 'sha256:deleted', size: 0 }, s);
      c.gets += 1;
      reads.add(ref.digest);
      const result = await inner.getBlob(ref, s);
      if (result.ok) c.getBytes += result.value.byteLength;
      return result;
    },
    appendLog: (asset, bytes, s) => inner.appendLog(asset, bytes, s),
    readLog: (asset, from, s) => inner.readLog(asset, from, s),
    truncateLog: (asset, before, s) => inner.truncateLog(asset, before, s),
  };
}

let peerSeq = 1000;
export function repoOn(store: DocumentStore): DocumentRepo {
  return createDocumentRepo({ store, engine, peer: () => `${(peerSeq += 1)}` as PeerId, compactAfterBytes: Number.POSITIVE_INFINITY });
}

export const pageId = (i: number): string => `p${i}`;
export const pagePart = (i: number): string => `page:${pageId(i)}`;

/**
 * A document with a root part (composition + page stubs) and `pages` page parts, each with
 * `perPage` elements: a headline text (`t<i>`), a hero image (`img<i>`) and shapes.
 */
export async function seedDocument(repo: DocumentRepo, asset: string, pages: number, perPage = 6): Promise<OpenDocument> {
  const parts = ['root', ...Array.from({ length: pages }, (_, i) => pagePart(i))];
  const doc = unwrap(await repo.create(asset, { treeSchema: registry.version, parts }, signal));
  for (const id of doc.partIds()) unwrap(await doc.part(id, signal));
  const changes: Record<string, PartOp[]> = {
    root: [
      { op: 'create', node: 'comp', kind: 'composition', parent: null, props: { name: 'Flyer set' } },
      ...Array.from({ length: pages }, (_, i): PartOp => ({ op: 'create', node: pageId(i), kind: 'page', parent: 'comp' })),
    ],
  };
  for (let i = 0; i < pages; i += 1) {
    const ops: PartOp[] = [
      { op: 'create', node: pageId(i), kind: 'page', parent: null, props: { name: `Page ${i + 1}` } },
      { op: 'create', node: `t${i}`, kind: 'text', parent: pageId(i), props: { 'spatial.x': 80, 'spatial.y': 300 }, texts: { 'text.content': { text: `Headline ${i + 1}`, spans: [{ start: 0, end: 8, marks: { bold: true } }] } } },
      { op: 'create', node: `img${i}`, kind: 'image', parent: pageId(i), props: { 'spatial.x': 240, 'source.asset': { asset: 'as_bg_lamps' } } },
    ];
    for (let n = 0; n < perPage - 2; n += 1) {
      ops.push({ op: 'create', node: `s${i}-${n}`, kind: 'shape', parent: pageId(i), props: { 'spatial.x': n * 10, 'spatial.y': n * 5, 'spatial.w': 40, 'spatial.h': 40, 'style.fill': { color: '#FF5C39' } } });
    }
    changes[pagePart(i)] = ops;
  }
  unwrap(await doc.transact({ actor: { kind: 'human', id: priya.id }, label: 'Seed' }, changes, signal));
  return doc;
}

/** Move element 0 of each listed page (one commit). */
export async function editPages(doc: OpenDocument, pages: readonly number[], value: number): Promise<void> {
  const changes: Record<string, PartOp[]> = {};
  for (const i of pages) changes[pagePart(i)] = [{ op: 'set', node: `s${i}-0`, path: 'spatial.x', value }];
  unwrap(await doc.transact({ actor: { kind: 'human', id: priya.id }, label: 'Edit' }, changes, signal));
}

/** A Milestones panel model over a seeded two-page document, with a host that records what it was asked to show. */
export async function panelFixture() {
  const store = createCountingStore();
  const doc = await seedDocument(repoOn(store), 'as_flyer', 2);
  const capture = createPartCapture({ store, registry });
  const milestones = createMilestoneService({ doc, store, capture, registry });
  const snapshots = createExportSnapshotService({ doc, store, capture, registry });
  const shown: { readOnly: ReadOnlyDocument[]; compared: CompareSession[]; opened: AssetId[] } = { readOnly: [], compared: [], opened: [] };
  const host: VersioningHost = { showReadOnly: (d) => shown.readOnly.push(d), showComparison: (s) => shown.compared.push(s), openDocument: (a) => shown.opened.push(a) };
  let ids = 0;
  const model = createMilestonesPanelModel({
    milestones,
    snapshots,
    documents: { store, engine, registry },
    host,
    actor: () => priya,
    newAssetId: () => `as_new${(ids += 1)}` as AssetId,
    title: () => 'Night Market Flyer',
    signal,
  });
  return { store, doc, milestones, model, shown };
}
