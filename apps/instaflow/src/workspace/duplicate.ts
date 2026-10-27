/**
 * Duplicate a design (B11c; HOME-FILES §3, "Duplicate"): a **fresh snapshot of Latest** of the source becomes a new,
 * detached document, the way "New document from milestone" makes one (`createDocumentFromMilestone`): canonical parts
 * rebuilt under a new peer, no history, no milestones, no undo of the source's edits. Store side only (it needs the CRDT
 * engine); Home asks for it through its journal (`../home/journal.ts`, op `duplicate`), and the drain runs it.
 *
 * The source is opened through the repo when nobody has it open, and closed again without compaction; an open source
 * (this tab's library or a template being saved) is read as it is.
 */
import { ok, type Result } from '@staticflux/core';
import type { CrdtEngine, DocumentRepo, DocumentStore } from '@staticflux/document/v2';
import type { Actor } from '@staticflux/stage';
import { actorRecord } from '@staticflux/stage';
import type { AssetId } from '../library/records.js';
import { createDocumentFromMilestone, type NewDocument } from '../versioning/new-document.js';
import { createPartCapture } from '../versioning/parts.js';
import { type ActorJson, MILESTONE_SCHEMA, type MilestoneId, type MilestoneRecord } from '../versioning/records.js';

export interface DuplicateServices {
  readonly store: DocumentStore;
  readonly engine: CrdtEngine;
  readonly repo: Pick<DocumentRepo, 'open' | 'get'>;
  readonly actor: Actor;
  readonly now?: () => number;
}

export interface DuplicateRequest {
  readonly source: string;
  readonly asset: AssetId;
  readonly title: string;
}

/** A label for the copy's `createdFrom` (never resolved: the copy stands alone). */
const LATEST_LABEL = 'ms_latest' as MilestoneId;

/** Make `request.asset` a detached copy of the source's Latest (see the module header). */
export async function duplicateDesign(services: DuplicateServices, request: DuplicateRequest, signal: AbortSignal): Promise<Result<NewDocument>> {
  const already = services.repo.get(request.source);
  const opened = already === undefined ? await services.repo.open(request.source, signal) : ok(already);
  if (!opened.ok) return opened;
  const doc = opened.value;
  try {
    const captured = await createPartCapture({ store: services.store }).capture(doc, signal);
    if (!captured.ok) return captured;
    const actor = actorRecord(services.actor) as unknown as ActorJson;
    const record: MilestoneRecord = {
      schema: MILESTONE_SCHEMA,
      asset: request.source as AssetId,
      kind: 'named',
      name: request.title,
      createdAt: new Date((services.now ?? Date.now)()).toISOString(),
      createdBy: actor,
      treeSchema: 1,
      parts: captured.value.parts,
      references: captured.value.references,
    };
    return await createDocumentFromMilestone(
      { store: services.store, engine: services.engine, ...(services.now === undefined ? {} : { now: services.now }) },
      { asset: request.asset, kind: 'composition', actor: services.actor, source: { milestone: LATEST_LABEL, record, title: request.title } },
      signal,
    );
  } finally {
    if (already === undefined) await doc.close(signal, { compact: false });
  }
}
