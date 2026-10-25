/**
 * A frozen export snapshot opened as a headless Studio document (C1; IF-5.10, IF-29.5, ARCHITECTURE §3.5): the
 * export worker reads the snapshot's canonical parts (B5) from the store, rebuilds each into a CRDT part of its own
 * (one fresh peer, never written back), and composes them exactly as Studio does (`openStudioDocument`: B1's stage
 * and brand rules, B7's repeat view), so the export draws what the canvas draws.
 *
 * The parts sit behind a read-only `OpenDocument`: every write is refused (IF-EXP-003), so nothing an export does can
 * reach the design (D10: plain exports create nothing).
 */
import { err, ok, type Result, type Scope } from '@staticflux/core';
import {
  type BlobRef,
  buildPartFromCanonical,
  type ComponentRegistry,
  type CrdtEngine,
  type DocumentCRDTv2,
  type DocumentHead,
  type DocumentStore,
  type OpenDocument,
  type PartId,
  type PeerId,
} from '@staticflux/document/v2';
import { freshPeer, openStudioDocument, type StudioDocument } from '../app/document.js';
import type { BrandKitSpec } from '../elements/brand-kit.js';
import type { GeometryService } from '../elements/geometry.js';
import { readCanonicalPart } from '../versioning/readonly.js';
import type { SnapshotId, SnapshotManifest } from '../versioning/records.js';
import { ExportSnapshotError } from './errors.js';

/** A frozen snapshot as the editor hands it to the export worker (B5 `FrozenSnapshot`, plain data). */
export interface ExportSnapshot {
  readonly id: SnapshotId;
  readonly ref: BlobRef;
  readonly manifest: SnapshotManifest;
}

const readOnly = (what: string): Result<never> => err(ExportSnapshotError({ message: `An export snapshot is read-only (${what}).`, details: { what } }));

/** A read-only `OpenDocument` over parts that are already loaded. */
export function readOnlyOpenDocument(asset: string, treeSchema: number, parts: ReadonlyMap<PartId, DocumentCRDTv2>, peer: PeerId = freshPeer()): OpenDocument {
  const head: DocumentHead = { asset, generation: 0, engine: 'snapshot', treeSchema, parts: {}, logFrom: 0, undoHorizon: 0 };
  return {
    asset,
    peer,
    state: 'open',
    head: () => head,
    partIds: () => [...parts.keys()],
    partState: (id) => (parts.has(id) ? 'loaded' : 'unloaded'),
    part: async (id) => {
      const part = parts.get(id);
      return part === undefined ? err(ExportSnapshotError({ message: `The snapshot has no part "${id}".`, details: { part: id } })) : ok(part);
    },
    loadedPart: (id) => parts.get(id),
    createPart: () => readOnly('create part'),
    commit: () => readOnly('commit'),
    transact: async () => readOnly('transact'),
    moveAcross: () => readOnly('move across parts'),
    gesture: () => readOnly('gesture'),
    applyRemote: () => readOnly('apply remote'),
    onCommit: () => () => undefined,
    flush: async () => ok(),
    undoHistory: () => [],
    compact: async () => readOnly('compact'),
    evict: () => readOnly('evict'),
    stats: () => ({ parts: [], logBytes: 0, logRecords: 0 }),
    close: async () => ok(),
  };
}

export interface OpenSnapshotOptions {
  readonly store: Pick<DocumentStore, 'getBlob'>;
  readonly snapshot: ExportSnapshot;
  readonly engine: CrdtEngine;
  readonly geometry: GeometryService;
  readonly brand?: BrandKitSpec;
  readonly registry?: ComponentRegistry;
  readonly signal: AbortSignal;
  /** The parts and the composed stage are disposed with it. */
  readonly scope: Scope;
}

/** Open `snapshot` as a Studio document (see the module header). IF-EXP-003 when a part cannot be read. */
export async function openSnapshotDocument(options: OpenSnapshotOptions): Promise<Result<StudioDocument>> {
  const { snapshot, signal, scope } = options;
  const parts = new Map<PartId, DocumentCRDTv2>();
  const peer = freshPeer();
  const failed = (step: string, cause: unknown): Result<never> => err(ExportSnapshotError({ cause, details: { step, snapshot: snapshot.id } }));
  for (const [id, ref] of Object.entries(snapshot.manifest.parts).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (signal.aborted) return failed('read parts', signal.reason);
    const canonical = await readCanonicalPart(options.store as DocumentStore, id, ref, signal, options.registry);
    if (!canonical.ok) return failed(`read part ${id}`, canonical.error);
    const built = buildPartFromCanonical(options.engine, canonical.value, { peer, ...(options.registry === undefined ? {} : { registry: options.registry }) });
    if (!built.ok) return failed(`build part ${id}`, built.error);
    parts.set(id, built.value);
    scope.defer(() => built.value.dispose());
  }
  const doc = readOnlyOpenDocument(snapshot.manifest.asset, snapshot.manifest.treeSchema, parts, peer);
  const opened = await openStudioDocument({ workspace: { engine: options.engine }, doc, geometry: options.geometry, ...(options.brand === undefined ? {} : { brand: options.brand }), signal, scope });
  return opened.ok ? opened : failed('compose', opened.error);
}
