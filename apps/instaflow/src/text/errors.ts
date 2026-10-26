/**
 * Text errors (`IF-TXT-*`, B2). Errors are values: services return them in `Result`s.
 */
import { defineError } from '@staticflux/core';

export const TextStyleInvalidError = defineError(
  'IF-TXT-001',
  'validation',
  'A text style value is invalid (mark or paragraph style).',
  'Use the typed style fields in `apps/instaflow/src/text/model.ts`: colours are CSS strings or `{ token }`, fonts `{ font: "sha256:…" }` or `{ token }`, links http(s)/mailto/#.',
);

export const NotATextNodeError = defineError(
  'IF-TXT-002',
  'not-found',
  'The node is missing or is not a text element (no `text.content`).',
  'Pass the id of a node of kind `text`; create one with `createTextOps`.',
);

export const TextRangeError = defineError(
  'IF-TXT-003',
  'validation',
  'A text offset or range is outside the text (UTF-16 offsets; the final paragraph break cannot be deleted).',
  'Clamp offsets to `[0, length]` of `readTextBlock(...).text`; resolve anchors with `resolveRange` before using them.',
);

export const AuthoringModuleError = defineError(
  'IF-TXT-004',
  'unavailable',
  'The authoring Wasm (text layout) could not be loaded, or its ABI does not match.',
  'Run `pnpm build` (builds `apps/instaflow/engine/dist` and its manifest) and load it with `loadAuthoringModule({ manifestUrl })`.',
);

export const TextLayoutError = defineError(
  'IF-TXT-005',
  'invariant',
  'The text engine rejected a layout request (malformed spec or unknown block).',
  'Build specs with `encodeLayoutSpec` (never by hand) and lay a block out before querying it; the message names the problem.',
);

export const FontInvalidError = defineError(
  'IF-TXT-006',
  'validation',
  'The file is not a usable font (OpenType/TrueType/collection), or the text engine could not register it.',
  'Offer .ttf, .otf, .ttc, .woff2 or .woff files (web fonts are decoded to OpenType first, B12).',
);

export const WebFontDecodeError = defineError(
  'IF-FIX-002',
  'validation',
  'A WOFF2 or WOFF font could not be decoded to OpenType (a damaged file, or the web font decoder could not load).',
  'Re-download the font or add its .ttf / .otf instead; when `cause` says the decoder failed to load, run `pnpm build` and serve `engine/dist` (`authoring-webfont` in the Wasm manifest).',
);

export const LocalFontsPermissionError = defineError(
  'IF-TXT-007',
  'forbidden',
  'Local Font Access was refused: the permission is denied, or the request did not come from a user gesture.',
  'Call `requestLocalFonts` from a click handler; when the permission is denied, explain how to re-enable it in site settings and offer an upload instead.',
);

export const LocalFontsUnavailableError = defineError(
  'IF-TXT-008',
  'unavailable',
  'Local Font Access is not available in this browser.',
  'Gate the "Use local fonts" action on the `localFontAccess` platform fact and offer uploads instead.',
);

export const FontTokenUnresolvedError = defineError(
  'IF-TXT-009',
  'not-found',
  'A brand-kit font or colour token does not resolve to a value in the current brand kit.',
  'Add the token to the brand kit or pick another one; the text falls back to the element default meanwhile.',
);

export const FontStoreError = defineError(
  'IF-TXT-010',
  'unavailable',
  'Storing or reading font bytes in the workspace blob store failed.',
  'Check storage quota and the blob store state (`@staticflux/blob`); the `cause` carries the store error.',
);
