import { describe, expect, it } from 'vitest';
import { createEditorCore } from './editor-core.js';
import { createEditorModule, queuedPeer, scriptedPeer } from './editor-module.js';
import { down, move, openScene, pipes, settle, smallScene, up } from './test-helpers.js';

const scene = smallScene();

/** A remote update moving `node` by `dx` (made by another peer of the same scene). */
function remoteMove(node: string, x: number): Uint8Array {
  const peer = openScene(scene, '42');
  const before = peer.version();
  const done = peer.transact({ actor: { kind: 'user', id: 'other' }, label: 'remote' }, [{ op: 'set', node, path: 'spatial.x', value: x }]);
  if (!done.ok) throw done.error;
  const bytes = peer.exportUpdates(before);
  peer.dispose();
  return bytes;
}

describe('scriptedPeer / queuedPeer', () => {
  it('a scripted peer hands out updates once their input position is reached, in order', () => {
    const a = new Uint8Array([1]);
    const b = new Uint8Array([2]);
    const c = new Uint8Array([3]);
    const peer = scriptedPeer([
      { after: 2, update: b },
      { after: 0, update: a },
      { after: 2, update: c },
    ]);
    expect(peer.take(0)).toEqual([a]);
    expect(peer.take(1)).toEqual([]);
    expect(peer.take(5)).toEqual([b, c]);
    expect(peer.take(9)).toEqual([]);
  });
  it('a queued peer hands out whatever arrived', () => {
    const peer = queuedPeer();
    peer.push(new Uint8Array([1]));
    peer.push(new Uint8Array([2]));
    expect(peer.pending).toBe(2);
    expect(peer.take(0)).toHaveLength(2);
    expect(peer.pending).toBe(0);
  });
});

describe('createEditorModule', () => {
  it('starts with a snapshot and a frame, then publishes deltas before the frame that references them', async () => {
    const p = await pipes();
    const module = createEditorModule({ part: openScene(scene), ports: { input: p.input, deltas: p.deltas, frames: p.frames } });
    if (!module.ok) throw module.error;
    const { frames, deltas } = await p.readers();
    expect(frames.read()?.record).toMatchObject({ viewSeq: 1, docVersion: 0, inputSeq: 0 });
    expect(deltas.peek()).toMatchObject({ kind: 'snapshot', version: 0 });
    p.push([down(50, 50), move(60, 60), up(60, 60)]);
    expect(module.value.step()).toBe(3);
    const frame = frames.read()?.record;
    expect(frame).toMatchObject({ viewSeq: 2, docVersion: 1, inputSeq: 3, batchSeq: 1 });
    const versions: number[] = [];
    deltas.apply((record) => versions.push(record.version));
    expect(versions).toEqual([0, 1]); // the delta the frame references is already in the stream
    expect(module.value.stats).toMatchObject({ inputs: 3, batches: 1, maxBatch: 3, viewFrames: 2, deltas: 1, snapshots: 1 });
    expect(module.value.step()).toBe(0); // nothing new: no frame
    expect(module.value.stats.viewFrames).toBe(2);
  });

  it('applies scripted remote updates right after their input position, before the next record', async () => {
    const p = await pipes();
    const module = createEditorModule({ part: openScene(scene), ports: { input: p.input, deltas: p.deltas, frames: p.frames, peer: scriptedPeer([{ after: 1, update: remoteMove('e5', 999) }]) } });
    if (!module.ok) throw module.error;
    const reference = createEditorCore({ part: openScene(scene) });
    if (!reference.ok) throw reference.error;
    const events = [down(50, 50), move(52, 50), up(52, 50)];
    p.push(events);
    module.value.step();
    reference.value.input(events[0] as never);
    expect(reference.value.remote(remoteMove('e5', 999)).ok).toBe(true);
    reference.value.input(events[1] as never);
    reference.value.input(events[2] as never);
    expect(module.value.core.final()).toEqual(reference.value.final());
    expect(module.value.core.part.prop('e5', 'spatial.x')).toBe(999);
    expect(module.value.core.peerSeq).toBe(1);
  });

  it('answers a reader resnapshot request with a snapshot and a fresh frame', async () => {
    const p = await pipes();
    const module = createEditorModule({ part: openScene(scene), ports: { input: p.input, deltas: p.deltas, frames: p.frames } });
    if (!module.ok) throw module.error;
    const { frames, deltas } = await p.readers();
    deltas.apply(() => undefined);
    deltas.requestResnapshot();
    await settle();
    expect(module.value.stats.snapshots).toBe(2);
    expect(frames.read()?.record.viewSeq).toBe(2);
  });

  it('drops every Nth delta under fault injection, so the reader sees a gap (E-1)', async () => {
    const p = await pipes();
    const module = createEditorModule({ part: openScene(scene), ports: { input: p.input, deltas: p.deltas, frames: p.frames }, dropDeltaEvery: 2 });
    if (!module.ok) throw module.error;
    const { deltas } = await p.readers();
    for (let i = 0; i < 3; i++) p.push([down(50 + i * 10, 50), move(51 + i * 10, 50), up(51 + i * 10, 50)]);
    module.value.step();
    expect(module.value.stats.droppedDeltas).toBe(1);
    const report = deltas.apply(() => undefined);
    expect(report.outcome).toBe('resyncing');
    expect(deltas.stats.gaps).toBe(1);
  });

  it('runs until aborted, stepping when input arrives', async () => {
    const p = await pipes('shared');
    const module = createEditorModule({ part: openScene(scene), ports: { input: p.input, deltas: p.deltas, frames: p.frames }, coalesceMs: 1 });
    if (!module.ok) throw module.error;
    const stop = new AbortController();
    const running = module.value.run(stop.signal);
    p.push([down(50, 50), move(55, 50), up(55, 50)]);
    for (let i = 0; i < 100 && module.value.stats.inputs < 3; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(module.value.stats.inputs).toBe(3);
    stop.abort();
    expect((await running).ok).toBe(true);
  });
});
