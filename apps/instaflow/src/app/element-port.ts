/**
 * The render port Studio's canvas draws through (B8): A7's `RenderPort` over B1's element scene. On each consistent
 * frame it encodes what changed in the scene store (B1's diffing encoder, with the resources the records carried),
 * applies the queued B2 text IR after it, moves the camera to the frame's, and presents. The pixels are the
 * `CanvasRaster`'s business: Vello's tiled renderer in the browser (`vello-canvas.ts`), a recording raster in tests.
 */
import { ok, type Result } from '@staticflux/core';
import type { ElementField } from '../elements/projection.js';
import { createElementSceneEncoder, type ElementSceneEncoderOptions } from '../elements/scene.js';
import type { RenderFrame, RenderPort } from '../sequencing/render-port.js';
import type { ElementSceneSide } from './canvas-pipeline.js';

/** Screen = page × zoom + t (B3's camera, A7's view frame). */
export interface CanvasCamera {
  readonly tx: number;
  readonly ty: number;
  readonly zoom: number;
}

/** What draws scene IR batches on a canvas. */
export interface CanvasRaster {
  /** Apply one scene IR batch. */
  apply(batch: Uint8Array): Result<void>;
  setCamera(camera: CanvasCamera): void;
  /** Draw a frame (tiles, compositing); called after the batches and the camera of one frame. */
  present(): Result<void>;
  /** The scene was replaced (device loss, resnapshot): tile caches are stale. */
  reset?(): void;
  /** The canvas changed size (CSS px). */
  resize?(width: number, height: number): Result<void>;
  dispose(): void;
}

export interface ElementRenderPortOptions extends ElementSceneEncoderOptions {
  readonly side: ElementSceneSide;
  readonly raster: CanvasRaster;
}

export interface ElementRenderPortStats {
  readonly draws: number;
  readonly batches: number;
}

export interface ElementRenderPort extends RenderPort<ElementField> {
  readonly stats: ElementRenderPortStats;
}

/** The element render port (see the module header). */
export function createElementRenderPort(options: ElementRenderPortOptions): ElementRenderPort {
  const { side, raster } = options;
  const encoder = createElementSceneEncoder(options.images === undefined ? {} : { images: options.images });
  let draws = 0;
  let batches = 0;
  const apply = (batch: Uint8Array | undefined): Result<void> => {
    if (batch === undefined) return ok();
    batches += 1;
    return raster.apply(batch);
  };
  return {
    get stats() {
      return { draws, batches };
    },
    draw(frame: RenderFrame<ElementField>): Result<void> {
      const queued = side.take();
      // Elements first (a full encode starts with CLEAR), then asset uploads and text IR. The raster resolves image
      // and font references when it draws (`present`), so uploads only need to arrive within the same frame.
      const elements = apply(encoder.encode(frame.scene, side.resources, { full: queued.full }));
      if (!elements.ok) return elements;
      for (const batch of [...queued.assets, ...queued.ir]) {
        const applied = apply(batch);
        if (!applied.ok) return applied;
      }
      raster.setCamera({ tx: frame.view.tx, ty: frame.view.ty, zoom: frame.view.zoom });
      draws += 1;
      return raster.present();
    },
    reset() {
      encoder.reset();
      raster.reset?.();
    },
    dispose: () => raster.dispose(),
  };
}

/** A raster that records what it was given (tests, headless runs and the smoke check's status line). */
export interface RecordingRaster extends CanvasRaster {
  readonly batches: readonly Uint8Array[];
  readonly cameras: readonly CanvasCamera[];
  readonly presents: number;
  readonly disposed: boolean;
}

export function createRecordingRaster(): RecordingRaster {
  const batches: Uint8Array[] = [];
  const cameras: CanvasCamera[] = [];
  let presents = 0;
  let disposed = false;
  return {
    batches,
    cameras,
    get presents() {
      return presents;
    },
    get disposed() {
      return disposed;
    },
    apply(batch) {
      batches.push(batch);
      return ok();
    },
    setCamera(camera) {
      cameras.push(camera);
    },
    present() {
      presents += 1;
      return ok();
    },
    dispose() {
      disposed = true;
    },
  };
}
