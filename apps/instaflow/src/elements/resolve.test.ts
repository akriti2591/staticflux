// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { P } from './components.js';
import { applyAffine, boxTransform, fitRadii, invert, multiply, readBox, resolveElement } from './resolve.js';
import { createFixture, KIT, shape } from './testing/fixtures.js';

const close = (a: readonly number[], b: readonly number[]): void => {
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i] as number, 9));
};

describe('transforms', () => {
  it('box transforms rotate, scale and flip about the anchor', () => {
    const box = readBox({ [P.x]: 10, [P.y]: 20, [P.w]: 100, [P.h]: 50 });
    expect(boxTransform(box)).toEqual([1, 0, -0, 1, 10, 20]);
    const turned = boxTransform({ ...box, rotation: 90 });
    close(applyAffine(turned, 50, 25), [60, 45]); // the centre stays
    close(applyAffine(turned, 0, 0), [85, -5]);
    const flipped = boxTransform({ ...box, flipX: true });
    close(applyAffine(flipped, 0, 0), [110, 20]);
    const t = boxTransform({ ...box, rotation: 30, scaleX: 2 });
    close(multiply(t, invert(t) ?? [0, 0, 0, 0, 0, 0]), [1, 0, 0, 1, 0, 0]);
    expect(invert([0, 0, 0, 0, 1, 1])).toBeUndefined();
  });

  it('fits radii like CSS and never above half the shortest side', () => {
    expect(fitRadii(100, 50, [10, 10, 10, 10])).toEqual([10, 10, 10, 10]);
    expect(fitRadii(100, 50, [100, 0, 0, 0])).toEqual([25, 0, 0, 0]);
    expect(fitRadii(100, 50, [50, 50, 50, 50])).toEqual([25, 25, 25, 25]);
    expect(fitRadii(10, 10, [-1, Number.NaN, 2, 2])).toEqual([0, 0, 2, 2]);
  });
});

describe('resolveElement', () => {
  it('resolves stacks, tokens (top level and nested), glows and effect presets', async () => {
    const f = await createFixture([
      shape('a', {
        [P.w]: 100,
        [P.h]: 40,
        [P.radius]: '@radius-md',
        [P.radiusTL]: 30,
        [P.smoothing]: 0.5,
        [P.fills]: [
          { paint: '@primary', opacity: 0.5, blend: 'multiply' },
          { paint: { kind: 'linear', from: [0, 0], to: [1, 0], stops: [{ offset: 0, color: '@ink' }, { offset: 1, color: '#fff' }] } },
          { paint: '#000', visible: false },
          { paint: { kind: 'conic', center: [0.5, 0.5], angle: 90, stops: [{ offset: 0, color: '#fff' }] } },
        ],
        [P.strokes]: [{ paint: '@ink', width: '@radius-md', align: 'outside', dash: [4, 2], sides: [1, 2, 3, 4] }],
        [P.effects]: [{ kind: 'outer-glow', blur: 8, color: '@primary' }, { kind: 'inner-glow', blur: 4, color: '#fff' }, '@shadow-md', { kind: 'background-blur', radius: 10 }],
        [P.maskMode]: 'luminance',
        [P.maskInvert]: true,
        [P.matchKey]: 'lk_a',
        role: 'cta',
        name: 'Button',
      }),
    ]);
    const el = resolveElement(f.stage, 'a', f.kit);
    // 30 + 12 do not fit the 40 px side: scaled by 40 / 42 (CSS), then capped at half the shortest side.
    expect(el?.geometry).toMatchObject({ kind: 'rect', smoothing: 0.5 });
    close((el?.geometry as unknown as { radii: number[] }).radii, [20, (12 * 40) / 42, (12 * 40) / 42, (12 * 40) / 42]);
    expect(el?.fills).toEqual([
      { paint: { kind: 'solid', color: [255, 92, 57, 255] }, opacity: 0.5, blend: 'multiply' },
      { paint: { kind: 'linear', from: [0, 0], to: [1, 0], stops: [[0, [22, 21, 26, 255]], [1, [255, 255, 255, 255]]] }, opacity: 1, blend: 'normal' },
      { paint: { kind: 'conic', center: [0.5, 0.5], start: Math.PI / 2, stops: [[0, [255, 255, 255, 255]]] }, opacity: 1, blend: 'normal' },
    ]);
    expect(el?.strokes[0]).toMatchObject({ width: 12, sides: [1, 2, 3, 4], align: 'outside', dash: [4, 2] });
    expect(el?.effects).toEqual([
      { kind: 'drop-shadow', x: 0, y: 0, blur: 8, spread: 0, color: [255, 92, 57, 255] },
      { kind: 'inner-shadow', x: 0, y: 0, blur: 4, spread: 0, color: [255, 255, 255, 255] },
      { kind: 'drop-shadow', x: 0, y: 4, blur: 12, spread: 0, color: [22, 21, 26, 255] },
      { kind: 'background-blur', radius: 10 },
    ]);
    expect(el?.mask).toEqual({ mode: 'luminance', invert: true });
    expect(el).toMatchObject({ matchKey: 'lk_a', role: 'cta', name: 'Button', issues: [] });
  });

  it('a whole-list effects preset resolves through the stage; unresolved tokens become issues and draw nothing', async () => {
    const f = await createFixture([
      shape('p', { [P.effects]: '@shadow-md', [P.fills]: [{ paint: '@nope' }, { paint: 'tomato' }], [P.strokes]: [{ paint: '#000', width: '@nope' }] }),
      shape('star', { [P.shape]: 'star', [P.radius]: 4, [P.radiusInner]: 2, [P.w]: 10, [P.h]: 10 }),
      shape('poly', { [P.shape]: 'polygon', [P.sides]: 6 }),
      shape('ell', { [P.shape]: 'ellipse' }),
      shape('line', { [P.shape]: 'line' }),
      shape('vec', { [P.path]: 'M0 0 L10 0 L10 10 Z', [P.radius]: 2, [P.vertexRadii]: [1, null, 3], [P.fillRule]: 'evenodd' }, 'p1', 'vector'),
      shape('grp', { [P.boolean]: 'subtract' }, 'p1', 'group'),
      shape('frm', { [P.clip]: false }, 'p1', 'frame'),
      shape('img', { [P.fills]: [{ paint: { kind: 'image', asset: { asset: 'as_img', at: 'ms_1' }, fit: 'tile' } }] }, 'p1', 'image'),
      shape('cls', { [P.inherit]: { kit: KIT, class: 'card' } }),
    ]);
    const p = resolveElement(f.stage, 'p', f.kit);
    expect(p?.effects).toHaveLength(1);
    expect(p?.fills).toEqual([]);
    expect(p?.strokes).toEqual([]);
    expect(p?.issues.map((i) => i.problem)).toEqual(['unresolved token @nope', 'not a colour: tomato', 'unresolved token @nope']);
    expect(resolveElement(f.stage, 'star', f.kit)?.geometry).toEqual({ kind: 'star', points: 5, ratio: 0.382, radius: 4, inner: 2, smoothing: 0 });
    expect(resolveElement(f.stage, 'poly', f.kit)?.geometry).toMatchObject({ kind: 'polygon', sides: 6 });
    expect(resolveElement(f.stage, 'ell', f.kit)?.geometry).toEqual({ kind: 'ellipse' });
    expect(resolveElement(f.stage, 'line', f.kit)?.geometry).toEqual({ kind: 'line' });
    expect(resolveElement(f.stage, 'vec', f.kit)?.geometry).toEqual({ kind: 'path', d: 'M0 0 L10 0 L10 10 Z', evenOdd: true, radii: [1, 2, 3], smoothing: 0 });
    expect(resolveElement(f.stage, 'grp', f.kit)?.geometry).toEqual({ kind: 'boolean', op: 'subtract' });
    expect(resolveElement(f.stage, 'frm', f.kit)?.geometry).toMatchObject({ kind: 'frame', clip: false });
    expect(resolveElement(f.stage, 'img', f.kit)?.fills[0]?.paint).toEqual({ kind: 'image', asset: 'as_img@ms_1', fit: 'tile' });
    expect(resolveElement(f.stage, 'cls', f.kit)?.fills[0]?.paint).toEqual({ kind: 'solid', color: [255, 92, 57, 255] });
    expect(resolveElement(f.stage, 'missing', f.kit)).toBeUndefined();
  });
});
