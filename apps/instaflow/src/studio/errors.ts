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
