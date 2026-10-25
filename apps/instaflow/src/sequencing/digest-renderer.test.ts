import { err, ok } from '@staticflux/core';
import { createCell } from '@staticflux/worker/pipeline';
import { describe, expect, it } from 'vitest';
import { createDigestRenderer, frameDigest } from './digest-renderer.js';
import { createEditorCore } from './editor-core.js';
import { RenderPortError } from './errors.js';
import { ViewFrameCell, type ViewFrameRecord } from './protocol.js';
import type { RenderFrame, RenderPort } from './render-port.js';
import { down, move, openScene, smallScene } from './test-helpers.js';

const scene = smallScene(50);

function frame(): RenderFrame {
  const created = createEditorCore({ part: openScene(scene) });
  if (!created.ok) throw created.error;
  const core = created.value;
  core.input(down(50, 50));
  core.input(move(57, 52));
  const cell = createCell(ViewFrameCell, { medium: 'local' });
  if (!cell.ok) throw cell.error;
  let view: ViewFrameRecord | undefined;
  cell.value.write(({ record }) => {
    core.writeFrame(record, { viewSeq: 1, inputSeq: 2, batchSeq: 1, epoch: 1, inputTs: 0 });
    view = record;
  });
  return { scene: core.scene, view: view as ViewFrameRecord, docVersion: 0, reason: 'arrival' };
}

describe('frameDigest', () => {
  it('equals the editor’s own digest of the same display', () => {
    const f = frame();
    expect(frameDigest(f)).toBe(f.view.digest);
  });
});

describe('createDigestRenderer', () => {
  it('records draws and self-check mismatches, and tees to an inner port', () => {
    const drawn: number[] = [];
    let resets = 0;
    let disposed = 0;
    const inner: RenderPort = { draw: (f) => (drawn.push(f.view.viewSeq), ok()), reset: () => void (resets += 1), dispose: () => void (disposed += 1) };
    const renderer = createDigestRenderer(inner);
    const f = frame();
    expect(renderer.draw(f).ok).toBe(true);
    expect(renderer.lastDigest).toBe(f.view.digest);
    expect(drawn).toEqual([1]);
    (f.view as { digest: number }).digest = 1; // pretend the editor disagreed
    renderer.draw(f);
    renderer.reset?.();
    renderer.dispose();
    expect(renderer.stats).toMatchObject({ draws: 2, selfCheckMismatches: 1, failures: 0 });
    expect([resets, disposed]).toEqual([1, 1]);
  });
  it('counts inner failures and works without an inner port', () => {
    const failing = createDigestRenderer({ draw: () => err(RenderPortError()), dispose: () => undefined });
    expect(failing.draw(frame()).ok).toBe(false);
    expect(failing.stats.failures).toBe(1);
    const alone = createDigestRenderer();
    expect(alone.draw(frame()).ok).toBe(true);
    alone.reset?.();
    alone.dispose();
  });
});
