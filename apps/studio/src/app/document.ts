/**
 * The document runtime as app-level units — loaded lazily (R12.12): nothing here
 * imports the worker/document packages. The first unit that needs a document
 * (an editor feature, or a document capability) resolves `DocumentRuntimeToken`,
 * whose `init` dynamically imports the runtime chunk, builds the core-context hub,
 * the supervised document worker and its replicas, and registers the worker as a
 * runtime subsystem (late registration starts it right away).
 */
import { err, ok, type Result, toSfError, token, unit } from '@staticflux/core';
import type { DocumentArchive } from '@staticflux/document';
import { SessionToken } from '@staticflux/auth';
import { FlagResolverToken } from '@staticflux/config';
import { DataClientToken } from '@staticflux/data';
import { GateToken } from '@staticflux/gate';
import { PlatformFactsToken } from '@staticflux/platform';
import { SupervisorToken } from '@staticflux/runtime';
import type { Spawner } from '@staticflux/worker';
import { type DocumentStore, DocumentStoreToken, type PresenceFeed, PresenceToken } from './contracts.js';

export interface DocumentRuntime {
  readonly store: DocumentStore;
  readonly presence: PresenceFeed;
  lastArchive(): DocumentArchive | undefined;
  workerState(): string;
}

/** Holder filled by `init` (unit `create` is synchronous; the runtime chunk loads async). */
export interface DocumentRuntimeHolder {
  current: DocumentRuntime | undefined;
  /** Loads the runtime chunk (called once by `init`). */
  load(signal: AbortSignal): Promise<Result<void>>;
}
export const DocumentRuntimeToken = token('studio/document-runtime').type<DocumentRuntimeHolder>();

export function documentRuntimeUnit(spawn: Spawner) {
  return unit({
    id: 'studio/document-runtime-unit',
    provides: DocumentRuntimeToken,
    scope: 'app',
    deps: {
      required: { client: DataClientToken, session: SessionToken, flags: FlagResolverToken, gate: GateToken, platform: PlatformFactsToken, supervisor: SupervisorToken },
    },
    create: ({ client, session, flags, gate, platform, supervisor }, ctx): DocumentRuntimeHolder => {
      const holder: DocumentRuntimeHolder = {
        current: undefined,
        async load(signal) {
          let runtime: typeof import('../adapters/document-worker.js');
          let contexts: typeof import('../adapters/worker-core.js');
          try {
            [runtime, contexts] = await Promise.all([import('../adapters/document-worker.js'), import('../adapters/worker-core.js')]);
          } catch (error) {
            return err(toSfError(error));
          }
          if (signal.aborted) return err(toSfError(signal.reason));
          const hub = contexts.createCoreContextHub({ session, flags, gate, platform, telemetry: ctx.telemetry, span: ctx.span, scope: ctx.scope });
          const created = runtime.createDocumentRuntime({ spawn, contexts: hub, client, telemetry: ctx.telemetry, scope: ctx.scope });
          holder.current = created;
          const registered = supervisor.register(created.subsystem);
          return registered.ok ? ok() : registered;
        },
      };
      return holder;
    },
    init: (holder, ctx) => holder.load(ctx.signal),
    description: 'Lazy document runtime (worker + replicas + projection).',
  });
}

export const documentStoreUnit = unit({
  id: 'studio/document-store-unit',
  provides: DocumentStoreToken,
  scope: 'app',
  deps: { required: { runtime: DocumentRuntimeToken } },
  create: ({ runtime }): DocumentStore => {
    if (runtime.current === undefined) throw new Error('document runtime not loaded');
    return runtime.current.store;
  },
});

export const presenceFeedUnit = unit({
  id: 'studio/presence-feed-unit',
  provides: PresenceToken,
  scope: 'app',
  deps: { required: { runtime: DocumentRuntimeToken } },
  create: ({ runtime }): PresenceFeed => {
    if (runtime.current === undefined) throw new Error('document runtime not loaded');
    return runtime.current.presence;
  },
});
