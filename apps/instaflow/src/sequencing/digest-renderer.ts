/**
 * The fake renderer of the oracle suite and the bench: a `RenderPort` that "draws" by computing
 * the digest of exactly what a real renderer would show from the frame it was given. Optionally
 * tees to a real port, so any renderer (A6's) runs under the oracle unchanged.
 */
import { ok, type Result } from '@staticflux/core';
import { displayDigest } from './digest.js';
import type { RenderFrame, RenderPort } from './render-port.js';

export interface DigestRendererStats {
  readonly draws: number;
  readonly lastDigest: number;
  /** Draws whose digest differed from the editor's own (`view.digest`): an end-to-end self-check. */
  readonly selfCheckMismatches: number;
  readonly failures: number;
}

export interface DigestRenderer extends RenderPort {
  readonly lastDigest: number;
  readonly stats: DigestRendererStats;
}

/** Digest of the display a frame describes (render side). */
export function frameDigest(frame: RenderFrame): number {
  const view = frame.view;
  return displayDigest(frame.scene, {
    overlay: view.targets,
    overlayCount: view.overlayCount,
    dx: view.dx,
    dy: view.dy,
    selection: view.selection,
    selectionCount: view.selectionCount,
    marquee: view.marqueeOn === 1 ? view.marquee : undefined,
  });
}

/** A digesting port; `inner` (a real renderer) is drawn after the digest when given. */
export function createDigestRenderer(inner?: RenderPort): DigestRenderer {
  let draws = 0;
  let lastDigest = 0;
  let selfCheckMismatches = 0;
  let failures = 0;
  return {
    get lastDigest() {
      return lastDigest;
    },
    get stats() {
      return { draws, lastDigest, selfCheckMismatches, failures };
    },
    draw(frame): Result<void> {
      lastDigest = frameDigest(frame);
      draws += 1;
      if (lastDigest !== frame.view.digest) selfCheckMismatches += 1;
      if (inner === undefined) return ok();
      const drawn = inner.draw(frame);
      if (!drawn.ok) failures += 1;
      return drawn;
    },
    reset: () => inner?.reset?.(),
    dispose: () => inner?.dispose(),
  };
}
