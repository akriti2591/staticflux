/**
 * Error catalog for @staticflux/surface (`SF-SURF-*`).
 */
import { defineError } from '@staticflux/core';

export const SurfaceContextError = defineError(
  'SF-SURF-001',
  'unavailable',
  'The canvas could not provide a rendering context of the requested kind.',
  'Feature-detect the kind (`supportsSurfaceKind`) and declare a fallback kind (e.g. webgpu → webgl → canvas2d).',
);

export const OffscreenUnsupportedError = defineError(
  'SF-SURF-002',
  'unavailable',
  'OffscreenCanvas transfer is not available, so the surface cannot render in a worker.',
  'Use `createRenderSurface` (falls back to a main-thread surface automatically) or render on the main thread.',
);

export const EngineInitError = defineError(
  'SF-SURF-003',
  'unavailable',
  'The render engine failed to initialize.',
  'Inspect `cause`; engines must return a Result from `init(ctx)` and degrade (e.g. WebGPU adapter missing → report, let the app pick another kind).',
);

export const MainThreadOnlyError = defineError(
  'SF-SURF-004',
  'invariant',
  'This API needs the DOM (main thread) but was used where no document exists (e.g. in a worker).',
  'Create HTML-in-Canvas adapters and accessible layers on the main thread; render heavy 3D in the render worker (hybrid composition).',
);

export const TaintedImageError = defineError(
  'SF-SURF-005',
  'forbidden',
  'A cross-origin image would taint the canvas: the response is opaque (no CORS).',
  'Serve the image with `Access-Control-Allow-Origin` (and `Cross-Origin-Resource-Policy` when isolated), or proxy it same-origin.',
);

export const ImageLoadError = defineError(
  'SF-SURF-006',
  'network',
  'An image for a surface could not be loaded or decoded.',
  'Check the URL and the CORS headers; decoding failures usually mean an unsupported format.',
);

export const RenderWorkerError = defineError(
  'SF-SURF-007',
  'unavailable',
  'The render worker reported an error or did not answer.',
  'Check the worker registers the engine id with `hostRenderSurfaces({ engines })`; worker crashes are handled by its supervisor.',
);

export const FrameBudgetExceededError = defineError(
  'SF-SURF-008',
  'quota',
  'A surface exceeded its frame-time or input-latency budget.',
  'Profile the engine frame (`surface/frame-time`); move work to the render worker or reduce per-frame work; raise the budget only with a reason.',
);

export const SurfaceNotAttachedError = defineError(
  'SF-SURF-009',
  'invariant',
  'The surface is not attached (or was disposed).',
  'Call `attach(host)` first and wait for it; check `surface.state` before starting the frame loop.',
);

export const TextInputUnavailableError = defineError(
  'SF-SURF-016',
  'unavailable',
  'The requested TextInput implementation cannot run here (no EditContext, or no document for the hidden textarea).',
  'Bind `TextInputFactoryToken` with `textInputBindings({ editContext })` so the platform fact picks the implementation; create inputs on the main thread.',
);
