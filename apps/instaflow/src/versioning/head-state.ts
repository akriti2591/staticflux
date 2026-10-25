/**
 * The versioning fields of a tree asset's head (DOCUMENT-FORMAT §5.2 `TreeHead.milestones` /
 * `pinned`), kept in the `DocumentHead.app` object under `versioning`. The repo carries `app`
 * unchanged; versioning swaps the head by compare-and-swap on `generation` and retries on a conflict
 * (the repo's own compaction adopts the newer head the same way).
 *
 * Pinning and renaming are head fields, so neither rewrites an immutable milestone record.
 */
import { err, ok, type Result } from '@staticflux/core';
import { type BlobRef, type DocumentHead, type DocumentStore, HeadConflictError, type JsonObject } from '@staticflux/document/v2';
import { VersionHeadConflictError } from './errors.js';
import { isMilestoneId, type MilestoneId } from './records.js';

export const VERSIONING_APP_KEY = 'versioning';

/** A milestone in the head list (the record is the blob `sha256:<id hex>` of `size` bytes). */
export interface MilestoneHeadEntry {
  readonly id: MilestoneId;
  readonly size: number;
}

export interface VersioningState {
  /** Newest first; GC roots. */
  readonly milestones: readonly MilestoneHeadEntry[];
  readonly pinned: readonly MilestoneId[];
  /** Display names set by "Rename" (the record keeps the name it was created with). */
  readonly names: Readonly<Record<MilestoneId, string>>;
  /** This asset's record (for documents made by "New document from milestone" or a template). */
  readonly record?: BlobRef;
}

export const EMPTY_VERSIONING_STATE: VersioningState = Object.freeze({ milestones: [], pinned: [], names: {} });

/** The versioning state of a head (tolerant: malformed entries are dropped, never thrown). */
export function readVersioningState(head: DocumentHead | undefined): VersioningState {
  const raw = head?.app?.[VERSIONING_APP_KEY];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return EMPTY_VERSIONING_STATE;
  const value = raw as Record<string, unknown>;
  const milestones = Array.isArray(value['milestones'])
    ? (value['milestones'] as unknown[]).filter((e): e is MilestoneHeadEntry => isMilestoneId((e as MilestoneHeadEntry)?.id) && typeof (e as MilestoneHeadEntry).size === 'number')
    : [];
  const known = new Set(milestones.map((e) => e.id));
  const pinned = Array.isArray(value['pinned']) ? (value['pinned'] as unknown[]).filter((id): id is MilestoneId => isMilestoneId(id) && known.has(id)) : [];
  const names: Record<MilestoneId, string> = {};
  if (typeof value['names'] === 'object' && value['names'] !== null) {
    for (const [id, name] of Object.entries(value['names'] as Record<string, unknown>)) if (isMilestoneId(id) && known.has(id) && typeof name === 'string') names[id] = name;
  }
  const record = value['record'] as BlobRef | undefined;
  return {
    milestones,
    pinned,
    names,
    ...(typeof record?.digest === 'string' && typeof record.size === 'number' ? { record: { digest: record.digest, size: record.size } } : {}),
  };
}

function toJson(state: VersioningState): JsonObject {
  return {
    milestones: state.milestones.map((e) => ({ id: e.id, size: e.size })),
    pinned: [...state.pinned],
    names: { ...state.names },
    ...(state.record === undefined ? {} : { record: { digest: state.record.digest, size: state.record.size } }),
  };
}

/** A head carrying `state` (generation unchanged: the caller sets it). */
export function withVersioningState(head: DocumentHead, state: VersioningState): DocumentHead {
  return { ...head, app: { ...(head.app ?? {}), [VERSIONING_APP_KEY]: toJson(state) } };
}

/** What an update decided: a new state to write, or `undefined` to leave the head alone. */
export type VersioningUpdate = (state: VersioningState, head: DocumentHead) => Result<VersioningState | undefined>;

export interface UpdatedState {
  readonly head: DocumentHead;
  readonly state: VersioningState;
  /** False when the update decided nothing had to change. */
  readonly written: boolean;
}

/**
 * Read the head, apply `update`, and swap the head by CAS. A conflict re-reads and re-applies
 * (the update must be a pure function of the state it is given). Gives up with IF-VER-004.
 */
export async function updateVersioningState(store: DocumentStore, asset: string, update: VersioningUpdate, signal: AbortSignal, attempts = 6): Promise<Result<UpdatedState>> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const read = await store.readHead(asset, signal);
    if (!read.ok) return read;
    const head = read.value;
    if (head === undefined) return err(VersionHeadConflictError({ message: `Asset "${asset}" has no head.`, details: { asset } }));
    const state = readVersioningState(head);
    const next = update(state, head);
    if (!next.ok) return next;
    if (next.value === undefined) return ok({ head, state, written: false });
    const written = withVersioningState({ ...head, generation: head.generation + 1 }, next.value);
    const swapped = await store.writeHead(asset, written, head.generation, signal);
    if (swapped.ok) return ok({ head: written, state: next.value, written: true });
    if (swapped.error.code !== HeadConflictError.code) return swapped;
  }
  return err(VersionHeadConflictError({ details: { asset, attempts } }));
}
