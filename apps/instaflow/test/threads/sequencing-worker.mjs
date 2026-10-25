// Thread fixture: a real sequencing worker (editor module, render module, or both — as main's
// `start` request says). Loads the TypeScript sources through the worker package's module hooks.
import '../../../../packages/worker/test/threads/register.mjs';
import { parentPort } from 'node:worker_threads';

const { fromMessagePort } = await import('@staticflux/worker');
const { createLoroEngine } = await import('@staticflux/document/loro-crdt');
const { hostSequencingWorker } = await import(new URL('../../src/sequencing/host.ts', import.meta.url).href);
const { createDigestRenderer } = await import(new URL('../../src/sequencing/digest-renderer.ts', import.meta.url).href);

hostSequencingWorker({
  port: fromMessagePort(parentPort),
  engine: createLoroEngine(),
  renderPorts: { oracle: () => createDigestRenderer() },
});
