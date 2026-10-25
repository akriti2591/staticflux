/**
 * `RasterBackend` contract (`@staticflux/surface/raster`, IF-7.4, R11.43). Every raster backend
 * (the reference CPU backend in Node, Vello GPU in Chromium) must pass it: dirty rects for every
 * change, tiles that compose to the same pixels as a direct region render, lifted nodes leaving the
 * tiles, cancellation and size limits, a scene that survives a device re-attach (the retained
 * CPU-side IR, IF-7.11), and typed errors instead of throws.
 *
 * The scene format belongs to the backend, so the fixture translates three box operations into the
 * backend's deltas. Boxes are opaque, axis-aligned and placed on whole world units; `tolerance` is
 * the max channel delta an anti-aliasing backend may show at box edges (default 2).
 *
 * @example
 * runRasterBackendContract('memory', async () => ({ backend: createMemoryRasterBackend(), scene: memoryBoxScene }), { describe, it });
 */
import type { Result } from '@staticflux/core';
import type { RasterBackend, RasterImage, TileKey, WorldRect } from '@staticflux/surface/raster';
import { diffImages } from './compare.js';
import { assertEqual, assertTrue, type ContractRunner, errOf, okValue, within } from './contract-runner.js';

export type ContractColor = readonly [number, number, number, number];

export interface RasterContractScene<Delta> {
  /** Add a box (drawn above earlier boxes). */
  add(id: number, rect: WorldRect, color: ContractColor): Delta;
  /** Move or recolor a box. */
  set(id: number, rect: WorldRect, color: ContractColor): Delta;
  remove(id: number): Delta;
}

export interface RasterContractFixture<Delta> {
  readonly backend: RasterBackend<Delta>;
  readonly scene: RasterContractScene<Delta>;
  /** Node id that `setLayer` takes for a box id (default: the same number). */
  readonly nodeOf?: (box: number) => number;
  /** Max channel delta allowed against exact box coverage (anti-aliasing). Default 2. */
  readonly tolerance?: number;
  /** Called after each case. */
  readonly cleanup?: () => void | Promise<void>;
}

export interface RasterContractCase<Delta> {
  readonly name: string;
  run(fixture: RasterContractFixture<Delta>): Promise<void>;
}

const VIEW = 128;
const WHITE: readonly [number, number, number, number] = [1, 1, 1, 1];
const RED: ContractColor = [255, 0, 0, 255];
const BLUE: ContractColor = [0, 0, 255, 255];
const signal = (): AbortSignal => new AbortController().signal;

function pixel(image: RasterImage, x: number, y: number): number[] {
  const i = (y * image.width + x) * 4;
  return [...image.data.subarray(i, i + 4)];
}

function near(actual: readonly number[], expected: readonly number[], tolerance: number): boolean {
  return actual.length === expected.length && actual.every((v, i) => Math.abs(v - expected[i]!) <= tolerance);
}

function assertPixel(image: RasterImage, x: number, y: number, expected: ContractColor, tolerance: number, message: string): void {
  const actual = pixel(image, x, y);
  assertTrue(near(actual, expected, tolerance), `${message}: pixel (${x}, ${y}) is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)} ±${tolerance}`);
}

function covers(rects: readonly WorldRect[], target: WorldRect): boolean {
  return rects.some((r) => r.x0 <= target.x0 + 1e-6 && r.y0 <= target.y0 + 1e-6 && r.x1 >= target.x1 - 1e-6 && r.y1 >= target.y1 - 1e-6);
}

async function attach<Delta>(backend: RasterBackend<Delta>): Promise<void> {
  okValue(await within(backend.attach({ signal: signal() }), 30_000, 'attach'), 'attach');
  okValue(backend.resize(VIEW, VIEW), 'resize');
}

/** Render every tile covering the 128 px view at level 0 and composite them. */
function compositeTiles<Delta>(backend: RasterBackend<Delta>, firstSlot = 0): number[] {
  const size = backend.tileSize;
  const n = Math.ceil(VIEW / size);
  const slots: number[] = [];
  const quads = [];
  let slot = firstSlot;
  for (let ty = 0; ty < n; ty++) {
    for (let tx = 0; tx < n; tx++) {
      const key: TileKey = { level: 0, tx, ty };
      okValue(backend.renderTile(slot, key, WHITE), `renderTile ${tx},${ty}`);
      quads.push({ source: { kind: 'tile' as const, slot }, dst: [tx * size, ty * size, (tx + 1) * size, (ty + 1) * size] as const });
      slots.push(slot);
      slot += 1;
    }
  }
  okValue(backend.composite({ clear: WHITE, quads, present: false }), 'composite');
  return slots;
}

async function frame<Delta>(backend: RasterBackend<Delta>): Promise<RasterImage> {
  const image = okValue(await within(backend.readFrame({ signal: signal() }), 30_000, 'readFrame'), 'readFrame');
  assertEqual([image.width, image.height, image.data.length], [VIEW, VIEW, VIEW * VIEW * 4], 'frame size');
  return image;
}

async function region<Delta>(backend: RasterBackend<Delta>): Promise<RasterImage> {
  return okValue(
    await within(backend.renderRegion({ world: { x0: 0, y0: 0, x1: VIEW, y1: VIEW }, width: VIEW, height: VIEW, background: WHITE }, { signal: signal() }), 30_000, 'renderRegion'),
    'renderRegion',
  );
}

export function rasterBackendContractCases<Delta>(): readonly RasterContractCase<Delta>[] {
  return [
    {
      name: 'attach returns GPU facts and a device that reports loss',
      async run({ backend }) {
        const handle = okValue(await within(backend.attach({ signal: signal() }), 30_000, 'attach'), 'attach');
        assertEqual(handle.facts.adapter.status, 'available', 'adapter status');
        assertTrue(typeof handle.facts.limits === 'object', 'device limits');
        assertTrue(backend.tileSize > 0 && backend.maxRegionSize >= VIEW, 'tile size and region limit');
        const lost = within(handle.lost, 30_000, 'lost after destroy');
        handle.destroy();
        assertEqual((await lost).reason, 'destroyed', 'destroy() settles lost with reason destroyed');
      },
    },
    {
      name: 'apply reports dirty rects for add, move (old and new) and remove; bounds follow the scene',
      async run({ backend, scene }) {
        await attach(backend);
        const a = { x0: 10, y0: 10, x1: 40, y1: 30 };
        const b = { x0: 60, y0: 70, x1: 90, y1: 100 };
        const added = okValue(backend.apply(scene.add(1, a, RED)), 'add');
        assertTrue(covers(added, a), `add covers the box: ${JSON.stringify(added)}`);
        const moved = okValue(backend.apply(scene.set(1, b, RED)), 'move');
        assertTrue(covers(moved, a) && covers(moved, b), `move covers old and new: ${JSON.stringify(moved)}`);
        const bounds = backend.bounds();
        assertTrue(bounds !== undefined && bounds.x0 <= b.x0 && bounds.x1 >= b.x1, 'bounds cover the scene');
        const removed = okValue(backend.apply(scene.remove(1)), 'remove');
        assertTrue(covers(removed, b), `remove covers the box: ${JSON.stringify(removed)}`);
      },
    },
    {
      name: 'tiles composite to the scene and match a direct region render',
      async run({ backend, scene, tolerance = 2 }) {
        await attach(backend);
        backend.apply(scene.add(1, { x0: 8, y0: 8, x1: 72, y1: 56 }, RED));
        backend.apply(scene.add(2, { x0: 40, y0: 40, x1: 120, y1: 120 }, BLUE));
        compositeTiles(backend);
        const tiled = await frame(backend);
        assertPixel(tiled, 20, 20, RED, tolerance, 'red box');
        assertPixel(tiled, 100, 100, BLUE, tolerance, 'blue box on top');
        assertPixel(tiled, 60, 50, BLUE, tolerance, 'overlap shows the later box');
        assertPixel(tiled, 4, 120, [255, 255, 255, 255], tolerance, 'background');
        const direct = await region(backend);
        const diff = okValue(diffImages(tiled, direct, { tolerance }), 'diff');
        assertTrue(diff.maxChannelDelta <= tolerance, `tiled vs region: max channel delta ${diff.maxChannelDelta} at ${JSON.stringify(diff.maxDeltaAt)}`);
      },
    },
    {
      name: 'lifted nodes leave the tiles and render in their layer; setLayer([]) gives them back',
      async run({ backend, scene, nodeOf = (n) => n, tolerance = 2 }) {
        await attach(backend);
        const rect = { x0: 16, y0: 16, x1: 48, y1: 48 };
        backend.apply(scene.add(1, rect, RED));
        const rects = okValue(backend.setLayer(7, [nodeOf(1)]), 'setLayer');
        assertTrue(covers(rects, rect), 'lift invalidates the node');
        compositeTiles(backend);
        assertPixel(await frame(backend), 32, 32, [255, 255, 255, 255], tolerance, 'lifted node is not in the tiles');
        const layer = okValue(backend.renderLayer(7, 1), 'renderLayer');
        assertTrue(layer.width >= 32 && layer.height >= 32 && layer.bytes > 0, `layer covers the node: ${JSON.stringify(layer)}`);
        okValue(
          backend.composite({ clear: WHITE, quads: [{ source: { kind: 'layer', layer: 7 }, dst: [layer.x + 20, layer.y, layer.x + 20 + layer.width, layer.y + layer.height] }], present: false }),
          'composite layer',
        );
        const dragged = await frame(backend);
        assertPixel(dragged, 52, 32, RED, tolerance, 'layer drawn at the drag offset');
        assertPixel(dragged, 20, 32, [255, 255, 255, 255], tolerance, 'nothing left behind');
        const back = okValue(backend.setLayer(7, []), 'unlift');
        assertTrue(covers(back, rect), 'unlift invalidates the node');
        compositeTiles(backend, 100);
        assertPixel(await frame(backend), 32, 32, RED, tolerance, 'node back in the tiles');
        backend.releaseLayer(7);
        backend.releaseLayer(7); // idempotent
        assertEqual(errOf(backend.renderLayer(7, 1), 'renderLayer after release').code, 'SF-SURF-014', 'released layer is unknown');
      },
    },
    {
      name: 'renderRegion honours abort and the size limit',
      async run({ backend }) {
        await attach(backend);
        const controller = new AbortController();
        controller.abort();
        const aborted = await backend.renderRegion({ world: { x0: 0, y0: 0, x1: 1, y1: 1 }, width: 4, height: 4 }, { signal: controller.signal });
        assertEqual(errOf(aborted, 'aborted region').kind, 'aborted', 'aborted kind');
        const tooBig = await backend.renderRegion({ world: { x0: 0, y0: 0, x1: 1, y1: 1 }, width: backend.maxRegionSize + 1, height: 1 }, { signal: signal() });
        errOf(tooBig, 'region over maxRegionSize');
        const aborted2 = await backend.readFrame({ signal: controller.signal });
        errOf(aborted2, 'aborted readFrame');
      },
    },
    {
      name: 'composite rejects unknown tile slots and layers with typed errors',
      async run({ backend }) {
        await attach(backend);
        const unknownTile = backend.composite({ clear: WHITE, quads: [{ source: { kind: 'tile', slot: 4242 }, dst: [0, 0, 10, 10] }], present: false });
        assertEqual(errOf(unknownTile, 'unknown slot').code, 'SF-SURF-014', 'unknown slot code');
        const unknownLayer = backend.composite({ clear: WHITE, quads: [{ source: { kind: 'layer', layer: 4242 }, dst: [0, 0, 10, 10] }], present: false });
        assertEqual(errOf(unknownLayer, 'unknown layer').code, 'SF-SURF-014', 'unknown layer code');
      },
    },
    {
      name: 'tile bytes are accounted and released',
      async run({ backend, scene }) {
        await attach(backend);
        backend.apply(scene.add(1, { x0: 0, y0: 0, x1: 10, y1: 10 }, RED));
        const before = backend.stats();
        const rendered = okValue(backend.renderTile(3, { level: 0, tx: 0, ty: 0 }, WHITE), 'renderTile');
        assertTrue(rendered.bytes >= backend.tileSize * backend.tileSize * 4, `tile bytes ${rendered.bytes}`);
        const during = backend.stats();
        assertEqual(during.tiles, before.tiles + 1, 'one more tile');
        backend.releaseTile(3);
        backend.releaseTile(3);
        assertEqual(backend.stats().tiles, before.tiles, 'tile released');
      },
    },
    {
      name: 'the scene survives a device re-attach (retained CPU-side IR)',
      async run({ backend, scene, tolerance = 2 }) {
        await attach(backend);
        backend.apply(scene.add(1, { x0: 8, y0: 8, x1: 72, y1: 56 }, RED));
        const handle = okValue(await within(backend.attach({ signal: signal() }), 30_000, 're-attach'), 're-attach');
        okValue(backend.resize(VIEW, VIEW), 'resize after re-attach');
        compositeTiles(backend);
        assertPixel(await frame(backend), 20, 20, RED, tolerance, 'scene rendered after re-attach');
        assertTrue(handle.facts.adapter.status === 'available', 'facts after re-attach');
      },
    },
    {
      name: 'warmUp resolves; snapshots upload and composite',
      async run({ backend, tolerance = 2 }) {
        await attach(backend);
        okValue(await within(backend.warmUp({ signal: signal() }), 30_000, 'warmUp'), 'warmUp');
        const data = new Uint8Array(4 * 4 * 4);
        for (let i = 0; i < data.length; i += 4) data.set([0, 200, 0, 255], i);
        okValue(backend.uploadSnapshot({ width: 4, height: 4, data }), 'uploadSnapshot');
        okValue(backend.composite({ clear: WHITE, quads: [{ source: { kind: 'snapshot' }, dst: [0, 0, VIEW, VIEW] }], present: false }), 'composite snapshot');
        assertPixel(await frame(backend), 64, 64, [0, 200, 0, 255], tolerance, 'snapshot drawn');
      },
    },
    {
      name: 'dispose is idempotent and later calls fail with typed errors',
      async run({ backend, scene }) {
        await attach(backend);
        backend.dispose();
        backend.dispose();
        const result: Result<unknown> = backend.apply(scene.add(1, { x0: 0, y0: 0, x1: 1, y1: 1 }, RED));
        assertEqual(errOf(result, 'apply after dispose').code, 'SF-SURF-014', 'apply after dispose');
        errOf(backend.renderTile(0, { level: 0, tx: 0, ty: 0 }, WHITE), 'renderTile after dispose');
        errOf(await backend.attach({ signal: signal() }), 'attach after dispose');
      },
    },
  ];
}

export interface RasterContractOptions {
  readonly skip?: readonly string[];
}

/** Register the suite with a test runner. */
export function runRasterBackendContract<Delta>(
  name: string,
  factory: () => RasterContractFixture<Delta> | Promise<RasterContractFixture<Delta>>,
  runner: ContractRunner,
  options: RasterContractOptions = {},
): void {
  runner.describe(`RasterBackend contract: ${name}`, () => {
    for (const testCase of rasterBackendContractCases<Delta>()) {
      if (options.skip?.includes(testCase.name)) continue;
      runner.it(testCase.name, async () => {
        const fixture = await factory();
        try {
          await testCase.run(fixture);
        } finally {
          await fixture.cleanup?.();
          fixture.backend.dispose();
        }
      });
    }
  });
}
