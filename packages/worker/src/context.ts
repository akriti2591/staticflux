/**
 * Core-context replication (R11.1, R11.7). A ContextHub on the main thread
 * holds named core contexts (session state, user, decision tables, flags,
 * platform facts, observability context). The full set is sent inside the
 * handshake `hello`, so it is present in the worker before any feature code
 * runs; afterwards changes are pushed on `sf/context`.
 *
 * Raw credentials are never replicated by default: values are scanned for
 * secret-looking keys, which are stripped and reported (SF-WK-012).
 */
import {
  box,
  type Box,
  createNoopTelemetry,
  err,
  ok,
  type LevelName,
  type Result,
  type Scope,
  type SfError,
  type Telemetry,
  watch,
} from '@staticflux/core';
import { Channels } from './envelope.js';
import { NoHandlerError, SecretReplicationError } from './errors.js';
import type { Link } from './link.js';

declare const contextType: unique symbol;

export type ContextId = `${string}/${string}`;

export interface ContextKey<T, Id extends ContextId = ContextId> {
  readonly kind: 'context';
  readonly id: Id;
  /** Phantom type carrier; never present at runtime. */
  readonly [contextType]?: T;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyContextKey = ContextKey<any, ContextId>;
export type ContextValue<K> = K extends ContextKey<infer T, ContextId> ? T : never;

export function defineContext<const Id extends ContextId>(id: Id): { type<T>(): ContextKey<T, Id> } {
  return { type: <T>() => Object.freeze({ kind: 'context', id }) as ContextKey<T, Id> };
}

// ---------------------------------------------------------------- core context shapes

export type ContextRecord = Readonly<Record<string, unknown>>;

/** Session state as seen by workers (no tokens!). */
export interface SessionContextValue extends ContextRecord {
  readonly status: string;
  readonly userId?: string;
}

export interface UserContextValue extends ContextRecord {
  readonly id: string;
}

export interface ObservabilityContextValue extends ContextRecord {
  /** Parent trace for worker-side spans (W3C traceparent). */
  readonly traceparent?: string;
  readonly defaultLevel?: LevelName;
  readonly levels?: Readonly<Record<string, LevelName>>;
  readonly sampleRate?: number;
}

/** The core contexts replicated to every worker (R11.1). Packages own the value shapes. */
export const CoreContexts = {
  session: defineContext('core/session').type<SessionContextValue>(),
  user: defineContext('core/user').type<UserContextValue | null>(),
  decisions: defineContext('core/decisions').type<ContextRecord>(),
  flags: defineContext('core/flags').type<ContextRecord>(),
  platform: defineContext('core/platform').type<ContextRecord>(),
  observability: defineContext('core/observability').type<ObservabilityContextValue>(),
} as const;

// ---------------------------------------------------------------- sources

export interface ContextSource<T> {
  get(): T;
  /** Called when the value may have changed. Returns unsubscribe. */
  subscribe(listener: () => void): () => void;
}

/** A source over a reactive expression (MobX via the core reactivity port). */
export function reactiveSource<T>(read: () => T): ContextSource<T> {
  return {
    get: read,
    subscribe: (listener) => watch(read, () => listener()),
  };
}

/** A fixed value. */
export function staticSource<T>(value: T): ContextSource<T> {
  return { get: () => value, subscribe: () => () => undefined };
}

export interface ContextEntry<T = unknown> {
  readonly key: ContextKey<T>;
  readonly source: ContextSource<T>;
  /** Map to the replicated (structured-cloneable) form. Default: identity. */
  readonly serialize?: (value: T) => unknown;
  /** Opt out of the secret scan (needs a reviewed reason). */
  readonly allowSecrets?: boolean;
}

export function provideContext<T>(
  key: ContextKey<T>,
  source: ContextSource<T>,
  options: { readonly serialize?: (value: T) => unknown; readonly allowSecrets?: boolean } = {},
): ContextEntry<T> {
  return { key, source, ...options };
}

// ---------------------------------------------------------------- secret scan

const SECRET_KEY = /^(access_?token|refresh_?token|id_?token|token|bearer|authorization|secret|client_?secret|password|api_?key|cookie)$/i;

/** Paths (dot-joined) of secret-looking keys inside `value`. */
export function findSecretPaths(value: unknown, path = ''): readonly string[] {
  if (typeof value !== 'object' || value === null) return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path === '' ? key : `${path}.${key}`;
    if (SECRET_KEY.test(key)) found.push(childPath);
    else found.push(...findSecretPaths(child, childPath));
  }
  return found;
}

/** Copy of `value` without secret-looking keys. */
export function stripSecrets(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map(stripSecrets);
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (!SECRET_KEY.test(key)) out[key] = stripSecrets(child);
  }
  return out;
}

// ---------------------------------------------------------------- hub (main thread)

export interface ContextSnapshotEntry {
  readonly version: number;
  readonly value: unknown;
}

export type ContextSnapshot = Readonly<Record<string, ContextSnapshotEntry>>;

interface ContextUpdate {
  readonly id: string;
  readonly version: number;
  readonly value: unknown;
}

export interface ContextHub {
  readonly ids: readonly ContextId[];
  /** Current serialized values of every context (goes into the handshake). */
  snapshot(): ContextSnapshot;
  /** Push changes to `link` until it closes or the scope is disposed. */
  attach(link: Link, scope?: Scope): () => void;
  dispose(): void;
}

export interface ContextHubOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly entries: readonly ContextEntry<any>[];
  readonly telemetry?: Telemetry;
  /** Called when a value had secrets stripped. */
  readonly onError?: (error: SfError) => void;
}

export function createContextHub(options: ContextHubOptions): ContextHub {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const links = new Set<Link>();
  const state = new Map<string, { version: number; value: unknown }>();

  const serialize = (entry: ContextEntry): unknown => {
    const rawValue = entry.source.get();
    const value = entry.serialize === undefined ? rawValue : entry.serialize(rawValue);
    if (entry.allowSecrets === true) return value;
    const secrets = findSecretPaths(value);
    if (secrets.length === 0) return value;
    const error = SecretReplicationError({ details: { context: entry.key.id, paths: secrets.join(',') } });
    telemetry.event('context.secrets-stripped', {
      subsystem: 'worker/context',
      level: 'critical',
      attrs: { context: entry.key.id, paths: secrets },
    });
    options.onError?.(error);
    return stripSecrets(value);
  };

  const unsubscribes = options.entries.map((entry) => {
    state.set(entry.key.id, { version: 1, value: serialize(entry) });
    return entry.source.subscribe(() => {
      const previous = state.get(entry.key.id);
      const next = { version: (previous?.version ?? 0) + 1, value: serialize(entry) };
      state.set(entry.key.id, next);
      const update: ContextUpdate = { id: entry.key.id, ...next };
      for (const link of links) link.send(Channels.context, update);
    });
  });

  return {
    ids: options.entries.map((entry) => entry.key.id),
    snapshot() {
      const out: Record<string, ContextSnapshotEntry> = {};
      for (const [id, entry] of state) out[id] = { version: entry.version, value: entry.value };
      return out;
    },
    attach(link, scope) {
      links.add(link);
      const offClose = link.onClose(() => links.delete(link));
      const detach = (): void => {
        links.delete(link);
        offClose();
      };
      scope?.defer(detach);
      return detach;
    },
    dispose() {
      for (const unsubscribe of unsubscribes) unsubscribe();
      links.clear();
    },
  };
}

// ---------------------------------------------------------------- worker side

export interface WorkerContexts {
  /** Current value (reactive), or undefined if the context was not replicated. */
  get<K extends AnyContextKey>(key: K): ContextValue<K> | undefined;
  /** Value or SF-WK-008 when the main thread did not provide it. */
  require<K extends AnyContextKey>(key: K): Result<ContextValue<K>>;
  version(key: AnyContextKey): number;
  has(key: AnyContextKey): boolean;
  subscribe<K extends AnyContextKey>(key: K, listener: (value: ContextValue<K>) => void): () => void;
}

export interface WorkerContextsHandle extends WorkerContexts {
  /** Receive updates from `link`. */
  attach(link: Link, scope?: Scope): () => void;
}

export function createWorkerContexts(snapshot: ContextSnapshot): WorkerContextsHandle {
  const values = new Map<string, { version: number; value: Box<unknown> }>();
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  for (const [id, entry] of Object.entries(snapshot)) values.set(id, { version: entry.version, value: box(entry.value) });

  const receive = (update: ContextUpdate): void => {
    const current = values.get(update.id);
    if (current !== undefined && current.version >= update.version) return;
    if (current === undefined) values.set(update.id, { version: update.version, value: box(update.value) });
    else {
      current.version = update.version;
      current.value.set(update.value);
    }
    for (const listener of [...(listeners.get(update.id) ?? [])]) listener(update.value);
  };

  return {
    get(key) {
      return values.get(key.id)?.value.get() as ContextValue<typeof key> | undefined;
    },
    require(key) {
      const entry = values.get(key.id);
      if (entry === undefined) {
        return err(NoHandlerError({ message: `Core context "${key.id}" was not replicated to this worker.`, details: { context: key.id } }));
      }
      return ok(entry.value.get() as ContextValue<typeof key>);
    },
    version(key) {
      return values.get(key.id)?.version ?? 0;
    },
    has(key) {
      return values.has(key.id);
    },
    subscribe(key, listener) {
      let set = listeners.get(key.id);
      if (set === undefined) {
        set = new Set();
        listeners.set(key.id, set);
      }
      const typed = listener as (value: unknown) => void;
      set.add(typed);
      return () => {
        set.delete(typed);
      };
    },
    attach(link, scope) {
      const off = link.on(Channels.context, (payload) => {
        const update = payload as ContextUpdate;
        if (typeof update?.id === 'string' && typeof update.version === 'number') receive(update);
      });
      scope?.defer(off);
      return off;
    },
  };
}
