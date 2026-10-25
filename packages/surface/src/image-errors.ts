/** Error of `@staticflux/surface/image` (`SF-SURF-016`); its own module so the image entry carries only it. */
import { defineError } from '@staticflux/core';

export const ImageEncodeError = defineError(
  'SF-SURF-016',
  'validation',
  'An image could not be scaled or encoded (zero or non-integer size, pixel data of the wrong length, or the compression stream failed).',
  'Pass a `RasterImage` whose `data` holds exactly `width × height × 4` RGBA bytes and a positive integer target size; inspect `cause` when `CompressionStream` is missing or failed.',
);
