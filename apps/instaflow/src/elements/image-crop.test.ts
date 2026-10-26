// @vitest-environment node
// B12 A-3 (IF-37.10–37.11): image fill crop (offset, scale, rotation) in the model, resolve, scene encoder and actions.
import { ok } from '@staticflux/core';
import { createRenderProjector, createSceneStore } from '@staticflux/document/render-projection';
import { describe, expect, it } from 'vitest';
import { commitEdit, cropImage, imageFillIndex } from './actions.js';
import { type ElementEditEnv, runElementAction, selectionFacts } from './capabilities.js';
import { P } from './components.js';
import { createElementRenderSource, ElementProjection } from './projection.js';
import { cropOf, resolveElement } from './resolve.js';
import { createElementSceneEncoder, createSceneResources } from './scene.js';
import { authoringBuilt, createFixture, human, loadGeometry, PAGE, shape, unwrap } from './testing/fixtures.js';
import { isPaintValue } from './values.js';

const photo = (extra: Record<string, unknown> = {}) => ({ kind: 'image', asset: { asset: 'as_photo' }, fit: 'cover', ...extra });

describe('image paint crop values (no Wasm)', () => {
  it('validates offset, scale and rotation; resolves the default as no crop', () => {
    expect(isPaintValue(photo({ offset: [0, 1], scale: 2, rotation: 90 }))).toBe(true);
    expect(isPaintValue(photo({ offset: [1.5, 0] }))).toBe(false);
    expect(isPaintValue(photo({ scale: 0 }))).toBe(false);
    expect(isPaintValue(photo({ rotation: 45 }))).toBe(false);
    expect(cropOf(photo() as never)).toBeUndefined();
    expect(cropOf(photo({ offset: [0.5, 0.5], scale: 1, rotation: 0 }) as never)).toBeUndefined();
    expect(cropOf(photo({ offset: [0, 1], scale: 2, rotation: 270 }) as never)).toEqual({ x: 0, y: 1, scale: 2, quarter: 3 });
  });
});

describe.skipIf(!authoringBuilt)('image crop through the stage, the projection and the capability', () => {
  it('writes a crop on the top image fill as one step, encodes it as an IMAGE_CROP paint and resets it', async () => {
    const g = await loadGeometry();
    const f = await createFixture([
      shape('img', { [P.x]: 0, [P.y]: 0, [P.w]: 40, [P.h]: 20, [P.fills]: [{ paint: '#000' }, { paint: photo(), opacity: 0.8 }] }, 'p1', 'image'),
      shape('plain', { [P.w]: 10, [P.h]: 10, [P.fills]: [{ paint: '#f00' }] }),
    ]);
    const ctx = f.ctx(g);
    expect(imageFillIndex(ctx, 'img')).toBe(1);
    expect(imageFillIndex(ctx, 'plain')).toBeUndefined();
    unwrap(commitEdit({ undo: f.undo, stage: f.stage, part: PAGE }, human, 'Crop', cropImage(ctx, ['img'], { offset: [0, 0], scale: 1.5, rotation: 90 })));
    const fills = f.stage.value('img', P.fills) as { paint: Record<string, unknown>; opacity?: number }[];
    expect(fills[1]).toEqual({ paint: photo({ offset: [0, 0], scale: 1.5, rotation: 90 }), opacity: 0.8 });
    const paint = resolveElement(f.stage, 'img', f.kit)?.fills[1]?.paint;
    expect(paint).toMatchObject({ kind: 'image', crop: { x: 0, y: 0, scale: 1.5, quarter: 1 } });

    // The scene encoder writes the crop (the render and export Wasm draw it: `crops` fixture, draw.rs tests).
    const source = createElementRenderSource({ stage: f.stage, geometry: g, kit: f.kit, root: 'p1' });
    const projector = createRenderProjector(ElementProjection, source);
    const store = createSceneStore(ElementProjection);
    const resources = createSceneResources();
    store.apply(projector.snapshot());
    resources.apply(source.takeResources() as Uint8Array);
    const ir = createElementSceneEncoder({ images: () => 3 }).encode(store, resources, { full: true }) as Uint8Array;
    expect([...ir].some((_, i) => ir[i] === 6 && ir[i + 1] === 3 && ir[i + 5] === 1)).toBe(true); // IMAGE_CROP image 3 cover
    source.dispose();

    // Partial edits keep the other fields; null resets to the plain fit.
    f.seed(unwrap(cropImage(ctx, ['img'], { scale: 3 })));
    expect((f.stage.value('img', P.fills) as { paint: Record<string, unknown> }[])[1]?.paint).toEqual(photo({ offset: [0, 0], scale: 3, rotation: 90 }));
    f.seed(unwrap(cropImage(ctx, ['img'], null)));
    expect((f.stage.value('img', P.fills) as { paint: Record<string, unknown> }[])[1]?.paint).toEqual(photo());
    expect(cropImage(ctx, ['plain'], { scale: 2 }).ok).toBe(false);
    const invalid = commitEdit({ undo: f.undo, stage: f.stage, part: PAGE }, human, 'Crop', cropImage(ctx, ['img'], { scale: 1000 }));
    expect(!invalid.ok && invalid.error.code).toBe('IF-EL-001');

    const env: ElementEditEnv = { context: () => ctx, target: () => ({ undo: f.undo, stage: f.stage, part: PAGE }), actorFor: () => ok(human) };
    expect(selectionFacts(ctx, ['img', 'plain']).images).toBe(1);
    expect(unwrap(runElementAction(env, 'image-crop', { nodes: ['img'], crop: { x: 1, y: 0.25, rotation: 180 } }, human))).toEqual({ ops: 1 });
    expect(resolveElement(f.stage, 'img', f.kit)?.fills[1]?.paint).toMatchObject({ crop: { x: 1, y: 0.25, scale: 1, quarter: 2 } });
    expect(unwrap(runElementAction(env, 'image-crop-reset', { nodes: ['img'] }, human))).toEqual({ ops: 1 });
    expect(runElementAction(env, 'image-crop', { nodes: ['plain'], crop: { scale: 2 } }, human).ok).toBe(false);
  });
});
