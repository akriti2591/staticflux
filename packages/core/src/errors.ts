/**
 * Errors are values in StaticFlux. Every error has a stable `code`, a `kind`
 * used for policy decisions (retry, gating, messaging), and a suggested `fix`.
 *
 * Error definitions are declared once with `defineError()` and collected in a
 * catalog (`listErrorDefinitions()`) so tooling can emit a machine-readable
 * `docs/errors.json` that agents look up instead of guessing.
 */

export type ErrorKind =
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'auth'
  | 'forbidden'
  | 'not-found'
  | 'validation'
  | 'conflict'
  | 'unavailable'
  | 'quota'
  | 'rate'
  | 'invariant'
  | 'unknown';

/** Stable error code, e.g. `SF-DI-004`. Packages use their own prefix. */
export type ErrorCode = `${Uppercase<string>}-${string}`;

export interface SfErrorInit {
  readonly code: ErrorCode;
  readonly kind: ErrorKind;
  readonly message: string;
  readonly fix?: string;
  readonly units?: readonly string[];
  readonly scope?: string;
  readonly traceId?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

export class SfError extends Error {
  override readonly name = 'SfError';
  readonly code: ErrorCode;
  readonly kind: ErrorKind;
  readonly fix: string | undefined;
  readonly units: readonly string[];
  readonly scope: string | undefined;
  readonly traceId: string | undefined;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(init: SfErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.code = init.code;
    this.kind = init.kind;
    this.fix = init.fix;
    this.units = init.units ?? [];
    this.scope = init.scope;
    this.traceId = init.traceId;
    this.details = init.details ?? {};
  }

  /** Serializable form (for telemetry, worker envelopes, devtools). */
  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      kind: this.kind,
      message: this.message,
      fix: this.fix,
      units: this.units,
      scope: this.scope,
      traceId: this.traceId,
      details: this.details,
    };
  }
}

export function sfError(init: SfErrorInit): SfError {
  return new SfError(init);
}

export function isSfError(value: unknown): value is SfError {
  return value instanceof SfError;
}

/** A declared error: metadata plus a factory. */
export interface ErrorDefinition {
  readonly code: ErrorCode;
  readonly kind: ErrorKind;
  readonly summary: string;
  readonly fix: string;
  (extra?: Partial<Omit<SfErrorInit, 'code' | 'kind'>>): SfError;
}

const catalog = new Map<ErrorCode, ErrorDefinition>();

/**
 * Declare an error once; call the returned factory to create instances.
 *
 * @example
 * export const ScopeViolation = defineError('SF-DI-002', 'invariant',
 *   'A longer-lived unit requires a shorter-lived unit.',
 *   'Move the dependency to a lazy dep, or lower the consumer scope.');
 * return err(ScopeViolation({ units: [a, b] }));
 */
export function defineError(code: ErrorCode, kind: ErrorKind, summary: string, fix: string): ErrorDefinition {
  const existing = catalog.get(code);
  if (existing !== undefined) return existing;
  const factory = (extra: Partial<Omit<SfErrorInit, 'code' | 'kind'>> = {}): SfError =>
    new SfError({ ...extra, code, kind, message: extra.message ?? summary, fix: extra.fix ?? fix });
  const definition = Object.assign(factory, { code, kind, summary, fix }) as ErrorDefinition;
  catalog.set(code, definition);
  return definition;
}

/** All declared errors (for the machine-readable catalog). */
export function listErrorDefinitions(): readonly { code: ErrorCode; kind: ErrorKind; summary: string; fix: string }[] {
  return [...catalog.values()]
    .map((d) => ({ code: d.code, kind: d.kind, summary: d.summary, fix: d.fix }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

export const UnknownError = defineError(
  'SF-CORE-000',
  'unknown',
  'An unexpected non-StaticFlux error was thrown.',
  'Inspect `cause`; wrap the throwing call with `attempt()` and return a typed error instead.',
);

export const AbortedError = defineError(
  'SF-CORE-002',
  'aborted',
  'The operation was aborted.',
  'Usually expected (navigation, scope disposal). Do not retry aborted work.',
);

export const TimeoutError = defineError(
  'SF-CORE-003',
  'timeout',
  'The operation timed out.',
  'Raise the timeout only with a reason; prefer making the operation cheaper or cancellable.',
);

/** Normalize anything thrown into an SfError. AbortError/TimeoutError DOMExceptions map to their kinds. */
export function toSfError(value: unknown): SfError {
  if (value instanceof SfError) return value;
  if (typeof value === 'object' && value !== null && 'name' in value) {
    const name = (value as { name: unknown }).name;
    if (name === 'AbortError') return AbortedError({ cause: value });
    if (name === 'TimeoutError') return TimeoutError({ cause: value });
  }
  const message = value instanceof Error ? value.message : String(value);
  return UnknownError({ message, cause: value });
}

/**
 * Invariant I-9 — replicas never mutate; writes are intents sent to the owner.
 * Defined in core because both @staticflux/data (stores) and @staticflux/worker
 * (replication) raise it; each package re-exports this single definition.
 */
export const ReplicaWriteError = defineError(
  'SF-WK-002',
  'invariant',
  'A replica was written to directly. Replicas are read-only; writes must be sent as intents to the owner (I-9).',
  'Send the write as an intent (e.g. `replica.intent(action, args)` or a store created with an intent `sink`); the owner applies it and replicates the patches back.',
);
