/**
 * Versioning errors (`IF-VER-*`, Instaflow M1 B5). Errors are values: every service returns
 * them in `Result`s; the panel shows their message and the top bar shows the cause of a stalled save.
 */
import { defineError } from '@staticflux/core';

export const MilestoneNameError = defineError(
  'IF-VER-001',
  'validation',
  'A milestone name must be 1–120 characters after trimming.',
  'Ask for a short name ("Client v2"); the panel keeps the field open with this message.',
);

export const UnknownMilestoneError = defineError(
  'IF-VER-002',
  'not-found',
  'The milestone is not in this document’s milestone list.',
  'Refresh the list (`milestones.refresh(signal)`); another tab may have changed the head. Never build a milestone id by hand.',
);

export const MilestoneDataError = defineError(
  'IF-VER-003',
  'not-found',
  'A milestone record, snapshot manifest or canonical part is missing or malformed in the store.',
  'Show a placeholder and keep the rest of the list usable; `details.digest` names the object. Re-import the `.iflow` it came from if the store lost it.',
);

export const VersionHeadConflictError = defineError(
  'IF-VER-004',
  'conflict',
  'The document head kept changing while versioning tried to update it (compare-and-swap lost repeatedly).',
  'Retry the action; if it persists another writer is swapping the head in a loop (check the store leader).',
);

export const SlotMarkError = defineError(
  'IF-VER-005',
  'validation',
  'The element cannot be marked as this slot (unknown node, duplicate slot name, or a target that does not fit the slot kind).',
  'Pick an element of the right kind and a slot name that is unique in the template; `details` names the node and slot.',
);

export const SlotFillError = defineError(
  'IF-VER-006',
  'validation',
  'A template fill does not match its slot (unknown slot name, wrong value type, or over the slot’s character limit).',
  'Fill text slots with a string, image slots with an image asset id (`as_…`) and colour slots with a hex colour (`#rrggbb`); `details.slot` names the slot.',
);

export const RequiredSlotError = defineError(
  'IF-VER-007',
  'validation',
  'A required template slot was not filled.',
  'Fill every slot listed in `details.slots` (the "Use template" form marks them), then create the document again.',
);

export const AssetExistsError = defineError(
  'IF-VER-008',
  'conflict',
  'The asset id for the new document is already in use.',
  'Generate a fresh asset id (uuidv7) for every new document; never reuse the source asset id.',
);

export const ReleaseUnavailableError = defineError(
  'IF-VER-009',
  'unavailable',
  'Publishing a Release is not available in this build (the Release hook has no implementation yet).',
  'Plain exports need no Release (D10). Provide `ReleasePortToken` when the publish flow lands.',
);

export const VersioningDisposedError = defineError(
  'IF-VER-010',
  'invariant',
  'The versioning service was used after its document was closed.',
  'Create versioning services in the open document’s scope so they are disposed with it; do not keep references across documents.',
);
