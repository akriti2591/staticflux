/**
 * Error catalog of @staticflux/vite-plugin. Codes are stable (`SF-VITE-NNN`); each one
 * has a concrete fix. Loader errors (`SF-LOAD-*`) raised by the manifest builder are
 * passed through as `cause` with their own code in the message.
 */
import { defineError } from '@staticflux/core';

export const ViteManifestBuildError = defineError(
  'SF-VITE-001',
  'validation',
  'The sf-manifest could not be built from the Vite/Rolldown bundle.',
  'Read the wrapped SF-LOAD code: every declaration needs an `entry` that matches a bundled module (path suffix) or chunk name, every `deps` id must be declared, and eager chunks need a `reason`.',
);

export const ViteBudgetExceededError = defineError(
  'SF-VITE-002',
  'quota',
  'A chunk, eager boot cost or per-profile boot JS exceeds its budget (R12.7).',
  'Split or lazy-load the offending chunk, drop `load: \'eager\'`, or raise the budget with a reviewed reason (R12.8). Use `budgets.onViolation: \'warn\'` to report without failing.',
);

export const ViteBootPlanError = defineError(
  'SF-VITE-003',
  'validation',
  'Per-profile preloads could not be computed from the boot plans.',
  'Every profile needs a matching boot plan (add a fallback plan without `match`), and every chunk a plan lists must be declared in `chunks`.',
);

export const ViteOptionsError = defineError(
  'SF-VITE-004',
  'validation',
  'The staticflux() Vite plugin options are invalid.',
  'Check the options: chunk ids are unique `kind:name` ids, `bootPlans` need `profiles`, and `html.profile` must be one of `profiles`.',
);
