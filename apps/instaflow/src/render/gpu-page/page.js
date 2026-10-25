// Real-WebGPU checks of the Vello render backend (see index.html). Plain ESM over the built dist files;
// every result goes to globalThis.__sfGpuResult. Timings are recorded for the record, never asserted.
import { createGpuDevice, createTiledRenderer, manualTilePrepLane } from '@staticflux/surface/raster';
import { loadRenderModule } from '/apps/instaflow/dist/render/render-module.js';
import { createSceneWriter } from '/apps/instaflow/dist/render/scene-ir.js';
import { createVelloRasterBackend } from '/apps/instaflow/dist/render/vello-backend.js';
import { encodePageImage, publishGpuResult } from '/packages/testkit/dist/gpu-readback.js';
import { rasterBackendContractCases } from '/packages/testkit/dist/raster-backend-contract.js';

const FIXTURES = '/apps/instaflow/engine/crates/render/fixtures/';
const WHITE = [1, 1, 1, 1];
const signal = () => new AbortController().signal;
const images = {};
const data = { contract: [], timings: {}, errors: [] };

const started = performance.now();
const step = (name) => console.log(`[render-gpu] ${(performance.now() - started).toFixed(0)} ms: ${name}`);
const must = (result, what) => {
  if (!result.ok) throw new Error(`${what}: ${result.error.code} ${result.error.message}`);
  return result.value;
};
const keep = (name, image) => (images[name] = encodePageImage(image));
const batch = async (name) => new Uint8Array(await (await fetch(`${FIXTURES}${name}.sfir`)).arrayBuffer());

/** Box operations as scene IR batches (the contract's scene adapter). */
const boxScene = {
  add: (id, r, color) => createSceneWriter().upsert(boxNode(id, r, color)).finish(),
  set: (id, r, color) => createSceneWriter().upsert(boxNode(id, r, color)).finish(),
  remove: (id) => createSceneWriter().remove(id).finish(),
};
function boxNode(id, r, color) {
  return { id, transform: [1, 0, 0, 1, r.x0, r.y0], geometry: { kind: 'rect', w: r.x1 - r.x0, h: r.y1 - r.y0 }, fill: { kind: 'solid', color } };
}

async function headless(wasm, width, height) {
  const backend = createVelloRasterBackend({ wasm, width, height, id: 'vello-headless' });
  must(await backend.attach({ signal: signal() }), 'attach');
  must(backend.resize(width, height), 'resize');
  return backend;
}

/** Render tiles of `level` covering the 256 px view at device offset (ox, oy) and composite them. */
function compositeTiles(backend, level, ox, oy, tiles, layer) {
  const quads = [];
  let slot = 0;
  for (const [tx, ty] of tiles) {
    must(backend.renderTile(slot, { level, tx, ty }, WHITE), `tile ${level}:${tx}:${ty}`);
    quads.push({ source: { kind: 'tile', slot }, dst: [tx * 512 - ox, ty * 512 - oy, (tx + 1) * 512 - ox, (ty + 1) * 512 - oy] });
    slot += 1;
  }
  if (layer !== undefined) quads.push({ source: { kind: 'layer', layer: layer.layer }, dst: [layer.x - ox, layer.y - oy, layer.x - ox + layer.width, layer.y - oy + layer.height] });
  must(backend.composite({ clear: WHITE, quads, present: false }), 'composite');
}

async function run() {
  const wasm = must(await loadRenderModule({ manifestUrl: '/apps/instaflow/engine/dist/sf-wasm-manifest.json' }), 'load render wasm');
  data.abi = wasm.abi_version();
  step('wasm loaded');

  // 1. RasterBackend contract on Vello (headless backends, one device per case).
  for (const testCase of rasterBackendContractCases()) {
    const backend = createVelloRasterBackend({ wasm, width: 128, height: 128, id: 'vello-contract' });
    step(`contract: ${testCase.name}`);
    try {
      await testCase.run({ backend, scene: boxScene, tolerance: 2 });
      data.contract.push({ name: testCase.name, ok: true });
    } catch (e) {
      data.contract.push({ name: testCase.name, ok: false, error: String(e?.message ?? e) });
    } finally {
      backend.dispose();
    }
  }

  // 2. GPU renders of the engine fixtures (compared with vello_cpu references in Node).
  const fixtures = [
    ['shapes', [0, 0, 128, 128], 128],
    ['paints', [0, 0, 128, 128], 128],
    ['layers', [0, 0, 128, 128], 128],
    ['elements', [0, 0, 128, 128], 128],
    ['appearance', [0, 0, 128, 128], 128],
    ['tiles', [384, 384, 640, 640], 256],
  ];
  for (const [name, [x0, y0, x1, y1], size] of fixtures) {
    step(`fixture ${name}`);
    const backend = await headless(wasm, size, size);
    must(backend.apply(await batch(name)), `apply ${name}`);
    keep(`gpu-${name}`, must(await backend.renderRegion({ world: { x0, y0, x1, y1 }, width: size, height: size, background: WHITE }, { signal: signal() }), `region ${name}`));
    backend.dispose();
  }

  // 2b. The element pipeline's scene (B1: stage → render projection → scene IR), vs its vello_cpu reference.
  {
    step('element scene');
    const ELEMENTS = '/apps/instaflow/src/elements/__fixtures__/';
    const load = async (name) => new Uint8Array(await (await fetch(`${ELEMENTS}${name}`)).arrayBuffer());
    const backend = await headless(wasm, 128, 128);
    must(backend.apply(await load('elements-scene.sfir')), 'apply element scene');
    must(backend.apply(await load('elements-images.sfir')), 'apply element images');
    keep('gpu-element-scene', must(await backend.renderRegion({ world: { x0: 0, y0: 0, x1: 128, y1: 128 }, width: 128, height: 128, background: WHITE }, { signal: signal() }), 'region element scene'));
    backend.dispose();
  }

  step('tiled vs region');
  // 3. Tiled vs region (no seams) at zoom 1 and zoom 2, and a lifted layer composited over tiles.
  {
    const backend = await headless(wasm, 256, 256);
    must(backend.apply(await batch('tiles')), 'apply tiles');
    compositeTiles(backend, 0, 384, 384, [[0, 0], [1, 0], [0, 1], [1, 1]]);
    keep('tiled-z1', must(await backend.readFrame({ signal: signal() }), 'read z1'));
    keep('region-z2', must(await backend.renderRegion({ world: { x0: 448, y0: 448, x1: 576, y1: 576 }, width: 256, height: 256, background: WHITE }, { signal: signal() }), 'region z2'));
    compositeTiles(backend, 2, 896, 896, [[1, 1], [2, 1], [1, 2], [2, 2]]);
    keep('tiled-z2', must(await backend.readFrame({ signal: signal() }), 'read z2'));
    must(backend.setLayer(1, [31]), 'lift');
    const layer = must(backend.renderLayer(1, 1), 'render layer');
    compositeTiles(backend, 0, 384, 384, [[0, 0], [1, 0], [0, 1], [1, 1]], layer);
    keep('lifted-z1', must(await backend.readFrame({ signal: signal() }), 'read lifted'));
    backend.dispose();
  }

  step('tiled renderer');
  // 4. Tiled renderer on a real canvas: warm-up, sharp frame, drag through the lifted layer, device loss.
  {
    const canvas = document.getElementById('c').transferControlToOffscreen();
    const backend = createVelloRasterBackend({ wasm, canvas, width: 256, height: 256, id: 'vello-canvas' });
    const device = createGpuDevice({ id: 'vello-canvas', provider: { acquire: (o) => backend.attach(o) } });
    must(await device.attach(), 'device attach');
    const lane = manualTilePrepLane();
    const renderer = must(
      createTiledRenderer({ backend, lane, requestFrame: () => undefined, camera: { x: 384, y: 384, zoom: 1, width: 256, height: 256 }, inFrameBudgetMs: 0, background: WHITE }),
      'renderer',
    );
    must(renderer.resize(256, 256), 'renderer resize');
    must(renderer.apply(await batch('tiles')), 'renderer apply');
    let t = performance.now();
    must(await renderer.warmUp(signal()), 'warm-up');
    data.timings.warmUpMs = performance.now() - t;
    t = performance.now();
    must(renderer.frame(), 'frame 1');
    lane.run();
    const sharp = must(renderer.frame(), 'frame 2');
    data.timings.firstSharpMs = performance.now() - t;
    data.sharp = sharp.sharp;
    keep('renderer-sharp', must(await renderer.captureSnapshot(signal()), 'capture').image);

    const lifted = must(renderer.lift([31]), 'lift');
    must(renderer.frame(), 'lift frame');
    lane.run();
    must(renderer.frame(), 'lift frame 2');
    const before = backend.stats();
    t = performance.now();
    for (let dy = 2; dy <= 20; dy += 2) {
      renderer.drag(lifted.id, 0, dy);
      must(renderer.frame(), `drag ${dy}`);
    }
    data.timings.drag10FramesMs = performance.now() - t;
    data.dragTileBytesUnchanged = backend.stats().tileBytes === before.tileBytes;
    keep('renderer-drag', (await backend.readFrame({ signal: signal() })).value);
    const expected = await headless(wasm, 256, 256);
    must(expected.apply(await batch('tiles')), 'expected apply');
    const n31 = { x0: 392, y0: 602 + 20, x1: 426, y1: 636 + 20 };
    must(expected.apply(boxScene.set(31, n31, [30, 215, 200, 255])), 'expected move');
    keep('expected-drag', must(await expected.renderRegion({ world: { x0: 384, y0: 384, x1: 640, y1: 640 }, width: 256, height: 256, background: WHITE }, { signal: signal() }), 'expected region'));
    expected.dispose();

    step('device loss');
    // Device loss: destroy the device behind the backend's back; the lifecycle re-attaches.
    const recovered = new Promise((resolve) => device.onRecovered(resolve));
    device.onRecovered(() => renderer.deviceRestored());
    renderer.drop(lifted.id);
    device.handle.device.destroy();
    const record = await recovered;
    data.recovery = { ok: record.ok, attempts: record.attempts, ms: record.ms };
    must(renderer.frame(), 'frame after loss');
    lane.run();
    const after = must(renderer.frame(), 'frame after loss 2');
    data.sharpAfterLoss = after.sharp;
    keep('renderer-recovered', must(await renderer.captureSnapshot(signal()), 'capture after loss').image);
    data.presentedState = device.state;
    renderer.dispose();
    device.dispose();
    backend.dispose();
  }
  data.errors = wasm.take_errors();
}

run().then(
  () => publishGpuResult({ ok: true, data, images }),
  (e) => publishGpuResult({ ok: false, error: String(e?.stack ?? e), data, images }),
);
