/**
 * Spawners create a worker and hand back its Port. The supervisor calls the
 * spawner on every (re)spawn. Real adapters are feature-detected; the
 * in-memory spawner runs worker code in-thread over a port pair (tests,
 * and an in-thread fallback when workers are unavailable).
 */
import { err, ok, type Result, toSfError } from '@staticflux/core';
import { SpawnFailedError, WorkerUnsupportedError } from './errors.js';
import { createPortPair, fromSharedWorker, fromWorker, fromMessagePort, type Port, type PortPair, type PortPairOptions } from './port.js';

export interface SpawnedWorker {
  readonly port: Port;
  /** Hard stop (Worker.terminate / close the shared port / close the pair). */
  terminate(): void;
}

export interface SpawnContext {
  readonly signal: AbortSignal;
  /** 1-based spawn attempt (respawns increment it). */
  readonly attempt: number;
}

export type Spawner = (context: SpawnContext) => Result<SpawnedWorker> | Promise<Result<SpawnedWorker>>;

export function supportsWorker(): boolean {
  return typeof (globalThis as { Worker?: unknown }).Worker === 'function';
}

export function supportsSharedWorker(): boolean {
  return typeof (globalThis as { SharedWorker?: unknown }).SharedWorker === 'function';
}

/** Spawn a dedicated worker, e.g. `dedicatedWorkerSpawner(() => new Worker(new URL('./doc.worker.js', import.meta.url), { type: 'module' }))`. */
export function dedicatedWorkerSpawner(create: () => Worker): Spawner {
  return () => {
    if (!supportsWorker()) return err(WorkerUnsupportedError({ details: { kind: 'Worker' } }));
    try {
      const worker = create();
      return ok({ port: fromWorker(worker), terminate: () => worker.terminate() });
    } catch (error) {
      return err(SpawnFailedError({ cause: toSfError(error), details: { kind: 'Worker' } }));
    }
  };
}

/** Connect to a SharedWorker (cross-tab coordinator); falls back when unsupported. */
export function sharedWorkerSpawner(create: () => SharedWorker, fallback?: Spawner): Spawner {
  return (context) => {
    if (!supportsSharedWorker()) {
      return fallback === undefined ? err(WorkerUnsupportedError({ details: { kind: 'SharedWorker' } })) : fallback(context);
    }
    try {
      const worker = create();
      const port = fromSharedWorker(worker);
      return ok({ port, terminate: () => port.close() });
    } catch (error) {
      return err(SpawnFailedError({ cause: toSfError(error), details: { kind: 'SharedWorker' } }));
    }
  };
}

export interface InMemoryWorkerContext extends SpawnContext {
  readonly pair: PortPair;
}

/**
 * Run `start(workerPort, context)` in-thread as the "worker". The supervisor
 * gets `pair.a`; `pair.crash()` simulates a crash, `pair.b.freeze()` a hang.
 */
export function inMemorySpawner(start: (port: Port, context: InMemoryWorkerContext) => void, options: PortPairOptions = {}): Spawner {
  return (context) => {
    const pair = createPortPair(options);
    try {
      start(pair.b, { ...context, pair });
    } catch (error) {
      pair.close();
      return err(SpawnFailedError({ cause: toSfError(error), details: { kind: 'in-memory' } }));
    }
    return ok({ port: pair.a, terminate: () => pair.close() });
  };
}

/** Shape of a SharedWorker global scope (the `connect` event source). */
export interface SharedWorkerScopeLike {
  addEventListener(type: 'connect', listener: (event: Event) => void): void;
  removeEventListener(type: 'connect', listener: (event: Event) => void): void;
}

/** Inside a SharedWorker: call `onConnect` with a Port for every connecting tab. */
export function acceptSharedConnections(scope: SharedWorkerScopeLike, onConnect: (port: Port) => void): () => void {
  const listener = (event: Event): void => {
    const port = (event as MessageEvent).ports[0];
    if (port !== undefined) onConnect(fromMessagePort(port));
  };
  // sf-lint-disable-next-line no-bare-listener -- removed by the returned stop function; SharedWorkerScopeLike takes no listener options
  scope.addEventListener('connect', listener);
  return () => scope.removeEventListener('connect', listener);
}
