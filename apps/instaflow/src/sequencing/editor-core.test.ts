import { createCell } from '@staticflux/worker/pipeline';
import { describe, expect, it } from 'vitest';
import { InputFlag, InputModifier } from '@staticflux/surface';
import { applyWheel, type Camera, createEditorCore, type EditorCore, type EditorDelta, ZOOM_MAX, ZOOM_MIN } from './editor-core.js';
import { viewPartDigest } from './digest.js';
import { ViewFrameCell } from './protocol.js';
import { down, key, move, openScene, smallScene, up, wheel } from './test-helpers.js';

const scene = smallScene();

function core(): { core: EditorCore; deltas: EditorDelta[] } {
  const deltas: EditorDelta[] = [];
  const created = createEditorCore({ part: openScene(scene), onDelta: (d) => deltas.push(d) });
  if (!created.ok) throw created.error;
  return { core: created.value, deltas };
}

const x = (c: EditorCore, node: string): number => c.part.prop(node, 'spatial.x') as number;
const y = (c: EditorCore, node: string): number => c.part.prop(node, 'spatial.y') as number;
const slot = (c: EditorCore, node: string): number => c.projector.slotOf(node) as number;

/** A remote peer's update against the same scene (another tab or collaborator). */
function remoteUpdate(ops: Parameters<ReturnType<typeof openScene>['transact']>[1]): Uint8Array {
  const peer = openScene(scene, '42');
  const before = peer.version();
  const done = peer.transact({ actor: { kind: 'user', id: 'other' }, label: 'remote' }, ops);
  if (!done.ok) throw done.error;
  const bytes = peer.exportUpdates(before);
  peer.dispose();
  return bytes;
}

describe('applyWheel', () => {
  it('pans by the wheel delta and zooms about the pointer with Ctrl, clamped', () => {
    const camera: Camera = { tx: 0, ty: 0, zoom: 1 };
    applyWheel(camera, 0, 0, 10, 5, 0);
    expect(camera).toEqual({ tx: -10, ty: -5, zoom: 1 });
    const before = { x: (300 - camera.tx) / camera.zoom, y: (200 - camera.ty) / camera.zoom };
    applyWheel(camera, 300, 200, 0, -50, InputModifier.ctrl);
    expect(camera.zoom).toBeCloseTo(Math.exp(0.5));
    expect((300 - camera.tx) / camera.zoom).toBeCloseTo(before.x); // the point under the pointer stays put
    expect((200 - camera.ty) / camera.zoom).toBeCloseTo(before.y);
    applyWheel(camera, 0, 0, 0, -10_000, InputModifier.ctrl);
    expect(camera.zoom).toBe(ZOOM_MAX);
    applyWheel(camera, 0, 0, 0, 10_000, InputModifier.ctrl);
    expect(camera.zoom).toBe(ZOOM_MIN);
  });
});

describe('createEditorCore', () => {
  it('drags one element as an overlay and commits one transaction on pointerup (E-5, E-2 supersedes)', () => {
    const { core: c, deltas } = core();
    const committed = c.displayDigest();
    expect(c.probe(50, 50)).toBe(true);
    expect(c.probe(90, 50)).toBe(false);
    c.input(down(50, 50));
    expect(c.selection).toEqual([slot(c, 'e0')]);
    expect(c.dragTargets()).toEqual([slot(c, 'e0')]);
    for (let i = 1; i <= 10; i++) c.input(move(50 + i, 50 + 2 * i));
    expect(c.gesture).toMatchObject({ kind: 'drag', dx: 10, dy: 20 });
    expect(c.displayDigest()).not.toBe(committed); // the overlay is drawn
    expect(deltas).toHaveLength(0); // no intermediate transactions
    const gesture = c.gesture?.id;
    c.input(up(60, 70));
    expect([x(c, 'e0'), y(c, 'e0')]).toEqual([10, 20]);
    expect(c.commits).toBe(1);
    expect(c.docVersion).toBe(1);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ version: 1, supersedes: [gesture] });
    expect(c.gesture).toBeUndefined();
    expect(c.committedDigest()).toBe(c.final().committedDigest);
  });

  it('a click without movement commits nothing; Alt drags the whole group', () => {
    const { core: c } = core();
    c.input(down(50, 50));
    c.input(up(50, 50));
    expect(c.commits).toBe(0);
    c.input(down(50, 50, InputModifier.alt));
    expect(c.dragTargets()).toHaveLength(100);
    c.input(move(55, 50, InputModifier.alt));
    c.input(up(55, 50, InputModifier.alt));
    expect(x(c, 'e99')).toBe(9 * 60 + 5);
    expect(x(c, 'e100')).toBe(0); // the next group did not move
  });

  it('marquee selects intersecting elements (sorted slots) and commits nothing', () => {
    const { core: c } = core();
    c.input(down(90, 50)); // empty space between e0 and e1
    expect(c.gesture?.kind).toBe('marquee');
    c.input(move(230, 160));
    const expected = ['e1', 'e2', 'e3', 'e11', 'e12', 'e13'].map((n) => slot(c, n)).sort((a, b) => a - b);
    expect(c.selection).toEqual(expected);
    c.input(up(230, 160));
    expect(c.commits).toBe(0);
    expect(c.selection).toEqual(expected);
  });

  it('nudges the selection, ×10 with Shift, one transaction per key; nothing without a selection', () => {
    const { core: c } = core();
    c.input(key('ArrowRight'));
    expect(c.commits).toBe(0);
    c.input(down(50, 50));
    c.input(up(50, 50));
    c.input(key('ArrowRight'));
    c.input(key('ArrowDown', InputModifier.shift));
    c.input(key('KeyQ'));
    expect([x(c, 'e0'), y(c, 'e0')]).toEqual([1, 10]);
    expect(c.commits).toBe(2);
  });

  it('Esc and pointercancel cancel the gesture without a commit', () => {
    const { core: c } = core();
    c.input(down(50, 50));
    c.input(move(70, 70));
    c.input(key('Escape'));
    c.input(up(70, 70));
    expect(c.commits).toBe(0);
    expect(c.cancels).toBe(1);
    c.input(down(50, 50));
    c.input({ ...move(70, 70), t: 4 });
    expect(c.cancels).toBe(2);
    c.input(key('Escape')); // nothing to cancel
    expect(c.cancels).toBe(2);
  });

  it('E-3: a remote move of the target mid-drag composes with the overlay', () => {
    const { core: c, deltas } = core();
    c.input(down(50, 50));
    c.input(move(60, 50));
    expect(c.remote(remoteUpdate([{ op: 'set', node: 'e0', path: 'spatial.y', value: 7 }])).ok).toBe(true);
    expect(c.peerSeq).toBe(1);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.supersedes).toEqual([]);
    c.input(up(60, 50));
    expect([x(c, 'e0'), y(c, 'e0')]).toEqual([10, 7]);
    expect(c.docVersion).toBe(2);
  });

  it('E-3: a remote delete of a target cancels the gesture with IF-ENG-001 and leaves the selection', () => {
    const { core: c } = core();
    c.input(down(50, 50, InputModifier.alt));
    c.input(move(60, 50, InputModifier.alt));
    expect(c.remote(remoteUpdate([{ op: 'delete', node: 'e3' }])).ok).toBe(true);
    expect(c.gesture).toBeUndefined();
    expect(c.cancels).toBe(1);
    expect(c.errors.map((e) => e.code)).toEqual(['IF-ENG-001']);
    expect(c.selection).toHaveLength(99);
    c.input(up(60, 50));
    expect(c.commits).toBe(0);
    expect(c.final()).toMatchObject({ errors: 1, cancels: 1, docVersion: 1 });
    expect(c.remote(new Uint8Array([1, 2, 3])).ok).toBe(false);
  });

  it('E-4: a hit test uses the camera after exactly the earlier inputs', () => {
    const { core: c } = core();
    c.input(wheel(0, 0, 60, 0)); // pan: e1 now sits where e0 was
    c.input(down(50, 50));
    expect(c.selection).toEqual([slot(c, 'e1')]);
  });

  it('ignores predicted samples', () => {
    const { core: c } = core();
    c.input(down(50, 50));
    c.input({ ...move(80, 80), f: InputFlag.predicted });
    expect(c.gesture).toMatchObject({ dx: 0, dy: 0 });
  });

  it('writes the view frame: versions, camera, overlay, selection, marquee and its own digest', () => {
    const { core: c } = core();
    const cell = createCell(ViewFrameCell, { medium: 'local' });
    if (!cell.ok) throw cell.error;
    c.input(down(50, 50));
    c.input(move(53, 54));
    cell.value.write(({ record }) => c.writeFrame(record, { viewSeq: 3, inputSeq: 2, batchSeq: 1, epoch: 1, inputTs: 99 }));
    let record = undefined as unknown as Parameters<EditorCore['writeFrame']>[0];
    cell.value.write(({ record: r }) => {
      c.writeFrame(r, { viewSeq: 4, inputSeq: 2, batchSeq: 1, epoch: 1, inputTs: 99 });
      record = r;
    });
    expect(record).toMatchObject({ viewSeq: 4, inputSeq: 2, batchSeq: 1, epoch: 1, inputTs: 99, docVersion: 0, tx: 40, ty: 40, zoom: 1, overlayCount: 1, dx: 3, dy: 4, selectionCount: 1, marqueeOn: 0, digest: c.displayDigest() });
    expect(record.gestureId).toBeGreaterThan(0);
    expect(record.targets[0]).toBe(slot(c, 'e0'));
    c.input(up(53, 54));
    c.input(down(90, 50));
    c.input(move(100, 60));
    cell.value.write(({ record: r }) => c.writeFrame(r, { viewSeq: 5, inputSeq: 5, batchSeq: 2, epoch: 1, inputTs: 1 }));
    cell.value.write(({ record: r }) => {
      c.writeFrame(r, { viewSeq: 6, inputSeq: 5, batchSeq: 2, epoch: 1, inputTs: 1 });
      expect(r.marqueeOn).toBe(1);
      expect(r.overlayCount).toBe(0);
      expect([...r.marquee]).toEqual([50, 10, 60, 20]);
    });
  });

  it('keeps the committed digest incrementally equal to a full recompute', () => {
    const { core: c } = core();
    const empty = c.displayDigest();
    c.input(down(50, 50, InputModifier.alt));
    c.input(move(57, 61, InputModifier.alt));
    c.input(up(57, 61, InputModifier.alt));
    expect(c.remote(remoteUpdate([{ op: 'delete', node: 'e150' }, { op: 'set', node: 'e151', path: 'spatial.x', value: -5 }])).ok).toBe(true);
    c.input(key('Escape'));
    c.input(down(1000, 1000)); // empty: clears the selection
    c.input(up(1000, 1000));
    expect(c.displayDigest()).not.toBe(empty);
    expect(c.selection).toEqual([]);
    // incremental (inside displayDigest) == full recompute over the same scene + an empty view part
    expect(c.displayDigest()).toBe((c.committedDigest() + viewPartDigest([], 0, undefined)) >>> 0);
  });

  it('snapshots the committed scene for resync', () => {
    const { core: c } = core();
    expect(c.snapshot().byteLength).toBeGreaterThan(300 * 32);
    expect(c.scene.count).toBe(300);
    expect(c.spatial.index.size).toBe(300);
  });
});
