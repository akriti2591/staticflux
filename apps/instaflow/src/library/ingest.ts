/**
 * Asset ingest (IF-3.5, IF-3.6, IF-3.8): a file becomes an immutable blob asset.
 *
 * 1. The media type decides the kind (`kinds.ts`); anything else is IF-LIB-001 before any byte is read.
 * 2. The import is listed at once under a **provisional id** (`pv_…`) with its progress, so the panel can
 *    show and reference it before hashing finishes; `resolve(pv)` gives the asset id once listed.
 * 3. The content streams into the blob store (`@staticflux/blob`: SHA-256 in chunks, 4 MiB chunk manifests
 *    above 8 MiB, deduped by digest, cancellable, with progress).
 * 4. Same bytes already live in the library → that entry is returned (`deduplicated`), nothing new is listed.
 * 5. The kind's probe (`probes`, data) reads media facts; a decode failure is IF-LIB-005.
 * 6. The immutable `instaflow.asset/1` record (provenance `imported`) is stored as a blob, then one commit
 *    lists the entry in the library document; `onListed` hands it to the rendition queue.
 *
 * Machine `instaflow/library-ingest` (one per file): provisional → hashing → probing → recording → listed;
 * hashing → listed (deduplicated); any non-terminal → failed (error, or cancelled through the signal).
 */
import type { BlobRef, BlobStore } from '@staticflux/blob';
import { AbortedError, box, createMachine, defineMachine, err, ok, type Result, type SfError } from '@staticflux/core';
import { actorRecord, type Actor } from '@staticflux/stage';
import { ImportFailedError, LibraryDisposedError, MediaDecodeError, UnsupportedMediaError } from './errors.js';
import { assetKindOf, type BlobAssetKind, mediaTypeOf, titleFromFileName } from './kinds.js';
import type { Library } from './library.js';
import type { LibraryEntry } from './library-doc.js';
import { ASSET_RECORD_MIME, type AssetId, type BlobAssetRecord, BLOB_ASSET_SCHEMA, encodeBlobAssetRecord, type MediaInfo } from './records.js';
import type { ActorJson } from '../versioning/records.js';

/** What can be imported: structurally a DOM `File` (name, type, size, stream). */
export interface IngestFile {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  stream(): ReadableStream<Uint8Array>;
}

/** Reads media facts for one kind. `read` loads the stored content (only when the probe needs bytes). */
export interface MediaProbe {
  probe(content: BlobRef, read: () => Promise<Result<Uint8Array>>, signal: AbortSignal): Promise<Result<MediaInfo>>;
}

export type ProvisionalId = `pv_${string}`;

export const IngestMachine = /* @__PURE__ */ defineMachine({
  id: 'instaflow/library-ingest',
  initial: 'provisional',
  states: ['provisional', 'hashing', 'probing', 'recording', 'listed', 'failed'],
  transitions: {
    provisional: { hash: 'hashing', fail: 'failed' },
    hashing: { probe: 'probing', dedupe: 'listed', fail: 'failed' },
    probing: { record: 'recording', fail: 'failed' },
    recording: { list: 'listed', fail: 'failed' },
  },
  terminal: ['listed', 'failed'],
});

export type IngestState = (typeof IngestMachine.states)[number];

/** An import in flight (reactive, for the panel). */
export interface PendingIngest {
  readonly id: ProvisionalId;
  readonly name: string;
  readonly kind: BlobAssetKind;
  readonly size: number;
  readonly bytesRead: number;
  readonly state: IngestState;
}

export interface IngestResult {
  readonly provisional: ProvisionalId;
  readonly entry: LibraryEntry;
  /** The same content was already in the library; its entry is returned. */
  readonly deduplicated: boolean;
}

export interface IngestServiceOptions {
  readonly library: Pick<Library, 'add' | 'findByContent'>;
  readonly blobs: Pick<BlobStore, 'put' | 'get'>;
  /** Media probes per kind (data; kinds without one are listed without media facts). */
  readonly probes?: Readonly<Partial<Record<BlobAssetKind, MediaProbe>>>;
  readonly newAssetId: () => AssetId;
  readonly actor: () => Actor;
  readonly now?: () => number;
  /** Called once an asset is listed (the rendition queue's `request`). */
  readonly onListed?: (entry: LibraryEntry) => void;
}

export interface IngestService {
  ingest(file: IngestFile, options: { readonly signal: AbortSignal; readonly folder?: string }): Promise<Result<IngestResult>>;
  /** Imports in flight (reactive). */
  pending(): readonly PendingIngest[];
  /** The asset a provisional id became (once listed in this session). */
  resolve(provisional: ProvisionalId): AssetId | undefined;
  dispose(): void;
}

let provisionalSeq = 0;
const provisionalId = (): ProvisionalId => `pv_${Date.now().toString(36)}${(provisionalSeq += 1).toString(36)}`;

export function createIngestService(options: IngestServiceOptions): IngestService {
  const now = options.now ?? (() => Date.now());
  const pending = box<readonly PendingIngest[]>([]);
  const resolved = new Map<ProvisionalId, AssetId>();
  const lifetime = new AbortController();
  let disposed = false;

  const update = (id: ProvisionalId, patch: Partial<PendingIngest>): void => pending.set(pending.get().map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const drop = (id: ProvisionalId): void => pending.set(pending.get().filter((p) => p.id !== id));

  return {
    async ingest(file, ingestOptions) {
      if (disposed) return err(LibraryDisposedError());
      const mime = mediaTypeOf(file.name, file.type);
      const kind = mime === undefined ? undefined : assetKindOf(mime);
      if (mime === undefined || kind === undefined) return err(UnsupportedMediaError({ details: { name: file.name, type: file.type } }));
      const signal = AbortSignal.any([ingestOptions.signal, lifetime.signal]);
      const id = provisionalId();
      const machine = createMachine(IngestMachine);
      const fail = (error: SfError): Result<never> => {
        machine.send('fail');
        drop(id);
        return err(signal.aborted && error.code !== 'SF-CORE-002' ? AbortedError({ cause: error }) : error);
      };
      pending.set([...pending.get(), { id, name: file.name, kind, size: file.size, bytesRead: 0, state: machine.state }]);

      machine.send('hash');
      update(id, { state: machine.state });
      const stored = await options.blobs.put(file.stream(), { mime, signal, onProgress: (p) => update(id, { bytesRead: p.bytesRead }) });
      if (!stored.ok) return fail(stored.error.code === 'SF-BLOB-006' || signal.aborted ? AbortedError({ cause: stored.error }) : ImportFailedError({ cause: stored.error, details: { name: file.name } }));
      const content = stored.value;

      const existing = options.library.findByContent(content.digest);
      if (existing !== undefined) {
        machine.send('dedupe');
        drop(id);
        resolved.set(id, existing.asset);
        return ok({ provisional: id, entry: existing, deduplicated: true });
      }

      machine.send('probe');
      update(id, { state: machine.state, bytesRead: content.size });
      let media: MediaInfo | undefined;
      const probe = options.probes?.[kind];
      if (probe !== undefined) {
        const probed = await probe.probe(content, () => options.blobs.get(content, { signal }), signal);
        if (!probed.ok) return fail(probed.error.code === 'IF-LIB-005' || probed.error.code === 'SF-CORE-002' ? probed.error : MediaDecodeError({ cause: probed.error, details: { name: file.name } }));
        media = probed.value;
      }
      if (signal.aborted) return fail(AbortedError({ cause: signal.reason }));

      machine.send('record');
      update(id, { state: machine.state });
      const asset = options.newAssetId();
      const createdAt = new Date(now()).toISOString();
      const actor = actorRecord(options.actor()) as unknown as ActorJson;
      const record: BlobAssetRecord = {
        schema: BLOB_ASSET_SCHEMA,
        id: asset,
        kind,
        createdAt,
        createdBy: actor,
        content,
        ...(media === undefined ? {} : { media }),
        provenance: { action: 'imported', actor, ingredients: [] },
      };
      const encoded = encodeBlobAssetRecord(record);
      if (!encoded.ok) return fail(encoded.error);
      const recordRef = await options.blobs.put(encoded.value, { mime: ASSET_RECORD_MIME, signal });
      if (!recordRef.ok) return fail(ImportFailedError({ cause: recordRef.error, details: { name: file.name } }));
      if (signal.aborted) return fail(AbortedError({ cause: signal.reason }));

      const listed = options.library.add({
        asset,
        kind,
        title: titleFromFileName(file.name),
        createdAt,
        mime,
        size: content.size,
        ...(media === undefined ? {} : { media }),
        content,
        record: recordRef.value,
        ...(ingestOptions.folder === undefined ? {} : { folder: ingestOptions.folder }),
      });
      if (!listed.ok) return fail(listed.error);
      machine.send('list');
      drop(id);
      resolved.set(id, asset);
      options.onListed?.(listed.value);
      return ok({ provisional: id, entry: listed.value, deduplicated: false });
    },
    pending: () => pending.get(),
    resolve: (provisional) => resolved.get(provisional),
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
    },
  };
}
