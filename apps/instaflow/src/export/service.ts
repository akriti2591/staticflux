/**
 * The export service on the main thread (C1; IF-29.7–29.12): one job at a time, each in a fresh export worker (on
 * demand, ARCHITECTURE §2), so exporting never blocks editing.
 *
 * 1. The editor freezes Latest into a snapshot (B5: blobs only, no record, no head change: D10) and says which pages
 *    and which selection there are (`target`).
 * 2. A worker is spawned; main serves it the store port (the snapshot's parts, the image blobs) and starts it with the
 *    engine Wasm manifest and fonts.
 * 3. The job runs there with the request's cancellation; progress comes back as events.
 * 4. Main hands the files to `deliver` (the browser's download), then stops the worker.
 *
 * `status` is plain, reactive data for the Export panel and agents (`ExportPanelPort`).
 */
import type { BlobStore } from '@staticflux/blob';
import { AbortedError, box, err, ok, type Result, type SfError } from '@staticflux/core';
import type { DocumentStore, NodeId } from '@staticflux/document/v2';
import { createLink, createProtocolClient, fromMessagePort, type Port, type Spawner } from '@staticflux/worker';
import type { LibraryEntry } from '../library/library-doc.js';
import type { StudioAssets } from '../workers/protocol.js';
import { serveStudioStore } from '../workers/store-port.js';
import { ExportDeliveryError, ExportWorkerError, NothingToExportError } from './errors.js';
import { EXPORT_FORMATS, type ExportFile, type ExportOptions } from './formats.js';
import type { ExportProgress } from './job.js';
import { ExportWorkerProtocol, type ExportWorkerResult } from './protocol.js';
import type { ExportSnapshot } from './snapshot-document.js';

/** What the editor reports at export start. */
export interface ExportTarget {
  readonly snapshot: ExportSnapshot;
  /** The page shown (exported for `page` and `selection`). */
  readonly page: NodeId | undefined;
  readonly pages: readonly NodeId[];
  readonly selection: readonly NodeId[];
}

/** A finished file as the panel and agents see it (no bytes). */
export interface ExportedFileInfo {
  readonly name: string;
  readonly mime: string;
  readonly size: number;
}

export type ExportStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly options: ExportOptions; readonly progress: ExportProgress | undefined }
  | { readonly kind: 'done'; readonly options: ExportOptions; readonly files: readonly ExportedFileInfo[]; readonly missingImages: readonly string[] }
  | { readonly kind: 'failed'; readonly options: ExportOptions; readonly message: string; readonly code: string }
  | { readonly kind: 'cancelled'; readonly options: ExportOptions };

export interface ExportOutcome extends ExportWorkerResult {
  readonly options: ExportOptions;
}

export interface ExportServiceOptions {
  /** Spawns one export worker (`export.worker.ts` in the browser; in-process in tests). */
  readonly spawn: () => Spawner;
  /** Engine Wasm manifest and fonts (the same the Studio workers load). */
  readonly assets: StudioAssets;
  /** The store side main serves (snapshot parts, image blobs). */
  readonly store: { readonly store: DocumentStore; readonly blobs: Pick<BlobStore, 'get'> };
  /** Freeze the snapshot and read pages and selection (the editor worker). */
  readonly target: (signal: AbortSignal) => Promise<Result<ExportTarget>>;
  /** The design's title (file names, SVG title, PDF info). */
  readonly title: () => string;
  /** The workspace's image library entries (the snapshot's image paints resolve against them). */
  readonly images: () => readonly LibraryEntry[];
  /** Hand files to the person (default none: the outcome carries the bytes). */
  readonly deliver?: (files: readonly ExportFile[], signal: AbortSignal) => Promise<Result<void>>;
}

export interface ExportService {
  /** Reactive. */
  readonly status: ExportStatus;
  onChange(listener: (status: ExportStatus) => void): () => void;
  /** Export now (one job at a time: a second call while one runs is refused). */
  run(options: ExportOptions, signal?: AbortSignal): Promise<Result<ExportOutcome>>;
  /** Cancel the running export (no-op when idle). */
  cancel(): void;
  dispose(): void;
}

const fileInfo = (f: ExportFile): ExportedFileInfo => ({ name: f.name, mime: f.mime, size: f.bytes.length });

/** The browser's download, one anchor click per file (IF-EXP-008 when it throws). */
export function browserDownload(files: readonly ExportFile[]): Promise<Result<void>> {
  try {
    for (const file of files) {
      const url = URL.createObjectURL(new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.mime }));
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      a.rel = 'noopener';
      a.style.display = 'none';
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
    return Promise.resolve(ok());
  } catch (cause) {
    return Promise.resolve(err(ExportDeliveryError({ cause })));
  }
}

export function createExportService(options: ExportServiceOptions): ExportService {
  const state = box<ExportStatus>({ kind: 'idle' });
  const listeners = new Set<(status: ExportStatus) => void>();
  const set = (next: ExportStatus): void => {
    state.set(next);
    for (const l of [...listeners]) l(next);
  };
  let running: AbortController | undefined;
  let disposed = false;

  const runJob = async (opts: ExportOptions, signal: AbortSignal): Promise<Result<ExportOutcome>> => {
    const target = await options.target(signal);
    if (!target.ok) return target;
    const t = target.value;
    const page = t.page ?? t.pages[0];
    if (page === undefined) return err(NothingToExportError({ message: 'The design has no page to export.' }));
    if (opts.scope === 'selection' && t.selection.length === 0) return err(NothingToExportError({ message: 'Select one or more elements to export the selection.', details: { selection: 0 } }));
    if (typeof MessageChannel !== 'function') return err(ExportWorkerError({ message: 'No MessageChannel for the export worker’s store port.' }));
    const spawned = await options.spawn()({ signal, attempt: 1 });
    if (!spawned.ok) return err(ExportWorkerError({ cause: spawned.error, details: { step: 'spawn' } }));
    const worker = spawned.value;
    const link = createLink({ port: worker.port, name: 'instaflow/export' });
    const client = createProtocolClient(link, ExportWorkerProtocol);
    const channel = new MessageChannel();
    const storeLink = createLink({ port: fromMessagePort(channel.port1) as Port, name: 'instaflow/export-store-side' });
    const storeServer = serveStudioStore(storeLink, options.store);
    const crashed = new Promise<Result<never>>((resolve) => worker.port.onError((error: SfError) => resolve(err(ExportWorkerError({ cause: error, details: { step: 'crash' } })))));
    const off = client.on('progress', (progress: ExportProgress) => {
      if (running?.signal === signal) set({ kind: 'running', options: opts, progress });
    });
    try {
      const started = await Promise.race([client.request('start', { assets: options.assets, store: channel.port2 }, { transfer: [channel.port2], signal }), crashed]);
      if (!started.ok) return started.error.kind === 'aborted' ? started : err(ExportWorkerError({ cause: started.error, details: { step: 'start' } }));
      const request = {
        snapshot: t.snapshot,
        options: opts,
        title: options.title(),
        pages: opts.scope === 'pages' ? t.pages : [page],
        selection: opts.scope === 'selection' ? t.selection : [],
        images: options.images(),
      };
      const done = await Promise.race([client.request('run', request, { signal }), crashed]);
      if (!done.ok) return done;
      if (options.deliver !== undefined) {
        const delivered = await options.deliver(done.value.files, signal);
        if (!delivered.ok) return delivered;
      }
      return ok({ ...done.value, options: opts });
    } finally {
      off();
      void client.request('stop', undefined, { timeoutMs: 2_000 }).finally(() => {
        link.close();
        worker.terminate();
      });
      storeServer.dispose();
      storeLink.close();
    }
  };

  return {
    get status() {
      return state.get();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async run(opts, outer) {
      if (disposed) return err(ExportWorkerError({ message: 'The export service was disposed.' }));
      if (running !== undefined) return err(ExportWorkerError({ message: 'An export is already running; cancel it or wait for it to finish.', details: { step: 'busy' } }));
      const controller = new AbortController();
      running = controller;
      const stop = (): void => controller.abort(outer?.reason);
      const detach = new AbortController();
      if (outer?.aborted === true) stop();
      else outer?.addEventListener('abort', stop, { once: true, signal: detach.signal });
      set({ kind: 'running', options: opts, progress: undefined });
      try {
        const result = controller.signal.aborted ? err(AbortedError({})) : await runJob(opts, controller.signal);
        if (result.ok) set({ kind: 'done', options: opts, files: result.value.files.map(fileInfo), missingImages: result.value.missingImages });
        else if (result.error.kind === 'aborted' || controller.signal.aborted) set({ kind: 'cancelled', options: opts });
        else set({ kind: 'failed', options: opts, message: result.error.message, code: result.error.code });
        return controller.signal.aborted && result.ok ? err(AbortedError({})) : result;
      } finally {
        detach.abort();
        running = undefined;
      }
    },
    cancel() {
      running?.abort(new Error('cancelled by the person'));
    },
    dispose() {
      disposed = true;
      running?.abort(new Error('Studio closed'));
      listeners.clear();
    },
  };
}

/** The format row of an outcome's files (agents read it). */
export const formatOf = (options: ExportOptions): (typeof EXPORT_FORMATS)[keyof typeof EXPORT_FORMATS] => EXPORT_FORMATS[options.format];
