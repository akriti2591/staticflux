import { ok } from '@staticflux/core';
import {
  createPublisher,
  createReplica,
  createSupervisedWorker,
  defineProtocol,
  event,
  inMemorySpawner,
  type PortPair,
  request,
  runWorker,
} from '@staticflux/worker';
import { describe, expect, it } from 'vitest';
import {
  createDocumentEngine,
  createPresenceStore,
  createViewProjection,
  defineComponent,
  defineTextComponent,
  type DocumentArchive,
  type DocumentEngine,
  documentReplica,
  PresenceReplica,
  projectReplica,
  restoreDocumentEngine,
} from './index.js';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i += 1) await tick();
};

const Block = defineComponent('studio/block', { order: 'string', kind: 'string' });
const Body = defineTextComponent('studio/body');
const components = [Block, Body] as const;

const DocReplica = documentReplica('studio/doc-42');
const DocProtocol = defineProtocol({
  id: 'studio/document',
  version: 1,
  requests: { archive: request<null, DocumentArchive>({ idempotent: true }) },
  events: { archived: event<DocumentArchive>() },
});

function documentWorker() {
  const pairs: PortPair[] = [];
  const engines: DocumentEngine[] = [];
  const spawn = inMemorySpawner((port, context) => {
    pairs.push(context.pair);
    let engine: DocumentEngine;
    void runWorker({
      port,
      protocol: DocProtocol,
      handlers: (runtime) => {
        // Rehydrate from the last archive after a respawn (LIFECYCLES §3).
        const restored = runtime.rehydrate === undefined ? undefined : restoreDocumentEngine(runtime.rehydrate, { clientId: 1, components });
        engine = restored?.ok === true ? restored.value : createDocumentEngine({ clientId: 1, components, telemetry: runtime.telemetry });
        engines.push(engine);
        return {
          archive: () => engine.snapshot(),
        };
      },
      setup: (runtime) => {
        runtime.publish(createPublisher({ definition: DocReplica, source: engine }));
        runtime.publish(createPublisher({ definition: PresenceReplica, source: createPresenceStore({ localId: 'worker-user', now: () => 0 }) }));
        engine.observe(() => {
          const archive = engine.snapshot();
          if (archive.ok) runtime.emit('archived', archive.value);
        });
        return ok();
      },
    });
  });
  return { pairs, engines, spawn };
}

describe('document worker (owner) → main-thread replica + projection', () => {
  it('replicates over ports, edits are intents, respawn rehydrates from the last archive', async () => {
    const worker = documentWorker();
    const replica = createReplica(DocReplica);
    const presence = createReplica(PresenceReplica);
    const projection = createViewProjection();
    projectReplica(replica, projection);
    let lastArchive: DocumentArchive | undefined;
    const supervised = createSupervisedWorker({
      id: 'studio/document-worker',
      protocol: DocProtocol,
      spawn: worker.spawn,
      replicas: [replica, presence],
      rehydrate: () => lastArchive,
      heartbeat: false,
      restart: { baseDelayMs: 0, jitter: 'none' },
      fallback: { description: 'read-only document view' },
    });
    supervised.on('archived', (archive) => {
      lastArchive = archive;
    });
    expect((await supervised.start()).ok).toBe(true);
    expect(replica.status).toBe('live');

    // Main thread writes are intents to the owning engine (I-9).
    const created = await replica.intent('createEntity', { components: { 'studio/block': { order: 'a', kind: 'text' }, 'studio/body': 'Hello' } });
    expect(created).toEqual(ok('1-1'));
    expect(await replica.intent('insertText', { entity: '1-1', component: 'studio/body', index: 5, text: ' world' })).toEqual(ok(null));
    expect(projection.text('1-1', 'studio/body')).toBe('Hello world');
    expect(projection.values('1-1', 'studio/block')).toEqual({ order: 'a', kind: 'text' });
    expect(replica.state.entities['1-1']?.['studio/body']).toEqual({ kind: 'text', text: 'Hello world' });
    expect(() => {
      (replica.state.entities as Record<string, unknown>)['x'] = {};
    }).toThrowError(expect.objectContaining({ code: 'SF-WK-002' }));

    // Presence is a separate replicated store.
    expect(await presence.intent('setLocal', { name: 'Ada', cursor: { entity: '1-1', index: 3 } })).toEqual(ok(null));
    expect(presence.state.participants['worker-user']?.state.name).toBe('Ada');

    await settle();
    expect(lastArchive?.format).toBe('sf-document');
    const archived = await supervised.request('archive', null);
    expect(archived.ok && archived.value.clientId).toBe(1);

    // Crash → respawn → rehydrate → replicas resnapshot; the projection resets to the same content.
    const before = projection.entities();
    worker.pairs[0]?.crash(new Error('worker OOM'));
    expect((await supervised.whenReady()).ok).toBe(true);
    expect(supervised.inspect().attempt).toBe(2);
    expect(worker.engines).toHaveLength(2);
    expect(replica.status).toBe('live');
    expect(projection.entities()).toEqual(before);
    expect(projection.text('1-1', 'studio/body')).toBe('Hello world');

    // Ids continue deterministically after the restore; edits keep flowing.
    expect(await replica.intent('createEntity', { components: { 'studio/body': 'second' } })).toEqual(ok('1-2'));
    expect(projection.entities()).toEqual(['1-1', '1-2']);
    const rejected = await replica.intent('insertText', { entity: '1-2', component: 'studio/body', index: 99, text: 'x' });
    expect(!rejected.ok && rejected.error.code).toBe('SF-DOC-004');

    expect((await supervised.stop()).ok).toBe(true);
  });
});

describe('presence store', () => {
  it('tracks participants, expires stale remotes, and is replicable', () => {
    let now = 0;
    const store = createPresenceStore({ localId: 'me', ttlMs: 100, now: () => now });
    const patches: unknown[] = [];
    store.onPatches((p) => patches.push(...p));
    const local: unknown[] = [];
    store.onLocalChange((s) => local.push(s));
    store.setLocal({ name: 'Me' });
    store.applyRemote('you', { name: 'You', cursor: { entity: 'e', index: 1 } });
    store.applyRemote('me', { name: 'spoof' });
    expect(store.participants().map((p) => [p.id, p.local])).toEqual([
      ['me', true],
      ['you', false],
    ]);
    expect(store.getSnapshot().participants['me']?.state.name).toBe('Me');
    now = 500;
    expect(store.expire()).toEqual(['you']);
    store.applyRemote('ghost', null);
    expect(store.applyIntent('setLocal', null)).toEqual(ok(null));
    expect(store.local).toBeNull();
    expect(store.applyIntent('nope', null).ok).toBe(false);
    expect(local).toEqual([{ name: 'Me' }, null]);
    expect(patches).toHaveLength(4);
  });
});
