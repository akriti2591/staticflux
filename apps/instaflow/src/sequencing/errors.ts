/**
 * Instaflow engine and sequencing errors (`IF-ENG-*`, `IF-SEQ-*`). Errors are values: the
 * modules return them in `Result`s or record them (a gesture cancel is not a failure of the
 * pipeline, it is shown as a toast).
 */
import { defineError, type SfError, toSfError } from '@staticflux/core';

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

/** A cause chain as plain data. Errors cross worker links as wire errors, which keep `details` but drop `cause`. */
export interface CauseSummary {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export function summarizeCause(error: unknown, depth = 4): CauseSummary[] {
  const out: CauseSummary[] = [];
  let current: unknown = error;
  for (let i = 0; i < depth && current !== undefined && current !== null; i++) {
    const e: SfError = toSfError(current);
    const { causes: _nested, ...details } = e.details as Record<string, unknown>;
    out.push({ code: e.code, message: e.message, ...(Object.keys(details).length === 0 ? {} : { details }) });
    // A wire error carries its remote chain in details.causes.
    const nested = (e.details as { causes?: CauseSummary[] }).causes;
    if (Array.isArray(nested)) {
      out.push(...nested);
      break;
    }
    current = e.cause;
  }
  return out;
}

/** A boot failure at `step` whose message and details keep the cause chain across worker links. */
export function bootFailure(step: string, cause?: unknown): SfError {
  const causes = cause === undefined ? [] : summarizeCause(cause);
  const reason = causes.map((c) => `${c.code}: ${c.message}`).join(' ← ');
  return SequencingBootError({
    message: `Sequencing boot failed at "${step}"${reason === '' ? '.' : `: ${reason}`}`,
    ...(cause === undefined ? {} : { cause: toSfError(cause) }),
    details: { step, causes },
  });
}
