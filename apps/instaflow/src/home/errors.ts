/**
 * Home route errors (`IF-HOME-*`, Instaflow M1c C0): reading the Home index, Home's capabilities, and the store-side
 * pieces Home relies on (the index writer, opening a new design or a template in Studio).
 */
import { defineError } from '@staticflux/core';

export const HomeIndexReadError = defineError(
  'IF-HOME-001',
  'unavailable',
  'Home could not read the workspace index (the library head in the workspace store).',
  'Read the cause (SF-STORE-* from IndexedDB, or SF-DOC-*). Check that site data is allowed for this origin, then choose "Try again"; Studio rebuilds the index the next time it opens.',
);

export const UnknownDesignError = defineError(
  'IF-HOME-002',
  'validation',
  'There is no design with this asset id in the workspace (or it is in the trash).',
  'Pass an `asset` from Home’s recents or files (`window.__home.model.files()`); a design appears there once Studio has listed it.',
);

export const UnknownTemplateError = defineError(
  'IF-HOME-003',
  'validation',
  'There is no template with this asset id in the workspace.',
  'Pass a `template` from Home’s Templates section (`window.__home.model.templates()`); templates are library assets of kind "template".',
);

export const HomeRouteError = defineError(
  'IF-HOME-004',
  'invariant',
  'A Home or Studio href could not be built from the route table.',
  'Build hrefs only with `studioHref`, `newDesignHref` and `homeHref` (`src/home/routes.ts`); a param must be non-empty.',
);

export const HomeIndexWriteError = defineError(
  'IF-HOME-005',
  'conflict',
  'The Home index could not be written: the library head kept changing (compare-and-swap lost every retry).',
  'Retry later (the writer retries on the next library change or edit); persistent failures mean another writer rewrites the library head in a loop.',
);

export const TemplateSourceError = defineError(
  'IF-HOME-006',
  'validation',
  'The template has no milestone to start from (or its record is missing).',
  'Save the template again from Studio ("Save as template" makes the template’s first milestone); `details.template` names it.',
);

export const DesignOpenError = defineError(
  'IF-HOME-007',
  'unavailable',
  'Studio could not create or list the design it was asked to open (store, library or template).',
  'Read the cause and `details.step`; reload the page, or go back to Home and pick the design again.',
);

export const CustomSizeError = defineError(
  'IF-POL-054',
  'validation',
  'New design was asked for a custom size without both a width and a height.',
  'Pass `width` and `height` in px (1…16 384 each) with `format: "custom"`, or pick a format id (`post`, `story`, …) instead.',
);
