/**
 * Error catalog of @staticflux/kit (docs/LIFECYCLES.md §37). Field parsers return these as values;
 * the fields show their own localised inline message (`kitMessages`), never the code.
 */
import { defineError } from '@staticflux/core';

export const InvalidNumberInputError = defineError(
  'SF-KIT-001',
  'validation',
  'The text typed into a number field is not a number, an expression over numbers, or a number with a known unit.',
  'Type a number (`120`), an expression (`+10`, `*2`, `(100 + 20) / 2`), a percentage when the field has `percentOf`, or a unit listed in the field’s `units` (`2in`, `10mm`).',
);

export const InvalidNameError = defineError(
  'SF-KIT-002',
  'validation',
  'An inline edit was committed empty while a name is required, or longer than its maximum length.',
  'Type at least one non-space character (or set `required` to false), and stay within `maxlength`; Escape restores the previous name.',
);
