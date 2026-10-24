/**
 * The browser document-worker spawner (lazy chunk, see `spawn-browser.ts`). Without `Worker`
 * (feature-detected) the host runs in-thread, loaded lazily so the engine and Yjs never land
 * in the main-thread boot chunk.
 */
import { dedicatedWorkerSpawner, inMemorySpawner, type Spawner, supportsWorker } from '@staticflux/worker';

export function createDocumentWorkerSpawner(): Spawner {
  if (supportsWorker()) {
    return dedicatedWorkerSpawner(() => new Worker(new URL('./document.worker.ts', import.meta.url), { type: 'module', name: 'studio-document' }));
  }
  return async (context) => {
    const host = await import('./document-host.js');
    return inMemorySpawner((port) => host.startDocumentWorker(port))(context);
  };
}
