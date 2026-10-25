/**
 * Export errors (`IF-EXP-*`, Instaflow M1c C1): options, what to export, the frozen snapshot, the export Wasm, the
 * PNG render, the SVG / PDF writers, the export worker and delivering the file.
 */
import { defineError } from '@staticflux/core';

export const ExportOptionsError = defineError(
  'IF-EXP-001',
  'validation',
  'The export options are not valid.',
  'Pass `format` (png, pdf or svg), `scale` 1, 2 or 3 (PNG), `scope` page, selection or pages, and `transparent` true or false; see `validateExportOptions` (`src/export/formats.ts`).',
);

export const NothingToExportError = defineError(
  'IF-EXP-002',
  'validation',
  'There is nothing to export: the selection is empty, or the page has no visible content.',
  'Select one or more elements for a selection export, or export the page (`scope: "page"`); a page always exports at its size, empty or not.',
);

export const ExportSnapshotError = defineError(
  'IF-EXP-003',
  'unavailable',
  'The export could not freeze or read its snapshot of the design.',
  'Read the cause (IF-VER-003 for a missing part, SF-STORE-* from the workspace store). Export again; the snapshot is taken anew each time and writes nothing but content blobs (D10).',
);

export const ExportModuleError = defineError(
  'IF-EXP-004',
  'unavailable',
  'The export Wasm (SVG and PDF writers) could not be loaded, or its ABI does not match.',
  'Run `pnpm build` (it builds `apps/instaflow/engine/dist/export.*.wasm` and the manifest); check the network panel for the manifest and the hashed module.',
);

export const ExportRenderError = defineError(
  'IF-EXP-005',
  'unavailable',
  'Rendering the export failed (the headless render module, or a raster patch).',
  'Read the cause: SF-SURF-010 means no WebGPU adapter (exports need Chrome with WebGPU, D1), SF-SURF-013 an output too large for the device (lower the scale), SF-SURF-015 a readback failure (try again).',
);

export const ExportWriteError = defineError(
  'IF-EXP-006',
  'invariant',
  'The SVG or PDF writer rejected the scene.',
  'The message names the writer’s reason (a missing raster patch, an invalid region). Report it with the design: every scene the renderer draws must export (IF-7.10).',
);

export const ExportWorkerError = defineError(
  'IF-EXP-007',
  'unavailable',
  'The export worker could not start or stopped answering.',
  'Read the cause (IF-WRK-*, SF-WK-*). The worker is started per export; export again. In the dev server, check that `src/export/export.worker.ts` loads (network panel).',
);

export const ExportDeliveryError = defineError(
  'IF-EXP-008',
  'unavailable',
  'The exported file could not be handed to the browser (download or save dialog).',
  'Allow downloads for this site, or pick a folder in the save dialog; the export itself finished and can be run again.',
);
