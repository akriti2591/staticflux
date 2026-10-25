/**
 * Error catalog for @staticflux/stage (`SF-STAGE-*`). Lock and final-path errors are the framework side of
 * Instaflow's `IF-CS-004` and `IF-CS-013`. An undo over someone else's later overwrite is NOT an error: it is a
 * typed `conflict` outcome of `undo()` / `redo()` (D14).
 */
import { defineError } from '@staticflux/core';

export const LockedPathError = defineError(
  'SF-STAGE-001',
  'forbidden',
  'The edit targets a locked node or path (position, content or all).',
  'Unlock the node first (a UX lock can be removed by anyone with edit rights), or edit a path the lock does not cover. Client-side locks are UX, not security.',
);

export const PolicyLockError = defineError(
  'SF-STAGE-002',
  'forbidden',
  'A policy lock (brand kit or template) can be removed or changed only by a human with an explicit confirmation.',
  'Agents and flows can never remove a policy lock. For a human, ask for confirmation and pass `{ confirmPolicyUnlock: true }` to `stage.checkWrite`.',
);

export const FinalPathError = defineError(
  'SF-STAGE-003',
  'forbidden',
  'The path is final in a brand kit or template; local opinions on it are ignored.',
  'Edit the brand kit or template instead, or remove the `final` mark there where policy allows it.',
);

export const ActorUnavailableError = defineError(
  'SF-STAGE-004',
  'validation',
  'No actor record could be resolved for this run (unknown subject, or an agent without an identity).',
  'Give the attribution port an identity for the subject (`createAttributionPort({ human, agent, flow })`); agent runs need `origin.details` naming the agent or a resolver that knows it.',
);

export const StageDisposedError = defineError(
  'SF-STAGE-005',
  'aborted',
  'The stage or undo service is disposed.',
  'Create a new one for the open document; do not keep references past its scope.',
);

export const UndoUnavailableError = defineError(
  'SF-STAGE-006',
  'unavailable',
  'The undo step could not be applied: its inverse no longer validates and could not be repaired.',
  'Show the conflict to the user and let them retry with `onConflict: "keep-theirs"` (applies only what still validates).',
);
