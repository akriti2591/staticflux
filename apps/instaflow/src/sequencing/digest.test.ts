import { createSceneStore } from '@staticflux/document/render-projection';
import { describe, expect, it } from 'vitest';
import { committedDigest, displayDigest, elementTerm, mix, viewPartDigest } from './digest.js';
import { createEditorCore } from './editor-core.js';
import { SceneProjection } from './protocol.js';
import { openScene, smallScene } from './test-helpers.js';

const scene = smallScene(20);

function store() {
  const created = createEditorCore({ part: openScene(scene) });
  if (!created.ok) throw created.error;
  const copy = createSceneStore(SceneProjection);
  const applied = copy.apply(created.value.snapshot());
  if (!applied.ok) throw applied.error;
  return copy;
}

describe('mix / elementTerm', () => {
  it('is a deterministic 32-bit mix sensitive to every input', () => {
    expect(mix(1, 2, 3)).toBe(mix(1, 2, 3));
    expect(new Set([mix(1, 2, 3), mix(2, 2, 3), mix(1, 3, 3), mix(1, 2, 4)]).size).toBe(4);
    expect(mix(1, 2, 3)).toBeGreaterThanOrEqual(0);
    expect(mix(1, 2, 3)).toBeLessThan(2 ** 32);
    expect(elementTerm(5, 10, 20)).toBe(mix(5, 10, 20));
  });
});

describe('viewPartDigest', () => {
  it('is order-independent over the selection and changes with the marquee', () => {
    expect(viewPartDigest([1, 2, 3], 3, undefined)).toBe(viewPartDigest([3, 1, 2], 3, undefined));
    expect(viewPartDigest([1, 2, 3], 2, undefined)).not.toBe(viewPartDigest([1, 2, 3], 3, undefined));
    expect(viewPartDigest([], 0, [0, 0, 10, 10])).not.toBe(viewPartDigest([], 0, [0, 0, 10, 11]));
    expect(viewPartDigest([], 0, undefined)).not.toBe(viewPartDigest([], 0, [0, 0, 0, 0]));
  });
});

describe('committedDigest / displayDigest', () => {
  it('an overlay moved by (dx, dy) digests like the committed scene with the element moved', () => {
    const s = store();
    const view = { overlay: [3], overlayCount: 1, dx: 5, dy: -2, selection: [3], selectionCount: 1, marquee: undefined };
    const drawn = displayDigest(s, view);
    const xs = s.column('x');
    const ys = s.column('y');
    const moved = (committedDigest(s) - elementTerm(3, xs[3] as number, ys[3] as number) + elementTerm(3, (xs[3] as number) + 5, (ys[3] as number) - 2)) >>> 0;
    expect(drawn).toBe((moved + viewPartDigest([3], 1, undefined)) >>> 0);
    expect(displayDigest(s, { ...view, dx: 0, dy: 0 })).toBe((committedDigest(s) + viewPartDigest([3], 1, undefined)) >>> 0);
    expect(displayDigest(s, view, 0)).not.toBe(drawn); // a supplied committed digest is used as is
  });
  it('skips dead overlay targets', () => {
    const s = store();
    const base = displayDigest(s, { overlay: [999], overlayCount: 1, dx: 4, dy: 4, selection: [], selectionCount: 0, marquee: undefined });
    expect(base).toBe((committedDigest(s) + viewPartDigest([], 0, undefined)) >>> 0);
  });
});
