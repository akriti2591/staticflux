/**
 * Side-by-side compare (IF-5.11): two read-only documents — two milestones, or a milestone and a
 * frozen snapshot of Latest — shown on two read-only surfaces. Visual only: there is no structural
 * diff in V1. The session lists the parts present on either side so the host can show the same
 * page next to itself.
 */
import { ok, type Result } from '@staticflux/core';
import type { PartId } from '@staticflux/document/v2';
import type { MilestoneService } from './milestones.js';
import type { ReadOnlyDocument } from './readonly.js';
import type { MilestoneId } from './records.js';
import type { ExportSnapshotService } from './snapshot.js';

/** A milestone, or Latest (frozen at the moment the compare opens). */
export type CompareSide = MilestoneId | 'latest';

export const LATEST = 'latest' as const;

export interface CompareSession {
  readonly kind: 'side-by-side';
  readonly left: ReadOnlyDocument;
  readonly right: ReadOnlyDocument;
  /** Parts on either side: shared ones first (in id order), then those on one side only. */
  parts(): readonly PartId[];
}

export interface CompareSources {
  readonly milestones: Pick<MilestoneService, 'open'>;
  readonly snapshots: Pick<ExportSnapshotService, 'freeze' | 'open'>;
}

async function openSide(sources: CompareSources, side: CompareSide, signal: AbortSignal): Promise<Result<ReadOnlyDocument>> {
  if (side !== LATEST) return sources.milestones.open(side, signal);
  const frozen = await sources.snapshots.freeze(signal);
  if (!frozen.ok) return frozen;
  return sources.snapshots.open(frozen.value, signal);
}

export async function openComparison(sources: CompareSources, left: CompareSide, right: CompareSide, signal: AbortSignal): Promise<Result<CompareSession>> {
  const a = await openSide(sources, left, signal);
  if (!a.ok) return a;
  const b = await openSide(sources, right, signal);
  if (!b.ok) return b;
  const leftIds = new Set(a.value.partIds());
  const rightIds = new Set(b.value.partIds());
  const shared = [...leftIds].filter((id) => rightIds.has(id)).sort();
  const only = [...leftIds, ...rightIds].filter((id) => !(leftIds.has(id) && rightIds.has(id))).sort();
  const parts = [...shared, ...only];
  return ok({ kind: 'side-by-side', left: a.value, right: b.value, parts: () => parts });
}
