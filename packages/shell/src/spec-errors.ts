/**
 * Error catalog of the spec runtime (`@staticflux/shell/spec`, R13.25–R13.30): SF-SHELL-009…015. A module of its
 * own so the shell boot entry does not carry it; `pnpm errors` reads `packages/shell/dist/spec.js`.
 */
import { defineError } from '@staticflux/core';

export const SpecInvalidError = defineError(
  'SF-SHELL-009',
  'validation',
  'The spec was rejected: one or more slots are unknown, out of context, gated out or misplaced.',
  'Read `details.issues` (each has its own code and fix). Fix the spec, or register the missing contribution; nothing was mounted.',
);

export const UnknownSpecContributionError = defineError(
  'SF-SHELL-010',
  'not-found',
  'The spec names a section or contribution that is not registered (the vocabulary is closed).',
  'Name only registered contributions (`createSpecVocabulary({ sections, contributions })`), or register the contribution from the feature that owns it.',
);

export const SpecContextMismatchError = defineError(
  'SF-SHELL-011',
  'validation',
  'A slot does not apply under the spec context (its `when` excludes the spec’s lens, scope or another context value).',
  'Drop the slot from this spec, change the context (for example the scope), or widen the contribution’s `when` if it really applies.',
);

export const SpecContributionDeniedError = defineError(
  'SF-SHELL-012',
  'forbidden',
  'A slot is gated out for this user (or agent); specs never bypass gating.',
  'Expected for premium or role-gated contributions: drop the slot or offer the upsell. Client gating is UX, not security; the server re-checks.',
);

export const SpecSlotError = defineError(
  'SF-SHELL-013',
  'validation',
  'A slot is malformed: duplicated, in a placement its section or contribution does not offer, the wrong count for a one-slot section, or a pin of an unpinnable or absent slot.',
  'Name each slot once, use a placement from the section’s `placements`, give one-slot sections (the lens) exactly one slot, and pin only mounted slots of pinnable sections.',
);

export const SpecMountError = defineError(
  'SF-SHELL-014',
  'unknown',
  'The mount port failed to mount, move or unmount a slot; the rest of the diff was applied.',
  'Mount ports return a `Result`; check `details.slot` and the cause. The runtime’s layout reflects what is really mounted, so re-applying the spec retries only the failed slot.',
);

export const SpecRuntimeDisposedError = defineError(
  'SF-SHELL-015',
  'invariant',
  'The spec runtime was disposed.',
  'Create a new runtime (`createSpecRuntime`) for a new editor surface; do not keep references past its scope.',
);
