// @vitest-environment node
// B1's geometry and B2's text Wasm load from the file system in Node.
import { ok } from '@staticflux/core';
import { createRenderProjector, createSceneStore } from '@staticflux/document/render-projection';
import { describe, expect, it } from 'vitest';
import { commitEdit } from '../elements/actions.js';
import { P } from '../elements/components.js';
import { createElementRenderSource, ElementProjection, type ElementField } from '../elements/projection.js';
import { makeRepeat, newRepeatParams } from '../repeat/actions.js';
import { createTextOps } from '../text/rich-text.js';
import { attachCanvasRender, createCanvasPipes, createElementSceneSide, decodeSceneRecord, encodeSceneRecord } from './canvas-pipeline.js';
import { createElementRenderPort, createRecordingRaster } from './element-port.js';
import { createTextLayer, projectedSceneId } from './text-layer.js';
import { authoringBuilt, createStudioFixture, person, unwrap } from './test-helpers.js';

const rect = (node: string, x: number, y: number) => ({ op: 'create' as const, node, kind: 'shape', parent: 'p1', props: { [P.x]: x, [P.y]: y, [P.w]: 100, [P.h]: 80, [P.fills]: [{ paint: '#ff5c39' }] } });

describe('scene records', () => {
  it('frame resources, assets, the image table, projection, IR and overlay batches in that order and split them back', () => {
    const bytes = (n: number, v: number) => new Uint8Array(n).fill(v);
    const record = encodeSceneRecord({ resources: bytes(3, 1), assets: bytes(2, 2), images: [{ asset: 'as_a', rgba: 7, luma: 8 }], projection: bytes(4, 3), ir: bytes(1, 4), overlay: [bytes(2, 5), bytes(0, 0), bytes(1, 6)] });
    const back = unwrap(decodeSceneRecord(record));
    expect([...back.resources, ...back.assets, ...back.projection, ...back.ir]).toEqual([1, 1, 1, 2, 2, 3, 3, 3, 3, 4]);
    expect(back.overlay.map((b) => [...b])).toEqual([[5, 5], [], [6]]);
    expect(back.images).toEqual([{ asset: 'as_a', rgba: 7, luma: 8 }]);
    expect(unwrap(decodeSceneRecord(encodeSceneRecord({}))).overlay).toEqual([]);
    expect(unwrap(decodeSceneRecord(encodeSceneRecord({}))).projection.length).toBe(0);
    const foreign = decodeSceneRecord(new Uint8Array(40));
    expect(!foreign.ok && foreign.error.code).toBe('IF-INT-002');
    const truncated = decodeSceneRecord(record.subarray(0, record.length - 1));
    expect(!truncated.ok && truncated.error.code).toBe('IF-INT-002');
  });
});

describe('render side', () => {
  it('learns image ids from the records (a snapshot clears them) and queues overlay batches after the IR', () => {
    const side = createElementSceneSide();
    const store = createSceneStore(ElementProjection);
    unwrap(side.adapter.apply(store, encodeSceneRecord({ images: [{ asset: 'as_a', rgba: 3, luma: 4 }], overlay: [new Uint8Array([1])], ir: new Uint8Array([2]) }), 'delta'));
    expect([side.images('as_a', 'rgba'), side.images('as_a', 'luma'), side.images('as_b', 'rgba')]).toEqual([3, 4, undefined]);
    const queued = side.take();
    expect([queued.ir.length, queued.overlay.length, queued.full]).toEqual([1, 1, false]);
    unwrap(side.adapter.apply(store, encodeSceneRecord({}), 'snapshot'));
    expect(side.images('as_a', 'rgba')).toBeUndefined();
    expect(side.take().full).toBe(true);
  });

  it('a publisher publishes only while a page is attached', () => {
    const pipes = unwrap(createCanvasPipes({ medium: 'local' }));
    pipes.publisher.step();
    expect([pipes.publisher.attached, pipes.publisher.records]).toEqual([false, 0]);
    pipes.close();
  });
});

describe.skipIf(!authoringBuilt)('canvas pipeline over the repeat view (A7 ports, B1 source, B7 instances)', () => {
  it('draws committed elements, live repeat instances and text through consistent frames; resources arrive first', async () => {
    const f = await createStudioFixture();
    const { document } = f;
    unwrap(commitEdit(document.target('p1'), person, 'Seed', ok([rect('a', 40, 40), rect('b', 300, 40)])));
    const source = createElementRenderSource({ stage: document.view, geometry: document.geometry, kit: document.kit, root: 'p1' });
    const projector = createRenderProjector(ElementProjection, source);
    const layer = createTextLayer({ document, page: 'p1', fonts: f.fonts, scope: f.scope, sceneParent: projectedSceneId(projector) });
    const sent: Uint8Array[] = [];
    const text = {
      changes: (full: boolean) => {
        const out = layer.changes(full);
        if (out?.ir !== undefined) sent.push(out.ir);
        return out;
      },
    };
    const side = createElementSceneSide();
    const raster = createRecordingRaster();
    const port = createElementRenderPort({ side, raster });
    let camera = { tx: 10, ty: 20, zoom: 0.5 };
    const pipes = unwrap(createCanvasPipes({ medium: 'local' }));
    const render = unwrap(await attachCanvasRender({ pipes: pipes.endpoints, port, side, signal: f.signal }));
    expect(render.state).toBe('running');
    pipes.publisher.attach({ source, projector, ir: text, view: () => ({ camera, selection: ['a'] }) });
    const pipeline = { render: render.render, publish: () => pipes.publisher.step() };
    const drawn = (): number => {
      pipeline.render.update('arrival');
      return port.stats.draws;
    };
    expect(drawn()).toBeGreaterThanOrEqual(1);
    const store = pipeline.render.scene;
    const ids = (): string[] => {
      const out: string[] = [];
      store.forEach((slot) => {
        out.push(store.idOf(slot) as string);
      });
      return out.sort();
    };
    expect(ids()).toEqual(['a', 'b']);
    // The look of every drawn element is on the render side (it travelled ahead of the projection).
    store.forEach((slot) => {
      expect(side.resources.look(store.column('look' satisfies ElementField)[slot] as number)).toBeDefined();
    });
    expect(raster.cameras.at(-1)).toEqual(camera);

    // A live radial repeat: instances are derived in the view and drawn like elements.
    const ctx = document.context();
    unwrap(commitEdit(document.target('p1'), person, 'Radial repeat', makeRepeat(ctx, ['b'], newRepeatParams('radial', { count: 4 }))));
    pipeline.publish();
    drawn();
    expect(ids().filter((id) => id.includes('~')).length).toBeGreaterThanOrEqual(4);
    expect(ids().filter((id) => id.includes('^')).length).toBe(3);

    // Text: glyph runs and the font travel on the IR section.
    unwrap(document.commitOps('p1', person, 'Text', unwrap(createTextOps({ node: 't', parent: 'p1', text: 'Hello', props: { [P.x]: 40, [P.y]: 400, [P.w]: 500, [P.h]: 60 } }))));
    camera = { tx: 0, ty: 0, zoom: 1 };
    pipeline.publish();
    drawn();
    expect(layer.nodes).toEqual(['t']);
    expect(unwrap(layer.layout('t')).runs().length).toBeGreaterThan(0);
    const textIr = sent.at(-1) as Uint8Array;
    expect(textIr.length).toBeGreaterThan(1000); // the font bytes go once, with the glyph run
    expect(raster.batches.some((b) => b.length === textIr.length && b.every((v, i) => v === textIr[i]))).toBe(true);
    expect(raster.cameras.at(-1)).toEqual(camera);
    expect(pipeline.render.stats.payloadErrors).toBe(0);
    expect(pipeline.render.stats.drawFailures).toBe(0);

    render.stop();
    expect(render.state).toBe('stopped');
    expect(raster.disposed).toBe(true);
    pipes.close();
    await f.scope.dispose();
  });
});
