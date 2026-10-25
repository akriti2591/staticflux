/**
 * The export worker's side (C1): serves `ExportWorkerProtocol` on a port. `start` opens the store port and loads the
 * job environment (the authoring Wasm and fonts to compose scenes, a headless render module, the export Wasm on first
 * need); `run` runs one `runExportJob` with the request's cancellation and posts its progress.
 *
 * @example
 * // export.worker.ts
 * hostExportWorker({ port: fromWorkerScope(self), env: browserExportEnvironment });
 */
import { err, ok, type Result } from '@staticflux/core';
import { createLink, createProtocolClient, createProtocolServer, type Link, type Port, type ProtocolServer } from '@staticflux/worker';
import { toPort } from '@staticflux/worker/pipeline';
import type { StudioAssets } from '../workers/protocol.js';
import { remoteBlobs, remoteDocumentStore, StudioStoreProtocol } from '../workers/store-port.js';
import { ExportWorkerError } from './errors.js';
import { type ExportJobEnv, runExportJob } from './job.js';
import { ExportWorkerProtocol } from './protocol.js';

/** What the export worker loads (the browser entry's pieces; fixtures in tests). */
export interface ExportWorkerEnvironment {
  load(assets: StudioAssets, signal: AbortSignal): Promise<Result<ExportJobEnv>>;
}

export interface ExportWorkerHost {
  readonly link: Link;
  dispose(): void;
}

/** Serve the export protocol on `port` (see the module header). */
export function hostExportWorker(options: { readonly port: Port; readonly env: ExportWorkerEnvironment; readonly name?: string }): ExportWorkerHost {
  const link = createLink({ port: options.port, name: options.name ?? 'instaflow/export-worker' });
  const lifetime = new AbortController();
  let env: ExportJobEnv | undefined;
  let io: { readonly store: ReturnType<typeof remoteDocumentStore>; readonly blobs: ReturnType<typeof remoteBlobs> } | undefined;
  let storeLink: Link | undefined;
  const server: ProtocolServer<typeof ExportWorkerProtocol> = createProtocolServer(link, ExportWorkerProtocol, {
    async start({ assets, store }) {
      if (env !== undefined) return err(ExportWorkerError({ message: 'This export worker was already started.' }));
      const port = toPort(store);
      if (port === undefined) return err(ExportWorkerError({ message: 'The export worker needs the store port (a MessagePort).', details: { step: 'store port' } }));
      storeLink = createLink({ port, name: 'instaflow/export-store' });
      const client = createProtocolClient(storeLink, StudioStoreProtocol);
      io = { store: remoteDocumentStore(client), blobs: remoteBlobs(client) };
      const loaded = await options.env.load(assets, lifetime.signal);
      if (!loaded.ok) return err(ExportWorkerError({ cause: loaded.error, details: { step: 'load' } }));
      env = loaded.value;
      return ok();
    },
    async run(request, context) {
      if (env === undefined || io === undefined) return err(ExportWorkerError({ message: 'The export worker has not started.' }));
      const result = await runExportJob(request, env, io, { signal: context.signal, onProgress: (p) => void server.emit('progress', p) });
      return result.ok ? ok({ files: result.value.files, patches: result.value.patches, missingImages: result.value.missingImages }) : result;
    },
    async stop() {
      dispose();
      return ok();
    },
  });
  const dispose = (): void => {
    lifetime.abort();
    storeLink?.close();
  };
  link.onClose(() => {
    dispose();
    server.dispose();
  });
  return {
    link,
    dispose() {
      dispose();
      server.dispose();
      link.close();
    },
  };
}
