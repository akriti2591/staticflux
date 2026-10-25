/**
 * Instaflow engine and sequencing errors (`IF-ENG-*`, `IF-SEQ-*`). Errors are values: the
 * modules return them in `Result`s or record them (a gesture cancel is not a failure of the
 * pipeline, it is shown as a toast).
 */
import { defineError } from '@staticflux/core';

/** E-3: a remote edit deleted (or locked) the target of the gesture in progress. */
export const GestureTargetGoneError = defineError(
  'IF-ENG-001',
  'conflict',
  'A collaborator deleted an element you were editing; the gesture was cancelled.',
  'Nothing to fix: the toast tells the user. Tools must cancel the gesture (no commit) and keep the rest of the selection.',
);

export const SequencingBootError = defineError(
  'IF-SEQ-001',
  'unavailable',
  'The editor ↔ render pipeline could not start (a worker failed to spawn or answer, or a pipe could not be created).',
  'Check the worker bundle URLs and cross-origin isolation (split topology needs SharedArrayBuffer for the shared medium); the error `cause` names the step.',
);

export const SequencingRoleError = defineError(
  'IF-SEQ-002',
  'invariant',
  'A sequencing worker was asked to do something its roles do not cover (e.g. attach render pipes in an editor-only worker).',
  'Boot through `bootSequencing`, which derives every worker’s roles from the topology plan; do not send control requests by hand.',
);

export const RenderPortError = defineError(
  'IF-SEQ-003',
  'invariant',
  'The render port failed to draw a frame or is not registered in this worker.',
  'Register the port under the name the boot settings use (`hostSequencingWorker({ renderPorts })`); a draw failure keeps the last good frame on screen.',
);
