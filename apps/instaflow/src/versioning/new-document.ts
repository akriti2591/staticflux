/**
 * "New document from milestone" (D2, IF-5.7; DOCUMENT-FORMAT §6.1): there is no restore. A new
 * asset gets a **fresh, detached baseline**: new Latest CRDT parts rebuilt from the milestone's
 * canonical parts with one fresh peer and one commit of history (S4: a shallow snapshot of the
 * source would keep the source's peers in its version vector, so it is not used). Node ids are
 * kept (they are asset-local). The only link back is the informational `createdFrom` label in the
 * asset record; nothing resolves it, so deleting or editing the source never affects the copy.
 *
 * Templates (IF-5.8) are this plus a `transform` that fills slots part by part.
 */
import { err, ok, type Result } from '@staticflux/core';
import {
  type BlobRef,
  buildPartFromCanonical,
  type CanonicalPart,
  type ComponentRegistry,
  type CrdtEngine,
  DEFAULT_UNDO_HORIZON,
  type DocumentHead,
  type DocumentStore,
  HeadConflictError,
  type PartId,
  type PeerId,
  randomPeerId,
} from '@staticflux/document/v2';
import { type Actor, actorRecord } from '@staticflux/stage';
import { AssetExistsError } from './errors.js';
import { EMPTY_VERSIONING_STATE, withVersioningState } from './head-state.js';
import { readCanonicalPart } from './readonly.js';
import { type ActorJson, ASSET_SCHEMA, type AssetId, type AssetKind, type AssetRecord, encodeRecord, type MilestoneId, type MilestoneRecord } from './records.js';

export interface NewDocumentServiceOptions {
  readonly store: DocumentStore;
  readonly engine: CrdtEngine;
  readonly registry?: ComponentRegistry;
  /** Undo steps per actor recorded in the new head (default 200, D9). */
  readonly undoHorizon?: number;
  readonly now?: () => number;
  /** The new baseline's peer (default: a fresh random peer). Never a source peer. */
  readonly peer?: () => PeerId;
}

export interface NewDocumentRequest {
  /** The new asset id (fresh uuidv7; IF-VER-008 if it exists). */
  readonly asset: AssetId;
  readonly kind?: AssetKind;
  readonly actor: Actor;
  readonly source: { readonly milestone: MilestoneId; readonly record: MilestoneRecord; readonly title: string };
  /** Applied to each canonical part before it is rebuilt (template slot filling). */
  readonly transform?: (part: CanonicalPart) => Result<CanonicalPart>;
  /** Checked once every part was transformed, before anything is written (required slots). */
  readonly check?: (parts: readonly CanonicalPart[]) => Result<void>;
}

export interface NewDocument {
  readonly asset: AssetId;
  readonly head: DocumentHead;
  readonly record: AssetRecord;
  readonly recordRef: BlobRef;
}

export async function createDocumentFromMilestone(options: NewDocumentServiceOptions, request: NewDocumentRequest, signal: AbortSignal): Promise<Result<NewDocument>> {
  const { store, engine } = options;
  const existing = await store.readHead(request.asset, signal);
  if (!existing.ok) return existing;
  if (existing.value !== undefined) return err(AssetExistsError({ details: { asset: request.asset } }));

  const milestone = request.source.record;
  const canonical: CanonicalPart[] = [];
  for (const id of Object.keys(milestone.parts).sort()) {
    const part = await readCanonicalPart(store, id, milestone.parts[id] as BlobRef, signal, options.registry);
    if (!part.ok) return part;
    const transformed = request.transform === undefined ? part : request.transform(part.value);
    if (!transformed.ok) return transformed;
    canonical.push(transformed.value);
  }
  const checked = request.check?.(canonical) ?? ok();
  if (!checked.ok) return checked;

  const peer = options.peer?.() ?? randomPeerId();
  const actor = actorRecord(request.actor);
  const parts: Record<PartId, BlobRef> = {};
  for (const part of canonical) {
    const built = buildPartFromCanonical(engine, part, {
      peer,
      ...(options.registry === undefined ? {} : { registry: options.registry }),
      meta: { actor, label: 'New document from milestone', via: request.actor.via },
    });
    if (!built.ok) return built;
    const bytes = built.value.exportSnapshot();
    built.value.dispose();
    const ref = await store.putBlob(bytes, signal);
    if (!ref.ok) return ref;
    parts[part.part] = ref.value;
  }

  const record: AssetRecord = {
    schema: ASSET_SCHEMA,
    id: request.asset,
    kind: request.kind ?? 'composition',
    createdAt: new Date((options.now ?? Date.now)()).toISOString(),
    createdBy: actor as unknown as ActorJson,
    provenance: { action: 'derived', actor: actor as unknown as ActorJson, ingredients: [] },
    createdFrom: { asset: milestone.asset, milestone: request.source.milestone, title: request.source.title },
  };
  const recordBytes = encodeRecord(record);
  if (!recordBytes.ok) return recordBytes;
  const recordRef = await store.putBlob(recordBytes.value, signal);
  if (!recordRef.ok) return recordRef;

  const head = withVersioningState(
    {
      asset: request.asset,
      generation: 1,
      engine: engine.id,
      treeSchema: options.registry?.version ?? milestone.treeSchema,
      parts,
      logFrom: 1,
      undoHorizon: options.undoHorizon ?? DEFAULT_UNDO_HORIZON,
    },
    { ...EMPTY_VERSIONING_STATE, record: recordRef.value },
  );
  const written = await store.writeHead(request.asset, head, null, signal);
  if (!written.ok) return written.error.code === HeadConflictError.code ? err(AssetExistsError({ details: { asset: request.asset } })) : written;
  return ok({ asset: request.asset, head, record, recordRef: recordRef.value });
}
