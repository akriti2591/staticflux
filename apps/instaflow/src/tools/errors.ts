/**
 * Tool errors (`IF-TOOL-*`, Instaflow M1b B3). Locks and final paths are the stage's (`SF-STAGE-001…003`), element
 * values and inapplicable actions are B1's (`IF-EL-001`, `IF-EL-004`), geometry failures `IF-EL-005`; these cover the
 * tools themselves: gesture order, transforms with nothing to move, view state and targets that vanished.
 */
import { defineError } from '@staticflux/core';

export const GestureStateError = defineError(
  'IF-TOOL-001',
  'invariant',
  'A pointer event arrived in a gesture state that does not accept it (a move or release without a press, or a press during a gesture).',
  'Feed pointer events in order (down, move…, up or cancel) per pointer; `controller.state` says which gesture is active (LIFECYCLES §25).',
);

export const NothingToTransformError = defineError(
  'IF-TOOL-002',
  'validation',
  'Nothing can be transformed: the selection is empty, or every selected element is position-locked.',
  'Select an element that is not locked (`stage.lockOf(node).position` is false), or unlock it first; `details.locked` lists the locked ones.',
);

export const InvalidViewStateError = defineError(
  'IF-TOOL-003',
  'validation',
  'A view-state change is out of range: a non-finite camera, a zoom outside the zoom range, or an unknown tab.',
  'Use finite numbers, keep zoom within `ZOOM_RANGE` (`details.range`), and open the tab with `viewStates.open(tab)` before using it.',
);

// ---------------------------------------------------------------- B10a: Free Transform (`IF-XF-*`)

export const InvalidTransformValueError = defineError(
  'IF-XF-001',
  'validation',
  'A numeric transform value is not a finite number in its range (W and H at least 1, skew within ±80°, angles within ±3600°).',
  'Type a finite number inside `details.range` for `details.field`; flip with Flip horizontal / vertical instead of a negative W or H.',
);

export const TransformModeStateError = defineError(
  'IF-XF-002',
  'invariant',
  'A transform session was committed or cancelled while none was active.',
  'Enter transform mode first (Mod+T or `mode.enter()`); `mode.state` says whether a session is active (LIFECYCLES §36).',
);

export const TargetGoneError = defineError(
  'IF-TOOL-004',
  'conflict',
  'Every element of the gesture was deleted (for example by a collaborator or an agent) before the gesture ended; nothing was committed.',
  'Nothing to fix: the gesture was cancelled and the selection pruned. Start the gesture again on an element that exists.',
);
