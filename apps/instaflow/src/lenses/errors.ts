/** Lens errors (`IF-LIB-010` … `IF-LIB-013`, Instaflow M1b B4; the library uses 001–009). */
import { defineError } from '@staticflux/core';

export const NoCompositionError = defineError(
  'IF-LIB-010',
  'not-found',
  'The document part has no composition root, so the lenses have nothing to arrange.',
  'Open a composition (its root part holds one top-level `composition` node with the page stubs); other tree assets have their own lenses.',
);

export const UnknownPageError = defineError(
  'IF-LIB-011',
  'not-found',
  'The page is not in the composition (deleted, or another document’s page).',
  'Use page ids from `controller.arrangement().frames`; the arrangement follows remote edits, so re-read it after a change.',
);

export const LensFeatureRegistryError = defineError(
  'IF-LIB-012',
  'invariant',
  'Two lens features claim the same lens, or the fallback lens has no feature.',
  'Contribute exactly one `LensFeature` per lens id (`lensFeatureContribution`) and keep the Canvas feature registered: lenses without their own arrangement use it (D19).',
);

export const StoryMoveError = defineError(
  'IF-LIB-013',
  'validation',
  'A page cannot move to that place in the story (index out of range).',
  'Move pages to an index between 0 and the page count − 1; the Pages panel moves one step at a time with Alt+↑/↓.',
);

/** B11b: a design keeps at least one page (Pages › Delete page). */
export const LastPageError = defineError(
  'IF-POL-052',
  'validation',
  'A design keeps at least one page, so its only page cannot be deleted.',
  'Add a page first (Pages › Add page), or clear this page’s elements instead.',
);

/** B11b: a page name is required (Pages › Rename). */
export const PageNameError = defineError(
  'IF-POL-053',
  'validation',
  'A page needs a name.',
  'Type at least one character; the name is trimmed.',
);
