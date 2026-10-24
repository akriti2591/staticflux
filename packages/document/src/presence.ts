/**
 * Presence: cursor/selection per participant, kept apart from the document
 * (never stored in the CRDT — UI state). It is its own replicated store
 * (`ReplicableSource<PresenceView>`), so a document worker can publish it and
 * the main thread can render remote cursors; local cursor moves are intents.
 * Remote participants expire after `ttlMs` without an update.
 */
import { err, ok, type Result } from '@staticflux/core';
import { defineReplica, type Patch, type ReplicableSource, UnknownIntentError } from '@staticflux/worker';
import type { ComponentId, EntityId } from './ecs.js';

export interface PresenceCursor {
  readonly entity: EntityId;
  readonly component?: ComponentId;
  readonly index: number;
}

export interface PresenceSelection {
  readonly entity: EntityId;
  readonly component?: ComponentId;
  readonly anchor: number;
  readonly head: number;
}

export interface PresenceState {
  readonly name?: string;
  readonly color?: string;
  readonly cursor?: PresenceCursor | null;
  readonly selection?: PresenceSelection | null;
}

export interface ParticipantView {
  readonly state: PresenceState;
  readonly updatedAt: number;
  readonly local: boolean;
}

export interface PresenceView {
  readonly participants: Readonly<Record<string, ParticipantView>>;
}

export type PresenceIntents = {
  readonly setLocal: { readonly args: PresenceState | null; readonly result: null };
};

export const PresenceReplica = defineReplica('document/presence').type<PresenceView, PresenceIntents>();

export interface PresenceStore extends ReplicableSource<PresenceView> {
  readonly localId: string;
  readonly local: PresenceState | null;
  /** Update (or clear with null) the local participant. */
  setLocal(state: PresenceState | null): void;
  /** Apply a remote participant's state (null = left). */
  applyRemote(participantId: string, state: PresenceState | null): void;
  participants(): readonly (ParticipantView & { readonly id: string })[];
  /** Remove remote participants not heard from within ttl. Returns removed ids. */
  expire(): readonly string[];
  /** Local state changes (for the collaboration transport). */
  onLocalChange(listener: (state: PresenceState | null) => void): () => void;
}

export interface PresenceStoreOptions {
  readonly localId: string;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export function createPresenceStore(options: PresenceStoreOptions): PresenceStore {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 30_000;
  const participants = new Map<string, ParticipantView>();
  const patchListeners = new Set<(patches: readonly Patch[]) => void>();
  const localListeners = new Set<(state: PresenceState | null) => void>();
  let local: PresenceState | null = null;

  const emit = (patches: readonly Patch[]): void => {
    for (const listener of [...patchListeners]) listener(patches);
  };

  const put = (id: string, state: PresenceState | null, isLocal: boolean): void => {
    if (state === null) {
      if (!participants.delete(id)) return;
      emit([{ op: 'remove', path: ['participants', id] }]);
      return;
    }
    const view: ParticipantView = { state, updatedAt: now(), local: isLocal };
    participants.set(id, view);
    emit([{ op: 'add', path: ['participants', id], value: view }]);
  };

  const setLocal = (state: PresenceState | null): void => {
    local = state;
    put(options.localId, state, true);
    for (const listener of [...localListeners]) listener(state);
  };

  return {
    localId: options.localId,
    get local() {
      return local;
    },
    setLocal,
    applyRemote(participantId, state) {
      if (participantId === options.localId) return;
      put(participantId, state, false);
    },
    participants() {
      return [...participants.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, view]) => ({ id, ...view }));
    },
    expire() {
      const cutoff = now() - ttlMs;
      const removed: string[] = [];
      for (const [id, view] of participants) {
        if (!view.local && view.updatedAt < cutoff) removed.push(id);
      }
      for (const id of removed) put(id, null, false);
      return removed;
    },
    onLocalChange(listener) {
      localListeners.add(listener);
      return () => localListeners.delete(listener);
    },
    getSnapshot() {
      return { participants: Object.fromEntries(participants) };
    },
    onPatches(listener) {
      patchListeners.add(listener);
      return () => patchListeners.delete(listener);
    },
    applyIntent(action, args): Result<unknown> {
      if (action !== 'setLocal') return err(UnknownIntentError({ details: { action } }));
      setLocal((args ?? null) as PresenceState | null);
      return ok(null);
    },
  };
}
