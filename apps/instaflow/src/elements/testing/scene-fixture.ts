/**
 * Test-only: the element scene used by the projection snapshot, the vello_cpu golden (render crate) and the GPU golden.
 * It touches every appearance feature B1 projects: fill and stroke stacks, conic and linear gradients, smooth and
 * per-corner radii, a rounded star, a live boolean, a luminance mask over a group, an image with `cover`, a clipped
 * frame with a per-side stroke, shadows, glows, a layer blur and a background blur.
 */
import type { PartOp } from '@staticflux/document/v2';
import { P } from '../components.js';

/** 16×16 checker (straight RGBA), uploaded as image 1 for `as_photo`. */
export function checkerPixels(): Uint8Array {
  const px = new Uint8Array(16 * 16 * 4);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const on = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0;
      px.set(on ? [255, 194, 61, 255] : [61, 90, 254, 255], (y * 16 + x) * 4);
    }
  }
  return px;
}

const at = (x: number, y: number, w: number, h: number): Record<string, number> => ({ [P.x]: x, [P.y]: y, [P.w]: w, [P.h]: h });

/** Ops for page `p1` (128 × 128 px of content). */
export function elementSceneOps(): PartOp[] {
  return [
    {
      op: 'create',
      node: 'card',
      kind: 'shape',
      parent: 'p1',
      props: {
        ...at(6, 6, 54, 34),
        [P.radius]: '@radius-md',
        [P.radiusBR]: 2,
        [P.smoothing]: 0.6,
        [P.fills]: [{ paint: '@primary' }, { paint: { kind: 'linear', from: [0, 0], to: [0, 1], stops: [{ offset: 0, color: '#ffffff00' }, { offset: 1, color: '#ffffff99' }] }, blend: 'screen' }],
        [P.strokes]: [{ paint: '@ink', width: 2, align: 'inside' }],
        [P.effects]: '@shadow-md',
      },
    },
    {
      op: 'create',
      node: 'star',
      kind: 'shape',
      parent: 'p1',
      props: { ...at(70, 4, 40, 40), [P.shape]: 'star', [P.radius]: 3, [P.radiusInner]: 1, [P.fills]: [{ paint: { kind: 'conic', center: [0.5, 0.5], stops: [{ offset: 0, color: '#ff5c39' }, { offset: 0.5, color: '#3d5afe' }, { offset: 1, color: '#ff5c39' }] } }], [P.effects]: [{ kind: 'outer-glow', blur: 6, color: '#ffc23dcc' }] },
    },
    { op: 'create', node: 'bool', kind: 'group', parent: 'p1', props: { ...at(6, 50, 0, 0), [P.boolean]: 'subtract', [P.fills]: [{ paint: '#00b37e' }] } },
    { op: 'create', node: 'b1', kind: 'shape', parent: 'bool', props: at(0, 0, 36, 36) },
    { op: 'create', node: 'b2', kind: 'shape', parent: 'bool', props: { ...at(12, 12, 28, 28), [P.shape]: 'ellipse' } },
    { op: 'create', node: 'masked', kind: 'group', parent: 'p1', props: at(50, 50, 0, 0) },
    {
      op: 'create',
      node: 'm',
      kind: 'shape',
      parent: 'masked',
      props: { ...at(0, 0, 36, 36), [P.shape]: 'ellipse', [P.maskMode]: 'luminance', [P.fills]: [{ paint: { kind: 'radial', center: [0.5, 0.5], radius: 0.5, stops: [{ offset: 0, color: '#ffffff' }, { offset: 1, color: '#000000' }] } }] },
    },
    { op: 'create', node: 'm1', kind: 'shape', parent: 'masked', props: { ...at(0, 0, 36, 36), [P.fills]: [{ paint: '#d6265f' }] } },
    { op: 'create', node: 'photo', kind: 'image', parent: 'p1', props: { ...at(92, 50, 32, 24), [P.radius]: 6, [P.fills]: [{ paint: { kind: 'image', asset: { asset: 'as_photo' }, fit: 'cover' } }] } },
    {
      op: 'create',
      node: 'frame',
      kind: 'frame',
      parent: 'p1',
      props: { ...at(6, 92, 60, 30), [P.radius]: 8, [P.fills]: [{ paint: '#e4e9ef' }], [P.strokes]: [{ paint: '#16151a', width: 1, sides: [0, 0, 3, 0], align: 'inside' }] },
    },
    { op: 'create', node: 'inside', kind: 'shape', parent: 'frame', props: { ...at(40, 10, 40, 40), [P.shape]: 'ellipse', [P.fills]: [{ paint: '#3d5afe' }], [P.effects]: [{ kind: 'layer-blur', radius: 2 }] } },
    { op: 'create', node: 'stripe', kind: 'shape', parent: 'p1', props: { ...at(72, 92, 12, 30), [P.fills]: [{ paint: '#16151a' }] } },
    {
      op: 'create',
      node: 'glass',
      kind: 'shape',
      parent: 'p1',
      props: { ...at(76, 96, 46, 22), [P.radius]: 6, [P.fills]: [{ paint: '#ffffff66' }], [P.strokes]: [{ paint: '#16151a', width: 1, dash: [3, 2] }], [P.effects]: [{ kind: 'background-blur', radius: 4 }, { kind: 'inner-glow', blur: 4, color: '#ffffff' }] },
    },
  ];
}
