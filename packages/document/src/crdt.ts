/**
 * The `DocumentCRDT` interface (R11.8): the only way the engine touches
 * replicated state, so the library (Yjs today; Automerge / Yjs 14 later) stays
 * behind it and no `Y.*` type leaks into feature code.
 *
 * Structure (entities, component presence, struct fields) is last-writer-wins
 * per property (Lamport clock, client id tie-break — Figma-style). Text is a
 * sequence CRDT (Yjs `Y.Text`). Updates are opaque bytes.
 */
import type { Result } from '@staticflux/core';
import type { ComponentId, EntityId } from './ecs.js';

export type DocumentOp =
  | { readonly type: 'entity.create'; readonly entity: EntityId }
  | { readonly type: 'entity.delete'; readonly entity: EntityId }
  | {
      readonly type: 'component.set';
      readonly entity: EntityId;
      readonly component: ComponentId;
      readonly values: Readonly<Record<string, unknown>>;
    }
  | { readonly type: 'component.remove'; readonly entity: EntityId; readonly component: ComponentId }
  | { readonly type: 'text.init'; readonly entity: EntityId; readonly component: ComponentId }
  | {
      readonly type: 'text.insert';
      readonly entity: EntityId;
      readonly component: ComponentId;
      readonly index: number;
      readonly text: string;
    }
  | {
      readonly type: 'text.delete';
      readonly entity: EntityId;
      readonly component: ComponentId;
      readonly index: number;
      readonly length: number;
    };

export type CrdtOrigin = 'local' | 'remote' | 'restore';

/** What a CRDT transaction touched (the engine re-materializes these entities). */
export interface CrdtChange {
  readonly origin: CrdtOrigin;
  readonly entities: readonly EntityId[];
}

export type CrdtComponentState =
  | { readonly kind: 'struct'; readonly values: Readonly<Record<string, unknown>> }
  | { readonly kind: 'text'; readonly text: string };

export interface CrdtEntityState {
  readonly exists: boolean;
  readonly components: ReadonlyMap<ComponentId, CrdtComponentState>;
}

export interface DocumentCRDT {
  /** Unique per peer (and per worker incarnation unless restoring its own archive). */
  readonly clientId: number;
  /** Apply local ops as one transaction; emits one local update. */
  applyLocal(ops: readonly DocumentOp[]): Result<CrdtChange>;
  /** Merge a remote update (or an archive on restore). Idempotent and commutative. */
  applyRemote(update: Uint8Array, origin?: Exclude<CrdtOrigin, 'local'>): Result<CrdtChange>;
  encodeStateVector(): Uint8Array;
  /** Everything the holder of `stateVector` is missing (everything if omitted). */
  encodeUpdate(stateVector?: Uint8Array): Result<Uint8Array>;
  readEntity(entity: EntityId): CrdtEntityState | undefined;
  /** Every entity id known to the CRDT (including deleted ones). */
  entityIds(): readonly EntityId[];
  observe(listener: (change: CrdtChange) => void): () => void;
  /** Local updates to broadcast to collaborators. */
  onLocalUpdate(listener: (update: Uint8Array) => void): () => void;
  dispose(): void;
}
