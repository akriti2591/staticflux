/**
 * DI tokens/units and replica definitions for documents.
 */
import { type ScopeLevel, type Token, type TokenId, token, unit, type UnitContext, type UnitDefinition } from '@staticflux/core';
import { type ChannelId, defineReplica, type ReplicaDefinition } from '@staticflux/worker';
import type { CollaborationTransport } from './collab.js';
import { createDocumentEngine, type DocumentEngine, type DocumentEngineOptions, type DocumentIntents, type DocumentView } from './engine.js';

export const CollaborationTransportToken = token('document/collaboration-transport').type<CollaborationTransport>();

/** Replica definition for a document view (one per document channel). */
export function documentReplica<const Id extends ChannelId>(id: Id): ReplicaDefinition<Id, DocumentView, DocumentIntents> {
  return defineReplica(id).type<DocumentView, DocumentIntents>();
}

/** A unit providing a document engine (default scope `feature`; disposed with it). */
export function documentEngineUnit<const Id extends TokenId>(options: {
  readonly id: TokenId;
  readonly provides: Token<DocumentEngine, Id>;
  readonly scope?: ScopeLevel;
  readonly engine: (context: UnitContext) => DocumentEngineOptions;
}): UnitDefinition<DocumentEngine, Record<never, never>, Id> {
  return unit<DocumentEngine, Record<never, never>, Id>({
    id: options.id,
    provides: options.provides,
    scope: options.scope ?? 'feature',
    create: (_deps, context) => {
      const engine = createDocumentEngine({ telemetry: context.telemetry, ...options.engine(context) });
      context.scope.defer(() => engine.dispose());
      return engine;
    },
  });
}

/** A unit providing a collaboration transport (e.g. the mock in tests/dev). */
export function collaborationTransportUnit(options: {
  readonly id: TokenId;
  readonly scope?: ScopeLevel;
  readonly transport: (context: UnitContext) => CollaborationTransport;
}): UnitDefinition<CollaborationTransport, Record<never, never>, 'document/collaboration-transport'> {
  return unit<CollaborationTransport, Record<never, never>, 'document/collaboration-transport'>({
    id: options.id,
    provides: CollaborationTransportToken,
    scope: options.scope ?? 'session',
    create: (_deps, context) => options.transport(context),
  });
}
