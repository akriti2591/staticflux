// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { down, move, smallScene, wheel } from '../test-helpers.js';
import { engine } from '../test-helpers.js';
import type { PresentedRecord } from '../render-module.js';
import { createFakeRaf, createInProcessSequencingSubject, createSequencingReference, throughRing, toPresentedFrame } from './oracle-subject.js';

const scene = smallScene(200);

describe('throughRing', () => {
  it('rounds coordinates and wheel deltas to f32 like the input ring', () => {
    const event = throughRing(wheel(0.1, 0.2, 0.3, 0.4));
    expect(event.x).toBe(Math.fround(0.1));
    expect(event.dy).toBe(Math.fround(0.4));
    expect(throughRing(down(1, 2)).dx).toBeUndefined();
  });
});

describe('createFakeRaf', () => {
  it('runs queued callbacks once per flush', () => {
    const raf = createFakeRaf();
    const times: number[] = [];
    raf.raf((t) => times.push(t));
    raf.flush(16);
    raf.flush(32);
    expect(times).toEqual([16]);
  });
});

describe('createSequencingReference', () => {
  it('replays inputs, makes real remote CRDT updates and reports its display', () => {
    const reference = createSequencingReference({ engine, scene });
    const random = () => 0.5;
    const before = reference.display();
    expect(reference.probe(50, 50)).toBe(true);
    reference.input(down(50, 50));
    reference.input(move(60, 50));
    expect(reference.dragTargets()).toHaveLength(1);
    const target = reference.dragTargets()[0] as number;
    const update = reference.makeRemote({ kind: 'move', target, dx: 3, dy: 4, random });
    expect(update).toBeInstanceOf(Uint8Array);
    reference.remote(update);
    expect(reference.core.part.prop('e0', 'spatial.y')).toBe(4);
    const removal = reference.makeRemote({ kind: 'delete', dx: 0, dy: 0, random });
    reference.remote(removal);
    expect(reference.core.scene.count).toBe(199);
    expect(reference.makeRemote({ kind: 'move', target: 9_999, dx: 1, dy: 1, random })).toBeUndefined();
    expect(reference.display()).not.toEqual(before);
    expect(reference.zoom()).toBe(1);
    expect(reference.contentCenter()).toEqual([(0 + 9 * 60 + 40) / 2, (0 + 19 * 60 + 40) / 2]);
    expect(reference.final()).toMatchObject({ docVersion: 2, commits: 0 });
    reference.dispose();
  });
});

describe('createInProcessSequencingSubject', () => {
  it('boots the real pipeline in-process and maps presented records', async () => {
    const subject = createInProcessSequencingSubject({ engine, scene });
    const pipeline = await subject.boot({ config: { name: 'colocated', topology: 'colocated', medium: 'local', inputMedium: 'shared' }, remote: [] });
    pipeline.push([down(50, 50), move(55, 50)]);
    pipeline.vsync();
    expect(await pipeline.settled(2, 2_000)).toBe(true);
    const frames = pipeline.presented();
    expect(frames.at(-1)).toMatchObject({ inputSeq: 2, overlayAfterCommit: false });
    expect(toPresentedFrame(pipeline.hosts[0]?.render?.presented.at(-1) as PresentedRecord)).toEqual(frames.at(-1));
    const final = await pipeline.finish();
    expect(final.render.committedDigest).toBe(final.editor.committedDigest);
    await pipeline.dispose();
  });
});
