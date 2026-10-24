/**
 * Control channel messages (`sf/control`) between a supervisor and
 * `runWorker()`: handshake, heartbeat and lifecycle commands (R11.5).
 */
import type { ContextSnapshot } from './context.js';

export interface ProtocolRef {
  readonly id: string;
  readonly version: number;
}

export interface HelloMessage {
  readonly type: 'hello';
  readonly workerId: string;
  readonly attempt: number;
  readonly epoch: number;
  readonly paused: boolean;
  readonly protocol: ProtocolRef;
  /** Core contexts, present before any feature code runs (R11.1). */
  readonly contexts: ContextSnapshot;
  /** State to rehydrate from (e.g. the last document archive) after a respawn. */
  readonly rehydrate: unknown;
}

export interface ReadyMessage {
  readonly type: 'ready';
  readonly protocol: ProtocolRef;
}

export type ControlMessage =
  | HelloMessage
  | { readonly type: 'ping' }
  | { readonly type: 'pause' }
  | { readonly type: 'resume' }
  | { readonly type: 'refresh'; readonly epoch: number }
  | { readonly type: 'drain' };

export function isControlMessage(value: unknown): value is ControlMessage {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}
