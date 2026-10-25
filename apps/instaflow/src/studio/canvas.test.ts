/**
 * The canvas region mounts the A7 editor and render modules behind their ports: the Studio shell boots
 * the pipeline (one in-memory worker, the digest renderer as the fake `RenderPort`) and its surface's
 * pointer input reaches the editor, which commits a drag that the render module presents.
 */
import { err } from '@staticflux/core';
import { inMemorySpawner, SpawnFailedError } from '@staticflux/worker';
import { compileTheme } from '@staticflux/ui/theme';
import { mountTestRoot, settle } from '@staticflux/ui/testing';
import { html, render } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bootSequencing } from '../sequencing/boot.js';
import { createDigestRenderer } from '../sequencing/digest-renderer.js';
import { hostSequencingWorker, type SequencingWorkerHost } from '../sequencing/host.js';
import { engine, smallScene } from '../sequencing/test-helpers.js';
import { DEFAULT_SEQUENCING_SETTINGS, type SequencingSettings } from '../sequencing/topology.js';
import { gateSpecDecide } from '../spec/index.js';
import { editorGate, studioRegistries } from '../spec/testing/fixtures.js';
import { cleanPopTheme } from '../theme/clean-pop.js';
import { type CanvasPort, sequencingCanvas } from './canvas.js';
import { createStudio } from './studio.js';
import { defineStudio, type IfStudioElement } from './studio-element.js';

const settings: SequencingSettings = { ...DEFAULT_SEQUENCING_SETTINGS, renderPort: 'digest', pacing: { ...DEFAULT_SEQUENCING_SETTINGS.pacing, coalesceMs: 0 } };
let cleanup: (() => Promise<void>) | undefined;

beforeAll(() => defineStudio());
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

async function mountWith(canvas: CanvasPort): Promise<IfStudioElement> {
  const style = document.createElement('style');
  style.textContent = compileTheme(cleanPopTheme);
  document.head.append(style);
  const { gate } = editorGate('pro');
  const studio = createStudio({ registries: studioRegistries(), decideFor: (s) => gateSpecDecide(gate, s), reducedMotion: () => true });
  await studio.open();
  const root = mountTestRoot({ units: [] });
  render(html`<if-studio .studio=${studio} .canvas=${canvas}></if-studio>`, root.container);
  cleanup = async () => {
    await studio.dispose();
    await root.dispose();
  };
  await settle(6);
  return root.container.querySelector('if-studio') as IfStudioElement;
}

async function until(condition: () => boolean, turns = 400): Promise<void> {
  for (let i = 0; i < turns && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
  expect(condition()).toBe(true);
}

const pointer = (type: string, x: number, y: number, buttons: number): PointerEvent =>
  new PointerEvent(type, { clientX: x, clientY: y, buttons, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true, composed: true });

describe('canvas region', () => {
  it('boots the editor ↔ render modules behind their ports and forwards surface input to the editor', async () => {
    const hosts: SequencingWorkerHost[] = [];
    const canvas = sequencingCanvas({
      boot: (signal) =>
        bootSequencing({
          settings,
          spawn: () => inMemorySpawner((port) => void hosts.push(hostSequencingWorker({ port, engine, renderPorts: { digest: () => createDigestRenderer() } })), { clone: false }),
          scene: smallScene(50),
          peer: '7',
          media: { input: 'message', modules: 'local', tick: 'message' },
          record: true,
          signal,
        }),
    });
    const element = await mountWith(canvas);
    await until(() => element.canvasActive !== undefined);
    const surface = element.shadowRoot?.querySelector('.surface') as HTMLElement;
    surface.dispatchEvent(pointer('pointerdown', 50, 50, 1));
    surface.dispatchEvent(pointer('pointermove', 70, 60, 1));
    surface.dispatchEvent(pointer('pointerup', 70, 60, 0));
    await until(() => (element.canvasActive?.forwarded ?? 0) >= 3);
    const render = () => hosts.find((h) => h.render !== undefined)?.render;
    await until(() => (render()?.presented.at(-1)?.inputSeq ?? -1) >= 1);
    expect(hosts[0]?.editor).toBeDefined();
    expect(render()?.presented.length).toBeGreaterThan(0);
  });

  it('a canvas that cannot start shows an inline alert (IF-SPEC-005) and the rest of Studio stays usable', async () => {
    const canvas = sequencingCanvas({ boot: (signal) => bootSequencing({ settings, spawn: () => () => err(SpawnFailedError()), scene: smallScene(5), peer: '7', signal }) });
    const started = await canvas.start(document.createElement('div'), new AbortController().signal);
    expect(!started.ok && [started.error.code, (started.error.cause as { code?: string } | undefined)?.code]).toEqual(['IF-SPEC-005', 'IF-SEQ-001']);
    const element = await mountWith(canvas);
    await until(() => element.shadowRoot?.querySelector('[role="alert"]') !== null);
    expect(element.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain('could not start');
    expect(element.shadowRoot?.querySelector('sf-toolbar.tools')).not.toBeNull();
  });

  it('stops the pipeline when the element disconnects', async () => {
    let stopped = 0;
    const canvas: CanvasPort = {
      start: async () => ({ ok: true, value: { forwarded: 0, stop: async () => void (stopped += 1) } }),
    };
    const element = await mountWith(canvas);
    await until(() => element.canvasActive !== undefined);
    element.remove();
    expect(stopped).toBe(1);
  });
});
