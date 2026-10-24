/**
 * Browser spawner for the document worker. Imported only by the browser entry
 * (`boot-browser.ts`); headless runs use the in-thread spawner instead. The real spawner
 * (worker transport, in-thread fallback) is its own chunk, loaded on the first spawn —
 * i.e. with the lazy document runtime, never on the boot path.
 */
import { err, toSfError } from '@staticflux/core';
import type { Spawner } from '@staticflux/worker';

export function browserDocumentWorkerSpawner(): Spawner {
  let spawner: Promise<Spawner> | undefined;
  return async (context) => {
    spawner ??= import('./spawn-worker.js').then((chunk) => chunk.createDocumentWorkerSpawner());
    try {
      return await (await spawner)(context);
    } catch (error) {
      spawner = undefined; // chunk failed (offline): the worker supervisor's restart retries the import
      return err(toSfError(error));
    }
  };
}
