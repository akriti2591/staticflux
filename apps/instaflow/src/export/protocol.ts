/**
 * The export worker's protocol (C1; ARCHITECTURE §2 "Export workers: on demand, one job each"). Data only, so both
 * threads import it without module code.
 *
 *   main ──start (Wasm manifest, fonts, the store port)──▶ export worker
 *   main ──run (snapshot, options, pages, selection, image entries)──▶ … ◀──progress (events)
 *   main ◀──files (bytes) ─────────────────────────────────────────────┘     (cancel: abort the request)
 *
 * The worker reads the snapshot through the store port (`StudioStoreProtocol`, served by main like the editor's) and
 * writes nothing; main delivers the files.
 */
import { defineProtocol, event, request } from '@staticflux/worker';
import type { StudioAssets } from '../workers/protocol.js';
import type { ExportFile } from './formats.js';
import type { ExportJobRequest, ExportProgress } from './job.js';

export interface ExportWorkerStart {
  readonly assets: StudioAssets;
  /** The store port (a `MessagePort` in the browser, an in-memory `Port` in tests). */
  readonly store: unknown;
}

export interface ExportWorkerResult {
  readonly files: readonly ExportFile[];
  readonly patches: number;
  readonly missingImages: readonly string[];
}

export const ExportWorkerProtocol = /* @__PURE__ */ defineProtocol({
  id: 'instaflow/export-worker',
  version: 1,
  requests: {
    start: request<ExportWorkerStart, void>({ timeoutMs: 60_000 }),
    /** One job. Large designs at 3× take a while on SwiftShader; the request is cancellable. */
    run: request<ExportJobRequest, ExportWorkerResult>({ timeoutMs: 900_000 }),
    stop: request<void, void>({ timeoutMs: 10_000 }),
  },
  events: {
    progress: event<ExportProgress>(),
  },
});
