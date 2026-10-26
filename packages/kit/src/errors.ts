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

/** OVERLAYS-FEEDBACK §1.2: the nesting table is enforced, not only documented. */
export const OverlayNestingError = defineError(
  'SF-KIT-003',
  'invariant',
  'An overlay was opened inside a parent that may not hold it (a popover from a popover or a menu, a submenu inside a submenu); it was not opened.',
  'Grow or swap the open popover in place, close the menu and anchor the popover to the menu’s trigger (`menu.trigger`), or turn a third menu level into a searchable menu or a dialog step (OVERLAYS-FEEDBACK §1.2).',
);

/** The copy field could not write to the clipboard (permission refused, insecure context, no Clipboard API). */
export const ClipboardWriteError = defineError(
  'SF-KIT-004',
  'forbidden',
  'The text could not be copied: the browser refused clipboard access or has no Clipboard API here.',
  'Serve the page over HTTPS and copy from a user gesture; people can allow clipboard access in site settings or select the field and copy by hand.',
);

export const InvalidNameError = defineError(
  'SF-KIT-002',
  'validation',
  'An inline edit was committed empty while a name is required, or longer than its maximum length.',
  'Type at least one non-space character (or set `required` to false), and stay within `maxlength`; Escape restores the previous name.',
);

/** A side of a size field is outside its limits (`<sf-size-field>`, R13.48). */
export const SizeOutOfRangeError = defineError(
  'SF-KIT-005',
  'validation',
  'A width or height typed into a size field is outside the field’s limits (`min`…`max` pixels).',
  'Type a size between `details.min` and `details.max` pixels (the field converts mm, in and pt at 96 px per inch); larger pages do not fit this device’s canvas.',
);
