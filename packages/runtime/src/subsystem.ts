/**
 * The `Subsystem` contract: a supervised child of the app (R4.1, docs/LIFECYCLES.md §2).
 * DI, renderer, workers, transports, stores, session, observability and the shell
 * register as subsystems; the supervisor starts them in dependency order, restarts
 * them with backoff (OTP-style intensity per window) and gives up → app degraded.
 */
import type { Result, Scope, SfError, Span, Telemetry } from '@staticflux/core';
import type { SubsystemState } from './machines.js';

/** Namespaced subsystem id, e.g. `worker/document`, `data/transport`. */
export type SubsystemId = `${string}/${string}`;

export interface RestartPolicy {
  /** `permanent`: restart on failure (default). `temporary`: never restart; a failure gives up immediately. */
  readonly mode?: 'permanent' | 'temporary';
  /** Max restarts within `windowMs` (OTP intensity). Exceeding it gives up. */
  readonly maxRestarts: number;
  /** Sliding window for `maxRestarts` (OTP period). */
  readonly windowMs: number;
  /** Exponential backoff base (default 200 ms). */
  readonly baseDelayMs?: number;
  /** Backoff cap (default 10 s). */
  readonly maxDelayMs?: number;
  /** Default `full` (AWS full jitter). */
  readonly jitter?: 'full' | 'none';
}

export const DEFAULT_RESTART_POLICY: Required<RestartPolicy> = {
  mode: 'permanent',
  maxRestarts: 3,
  windowMs: 60_000,
  baseDelayMs: 200,
  maxDelayMs: 10_000,
  jitter: 'full',
};

export type StopReason = 'shutdown' | 'reinitialize';

export interface SubsystemContext {
  readonly id: SubsystemId;
  /** Scope of this run. A fresh scope per (re)start; disposed on stop, failure and restart. */
  readonly scope: Scope;
  /** Aborted when this run ends (`scope.signal`). */
  readonly signal: AbortSignal;
  /** Current app epoch. */
  readonly epoch: number;
  readonly telemetry: Telemetry;
  /** Span of the current start attempt (parent for child spans). */
  readonly span: Span;
  /** 1-based start attempt within the current restart window. */
  readonly attempt: number;
  /** Report a crash after a successful start (e.g. worker error event). Triggers the restart policy. */
  fail(error: SfError): void;
}

/** What lifecycle hooks may return: nothing, a Result, or a promise of either. */
export type HookReturn = void | Result<void> | Promise<void | Result<void>>;

export interface Subsystem {
  readonly id: SubsystemId;
  /** Started after (and stopped before) these subsystems. */
  readonly dependsOn?: readonly SubsystemId[];
  /** Critical subsystems start before `core-ready` and may only depend on critical subsystems. */
  readonly critical?: boolean;
  readonly restart?: RestartPolicy;
  /** Fail the start attempt after this long (default: no timeout). */
  readonly startTimeoutMs?: number;
  /** Give up waiting for `stop()` after this long (default 5 s). */
  readonly stopTimeoutMs?: number;
  start(context: SubsystemContext): HookReturn;
  /** App paused: freeze (stores freeze, transports queue, schedulers stop, workers idle). */
  pause?(context: SubsystemContext): void | Promise<void>;
  resume?(context: SubsystemContext): void | Promise<void>;
  /** App epoch bumped (R4.3 refresh). A failed refresh counts as a subsystem failure. */
  refresh?(epoch: number, context: SubsystemContext): HookReturn;
  /** The root abort signal fired: cancel everything in flight (keep running). */
  abort?(reason: unknown, context: SubsystemContext): void;
  /** Ordered teardown (reverse dependency order). The run scope is disposed afterwards. */
  stop?(reason: StopReason, context: SubsystemContext): void | Promise<void>;
  /** A dependency became impaired (`failed`/`given-up`) or recovered (`running`). */
  onDependencyState?(dependency: SubsystemId, state: SubsystemState, context: SubsystemContext): void;
  readonly description?: string;
}

/** Identity helper that keeps literal ids. */
export function defineSubsystem<const S extends Subsystem>(subsystem: S): S {
  return subsystem;
}

export interface SubsystemInfo {
  readonly id: SubsystemId;
  readonly state: SubsystemState;
  readonly critical: boolean;
  readonly dependsOn: readonly SubsystemId[];
  /** Restarts performed so far (lifetime of this boot). */
  readonly restarts: number;
  readonly error: Readonly<Record<string, unknown>> | undefined;
}
