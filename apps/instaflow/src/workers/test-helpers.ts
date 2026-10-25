/**
 * Test-only fixtures for Studio's workers (never imported by app code): the editor's environment from the Node Wasm
 * fixtures (B1 geometry, B2 text, the test fonts), a recording raster for the render role, in-process "workers" over
 * in-memory port pairs (the same host code the browser runs), and a writer that pushes compact input events into the
 * editor's ring as the input forwarder would.
 */
import { ok, type Result } from '@staticflux/core';
import { createLoroEngine } from '@staticflux/document/loro-crdt';
import { type CompactInputEvent, InputCode } from '@staticflux/surface';
import { encodeInputRecord, type InputRecordFields } from '@staticflux/surface/input-ring';
import { inMemorySpawner, type Spawner } from '@staticflux/worker';
import type { RecordRingWriter } from '@staticflux/worker/pipeline';
import { createRecordingRaster, type RecordingRaster } from '../app/element-port.js';
import { createStudioFonts } from '../app/fonts.js';
import { loadGeometry } from '../elements/testing/fixtures.js';
import type { ImageDecoder } from '../library/renditions.js';
import { TEXT_MARK_EXPAND } from '../text/model.js';
import { loadAuthoringInNode, testFont } from '../text/test-helpers.js';
import type { EditorEnv } from './editor-module.js';
import { hostStudioWorker, type StudioWorkerEnvironment, type StudioWorkerHost } from './host.js';

/** A decoder that returns a 40 × 20 grey image (Place tests). */
export const fakeDecoder: ImageDecoder = { decode: async () => ok({ width: 40, height: 20, data: new Uint8Array(40 * 20 * 4).fill(200) }) };

/** The editor's environment over the Node fixtures (needs the built authoring Wasm). */
export async function nodeEditorEnv(): Promise<Result<EditorEnv>> {
  const fonts = createStudioFonts({ wasm: await loadAuthoringInNode('base'), fonts: [testFont('NotoSans-Latin.wght.ttf'), testFont('NotoSansArabic.wght.ttf')] });
  if (!fonts.ok) return fonts;
  return ok({ engine: createLoroEngine({ marks: TEXT_MARK_EXPAND }), geometry: await loadGeometry(), fonts: fonts.value, decoder: fakeDecoder });
}

export interface InProcessWorkers {
  /** The spawner for `bootStudioWorkers` / `createStudioApp`. */
  readonly spawn: () => Spawner;
  /** Every host spawned so far (one per worker of the plan). */
  readonly hosts: StudioWorkerHost[];
  /** The rasters the render role made. */
  readonly rasters: RecordingRaster[];
  /** Run the render module of every host (no worker rAF in Node: tests drive it). */
  draw(): void;
}

/** In-process workers: `hostStudioWorker` on in-memory ports, Node fixtures, recording rasters, manual drawing. */
export function inProcessWorkers(overrides: Partial<StudioWorkerEnvironment> = {}): InProcessWorkers {
  const hosts: StudioWorkerHost[] = [];
  const rasters: RecordingRaster[] = [];
  const env: StudioWorkerEnvironment = {
    editor: () => nodeEditorEnv(),
    raster: async () => {
      const raster = createRecordingRaster();
      rasters.push(raster);
      return ok(raster);
    },
    frame: (fn) => queueMicrotask(fn),
    ...overrides,
  };
  return {
    spawn: () => inMemorySpawner((port) => void hosts.push(hostStudioWorker({ port, env })), { clone: false }),
    hosts,
    rasters,
    draw() {
      for (const host of hosts) host.render?.render.update('arrival');
    },
  };
}

/** Push compact input events into the editor's ring as one forwarder batch. */
export function inputWriter(ring: RecordRingWriter<InputRecordFields>): (events: readonly Partial<CompactInputEvent>[]) => void {
  let batch = 0;
  let ts = 1_000;
  return (events) => {
    batch += 1;
    for (const event of events) {
      ts += 20;
      const full = { t: InputCode.pointerMove, ts, x: 0, y: 0, b: 0, m: 0, ...event } as CompactInputEvent;
      const pushed = ring.push((record) => encodeInputRecord(record, full, batch));
      if (!pushed.ok) throw new Error(pushed.error.message);
    }
    ring.flush();
  };
}

/** Pointer events of a drag from `a` to `b` (screen px), primary button. */
export function dragEvents(a: readonly [number, number], b: readonly [number, number], m = 0): Partial<CompactInputEvent>[] {
  return [
    { t: InputCode.pointerDown, x: a[0], y: a[1], b: 1, m, p: 1 },
    { t: InputCode.pointerMove, x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, b: 1, m, p: 1 },
    { t: InputCode.pointerMove, x: b[0], y: b[1], b: 1, m, p: 1 },
    { t: InputCode.pointerUp, x: b[0], y: b[1], b: 0, m, p: 1 },
  ];
}

/** Poll `condition` (macrotask turns) until it holds; throws with `what` after `turns`. */
export async function until(condition: () => boolean | Promise<boolean>, what: string, turns = 2_000): Promise<void> {
  for (let i = 0; i < turns; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`timed out waiting for: ${what}`);
}
