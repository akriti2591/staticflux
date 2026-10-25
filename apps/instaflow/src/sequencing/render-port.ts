/**
 * The render port: the only thing the render module (A7 sequencing) knows about the renderer
 * (A6: Vello raster, tiles, lifted layers, compositor). The render module calls `draw` only with a
 * **consistent** pair — the scene store at exactly `view.docVersion` and that view frame — and at
 * most once per new (viewSeq, docVersion). Everything else (tile caches, GPU memory, device loss)
 * is the port's business.
 *
 * Contract (checked by the sequencing oracle suite, which runs every port through a digesting tee):
 * - `draw` must not keep `frame`, `frame.view` or column views after it returns (the view is a
 *   reused copy; columns may be reallocated — re-fetch when `scene.layout` changes).
 * - `draw` must not mutate the scene store or the view.
 * - A failed draw returns an error value; the render module keeps the last good frame on screen
 *   and counts the failure (`IF-SEQ-003`).
 * - Overlay targets (`view.targets[0 … overlayCount)`) are drawn at committed + (dx, dy); the
 *   committed copies of those elements are hidden while the overlay is up (lifted layer, E-2).
 */
import type { Result } from '@staticflux/core';
import type { SceneStore } from '@staticflux/document/render-projection';
import type { SceneField, ViewFrameRecord } from './protocol.js';

export type DrawReason = 'arrival' | 'tick';

export interface RenderFrame {
  readonly scene: SceneStore<SceneField>;
  readonly view: Readonly<ViewFrameRecord>;
  /** Committed version applied (equals `view.docVersion`). */
  readonly docVersion: number;
  readonly reason: DrawReason;
}

export interface RenderPort {
  draw(frame: RenderFrame): Result<void>;
  /** Called after a resnapshot replaced the scene (tile caches are stale). Optional. */
  reset?(): void;
  dispose(): void;
}

/** A named factory, so a worker can build its port from boot settings (`hostSequencingWorker({ renderPorts })`). */
export type RenderPortFactory = () => RenderPort;
