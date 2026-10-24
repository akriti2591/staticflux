/**
 * The document worker protocol and the document schema (component ids are part of
 * the persisted archive format — renaming needs a migration).
 */
import { defineComponent, defineTextComponent, type DocumentArchive, documentReplica } from '@staticflux/document';
import { defineProtocol, event, request } from '@staticflux/worker';
import type { BlockRecord } from '../app/endpoints.js';

export const BlockComponent = defineComponent('studio/block', { order: 'string', kind: 'string', src: 'string' }, { kind: 'text', src: '' });
export const BodyComponent = defineTextComponent('studio/body');
export const documentComponents = [BlockComponent, BodyComponent] as const;

export const DocumentReplica = documentReplica('studio/document');

export interface OpenArgs {
  readonly docId: string;
  readonly blocks: readonly BlockRecord[];
}

export const DocumentWorkerProtocol = defineProtocol({
  id: 'studio/document-worker',
  version: 1,
  requests: {
    /** Load a document into the engine (replaces the current one). */
    open: request<OpenArgs, { readonly entities: number }>({ idempotent: true }),
    /** Current archive (for feature archive / handoff). */
    archive: request<null, DocumentArchive>({ idempotent: true }),
  },
  events: {
    /** Emitted after changes; the main thread keeps the last one for respawn rehydration. */
    archived: event<{ readonly docId: string; readonly archive: DocumentArchive }>(),
  },
});

export const COLLAB_PEER_NAME = 'Lin (co-editor bot)';
