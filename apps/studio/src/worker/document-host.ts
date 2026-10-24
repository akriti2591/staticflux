/**
 * Worker-side document host (R11.8, R11.10): runs inside the document worker (or
 * in-thread over a port pair when workers are unavailable / in tests).
 *
 * - Owns the `DocumentEngine` (ECS world over a Yjs-backed CRDT) and a presence store;
 *   both are published to main-thread replicas. Writes arrive as intents (I-9).
 * - Core contexts (session, flags, decisions, platform, observability) are replicated
 *   in the handshake before any of this runs (R11.1); the session context names the
 *   local participant.
 * - Rehydrates from the last archive after a respawn (LIFECYCLES §3).
 * - A mock collaboration network links a simulated co-editor (presence + edits).
 */
import { ok, type Result } from '@staticflux/core';
import {
  connectCollaboration,
  createDocumentEngine,
  createMockCollaborationNetwork,
  createPresenceStore,
  type DocumentEngine,
  keyBetween,
  PresenceReplica,
  restoreDocumentEngine,
  withComponent,
  withText,
} from '@staticflux/document';
import { CoreContexts, createPublisher, type Port, runWorker } from '@staticflux/worker';
import { BlockComponent, BodyComponent, COLLAB_PEER_NAME, documentComponents, DocumentReplica, DocumentWorkerProtocol, type OpenArgs } from './protocol.js';

const ROOM = 'studio/document-room';

export function startDocumentWorker(port: Port): void {
  let engine: DocumentEngine | undefined;
  let docId = '';
  const presence = createPresenceStore({ localId: 'local', ttlMs: 60_000 });

  const open = (args: OpenArgs): Result<{ readonly entities: number }> => {
    const target = engine;
    if (target === undefined) return ok({ entities: 0 });
    docId = args.docId;
    const result = target.transact((tx) => {
      for (const id of target.query([BlockComponent])) {
        const destroyed = tx.destroy(id);
        if (!destroyed.ok) return destroyed;
      }
      let order: string | undefined;
      for (const block of args.blocks) {
        order = keyBetween(order, undefined);
        const created = tx.createEntity([
          withComponent(BlockComponent, { order, kind: block.kind, src: block.src ?? '' }),
          withText(BodyComponent, block.text ?? ''),
        ]);
        if (!created.ok) return created;
      }
      return ok();
    });
    return result.ok ? ok({ entities: target.query([BlockComponent]).length }) : result;
  };

  void runWorker({
    port,
    protocol: DocumentWorkerProtocol,
    contexts: [CoreContexts.session],
    handlers: (runtime) => {
      const restored = runtime.rehydrate === undefined ? undefined : restoreDocumentEngine(runtime.rehydrate, { clientId: 1, components: documentComponents, telemetry: runtime.telemetry });
      engine =
        restored?.ok === true
          ? restored.value
          : createDocumentEngine({ clientId: runtime.attempt, components: documentComponents, telemetry: runtime.telemetry });
      const current = engine;
      return {
        open: (args) => open(args),
        archive: () => current.snapshot(),
      };
    },
    setup: async (runtime) => {
      const current = engine;
      if (current === undefined) return ok();
      runtime.publish(createPublisher({ definition: DocumentReplica, source: current }));
      runtime.publish(createPublisher({ definition: PresenceReplica, source: presence }));

      // Local participant name from the replicated session context (no tokens cross threads).
      const session = runtime.contexts.get(CoreContexts.session);
      presence.setLocal({ name: session?.userId ?? 'guest', cursor: null });

      // Mock co-editing: a bot peer joins the same room over the in-memory network.
      const network = createMockCollaborationNetwork();
      const bot = createDocumentEngine({ clientId: 99, components: documentComponents });
      const botPresence = createPresenceStore({ localId: 'bot', ttlMs: 60_000 });
      const mine = await network.transport.join(ROOM, 'local', runtime.scope.signal);
      const theirs = await network.transport.join(ROOM, 'bot', runtime.scope.signal);
      if (mine.ok && theirs.ok) {
        const a = connectCollaboration({ engine: current, session: mine.value, presence });
        const b = connectCollaboration({ engine: bot, session: theirs.value, presence: botPresence });
        botPresence.setLocal({ name: COLLAB_PEER_NAME, color: '#f97316', cursor: null });
        runtime.scope.defer(() => {
          if (a.ok) a.value.disconnect();
          if (b.ok) b.value.disconnect();
          bot.dispose();
        });
      }

      current.observe(() => {
        const archive = current.snapshot();
        if (archive.ok) runtime.emit('archived', { docId, archive: archive.value });
      });
      return ok();
    },
  });
}
