/**
 * Accessibility-layer errors (`IF-A11Y-*`, Instaflow M1b B6). The DOM layer's own failure (no document: a worker host)
 * is the framework's `SF-SURF-004`; these cover the projection and its services.
 */
import { defineError } from '@staticflux/core';

export const ProjectionRootError = defineError(
  'IF-A11Y-001',
  'validation',
  'The canvas projection has no root: the page (or canvas root) it projects is not on the stage.',
  'Project an existing page: pass the tab view state whose `root` is a node the stage can `read` (open the page part first).',
);

export const ProjectorDisposedError = defineError(
  'IF-A11Y-002',
  'invariant',
  'The canvas projection or its DOM mount was used after it was disposed.',
  'Create a new projection for the tab (`createCanvasProjector`) after a page switch; dispose happens with the tab scope (LIFECYCLES §26).',
);

export const NoCanvasError = defineError(
  'IF-A11Y-003',
  'validation',
  'There is no open canvas to describe.',
  'Open a page in the Canvas or Pages lens first; the describe capability reads the open tab’s projection.',
);
