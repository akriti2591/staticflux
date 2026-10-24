/**
 * Collaboration transport (R11.10): client contract only, plus an in-memory
 * mock network that links engines for co-editing tests. A real transport
 * (WebSocket relay, WebRTC, host bridge) implements the same contract.
 *
 * Sync protocol: on join (and when a peer joins), a peer broadcasts its state
 * vector; peers answer with the update the requester is missing. Afterwards
 * every local update is broadcast. Presence travels separately.
 */
import { AbortedError, err, ok, type Result } from '@staticflux/core';
import type { DocumentEngine } from './engine.js';
import { CollaborationClosedError } from './errors.js';
import type { PresenceState, PresenceStore } from './presence.js';

export type RoomId = `${string}/${string}`;

export type PeerEvent = 'joined' | 'left';

export interface CollaborationSession {
  readonly room: RoomId;
  readonly participantId: string;
  readonly closed: boolean;
  /** Broadcast (or send to one peer) a document update. */
  sendUpdate(update: Uint8Array, to?: string): void;
  /** Ask peers for what we are missing. */
  sendSyncRequest(stateVector: Uint8Array): void;
  sendPresence(state: PresenceState | null): void;
  onUpdate(listener: (update: Uint8Array, from: string) => void): () => void;
  onSyncRequest(listener: (stateVector: Uint8Array, from: string) => void): () => void;
  onPresence(listener: (from: string, state: PresenceState | null) => void): () => void;
  onPeer(listener: (peerId: string, event: PeerEvent) => void): () => void;
  peers(): readonly string[];
  leave(): void;
}

export interface CollaborationTransport {
  join(room: RoomId, participantId: string, signal?: AbortSignal): Promise<Result<CollaborationSession>>;
}

// ---------------------------------------------------------------- mock network

type Message =
  | { readonly kind: 'update'; readonly from: string; readonly update: Uint8Array }
  | { readonly kind: 'sync'; readonly from: string; readonly stateVector: Uint8Array }
  | { readonly kind: 'presence'; readonly from: string; readonly state: PresenceState | null }
  | { readonly kind: 'peer'; readonly from: string; readonly event: PeerEvent };

export interface MockCollaborationNetwork {
  readonly transport: CollaborationTransport;
  /** Stop delivery between two participants (both directions); messages queue. */
  partition(a: string, b: string): void;
  /** Deliver queued messages between them, in order. */
  heal(a: string, b: string): void;
  /** Messages delivered so far. */
  readonly delivered: number;
}

export interface MockNetworkOptions {
  /** Delivery scheduler. Default microtask. */
  readonly deliver?: (fn: () => void) => void;
}

interface Member {
  readonly id: string;
  receive(message: Message): void;
}

export function createMockCollaborationNetwork(options: MockNetworkOptions = {}): MockCollaborationNetwork {
  const deliver = options.deliver ?? ((fn: () => void) => queueMicrotask(fn));
  const rooms = new Map<RoomId, Map<string, Member>>();
  const cut = new Set<string>();
  const held = new Map<string, (() => void)[]>();
  let delivered = 0;
  const linkKey = (a: string, b: string): string => [a, b].sort().join('\u0000');

  const route = (room: RoomId, from: string, message: Message, to?: string): void => {
    const members = rooms.get(room);
    if (members === undefined) return;
    for (const member of members.values()) {
      if (member.id === from || (to !== undefined && member.id !== to)) continue;
      const send = (): void => {
        if (rooms.get(room)?.get(member.id) !== member) return;
        delivered += 1;
        member.receive(message);
      };
      const key = linkKey(from, member.id);
      if (cut.has(key)) {
        const queue = held.get(key) ?? [];
        queue.push(send);
        held.set(key, queue);
      } else deliver(send);
    }
  };

  const transport: CollaborationTransport = {
    async join(room, participantId, signal) {
      if (signal?.aborted === true) return err(AbortedError({ cause: signal.reason }));
      let members = rooms.get(room);
      if (members === undefined) {
        members = new Map();
        rooms.set(room, members);
      }
      const listeners = {
        update: new Set<(update: Uint8Array, from: string) => void>(),
        sync: new Set<(stateVector: Uint8Array, from: string) => void>(),
        presence: new Set<(from: string, state: PresenceState | null) => void>(),
        peer: new Set<(peerId: string, event: PeerEvent) => void>(),
      };
      let closed = false;
      const member: Member = {
        id: participantId,
        receive(message) {
          if (closed) return;
          switch (message.kind) {
            case 'update':
              for (const l of [...listeners.update]) l(message.update, message.from);
              break;
            case 'sync':
              for (const l of [...listeners.sync]) l(message.stateVector, message.from);
              break;
            case 'presence':
              for (const l of [...listeners.presence]) l(message.from, message.state);
              break;
            case 'peer':
              for (const l of [...listeners.peer]) l(message.from, message.event);
              break;
          }
        },
      };
      members.set(participantId, member);
      route(room, participantId, { kind: 'peer', from: participantId, event: 'joined' });
      const subscribe = <L>(set: Set<L>, listener: L): (() => void) => {
        set.add(listener);
        return () => set.delete(listener);
      };
      const session: CollaborationSession = {
        room,
        participantId,
        get closed() {
          return closed;
        },
        sendUpdate(update, to) {
          if (!closed) route(room, participantId, { kind: 'update', from: participantId, update: update.slice() }, to);
        },
        sendSyncRequest(stateVector) {
          if (!closed) route(room, participantId, { kind: 'sync', from: participantId, stateVector: stateVector.slice() });
        },
        sendPresence(state) {
          if (!closed) route(room, participantId, { kind: 'presence', from: participantId, state });
        },
        onUpdate: (listener) => subscribe(listeners.update, listener),
        onSyncRequest: (listener) => subscribe(listeners.sync, listener),
        onPresence: (listener) => subscribe(listeners.presence, listener),
        onPeer: (listener) => subscribe(listeners.peer, listener),
        peers: () => [...(rooms.get(room)?.keys() ?? [])].filter((id) => id !== participantId).sort(),
        leave() {
          if (closed) return;
          route(room, participantId, { kind: 'peer', from: participantId, event: 'left' });
          closed = true;
          rooms.get(room)?.delete(participantId);
        },
      };
      return ok(session);
    },
  };

  return {
    transport,
    partition(a, b) {
      cut.add(linkKey(a, b));
    },
    heal(a, b) {
      const key = linkKey(a, b);
      cut.delete(key);
      const queue = held.get(key) ?? [];
      held.delete(key);
      for (const send of queue) deliver(send);
    },
    get delivered() {
      return delivered;
    },
  };
}

// ---------------------------------------------------------------- binding

export interface CollaborationBinding {
  /** Send our state vector again (e.g. after reconnect). */
  resync(): void;
  disconnect(): void;
}

/** Link an engine (and optionally a presence store) to a session. */
export function connectCollaboration(options: {
  readonly engine: DocumentEngine;
  readonly session: CollaborationSession;
  readonly presence?: PresenceStore;
  readonly onError?: (error: unknown) => void;
}): Result<CollaborationBinding> {
  const { engine, session, presence } = options;
  if (session.closed) return err(CollaborationClosedError({ details: { room: session.room } }));
  const offs: (() => void)[] = [];
  offs.push(engine.onLocalUpdate((update) => session.sendUpdate(update)));
  offs.push(
    session.onUpdate((update) => {
      const applied = engine.applyRemote(update);
      if (!applied.ok) options.onError?.(applied.error);
    }),
  );
  offs.push(
    session.onSyncRequest((stateVector, from) => {
      const update = engine.encodeUpdate(stateVector);
      if (update.ok) session.sendUpdate(update.value, from);
      else options.onError?.(update.error);
    }),
  );
  const resync = (): void => session.sendSyncRequest(engine.encodeStateVector());
  offs.push(
    session.onPeer((peerId, event) => {
      if (event === 'joined') {
        resync();
        if (presence?.local !== null && presence?.local !== undefined) session.sendPresence(presence.local);
      } else presence?.applyRemote(peerId, null);
    }),
  );
  if (presence !== undefined) {
    offs.push(presence.onLocalChange((state) => session.sendPresence(state)));
    offs.push(session.onPresence((from, state) => presence.applyRemote(from, state)));
    if (presence.local !== null) session.sendPresence(presence.local);
  }
  resync();
  return ok({
    resync,
    disconnect() {
      for (const off of offs.splice(0)) off();
    },
  });
}
