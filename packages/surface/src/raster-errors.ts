/**
 * Errors of `@staticflux/surface/raster` (`SF-SURF-010` … `SF-SURF-015`): GPU devices, raster backends,
 * headless renders and readback. Own module so the main surface entry does not carry them.
 */
import { defineError } from '@staticflux/core';

export const GpuUnavailableError = defineError(
  'SF-SURF-010',
  'unavailable',
  'No usable WebGPU device: there is no `navigator.gpu`, `requestAdapter()` returned null, or `requestDevice()` failed.',
  'Check the `platform/webgpu-adapter` fact before booting a GPU surface and show the unsupported screen (or a CPU fallback) when it is not `available`; inspect `cause` for the browser message.',
);

export const GpuDeviceLostError = defineError(
  'SF-SURF-011',
  'unavailable',
  'The GPU device was lost and could not be re-attached within the recovery attempts.',
  'Usually a driver reset or GPU process crash that keeps failing: offer a reload, and check `details.attempts` and `cause`. Never reload the document to recover; recovery rebuilds from the retained CPU-side scene.',
);

export const GpuRecoveryOverBudgetError = defineError(
  'SF-SURF-012',
  'quota',
  'GPU device recovery took longer than its budget (IF-7.11: 1 s).',
  'Profile `restore` (pipeline creation, image re-upload); keep scene state on the CPU side so recovery never waits for the document, and warm pipelines asynchronously.',
);

export const HeadlessRenderError = defineError(
  'SF-SURF-013',
  'validation',
  'A headless render was asked for an invalid or too large output (zero or non-integer size, or more pixels than the configured maximum).',
  'Request a positive integer width and height; split huge exports into pages or lower the scale; raise `maxPixels` only with a memory reason.',
);

export const RasterBackendError = defineError(
  'SF-SURF-014',
  'invariant',
  'A raster backend call failed or was used out of order (unknown tile slot or layer, not attached, disposed, or the engine threw).',
  'Attach the backend (and wait for `running`) before rendering; only composite slots returned by the tile cache; inspect `cause` for an engine panic message.',
);

export const RasterReadbackError = defineError(
  'SF-SURF-015',
  'unavailable',
  'Reading pixels back from the GPU failed (map failed, device lost during readback, or a validation error).',
  'Retry after the device is `running` again; readback buffers need COPY_DST | MAP_READ and 256-byte aligned rows.',
);
