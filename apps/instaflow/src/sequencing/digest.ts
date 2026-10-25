/**
 * Display digests (the S2 oracle check, IF-7.3). An additive set hash over what a frame shows:
 * every committed element at its committed position, the overlay targets moved by the gesture
 * offset, the selection chrome and the marquee. The editor (expected), the single-threaded
 * reference and the render side (what was actually drawn) compute it with the same functions
 * over the same scene-store layout, so equality is an end-to-end check that costs microseconds.
 */
import type { SceneStore } from '@staticflux/document/render-projection';
import type { SceneField } from './protocol.js';

/** 32-bit avalanche mix of three ints (S2). */
export function mix(a: number, b: number, c: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b | 0, 0xc2b2ae35) ^ Math.imul((c | 0) + 0x27d4eb2f, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

const SELECTION_SALT = 0x5e1ec7;
const MARQUEE_SALT = 0x3a7c11;

/** One element's contribution at a position. */
export function elementTerm(slot: number, x: number, y: number): number {
  return mix(slot, x, y);
}

/** Digest of the view-only part: selection chrome and marquee. */
export function viewPartDigest(selection: ArrayLike<number>, count: number, marquee: ArrayLike<number> | undefined): number {
  let h = mix(count, SELECTION_SALT, 1);
  for (let i = 0; i < count; i++) h = (h + mix(selection[i] as number, SELECTION_SALT, 2)) >>> 0;
  if (marquee !== undefined) h = (h + mix(mix(marquee[0] as number, marquee[1] as number, MARQUEE_SALT), marquee[2] as number, marquee[3] as number)) >>> 0;
  return h;
}

/** Digest of the committed scene (no overlay, no view state). */
export function committedDigest(scene: SceneStore<SceneField>): number {
  const xs = scene.column('x');
  const ys = scene.column('y');
  let h = 0;
  scene.forEach((slot) => {
    h = (h + elementTerm(slot, xs[slot] as number, ys[slot] as number)) >>> 0;
  });
  return h;
}

export interface DisplayView {
  readonly overlay: ArrayLike<number>;
  readonly overlayCount: number;
  readonly dx: number;
  readonly dy: number;
  readonly selection: ArrayLike<number>;
  readonly selectionCount: number;
  readonly marquee: ArrayLike<number> | undefined;
}

/** Digest of a whole display: committed scene, overlay targets moved by (dx, dy), selection and marquee. */
export function displayDigest(scene: SceneStore<SceneField>, view: DisplayView, committed: number = committedDigest(scene)): number {
  let h = committed;
  if (view.overlayCount > 0 && (view.dx !== 0 || view.dy !== 0)) {
    const xs = scene.column('x');
    const ys = scene.column('y');
    for (let i = 0; i < view.overlayCount; i++) {
      const slot = view.overlay[i] as number;
      if (!scene.alive(slot)) continue;
      const x = xs[slot] as number;
      const y = ys[slot] as number;
      h = (h - elementTerm(slot, x, y) + elementTerm(slot, x + view.dx, y + view.dy)) >>> 0;
    }
  }
  return (h + viewPartDigest(view.selection, view.selectionCount, view.marquee)) >>> 0;
}
