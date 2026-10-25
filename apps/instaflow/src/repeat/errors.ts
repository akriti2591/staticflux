/**
 * Repeat errors (`IF-REP-*`, M1b B7). Lock, final-path and element-value problems keep their own codes
 * (`SF-STAGE-001…003`, `IF-EL-001`, `IF-EL-004`); these cover repeat parameters, instances and handle drags.
 */
import { defineError } from '@staticflux/core';

export const InvalidRepeatParamError = defineError(
  'IF-REP-001',
  'validation',
  'A repeat parameter has the wrong type or is out of range (count, radius, angles, rows, columns, gaps, offsets, axis).',
  'Write the shapes and ranges documented in `apps/instaflow/src/repeat/params.ts` (`REPEAT_LIMITS`); `details.path` names the parameter and `details.expects` what it takes.',
);

export const TooManyInstancesError = defineError(
  'IF-REP-002',
  'validation',
  'The repeat would make more instances than the limit allows.',
  'Lower the count (radial) or rows × columns (grid) to at most `REPEAT_LIMITS.instances` (`details.limit`); expand smaller repeats and repeat the result if you need more.',
);

export const RepeatNotApplicableError = defineError(
  'IF-REP-003',
  'validation',
  'The repeat action does not apply to this selection (not a repeat, no elements, or elements with different parents).',
  'Select sibling elements to make a repeat, or one live repeat group to edit, expand or release it; `details.needs` says what the selection lacks.',
);

export const DerivedInstanceError = defineError(
  'IF-REP-004',
  'conflict',
  'Repeat instances are derived from the source: they cannot be written, expanded or deleted on their own.',
  'Edit the source element (`resolveInstance(id).source`), change the repeat parameters, or expand the repeat first to get real elements.',
);

export const HandleDragError = defineError(
  'IF-REP-005',
  'invariant',
  'A repeat handle drag was used after it ended (committed, cancelled or failed), or names a handle the repeat does not have.',
  'Start a new drag with `beginHandleDrag` for one of the handles `repeatHandles(ctx, node)` lists; never reuse an ended drag.',
);
