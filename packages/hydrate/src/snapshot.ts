/**
 * State rehydration from snapshots for instant boot (R12.4 part 2).
 *
 *   const registry = createSnapshotRegistry({ store, identity: () => session.identityKey, epoch });
 *   registry.register(storeSnapshotSource(docListOwner, { sensitivity: 'identity' }));
 *   await registry.restore();   // at boot, BEFORE the network: UI renders last-known state instantly
 *   registry.start();           // save on hide/pagehide + every `intervalMs`
 *
 * Envelope (stable, `SNAPSHOT_ENVELOPE_FORMAT`), one AsyncStore entry per source under `<prefix><id>`:
 *   { format: 'sf-hydrate-snapshot/1', id, version, identity, savedAt, epoch, bytes, data }
 * Store sources put the data package's stable `StoreSnapshot` (STORE_FORMAT 1) in `data`.
 *
 * Restore rules (each violation drops the entry — deleted from storage — and is reported, never thrown):
 * - malformed envelope → `SF-HYD-023`; identity-bound source with another identity → `SF-HYD-021`
 *   (never restored across identities); newer version or no migration path → `SF-HYD-020`;
 *   apply/validation failure → `SF-HYD-024`; older than `maxAgeMs` → dropped (`expired`).
 * - Restored state is tagged (`provenance(id)`: savedAt, age, saved epoch) so consumers treat it
 *   as stale: resource sources re-seed the SWR cache AND invalidate (revalidate in background).
 * - The app epoch is never touched: in-flight responses of older epochs are still discarded by
 *   the data client (I-10). If the epoch changes WHILE restoring, the snapshot is the stale
 *   response and is skipped (`stale-epoch`). A target written before the snapshot arrived
 *   (network won the race) is never overwritten (`superseded`).
 * - The whole restore is time-boxed (`restoreTimeoutMs`); on timeout boot continues without it.
 * - Saving is refused until a restore ran (a boot save must never clobber the last snapshot).
 * Saving: one `batch` per save; unchanged sources (same `revision()`) are skipped; over-budget
 * snapshots are not written and the stale one is removed (`SF-HYD-022`). Identity-bound sources
 * are not saved without an identity.
 */
import {
  AbortedError,
  anySignal,
  batch,
  box,
  createMachine,
  createNoopTelemetry,
  defineMachine,
  err,
  ok,
  type Result,
  type SfError,
  type Telemetry,
  type TokenId,
  toSfError,
  untracked,
} from '@staticflux/core';
import { byteSize, type EpochSource, FIXED_EPOCH } from '@staticflux/data';
import type { AsyncStore, BatchOp } from '@staticflux/storage';
import {
  SnapshotCorruptError,
  SnapshotIdentityMismatchError,
  SnapshotOverBudgetError,
  SnapshotRestoreFailedError,
  SnapshotRestoreTimeoutError,
  SnapshotSourceDuplicateError,
  SnapshotStorageError,
  SnapshotUnknownSourceError,
  SnapshotVersionMismatchError,
} from './errors.js';
import { HYDRATE_SUBSYSTEMS, hydrateMetrics } from './telemetry.js';

export const SNAPSHOT_ENVELOPE_FORMAT = 'sf-hydrate-snapshot/1';
export const DEFAULT_SNAPSHOT_PREFIX = 'sf-snap/';
export const DEFAULT_SNAPSHOT_MAX_BYTES = 256 * 1024;
export const DEFAULT_SNAPSHOT_INTERVAL_MS = 30_000;
export const DEFAULT_RESTORE_TIMEOUT_MS = 200;

export interface SnapshotEnvelope<T = unknown> {
  readonly format: typeof SNAPSHOT_ENVELOPE_FORMAT;
  readonly id: string;
  readonly version: number;
  /** Identity key at save time (`null` for public sources). Opaque — bind a hash, not a user id. */
  readonly identity: string | null;
  /** Wall-clock ms. */
  readonly savedAt: number;
  /** App epoch at save time. */
  readonly epoch: number;
  readonly bytes: number;
  readonly data: T;
}

/** `identity` snapshots are bound to the identity key and never restored for another identity. */
export type SnapshotSensitivity = 'public' | 'identity';

/** Provenance of restored state (R17.8 data source `snapshot`). Restored state is always stale. */
export interface RestoredMeta {
  readonly id: string;
  readonly source: 'snapshot';
  readonly stale: true;
  readonly savedAt: number;
  readonly ageMs: number;
  readonly savedEpoch: number;
  readonly epoch: number;
  readonly identity: string | null;
  /** Version the data was migrated from, if migrated. */
  readonly migratedFrom: number | undefined;
}

export type RestoreApplied = 'applied' | 'superseded';

export interface SnapshotSource<T = unknown> {
  readonly id: TokenId;
  /** Bump on every shape change; add `migrations[previous]`. */
  readonly version: number;
  readonly sensitivity: SnapshotSensitivity;
  readonly maxBytes?: number;
  readonly maxAgeMs?: number;
  /** `migrations[n]` turns version-n data into version n+1 data. */
  readonly migrations?: Readonly<Record<number, (data: unknown) => unknown>>;
  /** Current data to persist; `undefined` → nothing to persist (the entry is removed). */
  capture(): T | undefined;
  /** Change marker; an unchanged revision skips the write. */
  revision?(): string | number;
  /** Apply restored data. `superseded` = the target already has newer data (keep it). */
  restore(data: T, meta: RestoredMeta): Result<RestoreApplied>;
}

export type DropReason = 'corrupt' | 'identity' | 'version' | 'invalid' | 'expired' | 'storage';

export interface RestoreReport {
  readonly restored: readonly string[];
  readonly superseded: readonly string[];
  readonly missing: readonly string[];
  /** Kept in storage, not applied (the epoch changed during the restore). */
  readonly staleEpoch: readonly string[];
  readonly dropped: readonly { readonly id: string; readonly reason: DropReason }[];
  readonly timedOut: boolean;
  readonly durationMs: number;
}

export type SaveReason = 'hide' | 'interval' | 'manual';

export interface SaveReport {
  readonly reason: SaveReason;
  readonly saved: readonly string[];
  readonly unchanged: readonly string[];
  readonly removed: readonly string[];
  /** Not saved: not restored yet, no identity, or over budget. */
  readonly skipped: readonly { readonly id: string; readonly why: 'not-restored' | 'no-identity' | 'over-budget' }[];
}

/** Save triggers (injectable; default: visibilitychange→hidden + pagehide, setInterval). */
export interface SnapshotLifecycle {
  onHide(callback: () => void): () => void;
  every(ms: number, callback: () => void): () => void;
}

export function browserSnapshotLifecycle(): SnapshotLifecycle {
  return {
    onHide(callback) {
      const doc = (globalThis as { document?: Document }).document;
      const win = globalThis as unknown as Partial<Window>;
      const detach = new AbortController();
      if (doc !== undefined) {
        doc.addEventListener('visibilitychange', () => {
          if (doc.visibilityState === 'hidden') callback();
        }, { signal: detach.signal });
      }
      if (typeof win.addEventListener === 'function') win.addEventListener('pagehide', () => callback(), { signal: detach.signal });
      return () => detach.abort();
    },
    every(ms, callback) {
      const handle = setInterval(callback, ms);
      return () => clearInterval(handle);
    },
  };
}

export const snapshotRegistryMachine = defineMachine({
  id: 'hydrate/snapshots',
  initial: 'idle',
  states: ['idle', 'restoring', 'ready', 'saving', 'disposed'],
  transitions: {
    idle: { restore: 'restoring', dispose: 'disposed' },
    restoring: { restored: 'ready', dispose: 'disposed' },
    ready: { save: 'saving', restore: 'restoring', dispose: 'disposed' },
    saving: { saved: 'ready', dispose: 'disposed' },
  },
  terminal: ['disposed'],
});
export type SnapshotRegistryState = (typeof snapshotRegistryMachine.states)[number];

export interface SnapshotRegistryOptions {
  readonly store: AsyncStore;
  readonly sources?: readonly SnapshotSource[];
  /** Current identity key (opaque, e.g. a hash of the subject); `undefined` = anonymous. */
  readonly identity?: () => string | undefined;
  readonly epoch?: EpochSource;
  /** Wall clock for `savedAt`/age (default `Date.now`). */
  readonly clock?: () => number;
  readonly lifecycle?: SnapshotLifecycle;
  /** Autosave interval; 0 disables. Default 30 s. */
  readonly intervalMs?: number;
  readonly restoreTimeoutMs?: number;
  readonly defaultMaxBytes?: number;
  readonly prefix?: string;
  readonly telemetry?: Telemetry;
  readonly onIssue?: (error: SfError) => void;
}

export interface SnapshotRegistry {
  /** Reactive. */
  readonly state: SnapshotRegistryState;
  readonly sources: readonly string[];
  /** Register a source (e.g. a lazily loaded feature store). Returns unregister. */
  register(source: SnapshotSource): Result<() => void>;
  /** Boot restore of every registered source (time-boxed). */
  restore(signal?: AbortSignal): Promise<Result<RestoreReport>>;
  /** Restore one (late-registered) source. Not time-boxed by the boot box. */
  restoreOne(id: string, signal?: AbortSignal): Promise<Result<RestoreReport>>;
  save(reason?: SaveReason): Promise<Result<SaveReport>>;
  /** Start autosave (hide/pagehide + interval). Idempotent. */
  start(): void;
  /** Provenance of restored state, `undefined` if the source was not restored. Reactive. */
  provenance(id: string): RestoredMeta | undefined;
  /** Delete every identity-bound snapshot (call on logout / identity switch). */
  clearIdentityBound(): Promise<Result<readonly string[]>>;
  /** Delete entries under the prefix that no registered source owns (renamed/removed stores). */
  prune(): Promise<Result<readonly string[]>>;
  issues(): readonly SfError[];
  dispose(): Promise<void>;
}

function isEnvelope(value: unknown): value is SnapshotEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v['format'] === SNAPSHOT_ENVELOPE_FORMAT &&
    typeof v['id'] === 'string' &&
    Number.isInteger(v['version']) &&
    (v['identity'] === null || typeof v['identity'] === 'string') &&
    typeof v['savedAt'] === 'number' &&
    typeof v['epoch'] === 'number' &&
    typeof v['bytes'] === 'number' &&
    'data' in v
  );
}

/** Run `migrations` from `from` up to `to`. */
export function migrateSnapshot(
  data: unknown,
  from: number,
  to: number,
  migrations: Readonly<Record<number, (data: unknown) => unknown>> | undefined,
): Result<unknown> {
  if (from > to) return err(SnapshotVersionMismatchError({ message: `Snapshot version ${from} is newer than ${to}.`, details: { from, to } }));
  let current = data;
  for (let v = from; v < to; v += 1) {
    const step = migrations?.[v];
    if (step === undefined) return err(SnapshotVersionMismatchError({ message: `No snapshot migration from version ${v}.`, details: { from, to, missing: v } }));
    try {
      current = step(current);
    } catch (cause) {
      return err(SnapshotVersionMismatchError({ message: `Snapshot migration from version ${v} threw.`, details: { from, to, failed: v }, cause }));
    }
  }
  return ok(current);
}

type ReadOutcome =
  | { readonly kind: 'missing' }
  | { readonly kind: 'storage'; readonly error: SfError }
  | { readonly kind: 'found'; readonly value: unknown };

export function createSnapshotRegistry(options: SnapshotRegistryOptions): SnapshotRegistry {
  const { store } = options;
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const identityOf = options.identity ?? ((): string | undefined => undefined);
  const epoch = options.epoch ?? FIXED_EPOCH;
  const clock = options.clock ?? Date.now;
  const lifecycle = options.lifecycle ?? browserSnapshotLifecycle();
  const intervalMs = options.intervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
  const restoreTimeoutMs = options.restoreTimeoutMs ?? DEFAULT_RESTORE_TIMEOUT_MS;
  const defaultMaxBytes = options.defaultMaxBytes ?? DEFAULT_SNAPSHOT_MAX_BYTES;
  const prefix = options.prefix ?? DEFAULT_SNAPSHOT_PREFIX;
  const machine = createMachine(snapshotRegistryMachine);
  const sources = new Map<string, SnapshotSource>();
  const provenance = box<ReadonlyMap<string, RestoredMeta>>(new Map());
  const lastRevision = new Map<string, { revision: string | number; identity: string | null }>();
  const issues: SfError[] = [];
  const stops: (() => void)[] = [];
  const lifetime = new AbortController();
  let started = false;
  let restoredOnce = false;
  let saving: Promise<Result<SaveReport>> | undefined;

  const keyOf = (id: string): string => `${prefix}${id}`;
  const report = (error: SfError): void => {
    issues.push(error);
    telemetry.event('snapshot.issue', { subsystem: HYDRATE_SUBSYSTEMS.snapshot, attrs: { code: error.code } });
    options.onIssue?.(error);
  };

  for (const source of options.sources ?? []) {
    if (sources.has(source.id)) report(SnapshotSourceDuplicateError({ details: { source: source.id } }));
    else sources.set(source.id, source);
  }

  const read = async (id: string, signal: AbortSignal): Promise<ReadOutcome> => {
    const got = await store.get(keyOf(id), { signal });
    if (!got.ok) return { kind: 'storage', error: got.error };
    return got.value === undefined ? { kind: 'missing' } : { kind: 'found', value: got.value };
  };

  /** Restore `ids` (registered sources) with an optional time box. */
  const restoreIds = async (ids: readonly string[], signal: AbortSignal | undefined, timeoutMs: number | undefined): Promise<Result<RestoreReport>> => {
    const startedAt = telemetry.now();
    const span = telemetry.span('snapshot.restore', { subsystem: HYDRATE_SUBSYSTEMS.snapshot, attrs: { sources: ids.length } });
    const timer = new AbortController();
    const combined = anySignal(signal, timer.signal, lifetime.signal);
    const epochAtStart = untracked(() => epoch.current);
    const restored: string[] = [];
    const superseded: string[] = [];
    const missing: string[] = [];
    const staleEpoch: string[] = [];
    const dropped: { id: string; reason: DropReason }[] = [];
    const toDelete: string[] = [];
    let timedOut = false;

    const timeoutHandle = timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      timer.abort(new DOMException('restore timeout', 'TimeoutError'));
    }, timeoutMs);
    const settled = new AbortController();
    const abortedOutcome = new Promise<'aborted'>((resolve) => {
      if (combined.aborted) resolve('aborted');
      combined.addEventListener('abort', () => resolve('aborted'), { once: true, signal: settled.signal });
    });
    const reads = await Promise.race([Promise.all(ids.map((id) => read(id, combined))), abortedOutcome]);
    settled.abort();
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);

    const finish = (status: 'ok' | 'cancelled'): RestoreReport => {
      const durationMs = telemetry.now() - startedAt;
      telemetry.record(hydrateMetrics.restoreDuration, durationMs, { outcome: timedOut ? 'timeout' : status }, span);
      span.set('restored', restored.length);
      span.set('dropped', dropped.length);
      span.end(status);
      return { restored, superseded, missing, staleEpoch, dropped, timedOut, durationMs };
    };

    if (reads === 'aborted') {
      if (timedOut) {
        report(SnapshotRestoreTimeoutError({ details: { timeoutMs: timeoutMs ?? null, sources: [...ids] } }));
        return ok(finish('ok'));
      }
      finish('cancelled');
      return err(AbortedError({ cause: combined.reason }));
    }

    const identity = identityOf() ?? null;
    const now = clock();
    const drop = (id: string, reason: DropReason, error: SfError | undefined, remove: boolean): void => {
      dropped.push({ id, reason });
      if (remove) toDelete.push(keyOf(id));
      telemetry.record(hydrateMetrics.snapshotDropped, 1, { source: id, reason }, span);
      if (error !== undefined) report(error);
    };

    batch(() => {
      const nextProvenance = new Map(untracked(() => provenance.get()));
      ids.forEach((id, index) => {
        const source = sources.get(id);
        const outcome = reads[index];
        if (source === undefined || outcome === undefined) return;
        if (outcome.kind === 'missing') {
          missing.push(id);
          return;
        }
        if (outcome.kind === 'storage') {
          drop(id, 'storage', SnapshotStorageError({ details: { source: id, op: 'get' }, cause: outcome.error }), false);
          return;
        }
        const envelope = outcome.value;
        if (!isEnvelope(envelope) || envelope.id !== id) {
          drop(id, 'corrupt', SnapshotCorruptError({ details: { source: id } }), true);
          return;
        }
        if (source.sensitivity === 'identity' && (envelope.identity === null || envelope.identity !== identity)) {
          drop(id, 'identity', SnapshotIdentityMismatchError({ details: { source: id } }), true);
          return;
        }
        const ageMs = Math.max(0, now - envelope.savedAt);
        if (source.maxAgeMs !== undefined && ageMs > source.maxAgeMs) {
          drop(id, 'expired', undefined, true);
          return;
        }
        const migrated = migrateSnapshot(envelope.data, envelope.version, source.version, source.migrations);
        if (!migrated.ok) {
          drop(id, 'version', SnapshotVersionMismatchError({ message: migrated.error.message, details: { source: id, ...migrated.error.details }, cause: migrated.error.cause }), true);
          return;
        }
        const currentEpoch = untracked(() => epoch.current);
        if (currentEpoch !== epochAtStart) {
          staleEpoch.push(id);
          return;
        }
        const meta: RestoredMeta = {
          id,
          source: 'snapshot',
          stale: true,
          savedAt: envelope.savedAt,
          ageMs,
          savedEpoch: envelope.epoch,
          epoch: currentEpoch,
          identity: envelope.identity,
          migratedFrom: envelope.version === source.version ? undefined : envelope.version,
        };
        let applied: Result<RestoreApplied>;
        try {
          applied = source.restore(migrated.value, meta);
        } catch (thrown) {
          applied = err(toSfError(thrown));
        }
        if (!applied.ok) {
          drop(id, 'invalid', SnapshotRestoreFailedError({ details: { source: id }, cause: applied.error }), true);
          return;
        }
        if (applied.value === 'superseded') {
          superseded.push(id);
          return;
        }
        restored.push(id);
        nextProvenance.set(id, meta);
        const revision = source.revision?.();
        if (revision !== undefined) lastRevision.set(id, { revision, identity: envelope.identity });
        telemetry.record(hydrateMetrics.snapshotRestored, 1, { source: id }, span);
        telemetry.record(hydrateMetrics.snapshotAge, ageMs, { source: id }, span);
      });
      provenance.set(nextProvenance);
    });

    if (toDelete.length > 0) {
      const removed = await store.batch(toDelete.map((key): BatchOp<unknown> => ({ type: 'delete', key })));
      if (!removed.ok) report(SnapshotStorageError({ details: { op: 'delete', keys: toDelete }, cause: removed.error }));
    }
    return ok(finish('ok'));
  };

  const registry: SnapshotRegistry = {
    get state() {
      return machine.state;
    },
    get sources() {
      return [...sources.keys()];
    },
    register(source) {
      if (sources.has(source.id)) {
        const error = SnapshotSourceDuplicateError({ details: { source: source.id } });
        report(error);
        return err(error);
      }
      sources.set(source.id, source);
      return ok(() => {
        if (sources.get(source.id) === source) sources.delete(source.id);
      });
    },
    async restore(signal) {
      if (!machine.can('restore')) return err(AbortedError({ message: `Snapshot registry is ${machine.state}.` }));
      machine.send('restore');
      const result = await restoreIds([...sources.keys()], signal, restoreTimeoutMs);
      restoredOnce = true;
      if (machine.can('restored')) machine.send('restored');
      return result;
    },
    async restoreOne(id, signal) {
      if (!sources.has(id)) return err(SnapshotUnknownSourceError({ details: { source: id } }));
      if (machine.is('disposed')) return err(AbortedError({ message: 'Snapshot registry is disposed.' }));
      return restoreIds([id], signal, undefined);
    },
    save(reason = 'manual') {
      if (saving !== undefined) return saving;
      if (machine.is('disposed')) return Promise.resolve(err(AbortedError({ message: 'Snapshot registry is disposed.' })));
      if (!restoredOnce || !machine.is('ready')) {
        return Promise.resolve(ok({
          reason,
          saved: [],
          unchanged: [],
          removed: [],
          skipped: [...sources.keys()].map((id) => ({ id, why: 'not-restored' as const })),
        }));
      }
      machine.send('save');
      saving = (async (): Promise<Result<SaveReport>> => {
        const span = telemetry.span('snapshot.save', { subsystem: HYDRATE_SUBSYSTEMS.snapshot, attrs: { reason } });
        const identity = identityOf() ?? null;
        const saved: string[] = [];
        const unchanged: string[] = [];
        const removed: string[] = [];
        const skipped: { id: string; why: 'not-restored' | 'no-identity' | 'over-budget' }[] = [];
        const ops: BatchOp<unknown>[] = [];
        const revisions = new Map<string, { revision: string | number; identity: string | null }>();
        const sizes = new Map<string, number>();
        const savedAt = clock();
        const savedEpoch = untracked(() => epoch.current);
        for (const source of sources.values()) {
          const id = source.id;
          const envelopeIdentity = source.sensitivity === 'identity' ? identity : null;
          if (source.sensitivity === 'identity' && identity === null) {
            skipped.push({ id, why: 'no-identity' });
            continue;
          }
          let revision: string | number | undefined;
          let data: unknown;
          try {
            revision = source.revision?.();
            const last = lastRevision.get(id);
            if (revision !== undefined && last !== undefined && last.revision === revision && last.identity === envelopeIdentity) {
              unchanged.push(id);
              continue;
            }
            data = source.capture();
          } catch (thrown) {
            report(toSfError(thrown));
            continue;
          }
          if (data === undefined) {
            ops.push({ type: 'delete', key: keyOf(id) });
            removed.push(id);
            continue;
          }
          const bytes = byteSize(data);
          const maxBytes = source.maxBytes ?? defaultMaxBytes;
          if (bytes > maxBytes) {
            ops.push({ type: 'delete', key: keyOf(id) });
            skipped.push({ id, why: 'over-budget' });
            report(SnapshotOverBudgetError({ details: { source: id, bytes, maxBytes } }));
            continue;
          }
          const envelope: SnapshotEnvelope = {
            format: SNAPSHOT_ENVELOPE_FORMAT,
            id,
            version: source.version,
            identity: envelopeIdentity,
            savedAt,
            epoch: savedEpoch,
            bytes,
            data,
          };
          ops.push({ type: 'set', key: keyOf(id), value: envelope });
          saved.push(id);
          sizes.set(id, bytes);
          if (revision !== undefined) revisions.set(id, { revision, identity: envelopeIdentity });
        }
        if (ops.length > 0) {
          const written = await store.batch(ops);
          if (!written.ok) {
            const error = SnapshotStorageError({ details: { op: 'batch', reason }, cause: written.error });
            report(error);
            span.end('error', error);
            return err(error);
          }
        }
        for (const [id, rev] of revisions) lastRevision.set(id, rev);
        for (const [id, bytes] of sizes) telemetry.record(hydrateMetrics.snapshotBytes, bytes, { source: id }, span);
        span.set('saved', saved.length);
        span.end('ok');
        return ok({ reason, saved, unchanged, removed, skipped });
      })().finally(() => {
        saving = undefined;
        if (machine.can('saved')) machine.send('saved');
      });
      return saving;
    },
    start() {
      if (started || machine.is('disposed')) return;
      started = true;
      stops.push(lifecycle.onHide(() => void registry.save('hide')));
      if (intervalMs > 0) stops.push(lifecycle.every(intervalMs, () => void registry.save('interval')));
    },
    provenance(id) {
      return provenance.get().get(id);
    },
    async clearIdentityBound() {
      const ids = [...sources.values()].filter((s) => s.sensitivity === 'identity').map((s) => s.id);
      for (const id of ids) lastRevision.delete(id);
      batch(() => {
        const next = new Map(untracked(() => provenance.get()));
        for (const id of ids) next.delete(id);
        provenance.set(next);
      });
      if (ids.length === 0) return ok([]);
      const removed = await store.batch(ids.map((id): BatchOp<unknown> => ({ type: 'delete', key: keyOf(id) })));
      if (!removed.ok) {
        const error = SnapshotStorageError({ details: { op: 'delete', keys: ids }, cause: removed.error });
        report(error);
        return err(error);
      }
      return ok(ids);
    },
    async prune() {
      const keys = await store.seek({ prefix }).keys();
      if (!keys.ok) {
        const error = SnapshotStorageError({ details: { op: 'seek' }, cause: keys.error });
        report(error);
        return err(error);
      }
      const orphans = keys.value.filter((key) => !sources.has(key.slice(prefix.length)));
      if (orphans.length === 0) return ok([]);
      const removed = await store.batch(orphans.map((key): BatchOp<unknown> => ({ type: 'delete', key })));
      if (!removed.ok) {
        const error = SnapshotStorageError({ details: { op: 'delete', keys: orphans }, cause: removed.error });
        report(error);
        return err(error);
      }
      return ok(orphans);
    },
    issues: () => [...issues],
    async dispose() {
      if (machine.is('disposed')) return;
      for (const stop of stops.splice(0)) stop();
      lifetime.abort();
      machine.send('dispose');
    },
  };
  return registry;
}
