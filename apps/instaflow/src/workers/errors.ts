/**
 * Errors of Studio's worker topology (`IF-WRK-*`, Instaflow B9): booting the editor and render modules in their
 * workers, routing requests to the module that owns them, mirrors, the store port and the canvas transfer.
 */
import { defineError } from '@staticflux/core';

export const WorkerBootError = defineError(
  'IF-WRK-001',
  'unavailable',
  'A Studio worker could not start (spawn, engine Wasm, fonts, the store port, the document or the pipes).',
  'Read `details.step` and the cause. In dev run `pnpm build` (the Wasm) and reload; a worker that fails to load its script reports the browser error as the cause (LIFECYCLES §35).',
);

export const WorkerRoleError = defineError(
  'IF-WRK-002',
  'invariant',
  'A request reached a worker that does not host the module it needs, or a worker was started twice.',
  'Route editor requests to the worker whose plan has the `editor` role and render requests to the `render` role (`StudioWorkers.editor` / `.render`); never branch on the topology.',
);

export const MirrorUnknownError = defineError(
  'IF-WRK-003',
  'invariant',
  'A forwarded action names a mirror or an action the editor module does not serve.',
  'Declare the mirror with `defineMirror` and serve it in the editor module (`servers.serve`) before main calls it; check `details.mirror` and `details.action`.',
);

export const CapabilityNotServedError = defineError(
  'IF-WRK-004',
  'validation',
  'The editor module has no implementation for this capability.',
  'Forward only the capability ids the editor reported at start (`started.capabilities`); add the implementation to the editor module’s table.',
);

export const StorePortError = defineError(
  'IF-WRK-005',
  'unavailable',
  'The store port is closed or the store side did not answer.',
  'The store side (main, the store-worker stand-in) must serve `StudioStoreProtocol` on the port it passed at start for the document’s lifetime; reopen the document after a reload.',
);

export const CanvasTransferError = defineError(
  'IF-WRK-006',
  'unavailable',
  'The canvas could not be handed to the render module (no OffscreenCanvas transfer in this browser, or it was transferred already).',
  'Use Chrome with OffscreenCanvas and WebGPU (D1). A canvas element can be transferred once: create a new one for a new render module.',
);
