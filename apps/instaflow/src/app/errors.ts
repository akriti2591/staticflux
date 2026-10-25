/**
 * Studio integration errors (`IF-INT-*`, Instaflow B8). Feature errors stay with their features (IF-EL, IF-TOOL, …);
 * these cover the glue: the canvas pipeline, the per-tab tool session and opening the demo document.
 */
import { defineError } from '@staticflux/core';

export const PipelineStartError = defineError(
  'IF-INT-001',
  'unavailable',
  'The canvas pipeline could not start (a scene record stream, view frame cell or their endpoints).',
  'Read `details.step` and the cause; the local medium needs no isolation, so this is usually a disposed scope. Reopen the page (LIFECYCLES §29).',
);

export const SceneRecordError = defineError(
  'IF-INT-002',
  'invariant',
  'A scene record on the canvas stream is not a framed element record (resources, projection, scene IR).',
  'Write records only with `encodeSceneRecord`; a stream shared with A7’s `SceneProjection` payloads needs the default scene adapter instead.',
);

export const NoOpenPageError = defineError(
  'IF-INT-003',
  'validation',
  'There is no open page in this tab (the tool session or the canvas is not started).',
  'Open a page first (`openPage`), or wait for the canvas port to start; HUD actions and creation tools need an open page.',
);

export const CanvasBackendError = defineError(
  'IF-INT-004',
  'unavailable',
  'The canvas renderer could not start (render Wasm, WebGPU device or canvas).',
  'Use Chrome with WebGPU (D1). In tests and headless runs pass a recording raster to `studioCanvas`; the rest of Studio keeps working.',
);

export const DocumentOpenError = defineError(
  'IF-INT-005',
  'unavailable',
  'The Studio document could not be created or opened (store, parts or the library document).',
  'Read the cause (A3 store or repo error) and `details.step`; in dev, reload the page (the dev entry uses an in-memory store).',
);
