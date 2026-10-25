/**
 * Workspace templates (C0; IF-28.26–28.27) over B5's versioning: a template is a tree asset of kind `template` with its
 * own milestones (D2); "Use template" is B5's New document from milestone plus slot filling, from the template's newest
 * milestone (`createDocumentFromTemplate`). Store side only (it needs the CRDT engine to rebuild parts).
 *
 * - `saveAsTemplate`: from a milestone of a design, a detached new asset of kind `template` (`createDocumentFromMilestone`)
 *   with a first milestone of its own, so the template stands alone if the design is deleted.
 * - `newDocumentFromTemplate`: a new composition from the template's newest milestone (no fills in M1; slots are kept
 *   out of the new document).
 */
import { defineCapability, s } from '@staticflux/capabilities';
import { err, ok, type Result } from '@staticflux/core';
import type { CrdtEngine, DocumentRepo, DocumentStore } from '@staticflux/document/v2';
import type { Actor } from '@staticflux/stage';
import { TemplateSourceError } from '../home/errors.js';
import { readVersioningState } from '../versioning/head-state.js';
import { createMilestoneService } from '../versioning/milestones.js';
import { createDocumentFromMilestone, type NewDocument } from '../versioning/new-document.js';
import { createPartCapture } from '../versioning/parts.js';
import { type AssetId, decodeMilestoneRecord, digestOfId, type MilestoneId, type MilestoneRecord } from '../versioning/records.js';
import { createDocumentFromTemplate } from '../versioning/templates.js';

/** Studio's "Save as template" (top bar button, agents): a milestone of the open design, then a template from it. */
export const SaveAsTemplateCapability = /* @__PURE__ */ defineCapability({
  id: 'instaflow/save-as-template',
  title: 'Save as template',
  description: 'Make a workspace template from the open design: it takes a milestone of the design and lists a new template that "Use template" on Home starts new designs from.',
  input: s.object({ title: s.optional(s.string({ minLength: 1, maxLength: 200, description: 'Template title (default: the design’s title)' })) }),
  output: s.object({ template: s.string(), milestone: s.string(), title: s.string() }),
  requiresConfirmation: false,
  destructive: false,
});

export interface TemplateServices {
  readonly store: DocumentStore;
  readonly engine: CrdtEngine;
  readonly actor: Actor;
}

/** A milestone of `asset` and its record (`milestone` omitted: the newest). IF-HOME-006 when there is none. */
export async function readMilestone(store: DocumentStore, asset: string, milestone: MilestoneId | undefined, signal: AbortSignal): Promise<Result<{ readonly id: MilestoneId; readonly record: MilestoneRecord }>> {
  const head = await store.readHead(asset, signal);
  if (!head.ok) return head;
  const state = readVersioningState(head.value);
  const entry = milestone === undefined ? state.milestones[0] : state.milestones.find((m) => m.id === milestone);
  if (entry === undefined) return err(TemplateSourceError({ details: { template: asset, milestone: milestone ?? null } }));
  const digest = digestOfId(entry.id);
  const bytes = await store.getBlob({ digest, size: entry.size }, signal);
  if (!bytes.ok) return err(TemplateSourceError({ cause: bytes.error, details: { template: asset, milestone: entry.id } }));
  const record = decodeMilestoneRecord(bytes.value, digest);
  if (!record.ok) return err(TemplateSourceError({ cause: record.error, details: { template: asset, milestone: entry.id } }));
  return ok({ id: entry.id, record: record.value });
}

export interface SaveAsTemplateRequest {
  /** The design and the milestone to make the template from (the caller just created it). */
  readonly source: { readonly asset: string; readonly milestone: MilestoneId };
  /** The new template's asset id and title. */
  readonly asset: AssetId;
  readonly title: string;
}

/** Make a template from a design's milestone (see the module header). */
export async function saveAsTemplate(services: TemplateServices & { readonly repo: Pick<DocumentRepo, 'open'> }, request: SaveAsTemplateRequest, signal: AbortSignal): Promise<Result<{ readonly asset: AssetId; readonly milestone: MilestoneId }>> {
  const source = await readMilestone(services.store, request.source.asset, request.source.milestone, signal);
  if (!source.ok) return source;
  const made = await createDocumentFromMilestone(
    { store: services.store, engine: services.engine },
    { asset: request.asset, kind: 'template', actor: services.actor, source: { milestone: source.value.id, record: source.value.record, title: request.title } },
    signal,
  );
  if (!made.ok) return made;
  const doc = await services.repo.open(request.asset, signal);
  if (!doc.ok) return doc;
  const milestones = createMilestoneService({ doc: doc.value, store: services.store, capture: createPartCapture({ store: services.store }) });
  try {
    const created = await milestones.create({ name: request.title, actor: services.actor }, signal);
    if (!created.ok) return created;
    return ok({ asset: request.asset, milestone: created.value.entry.id });
  } finally {
    milestones.dispose();
    await doc.value.close(signal, { compact: false });
  }
}

/** A new composition from the template's newest milestone (see the module header). */
export async function newDocumentFromTemplate(services: TemplateServices, request: { readonly template: string; readonly asset: AssetId; readonly title: string }, signal: AbortSignal): Promise<Result<NewDocument>> {
  const source = await readMilestone(services.store, request.template, undefined, signal);
  if (!source.ok) return source;
  return createDocumentFromTemplate(
    { store: services.store, engine: services.engine },
    { asset: request.asset, kind: 'composition', actor: services.actor, source: { milestone: source.value.id, record: source.value.record, title: request.title }, fills: {} },
    signal,
  );
}
