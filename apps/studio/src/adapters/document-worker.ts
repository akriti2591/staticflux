/**
 * Adapter: @staticflux/document (engine in the worker, projection on the main
 * thread) ⇄ @staticflux/worker (supervised worker + replication), plus the data
 * endpoints that load/save the document.
 *
 *   worker: DocumentEngine ──publisher──► main: Replica<DocumentView> ──► ViewProjection ──► DocumentStore
 *   main:   store.insertText() ──intent──► worker: engine.applyIntent()   (I-9)
 *
 * The supervised worker respawns with the last archive (rehydrate); when it gives up
 * the declared fallback makes the store read-only and the app goes `degraded`.
 *
 * This module is the lazy half of the document runtime (`app/document.ts` imports it on
 * first use), so the worker/replication/document code stays out of the boot chunk.
 */
import { batch, box, derived, err, ok, type Result, type Scope, type Telemetry, untracked } from '@staticflux/core';
import type { DataClient } from '@staticflux/data';
import { createViewProjection, type DocumentArchive, keyBetween, PresenceReplica, projectReplica } from '@staticflux/document';
import { defineSubsystem, type Subsystem } from '@staticflux/runtime';
import { type ContextHub, createReplica, createSupervisedWorker, type Spawner, type SupervisedWorker } from '@staticflux/worker';
import type { DocumentRuntime } from '../app/document.js';
import type { BlockView, DocumentStore, PresenceFeed } from '../app/contracts.js';
import { type BlockRecord, DocGetEndpoint, DocSaveEndpoint } from '../app/endpoints.js';
import { DocumentWorkerGaveUpError, ReadOnlyDocumentError } from '../app/errors.js';
import { BlockComponent, BodyComponent, DocumentReplica, DocumentWorkerProtocol } from '../worker/protocol.js';

export type DocumentWorker = SupervisedWorker<typeof DocumentWorkerProtocol>;

export interface DocumentWorkerHandle {
  readonly worker: DocumentWorker;
  readonly replica: ReturnType<typeof createReplica<typeof DocumentReplica>>;
  readonly presence: ReturnType<typeof createReplica<typeof PresenceReplica>>;
  readonly readOnly: { get(): boolean };
  lastArchive(): DocumentArchive | undefined;
}

function createWorkerHandle(spawn: Spawner, contexts: ContextHub, telemetry: Telemetry, scope: Scope): DocumentWorkerHandle {
    {
      const replica = createReplica(DocumentReplica, { initial: { entities: {} } });
      const presence = createReplica(PresenceReplica, { initial: { participants: {} } });
      const readOnly = box(false);
      let archive: DocumentArchive | undefined;
      const worker = createSupervisedWorker({
        id: 'studio/document-worker',
        protocol: DocumentWorkerProtocol,
        spawn,
        contexts,
        replicas: [replica, presence],
        rehydrate: () => archive,
        telemetry,
        heartbeat: { intervalMs: 5_000, timeoutMs: 4_000, maxMissed: 3 },
        restart: { intensity: 3, periodMs: 60_000, baseDelayMs: 50 },
        fallback: {
          description: 'Read-only document view (edits disabled until the worker recovers).',
          activate: () => readOnly.set(true),
          deactivate: () => readOnly.set(false),
        },
      });
      scope.defer(
        worker.on('archived', (payload) => {
          archive = payload.archive;
        }),
      );
      scope.defer(() => worker.stop('shutdown'));
      return { worker, replica, presence, readOnly, lastArchive: () => archive };
    }
}

/** The worker as a runtime subsystem: give-up → app `degraded` (R4.4). */
function workerSubsystem(handle: DocumentWorkerHandle): Subsystem {
  return defineSubsystem({
      id: 'worker/document',
      critical: false,
      restart: { mode: 'temporary', maxRestarts: 0, windowMs: 60_000 },
      start: async (ctx) => {
        const started = await handle.worker.start({ signal: ctx.signal, epoch: ctx.epoch });
        if (!started.ok) return started;
        ctx.scope.defer(
          handle.worker.onStateChange((record) => {
            if (record.to === 'failed') ctx.fail(DocumentWorkerGaveUpError({ cause: handle.worker.lastError }));
          }),
        );
        return ok();
      },
      pause: () => handle.worker.pause(),
      resume: () => handle.worker.resume(),
      refresh: (epoch) => handle.worker.refresh(epoch),
      stop: async () => {
        await handle.worker.stop('shutdown');
      },
      description: 'Document worker (engine owner).',
    });
}

const SAVE_DELAY_MS = 300;

function toRecord(block: BlockView): BlockRecord {
  return block.kind === 'image' ? { kind: 'image', src: block.src, text: block.text } : { kind: 'text', text: block.text };
}

function createDocumentStore(handle: DocumentWorkerHandle, client: DataClient, scope: Scope): DocumentStore {
  {
    const ctx = { scope, signal: scope.signal };
    const projection = createViewProjection();
    ctx.scope.defer(projectReplica(handle.replica, projection));
    const docId = box<string | undefined>(undefined);
    const title = box('');
    const status = box<DocumentStore['status']>('idle');
    const pending = box(false);
    const tab = box<'content' | 'comments' | 'history' | undefined>(undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inflight: Promise<Result<void>> | undefined;

    const blocks = derived((): readonly BlockView[] => {
      void projection.revision;
      return projection
        .entities()
        .map((id): BlockView | undefined => {
          const values = projection.values(id, BlockComponent.id);
          if (values === undefined) return undefined;
          return {
            id,
            kind: values['kind'] === 'image' ? 'image' : 'text',
            order: typeof values['order'] === 'string' ? values['order'] : '',
            src: typeof values['src'] === 'string' ? values['src'] : '',
            text: projection.text(id, BodyComponent.id) ?? '',
          };
        })
        .filter((b): b is BlockView => b !== undefined)
        .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id.localeCompare(b.id)));
    });

    const save = async (): Promise<Result<void>> => {
      const id = untracked(() => docId.get());
      if (id === undefined) return ok();
      const result = await client.call(DocSaveEndpoint, { id, title: untracked(() => title.get()), blocks: untracked(() => blocks.get()).map(toRecord) }, { signal: ctx.signal });
      pending.set(timer !== undefined);
      return result.ok ? ok() : err(result.error);
    };
    const scheduleSave = (): void => {
      pending.set(true);
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        inflight = save();
      }, SAVE_DELAY_MS);
    };
    ctx.scope.defer(() => {
      if (timer !== undefined) clearTimeout(timer);
    });

    const writable = (): Result<void> => (untracked(() => handle.readOnly.get()) ? err(ReadOnlyDocumentError()) : ok());

    const store: DocumentStore = {
      get docId() {
        return docId.get();
      },
      get title() {
        return title.get();
      },
      get status() {
        return status.get();
      },
      get blocks() {
        return blocks.get();
      },
      get pendingSave() {
        return pending.get();
      },
      get readOnly() {
        return handle.readOnly.get();
      },
      tab,
      async open(id, signal) {
        if (untracked(() => docId.get()) === id && untracked(() => status.get()) === 'ready') return ok();
        await store.flush(signal);
        batch(() => {
          docId.set(id);
          status.set('loading');
        });
        const loaded = await client.call(DocGetEndpoint, { id }, signal === undefined ? {} : { signal });
        if (!loaded.ok) {
          status.set('error');
          return err(loaded.error);
        }
        title.set(loaded.value.title);
        const ready = await handle.worker.whenReady(signal);
        if (!ready.ok) {
          status.set('error');
          return ready;
        }
        const opened = await handle.worker.request('open', { docId: id, blocks: loaded.value.blocks }, signal === undefined ? {} : { signal });
        if (!opened.ok) {
          status.set('error');
          return err(opened.error);
        }
        status.set('ready');
        return ok();
      },
      async insertText(text) {
        const allowed = writable();
        if (!allowed.ok) return allowed;
        const last = untracked(() => blocks.get()).at(-1);
        const created = await handle.replica.intent('createEntity', {
          components: { [BlockComponent.id]: { order: keyBetween(last?.order, undefined), kind: 'text', src: '' }, [BodyComponent.id]: text },
        });
        if (created.ok) scheduleSave();
        return created;
      },
      async insertImage(src, alt = '') {
        const allowed = writable();
        if (!allowed.ok) return allowed;
        const last = untracked(() => blocks.get()).at(-1);
        const created = await handle.replica.intent('createEntity', {
          components: { [BlockComponent.id]: { order: keyBetween(last?.order, undefined), kind: 'image', src }, [BodyComponent.id]: alt },
        });
        if (created.ok) scheduleSave();
        return created;
      },
      async editText(blockId, text) {
        const current = untracked(() => blocks.get()).find((b) => b.id === blockId);
        if (current === undefined) return ok();
        const removed = await handle.replica.intent('deleteText', { entity: blockId, component: BodyComponent.id, index: 0, length: current.text.length });
        if (!removed.ok) return removed;
        const inserted = await handle.replica.intent('insertText', { entity: blockId, component: BodyComponent.id, index: 0, text });
        if (!inserted.ok) return inserted;
        scheduleSave();
        return ok();
      },
      async clear() {
        const all = untracked(() => blocks.get());
        for (const block of all) {
          const destroyed = await handle.replica.intent('destroy', { entity: block.id });
          if (!destroyed.ok) return destroyed;
        }
        scheduleSave();
        return ok(all.length);
      },
      rename(next) {
        title.set(next);
        scheduleSave();
      },
      async flush() {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
          inflight = save();
        }
        const result = inflight === undefined ? ok() : await inflight;
        inflight = undefined;
        pending.set(false);
        return result;
      },
      plainText() {
        return untracked(() => blocks.get())
          .map((b) => b.text)
          .join('\n');
      },
    };
    return store;
  }
}

function createPresenceFeed(handle: DocumentWorkerHandle): PresenceFeed {
  return {
    get view() {
      return handle.presence.state as PresenceFeed['view'];
    },
    async setLocal(name, cursor) {
      const result = await handle.presence.intent('setLocal', { name, cursor });
      return result.ok ? ok() : err(result.error);
    },
  };
}

export interface DocumentRuntimeDeps {
  readonly spawn: Spawner;
  readonly contexts: ContextHub;
  readonly client: DataClient;
  readonly telemetry: Telemetry;
  readonly scope: Scope;
}

/** Build the document runtime (worker + replicas + store + presence) and its subsystem. */
export function createDocumentRuntime(deps: DocumentRuntimeDeps): DocumentRuntime & { readonly subsystem: Subsystem } {
  const handle = createWorkerHandle(deps.spawn, deps.contexts, deps.telemetry, deps.scope);
  return {
    store: createDocumentStore(handle, deps.client, deps.scope),
    presence: createPresenceFeed(handle),
    lastArchive: () => handle.lastArchive(),
    workerState: () => handle.worker.state,
    subsystem: workerSubsystem(handle),
  };
}
