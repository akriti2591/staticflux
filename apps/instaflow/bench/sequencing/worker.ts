/**
 * Bench worker: a sequencing worker (editor, render or both, as the boot plan says) with two render
 * ports — `none` (digest only: sequencing cost) and `webgpu` (instanced quads into the transferred canvas).
 */
import { createLoroEngine } from '@staticflux/document/loro-crdt';
import { fromWorkerScope, type MessageTargetLike } from '@staticflux/worker';
import { createDigestRenderer } from '../../src/sequencing/digest-renderer.js';
import { hostSequencingWorker } from '../../src/sequencing/host.js';
import { createQuadsPort } from './quads-port.js';

const scope = globalThis as unknown as MessageTargetLike & { addEventListener(type: 'message', listener: (event: MessageEvent) => void): void };
let canvas: OffscreenCanvas | undefined;
// The canvas arrives before the boot protocol starts (posted by main right after spawning).
// sf-lint-disable-next-line no-bare-listener -- lives as long as the worker
scope.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { benchCanvas?: OffscreenCanvas } | undefined;
  if (data?.benchCanvas !== undefined) canvas = data.benchCanvas;
});

hostSequencingWorker({
  port: fromWorkerScope(scope),
  engine: createLoroEngine(),
  renderPorts: {
    none: () => createDigestRenderer(),
    webgpu: () => createDigestRenderer(createQuadsPort(() => canvas)),
  },
});
