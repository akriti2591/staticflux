// @vitest-environment node
// B12b P2 (IF-37.27–37.29): text in the element tree. Text used to be drawn as root groups after every element, so it
// painted above all shapes and ignored its parents' opacity, frame clips and masks. Now the projection draws a text
// element as a node of its own and the text layer puts the glyphs under it. One page, drawn three ways from the same
// document: the canvas (the pipeline Studio's canvas runs, into the export Wasm's scene), the SVG and PDF writers
// (the export scene, D21), and the hit test.
import { constants as zlibConstants, inflateSync } from 'node:zlib';
import { createBlobStore, createMemoryObjectStore } from '@staticflux/blob';
import { createScope, err, ok, type Result } from '@staticflux/core';
import { createRenderProjector } from '@staticflux/document/render-projection';
import type { NodeId, PartOp } from '@staticflux/document/v2';
import { describe, expect, it } from 'vitest';
import { commitEdit, reorder } from '../elements/actions.js';
import { P } from '../elements/components.js';
import { createElementRenderSource, ElementProjection } from '../elements/projection.js';
import type { ExporterWasm } from '../export/export-module.js';
import { buildPageScene } from '../export/scene.js';
import { checkerDecoder, exportBuilt, loadExportInNode } from '../export/testing/test-helpers.js';
import { placeTextOps } from '../text/commands.js';
import { createElementIndex, hitTest } from '../tools/hit-test.js';
import { attachCanvasRender, createCanvasPipes, createElementSceneSide } from './canvas-pipeline.js';
import { type CanvasRaster, createElementRenderPort } from './element-port.js';
import { createTextLayer, projectedSceneId } from './text-layer.js';
import { authoringBuilt, createStudioFixture, person, unwrap } from './test-helpers.js';

const WHITE = new Uint8Array([255, 255, 255, 255]);
const rect = (node: NodeId, parent: NodeId, x: number, y: number, color: string, extra: Record<string, unknown> = {}): PartOp =>
  ({ op: 'create', node, kind: 'shape', parent, props: { [P.x]: x, [P.y]: y, [P.w]: 300, [P.h]: 200, [P.fills]: [{ paint: color }], ...extra } }) as PartOp;
const container = (node: NodeId, kind: 'group' | 'frame', x: number, y: number, extra: Record<string, unknown> = {}): PartOp =>
  ({ op: 'create', node, kind, parent: 'p1', props: { [P.x]: x, [P.y]: y, [P.w]: 300, [P.h]: 120, ...extra } }) as PartOp;

/** A canvas raster over the export Wasm's scene: what the render module's scene holds after the canvas's batches. */
function sceneRaster(exporter: ExporterWasm): CanvasRaster {
  return {
    apply(batch): Result<void> {
      try {
        exporter.apply(batch);
        return ok();
      } catch (e) {
        return err({ code: 'TEST', message: String(e) } as never);
      }
    },
    setCamera: () => undefined,
    present: () => ok(),
    dispose: () => undefined,
  };
}

describe.skipIf(!authoringBuilt || !exportBuilt)('text in the element tree (B12b P2)', () => {
  async function page() {
    const f = await createStudioFixture();
    const { document } = f;
    const commit = (label: string, ops: Result<readonly PartOp[]> | readonly PartOp[]): void =>
      unwrap(commitEdit(document.target('p1'), person, label, 'ok' in ops ? (ops as Result<readonly PartOp[]>) : ok(ops as readonly PartOp[])));
    // Paint order: a red rect, the text "Between", a blue rect over both.
    commit('below', [rect('below', 'p1', 100, 100, '#ff0000')]);
    commit('t', placeTextOps({ node: 't', parent: 'p1', x: 120, y: 150, text: 'Between' }));
    // The box an editing session writes back (`textBoxOps`): the hit test reads it.
    commit('t box', [{ op: 'set', node: 't', path: P.w, value: 170 } as PartOp, { op: 'set', node: 't', path: P.h, value: 60 } as PartOp]);
    commit('above', [rect('above', 'p1', 200, 130, '#0000ff')]);
    // A clipping frame, a group at 50 %, a shape mask over text and a text used as a mask.
    commit('frame', [container('fr', 'frame', 100, 500)]);
    commit('tc', placeTextOps({ node: 'tc', parent: 'fr', x: 10, y: 10, text: 'Clipped' }));
    commit('half', [container('half', 'group', 500, 500, { [P.opacity]: 0.5 })]);
    commit('tg', placeTextOps({ node: 'tg', parent: 'half', x: 0, y: 0, text: 'Halved' }));
    commit('mg', [container('mg', 'group', 100, 800), rect('mrect', 'mg', 0, 0, '#000000', { [P.maskMode]: 'clip', [P.w]: 60, [P.h]: 60 })]);
    commit('tm', placeTextOps({ node: 'tm', parent: 'mg', x: 0, y: 0, text: 'Masked' }));
    commit('mg2', [container('mg2', 'group', 500, 800)]);
    commit('tmask', placeTextOps({ node: 'tmask', parent: 'mg2', x: 0, y: 0, text: 'Stencil' }));
    commit('stencil', [{ op: 'set', node: 'tmask', path: P.maskMode, value: 'alpha' } as PartOp, rect('filled', 'mg2', 0, 0, '#00ff00')]);

    const wasm = await loadExportInNode();
    // The canvas: Studio's pipeline (B1 source with the page fill, the projector, the text layer under its nodes).
    const part = document.part('p1')!;
    const source = createElementRenderSource({ stage: document.view, geometry: document.geometry, kit: document.kit, root: 'p1', orderOf: (id) => part.node(id)?.order, pageFill: true });
    const projector = createRenderProjector(ElementProjection, source);
    const text = createTextLayer({ document, page: 'p1', fonts: f.fonts, scope: f.scope, sceneParent: projectedSceneId(projector) });
    const canvasScene = new wasm.Exporter();
    const side = createElementSceneSide();
    const port = createElementRenderPort({ side, raster: sceneRaster(canvasScene) });
    const pipes = unwrap(createCanvasPipes({ medium: 'local' }));
    const render = unwrap(await attachCanvasRender({ pipes: pipes.endpoints, port, side, signal: f.signal }));
    pipes.publisher.attach({ source, projector, ir: text, view: () => ({ camera: { tx: 0, ty: 0, zoom: 1 }, selection: [] }) });
    const draw = (): void => {
      pipes.publisher.step();
      render.render.update('arrival');
      expect(render.render.stats.drawFailures).toBe(0);
    };
    draw();
    const canvasSvg = (): string => canvasScene.svg(0, 0, 1080, 1350, 1080, 1350, WHITE, 'page');
    // The exports: the export scene of the same page, through the SVG and PDF writers.
    const exported = async (): Promise<{ readonly svg: string; readonly pdf: Uint8Array }> => {
      const scope = createScope();
      const scene = unwrap(await buildPageScene({ document, page: 'p1', fonts: f.fonts, images: () => undefined, blobs: createBlobStore(createMemoryObjectStore()), decoder: checkerDecoder, signal: f.signal, scope }));
      const x = new wasm.Exporter();
      for (const b of scene.batches) x.apply(b);
      const svg = x.svg(0, 0, 1080, 1350, 1080, 1350, WHITE, 'page');
      x.pdf_page(0, 0, 1080, 1350, 1080, 1350, WHITE);
      const pdf = x.pdf_finish('page');
      x.free();
      await scope.dispose();
      return { svg, pdf };
    };
    const ctx = { stage: document.view, geometry: document.geometry, kit: document.kit };
    const index = createElementIndex(ctx, 'p1', f.scope);
    const hit = (x: number, y: number): NodeId | undefined => unwrap(hitTest(ctx, index, x, y)).target;
    const dispose = async (): Promise<void> => {
      render.stop();
      pipes.close();
      canvasScene.free();
      await f.scope.dispose();
    };
    /** Publish a record without drawing (the render side coalesces records until its next frame). */
    const step = (): void => pipes.publisher.step();
    return { f, document, commit, step, draw, canvasSvg, exported, hit, dispose };
  }

  it('the canvas and the SVG draw text in tree order, inside its frame’s clip, its group’s opacity and its masks (D21)', { timeout: 60_000 }, async () => {
    const p = await page();
    const { svg } = await p.exported();
    expect(p.canvasSvg()).toBe(svg); // the canvas's scene is the export's
    const at = (s: string): number => svg.indexOf(s);
    expect(at('fill="#ff0000"')).toBeLessThan(at('aria-label="Between"'));
    expect(at('aria-label="Between"')).toBeLessThan(at('fill="#0000ff"')); // under the blue rect, not above it
    expect(openAt(svg, /<g[^>]*clip-path="url\(#[^)]*\)"[^>]*>/, 'aria-label="Clipped"')).toBe(true);
    expect(openAt(svg, /<g[^>]*opacity="0\.5"[^>]*>/, 'aria-label="Halved"')).toBe(true);
    expect(openAt(svg, /<g[^>]*mask="url\(#[^)]*\)"[^>]*>/, 'aria-label="Masked"')).toBe(true); // masked by the rect
    expect(openAt(svg, /<mask[^>]*>/, 'aria-label="Stencil"', 'mask')).toBe(true); // the text is the mask
    expect(openAt(svg, /<g[^>]*mask="url\(#[^)]*\)"[^>]*>/, 'fill="#00ff00"')).toBe(true); // … of the green rect
    await p.dispose();
  });

  it('the PDF draws the same tree: text between the rects, clipped, in the group’s 50 % layer, masked', { timeout: 60_000 }, async () => {
    const p = await page();
    const streams = contentStreams((await p.exported()).pdf);
    const main = streams.find((s) => s.includes('0 0 1080 1350 re')) ?? '';
    const at = (s: string): number => main.indexOf(s);
    expect(at('1 0 0 rg')).toBeLessThan(at('(Between)'));
    expect(at('(Between)')).toBeLessThan(at('0 0 1 rg'));
    // Clipped: inside the frame's clip (`W n`), before that save is restored.
    const clip = main.lastIndexOf('W\nn', at('(Clipped)'));
    expect(clip).toBeGreaterThan(0);
    expect(depth(main.slice(clip, at('(Clipped)')))).toBeGreaterThan(0);
    // Halved and Masked: in transparency groups (form XObjects drawn with the group's alpha or a soft mask), not on the page.
    for (const label of ['(Halved)', '(Masked)', '(Stencil)']) {
      expect(main.includes(label)).toBe(false);
      expect(streams.some((s) => s.includes(label))).toBe(true);
    }
    await p.dispose();
  });

  it('reorders (B12 Bring to front, Send to back) move text on the canvas, in the export and in the hit test alike', { timeout: 60_000 }, async () => {
    const p = await page();
    const order = (svg: string): number[] => ['fill="#ff0000"', 'aria-label="Between"', 'fill="#0000ff"'].map((s) => svg.indexOf(s));
    const sorted = (svg: string): string[] => ['red', 'text', 'blue'].map((n, i) => [n, order(svg)[i] as number] as const).sort((a, b) => a[1] - b[1]).map(([n]) => n);
    expect(sorted(p.canvasSvg())).toEqual(['red', 'text', 'blue']);
    expect([p.hit(250, 170), p.hit(150, 170)]).toEqual(['above', 't']); // the blue rect covers the text at 250
    p.commit('Bring to front', reorder(p.document.context(), ['t'], 'front'));
    p.draw();
    let svg = (await p.exported()).svg;
    expect(p.canvasSvg()).toBe(svg);
    expect(sorted(svg)).toEqual(['red', 'blue', 'text']);
    expect([p.hit(250, 170), p.hit(150, 170)]).toEqual(['t', 't']);
    p.commit('Send to back', reorder(p.document.context(), ['t'], 'back'));
    p.draw();
    svg = (await p.exported()).svg;
    expect(p.canvasSvg()).toBe(svg);
    expect(sorted(svg)).toEqual(['text', 'red', 'blue']);
    expect([p.hit(250, 170), p.hit(150, 170)]).toEqual(['above', 'below']);
    await p.dispose();
  });

  it('hidden text leaves the canvas and the export, and comes back under its element’s new node when shown', { timeout: 60_000 }, async () => {
    const p = await page();
    p.commit('Hide', [{ op: 'set', node: 't', path: P.hidden, value: true } as PartOp]);
    p.draw();
    expect(p.canvasSvg()).not.toContain('aria-label="Between"');
    expect(p.canvasSvg()).toBe((await p.exported()).svg);
    p.commit('Show', [{ op: 'set', node: 't', path: P.hidden, value: null } as PartOp]);
    p.draw();
    const { svg } = await p.exported();
    expect(p.canvasSvg()).toBe(svg);
    expect(svg.indexOf('aria-label="Between"')).toBeLessThan(svg.indexOf('fill="#0000ff"'));
    await p.dispose();
  });

  it('text created, edited and deleted between two frames draws nothing and fails nothing (its glyphs named a gone parent)', { timeout: 60_000 }, async () => {
    const p = await page();
    p.commit('Add', placeTextOps({ node: 'tmp', parent: 'p1', x: 700, y: 100, text: 'Temp' }));
    p.step();
    p.commit('Move', [{ op: 'set', node: 'tmp', path: P.x, value: 720 } as PartOp]);
    p.step();
    p.commit('Delete', [{ op: 'delete', node: 'tmp' } as PartOp]);
    p.draw(); // one frame over all three records
    expect(p.canvasSvg()).not.toContain('Temp');
    expect(p.canvasSvg()).toBe((await p.exported()).svg);
    await p.dispose();
  });
});

/** True when the last `open` tag before `label` is still open there (`<g>` nesting; `tag` names the element kind). */
function openAt(svg: string, open: RegExp, label: string, tag = 'g'): boolean {
  const end = svg.indexOf(label);
  if (end < 0) return false;
  const opens = [...svg.slice(0, end).matchAll(new RegExp(open.source, 'g'))];
  const last = opens.at(-1);
  if (last === undefined) return false;
  const between = svg.slice((last.index ?? 0) + last[0].length, end);
  const count = (re: RegExp): number => between.match(re)?.length ?? 0;
  return count(new RegExp(`<${tag}[\\s>]`, 'g')) >= count(new RegExp(`</${tag}>`, 'g'));
}

/** `q` saves minus `Q` restores in a content stream slice. */
const depth = (ops: string): number => (ops.match(/^q$/gm)?.length ?? 0) - (ops.match(/^Q$/gm)?.length ?? 0);

/** Every Flate stream of a PDF, inflated (content streams and form XObjects). */
function contentStreams(pdf: Uint8Array): string[] {
  const text = Buffer.from(pdf).toString('latin1');
  const out: string[] = [];
  let at = text.indexOf('stream\n');
  while (at >= 0) {
    const end = text.indexOf('endstream', at);
    if (end < 0) break;
    try {
      out.push(inflateSync(pdf.subarray(at + 7, end), { finishFlush: zlibConstants.Z_SYNC_FLUSH }).toString('latin1'));
    } catch {
      // not deflated: not a content stream
    }
    at = text.indexOf('stream\n', end + 'endstream'.length);
  }
  return out;
}
