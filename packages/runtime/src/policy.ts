/**
 * Pluggable policies of the supervisor.
 *
 * - CommandPolicy (R4.5): features *request* app-wide commands; the shell decides.
 * - PausedRequestPolicy (R4.6): what a transport does with a request while the app
 *   is paused — queue (replay on resume) or reject. Mutations never auto-replay
 *   unless declared idempotent.
 */
import type { AppCommand, AppState } from './machines.js';

export interface CommandRequest {
  readonly command: AppCommand;
  /** Who asks (feature id, package id) — for policy and devtools. */
  readonly source: string;
  readonly reason?: string;
}

export type CommandDecision = { readonly allow: true } | { readonly allow: false; readonly reason: string };

export interface CommandPolicyContext {
  readonly state: AppState;
}

export type CommandPolicy = (
  request: CommandRequest,
  context: CommandPolicyContext,
) => CommandDecision | Promise<CommandDecision>;

const FEATURE_REQUESTABLE: readonly AppCommand[] = ['pause', 'resume', 'refresh'];

/** Default: features may request pause/resume/refresh; abort/reinitialize/shutdown are reserved for the shell. */
export const defaultCommandPolicy: CommandPolicy = (request) =>
  FEATURE_REQUESTABLE.includes(request.command)
    ? { allow: true }
    : { allow: false, reason: `"${request.command}" is reserved for the shell; bind CommandPolicyToken to allow it.` };

export interface PausedRequest {
  /** `read` (query/fetch), `mutation` (write) or generic `task`. */
  readonly kind: 'read' | 'mutation' | 'task';
  /** Mutations replay on resume only when idempotent. */
  readonly idempotent?: boolean;
  readonly source?: string;
}

export type PausedDecision = 'queue' | 'reject';

export type PausedRequestPolicy = (request: PausedRequest) => PausedDecision;

/** Default: queue reads and tasks; queue mutations only if idempotent; reject the rest. */
export const defaultPausedRequestPolicy: PausedRequestPolicy = (request) =>
  request.kind === 'mutation' && request.idempotent !== true ? 'reject' : 'queue';
