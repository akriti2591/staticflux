/**
 * Element and style errors (`IF-EL-*`, M1 B1). Lock and final-path violations come from `@staticflux/stage`
 * (`SF-STAGE-001…003` ↔ `IF-CS-004`, `IF-CS-013`); these cover element values, brand kits, geometry and actions.
 */
import { defineError } from '@staticflux/core';

export const InvalidElementValueError = defineError(
  'IF-EL-001',
  'validation',
  'An element value has the wrong shape (paint, effect, corner radius, layout grid, mask or geometry).',
  'Write values in the shapes documented in `apps/instaflow/src/elements/values.ts` (e.g. a paint is a CSS colour, `@token`, `none`, or a gradient or image object); `details.path` names the field.',
);

export const UnknownTokenError = defineError(
  'IF-EL-002',
  'not-found',
  'A `@token` reference names no token in the brand kit, or the token has the wrong type for the field.',
  'Pick a token listed by `brandKitTokens(kit)` of the matching type (colour for paints, number for sizes), or write a literal value.',
);

export const BrandRuleError = defineError(
  'IF-EL-003',
  'forbidden',
  'The edit breaks a brand rule of the brand kit (for example "headlines use @display").',
  'Use a value the rule allows (`details.allowed`), or ask a brand-kit owner to change the rule. Client gating is UX, not security.',
);

export const ActionNotApplicableError = defineError(
  'IF-EL-004',
  'validation',
  'The action does not apply to this selection (too few elements, wrong kinds, or nothing to change).',
  'Check the action’s applicability (`appliesTo`) before offering it; `details.needs` says what the selection lacks.',
);

export const GeometryError = defineError(
  'IF-EL-005',
  'validation',
  'The geometry engine rejected the input (malformed path data, a degenerate shape or a failed boolean).',
  'Fix the path data or shape parameters named in `details`; booleans need closed operands with finite coordinates.',
);

export const GeometryModuleError = defineError(
  'IF-EL-006',
  'unavailable',
  'The authoring Wasm (geometry) could not be loaded, or its geometry version does not match this build.',
  'Run `pnpm build` (it builds `apps/instaflow/engine`), serve `engine/dist/sf-wasm-manifest.json`, and reload; never hard-code a hashed file name.',
);

export const MissingClassError = defineError(
  'IF-EL-007',
  'not-found',
  'The style class or brand kit an element inherits from is not available.',
  'Load the brand kit asset (or pick an existing class from `brandKitClasses(kit)`); until then the element shows its own values.',
);
