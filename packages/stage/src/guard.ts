/**
 * Lock enforcement for every write through the undo service (edits, gestures, undo and redo): the stage's
 * `checkWrite` per touched part. Client gating is UX, not security — a server or the store worker re-checks.
 */
import { ok, type Result } from '@staticflux/core';
import type { PartId, PartOp } from '@staticflux/document/v2';
import type { Actor } from './actor.js';
import type { Stage } from './stage.js';
import type { WriteGuard } from './undo.js';

/** A `WriteGuard` that checks locks and final paths on `stage` (the stage of the asset being written). */
export function stageWriteGuard(stage: Pick<Stage, 'checkWrite'>): WriteGuard {
  return (changes: Readonly<Record<PartId, readonly PartOp[]>>, actor: Actor): Result<void> => {
    for (const ops of Object.values(changes)) {
      const checked = stage.checkWrite(ops, { actor });
      if (!checked.ok) return checked;
    }
    return ok();
  };
}
