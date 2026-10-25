/**
 * Test helpers for the sequencing modules (not exported; excluded from builds by name).
 * A small scene, input events, and local-medium pipes around an editor module.
 */
import { createLoroEngine } from '@staticflux/document/loro-crdt';
import type { CrdtEngine, DocumentCRDTv2 } from '@staticflux/document/v2';
import { type CompactInputEvent, InputCode } from '@staticflux/surface';
import { encodeInputRecord } from '@staticflux/surface/input-ring';
import { attachCell, attachDeltaStream, attachRecordRing, createCell, createDeltaStream, createRecordRing, type PipeMedium } from '@staticflux/worker/pipeline';
import { EditorInputRing, SceneDeltas, ViewFrameCell } from './protocol.js';
import { gridSceneSnapshot } from './scene.js';

export const engine: CrdtEngine = createLoroEngine();

/** 300 shapes in 3 groups of 100, 10 per row, pitch 60, size 40 (screen = doc + 40 at the start camera). */
export function smallScene(elements = 300): Uint8Array {
  const scene = gridSceneSnapshot(engine, { elements, columns: 10 }, '7');
  if (!scene.ok) throw scene.error;
  return scene.value;
}

export function openScene(bytes: Uint8Array = smallScene(), peer: `${number}` = '7'): DocumentCRDTv2 {
  const part = engine.load(bytes, { peer });
  if (!part.ok) throw part.error;
  return part.value;
}

let ts = 0;
const at = (event: Omit<CompactInputEvent, 'ts'>): CompactInputEvent => ({ ...event, ts: (ts += 4) }) as CompactInputEvent;
export const down = (x: number, y: number, m = 0): CompactInputEvent => at({ t: InputCode.pointerDown, x, y, b: 1, m, p: 1, k: 0 });
export const move = (x: number, y: number, m = 0): CompactInputEvent => at({ t: InputCode.pointerMove, x, y, b: 1, m, p: 1, k: 0 });
export const up = (x: number, y: number, m = 0): CompactInputEvent => at({ t: InputCode.pointerUp, x, y, b: 0, m, p: 1, k: 0 });
export const wheel = (x: number, y: number, dx: number, dy: number, m = 0): CompactInputEvent => at({ t: InputCode.wheel, x, y, b: 0, m, dx, dy });
export const key = (name: string, m = 0): CompactInputEvent => at({ t: InputCode.keyDown, x: 0, y: 0, b: 0, m, key: name, code: name });

/** Editor-side pipes on one medium plus their render-side readers. */
export async function pipes(medium: PipeMedium = 'local') {
  const ring = createRecordRing(EditorInputRing, { medium });
  const deltas = createDeltaStream(SceneDeltas, { medium });
  const frames = createCell(ViewFrameCell, { medium });
  if (!ring.ok || !deltas.ok || !frames.ok) throw new Error('pipes');
  const ringEndpoint = ring.value.endpoint(0);
  if (!ringEndpoint.ok) throw ringEndpoint.error;
  const input = await attachRecordRing(EditorInputRing, ringEndpoint.value);
  if (!input.ok) throw input.error;
  let batch = 0;
  return {
    ring: ring.value,
    input: input.value,
    deltas: deltas.value,
    frames: frames.value,
    push(events: readonly CompactInputEvent[]): void {
      batch += 1;
      for (const event of events) ring.value.push((record) => encodeInputRecord(record, event, batch));
    },
    async readers() {
      const f = frames.value.endpoint();
      const d = deltas.value.endpoint();
      if (!f.ok || !d.ok) throw new Error('endpoints');
      const frameReader = await attachCell(ViewFrameCell, f.value);
      const deltaReader = await attachDeltaStream(SceneDeltas, d.value);
      if (!frameReader.ok || !deltaReader.ok) throw new Error('readers');
      return { frames: frameReader.value, deltas: deltaReader.value };
    },
  };
}

export const settle = async (turns = 4): Promise<void> => {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
