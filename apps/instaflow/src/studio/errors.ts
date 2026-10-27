/**
 * Studio surface errors (`IF-POL-050…`, B11b). The editor's mirror actions return them; the chrome shows them as toasts
 * (OVERLAYS-FEEDBACK §3: the message, never the code).
 */
import { defineError } from '@staticflux/core';

export const PageSizeError = defineError(
  'IF-POL-050',
  'validation',
  'A page side must be between 1 and 16 384 design pixels (New design’s range).',
  'Type a width and a height in that range (the Page section’s size field refuses others inline); `details` has what was asked.',
);

export const NoImageSelectedError = defineError(
  'IF-POL-051',
  'validation',
  'Replace image needs a selected element whose fill shows an image.',
  'Select an image (or a shape with an image fill), then choose Replace… again.',
);

/** B11c: the largest image Studio places or fills with from a file (HOME-FILES §3.1: larger files ask; M1 refuses). */
export const MAX_IMAGE_BYTES = 100 * 1024 * 1024;

export const ImageTooLargeError = defineError(
  'IF-POL-059',
  'validation',
  'This image is larger than 100 MB, more than Studio places or fills with from a file.',
  'Export a smaller copy (a JPEG or WebP under 100 MB) from the source app and drop or pick that; `details.name` and `details.size` say which file.',
);

export const NotAnImageError = defineError(
  'IF-POL-060',
  'validation',
  'Only images can be placed on the canvas or used as a fill.',
  'Pick or drop a PNG, JPEG, WebP, GIF, AVIF or SVG file; fonts and other media go to Assets (`Import`); `details.name` says which file.',
);
