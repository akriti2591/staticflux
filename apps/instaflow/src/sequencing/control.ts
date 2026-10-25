/**
 * Control protocol between main and a sequencing worker (boot only; frames, deltas and input never
 * travel here — they use the pipes in `protocol.ts`).
 */
import type { PeerId } from '@staticflux/document/v2';
import { defineProtocol, event, request } from '@staticflux/worker';
import type { RegionEndpoint } from '@staticflux/worker/pipeline';
import type { EditorFinal } from './editor-core.js';
import type { EditorModuleStats } from './editor-module.js';
import type { PresentedRecord, RenderFinal, RenderModuleStats } from './render-module.js';
import type { ModuleRole, SequencingMedia, SequencingSettings } from './topology.js';

export interface ScheduledRemoteUpdate {
  readonly after: number;
  readonly update: Uint8Array;
}

export interface StartArgs {
  readonly roles: readonly ModuleRole[];
  readonly settings: SequencingSettings;
  readonly media: SequencingMedia;
  /** Snapshot of the scene part the editor opens. */
  readonly scene: Uint8Array;
  readonly peer: PeerId;
  /** Input ring endpoint (editor role). */
  readonly input?: RegionEndpoint;
  /** Main tick endpoint (render role). */
  readonly tick?: RegionEndpoint;
  /** Scripted remote updates (the oracle's simulated peer). */
  readonly remote?: readonly ScheduledRemoteUpdate[];
  readonly dropDeltaEvery?: number;
  /** Keep a presented-frame log (oracle, bench). */
  readonly record?: boolean;
}

export interface PipeEndpoints {
  readonly frames: RegionEndpoint;
  readonly deltas: RegionEndpoint;
}

export interface WorkerFinal {
  readonly editor?: EditorFinal & { readonly stats: EditorModuleStats };
  readonly render?: RenderFinal & { readonly stats: RenderModuleStats };
  readonly presented?: readonly PresentedRecord[];
}

export const SequencingControl = /* @__PURE__ */ defineProtocol({
  id: 'instaflow/sequencing',
  version: 1,
  requests: {
    start: request<StartArgs, void>({ timeoutMs: 30_000 }),
    attach: request<PipeEndpoints, void>({ timeoutMs: 30_000 }),
    finish: request<void, WorkerFinal>({ timeoutMs: 60_000 }),
    stop: request<void, void>({ timeoutMs: 10_000 }),
  },
  events: {
    /** An editor-only worker publishes its pipe endpoints; main relays them to the render worker. */
    pipes: event<PipeEndpoints>(),
  },
});
