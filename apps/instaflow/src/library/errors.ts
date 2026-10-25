/**
 * Library errors (`IF-LIB-001` … `IF-LIB-009`, Instaflow M1b B4). Errors are values: every service
 * returns them in `Result`s and the Assets panel shows their message. The lenses use `IF-LIB-010` …
 * (`../lenses/errors.ts`).
 */
import { defineError } from '@staticflux/core';

export const UnsupportedMediaError = defineError(
  'IF-LIB-001',
  'validation',
  'The file is not a media type the library can import (images, video, audio, fonts and SVG are supported).',
  'Import a PNG, JPEG, WebP, GIF, AVIF, SVG, MP4, WebM, MOV, MP3, WAV, OGG, M4A, FLAC, TTF, OTF, WOFF or WOFF2 file; `details.type` names what was given.',
);

export const ImportFailedError = defineError(
  'IF-LIB-002',
  'unavailable',
  'Storing the imported file in the workspace failed (the blob store refused the write).',
  'Check `cause` (quota `SF-BLOB-001`, I/O `SF-BLOB-007`); free space or move the workspace to a folder, then import again. Nothing was listed.',
);

export const UnknownAssetError = defineError(
  'IF-LIB-003',
  'not-found',
  'The asset is not in the library document.',
  'Use ids from `library.entries()`; another tab may have removed it. Never build an asset id by hand.',
);

export const LibraryDataError = defineError(
  'IF-LIB-004',
  'not-found',
  'A library record or entry is missing or malformed.',
  'Show the entry as unavailable and keep the rest of the library usable; `details.digest` or `details.asset` names the object. Re-import the file if the store lost it.',
);

export const MediaDecodeError = defineError(
  'IF-LIB-005',
  'validation',
  'The media could not be decoded (corrupt file, or a format this browser cannot decode).',
  'Re-export the file from its source app as PNG or JPEG; `cause` carries the decoder message.',
);

export const RenditionError = defineError(
  'IF-LIB-006',
  'unavailable',
  'A rendition (thumbnail) could not be produced or stored.',
  'Renditions are regenerable: the job is retried by `renditions.resume()` on the next session. Check `cause` (decoder, renderer or store) when it keeps failing.',
);

export const LibraryMetadataError = defineError(
  'IF-LIB-007',
  'validation',
  'A title, tag or folder name is not valid.',
  'Titles are 1–200 characters, tags 1–40 characters without commas, folders "/"-separated names of 1–60 characters each; the panel keeps the field open with this message.',
);

export const AssetListedError = defineError(
  'IF-LIB-008',
  'conflict',
  'The asset id is already listed in the library.',
  'Generate a fresh asset id for every new asset; use `library.entry(id)` to update an existing one.',
);

export const LibraryDisposedError = defineError(
  'IF-LIB-009',
  'invariant',
  'A library service was used after it was disposed.',
  'Create library services in the workspace scope so they are disposed with it; do not keep references across workspaces.',
);
