import { err, ok } from '@staticflux/core';
import { attachCell, attachDeltaStream, createCell, createDeltaStream, type PipeMedium } from '@staticflux/worker/pipeline';
import { describe, expect, it } from 'vitest';
import { createDigestRenderer } from './digest-renderer.js';
import { createEditorCore, type EditorDelta } from './editor-core.js';
import { RenderPortError } from './errors.js';
import { cellTicks, createMainTick, DEFAULT_RENDER_PACING, MAIN_TICK_PACING, manualTicks, RAF_ONLY_PACING, type RenderPacing } from './pacing.js';
import { RenderTickCell, SceneDeltas, ViewFrameCell } from './protocol.js';
import { createRenderModule, RenderModuleLifecycle } from './render-module.js';
import type { RenderPort } from './render-port.js';
import { down, move, openScene, settle, smallScene, up } from './test-helpers.js';

const scene = smallScene();

async function rig(options: { pacing?: RenderPacing; port?: RenderPort; medium?: PipeMedium; ticks?: 'manual' | 'main' } = {}) {
  const medium = options.medium ?? 'local';
  const pending: EditorDelta[] = [];
  const created = createEditorCore({ part: openScene(scene), onDelta: (d) => pending.push(d) });
  if (!created.ok) throw created.error;
  const core = created.value;
  const deltas = createDeltaStream(SceneDeltas, { medium });
  const frames = createCell(ViewFrameCell, { medium });
  if (!deltas.ok || !frames.ok) throw new Error('pipes');
  deltas.value.snapshot({ version: 0, payload: core.snapshot() });
  let viewSeq = 0;
  let consumed = 0;
  const writeFrame = (): void => {
    viewSeq += 1;
    frames.value.write(({ record }) => core.writeFrame(record, { viewSeq, inputSeq: consumed, batchSeq: 0, epoch: deltas.value.epoch, inputTs: 0 }));
  };
  const appendPending = (): void => {
    for (const d of pending.splice(0)) deltas.value.append({ version: d.version, base: d.version - 1, payload: d.payload });
  };
  const input = (...events: Parameters<typeof core.input>[0][]): void => {
    for (const event of events) {
      core.input(event);
      consumed += 1;
    }
  };
  writeFrame();
  const fe = frames.value.endpoint();
  const de = deltas.value.endpoint();
  if (!fe.ok || !de.ok) throw new Error('endpoints');
  const frameReader = await attachCell(ViewFrameCell, fe.value);
  const deltaReader = await attachDeltaStream(SceneDeltas, de.value);
  if (!frameReader.ok || !deltaReader.ok) throw new Error('readers');
  const port = options.port ?? createDigestRenderer();
  const manual = manualTicks();
  const tickCell = createCell(RenderTickCell, { medium });
  if (!tickCell.ok) throw tickCell.error;
  const tickEndpoint = tickCell.value.endpoint();
  if (!tickEndpoint.ok) throw tickEndpoint.error;
  const tickReader = await attachCell(RenderTickCell, tickEndpoint.value);
  if (!tickReader.ok) throw tickReader.error;
  let clock = 1000;
  const render = createRenderModule({
    ports: { frames: frameReader.value, deltas: deltaReader.value, port, ticks: options.ticks === 'main' ? cellTicks(tickReader.value) : manual },
    pacing: options.pacing ?? DEFAULT_RENDER_PACING,
    record: true,
    digest: () => core.displayDigest(),
    now: () => (clock += 1),
  });
  return { core, deltas: deltas.value, frames: frames.value, writeFrame, appendPending, input, render, manual, mainTick: createMainTick(tickCell.value), port };
}

describe('RenderModuleLifecycle', () => {
  it('is waiting → presenting ⇄ holding, with disposed terminal', () => {
    expect(RenderModuleLifecycle.transitions.waiting).toMatchObject({ draw: 'presenting', hold: 'holding' });
    expect(RenderModuleLifecycle.transitions.holding).toMatchObject({ draw: 'presenting' });
    expect(RenderModuleLifecycle.terminal).toEqual(['disposed']);
  });
});

describe('createRenderModule', () => {
  it('draws a consistent frame once, holds while the frame is ahead of the deltas, and draws when they land (E-1/E-2)', async () => {
    const r = await rig();
    expect(r.render.state).toBe('waiting');
    expect(r.render.update('arrival')).toBe('drawn');
    expect(r.render.update('arrival')).toBe('unchanged');
    r.input(down(50, 50), move(60, 60), up(60, 60));
    r.writeFrame(); // the frame references docVersion 1 before its delta is in the stream (a broken writer)
    expect(r.render.update('arrival')).toBe('held');
    expect(r.render.state).toBe('holding');
    expect(r.render.presented).toHaveLength(1); // the last good frame stays
    r.appendPending();
    expect(r.render.update('arrival')).toBe('drawn');
    expect(r.render.state).toBe('presenting');
    const last = r.render.presented[r.render.presented.length - 1];
    expect(last).toMatchObject({ docVersion: 1, frameDocVersion: 1, inputSeq: 3, overlayAfterCommit: false });
    expect(r.render.final()).toMatchObject({ docVersion: 1, committedDigest: r.core.committedDigest(), gaps: 0, tornReads: 0, orderViolations: 0 });
  });

  it('never applies deltas newer than the frame being drawn', async () => {
    const r = await rig();
    r.render.update('arrival');
    r.input(down(50, 50), move(60, 60), up(60, 60));
    r.appendPending(); // delta v1 is in the stream, the frame still says v0
    expect(r.render.update('arrival')).toBe('unchanged');
    expect(r.render.final().docVersion).toBe(0);
    r.writeFrame();
    expect(r.render.update('arrival')).toBe('drawn');
    expect(r.render.final().docVersion).toBe(1);
  });

  it('flags a frame that still draws the overlay of a committed gesture (double-draw signature)', async () => {
    const r = await rig();
    r.input(down(50, 50), move(60, 60));
    r.writeFrame(); // overlay of gesture g at docVersion 0
    const overlayFrame = r.frames; // keep writing through the same cell
    r.input(up(60, 60));
    r.appendPending();
    // A broken editor: rewrite the overlay frame (gesture g, overlay on) with the new docVersion.
    overlayFrame.write(({ record }) => {
      record.viewSeq = 99;
      record.docVersion = 1;
      record.gestureId = 1;
      record.overlayCount = 1;
      record.dx = 10;
    });
    expect(r.render.update('arrival')).toBe('drawn');
    expect(r.render.stats.overlayAfterCommit).toBe(1);
  });

  it('resyncs from a snapshot after a gap and keeps the last good frame meanwhile', async () => {
    const r = await rig();
    r.render.update('arrival');
    r.input(down(50, 50), move(60, 60), up(60, 60));
    r.input(down(110, 50), move(120, 60), up(120, 60));
    r.appendPending();
    r.writeFrame();
    expect(r.render.update('arrival')).toBe('drawn'); // both deltas delivered: no gap
    // A lost record: v4 arrives on base 3, but v3 never did.
    r.input(down(170, 50), move(175, 50), up(175, 50));
    r.input(down(230, 50), move(235, 50), up(235, 50));
    r.deltas.append({ version: 4, base: 3, payload: new Uint8Array(0) }); // (v3 and v4 stay in the editor)
    r.writeFrame();
    expect(r.render.update('arrival')).toBe('held');
    expect(r.render.stats.gaps).toBe(1);
    r.deltas.snapshot({ version: r.core.docVersion, payload: r.core.snapshot() });
    r.writeFrame();
    expect(r.render.update('arrival')).toBe('drawn');
    expect(r.render.stats.resnapshots).toBe(1);
    expect(r.render.final().committedDigest).toBe(r.core.committedDigest());
  });

  it('estimates presentation at the first tick at or after submit', async () => {
    const r = await rig();
    r.render.update('arrival');
    const entry = r.render.presented[0];
    expect(entry?.presented).toBe(0);
    r.render.vsync(0); // before submit
    expect(entry?.presented).toBe(0);
    r.render.vsync(5_000);
    expect(entry?.presented).toBe(5_000);
    expect(r.render.stats.ticks).toBe(2);
  });

  it('counts draw failures and keeps the last good frame', async () => {
    const failing: RenderPort = { draw: () => err(RenderPortError()), dispose: () => undefined };
    const r = await rig({ port: failing });
    expect(r.render.update('arrival')).toBe('failed');
    expect(r.render.stats.drawFailures).toBe(1);
    expect(r.render.presented).toHaveLength(0);
  });

  it('run(): draws on arrival and paces with ticks; rAF-only pacing draws only on ticks', async () => {
    const eager = await rig({ pacing: { ...DEFAULT_RENDER_PACING, coalesceMs: 0 } });
    const stop = new AbortController();
    const running = eager.render.run(stop.signal);
    await settle();
    eager.input(down(50, 50), move(60, 60));
    eager.writeFrame();
    await settle();
    expect(eager.render.presented.at(-1)?.inputSeq).toBe(2);
    stop.abort();
    eager.manual.tick(0);
    expect((await running).ok).toBe(true);

    const rafOnly = await rig({ pacing: RAF_ONLY_PACING });
    const stop2 = new AbortController();
    const running2 = rafOnly.render.run(stop2.signal);
    await settle();
    const drawn = rafOnly.render.presented.length;
    rafOnly.input(down(50, 50), move(60, 60));
    rafOnly.writeFrame();
    await settle();
    expect(rafOnly.render.presented).toHaveLength(drawn); // no tick yet
    rafOnly.manual.tick(2_000);
    await settle();
    expect(rafOnly.render.presented).toHaveLength(drawn + 1);
    expect(rafOnly.render.presented.at(-1)?.reason).toBe('tick');
    stop2.abort();
    expect((await running2).ok).toBe(true);
  });

  it('main-rAF tick: a tick waits (latch) for the editor to consume the input main pushed', async () => {
    const r = await rig({ pacing: { ...MAIN_TICK_PACING, arrival: false, latchMs: 50 }, ticks: 'main', medium: 'shared' });
    const stop = new AbortController();
    const running = r.render.run(stop.signal);
    await settle();
    const before = r.render.presented.length;
    r.mainTick.pulse(3_000, 2); // main pushed 2 inputs; the editor has not written them yet
    await settle(2);
    r.input(down(50, 50), move(60, 60));
    r.writeFrame();
    for (let i = 0; i < 50 && r.render.presented.length === before; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(r.render.presented.at(-1)).toMatchObject({ inputSeq: 2, reason: 'tick' });
    expect(r.mainTick.ticks).toBe(1);
    stop.abort();
    expect((await running).ok).toBe(true);
  });

  it('run(): an exception in a port is counted and does not stop the loop', async () => {
    let calls = 0;
    const port: RenderPort = {
      draw: () => {
        calls += 1;
        if (calls === 1) throw new Error('boom');
        return ok();
      },
      dispose: () => undefined,
    };
    const r = await rig({ port, pacing: { ...DEFAULT_RENDER_PACING, coalesceMs: 0 } });
    const stop = new AbortController();
    const running = r.render.run(stop.signal);
    await settle();
    expect(r.render.stats).toMatchObject({ exceptions: 1, lastException: 'boom' });
    r.input(down(50, 50), move(60, 60));
    r.writeFrame();
    await settle();
    expect(r.render.stats.draws).toBe(1);
    stop.abort();
    r.manual.tick(0);
    expect((await running).ok).toBe(true);
  });

  it('disposes its port once and stops drawing', async () => {
    let disposed = 0;
    const port: RenderPort = { draw: () => ok(), dispose: () => void (disposed += 1) };
    const r = await rig({ port });
    r.render.dispose();
    r.render.dispose();
    expect(r.render.state).toBe('disposed');
    expect(disposed).toBe(1);
    expect(r.render.update('arrival')).toBe('empty');
  });
});
