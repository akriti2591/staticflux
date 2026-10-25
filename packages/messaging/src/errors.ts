/**
 * Error catalog of @staticflux/messaging (docs/LIFECYCLES.md §8, §12).
 */
import { defineError } from '@staticflux/core';

/** I-7: a surface cannot outlive its owning scope. */
export const SurfaceOutlivesScopeError = defineError(
  'SF-MSG-001',
  'invariant',
  'A surface was requested for a scope that is already disposed, or for an owner that lives longer than the surface’s declared scope (I-7).',
  'Request surfaces with the owning scope of the page/feature/view that shows them (e.g. `ownerOf(featureInjector)`); a surface declared `scope: "view"` cannot be owned by the app scope.',
);

export const SurfaceGatedError = defineError(
  'SF-MSG-002',
  'forbidden',
  'The surface is gated out for this user (its upsell surface, if declared, was shown instead).',
  'Expected for premium surfaces. Check the gate decision in devtools; declare `upsell` on the surface to resolve denials to an upsell.',
);

export const UnknownRoutableDialogError = defineError(
  'SF-MSG-003',
  'not-found',
  'No routable dialog surface is registered for this key.',
  'Declare the dialog with `defineSurface({ kind: "dialog", routable: { key } })` and register it (RoutableSurfacesToken contribution or `bridge.register`).',
);

export const InvalidRoutableParamsError = defineError(
  'SF-MSG-004',
  'validation',
  'The routable dialog parameters failed to parse.',
  'Fix the URL producer, or make `routable.params` accept the given shape and return a typed error otherwise.',
);

export const CoachTargetMissingError = defineError(
  'SF-MSG-005',
  'unavailable',
  'The coach mark target never became available (registered and visible) before the timeout.',
  'Mark the target with `coachTarget(target)` in its template, or raise `targetTimeoutMs`; coach marks never show without their target.',
);

export const DuplicateSurfaceError = defineError(
  'SF-MSG-006',
  'invariant',
  'Two routable surfaces were registered with the same key.',
  'Routable dialog keys are app-unique: rename one of them.',
);

export const SurfaceLoadFailedError = defineError(
  'SF-MSG-007',
  'unavailable',
  'The routable dialog’s lazy content failed to load.',
  'Inspect `cause` (chunk load/network). The dialog was not entered; the router should keep the parent path.',
);

/** OVERLAYS-FEEDBACK §1.7: one modal at a time under the strict surface policy. */
export const ModalBusyError = defineError(
  'SF-MSG-008',
  'conflict',
  'A dialog was requested while another dialog is open; under the strict surface policy a second modal is refused, never queued or stacked.',
  'Put the confirmation inline (an inline confirm row) or make the sub-task a step of the open dialog; only a blocking error may replace an open dialog (request it with `replace: true`).',
);
