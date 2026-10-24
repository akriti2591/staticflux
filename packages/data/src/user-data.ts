/**
 * The user-data document (R9.8–R9.12): typed per-feature slices over pluggable
 * backends, offline-first, batched writes, remote sync with per-slice conflict
 * policy, migrations on read, budgets, and the logout policy.
 *
 * - Reads are local-first: a slice is `ready` from the local backend (or its
 *   default) without waiting for the network; remote sync reconciles afterwards.
 * - Writes update the reactive value immediately and are flushed in one batched
 *   backend write per `writeDelayMs`; synced scopes are then pushed to the remote.
 * - Failed backend/remote IO never loses data: values stay dirty and are retried
 *   on the next flush; errors are reported (`errors`, `onError`, telemetry).
 * - A failed migration yields the default value plus a reported `SF-DATA-051`.
 * - Logout: flush (incl. remote push), then wipe local copies of the scopes in
 *   `logoutPolicy.wipe` (default `user`, `workspace`, `session`) and reload slices as guest.
 *
 * Storage keys: `sf-ud/<scope>/<owner>/<slice key>` where owner is the device id,
 * user id (`guest` when signed out), `<user>@<workspace>`, or `session`.
 */
import {
  AbortedError,
  batch,
  box,
  type Box,
  createMachine,
  createNoopTelemetry,
  err,
  type Machine,
  ok,
  type Result,
  type SfError,
  type Telemetry,
  toSfError,
  untracked,
} from '@staticflux/core';
import { byteSize, clonePlain, deepFreeze } from './clone.js';
import { RemoteSyncError, SliceBudgetError, SliceKeyCollisionError, SliceNotReadyError } from './errors.js';
import { DATA_SUBSYSTEMS, DataMetrics } from './metrics.js';
import { migrateRecord, type SliceDefinition, SliceMachine, type SliceRecord, type SliceScope, type SliceState } from './slices.js';
import { createMemoryBackend, type RecordPut, type RemoteSyncPort, type SliceBackend } from './storage.js';

type SliceEvent = 'load' | 'loaded' | 'migrate' | 'migrated' | 'fail' | 'recover' | 'save' | 'saved' | 'saveFailed' | 'conflict' | 'resolve' | 'flush' | 'clear';

export interface UserIdentity {
  /** undefined = guest. */
  readonly userId: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly deviceId: string;
}

export interface LogoutPolicy {
  /** Local copies of these scopes are wiped on logout. Default `['user', 'workspace', 'session']`. */
  readonly wipe: readonly SliceScope[];
}

export interface UserDataOptions {
  readonly identity: UserIdentity;
  /** Local persistence for device/user/workspace slices. Default: memory. */
  readonly local?: SliceBackend;
  /** Remote sync for user/workspace slices (signed-in users only). */
  readonly remote?: RemoteSyncPort;
  /** Debounce for batched writes. Default 250 ms. */
  readonly writeDelayMs?: number;
  readonly logoutPolicy?: LogoutPolicy;
  readonly telemetry?: Telemetry;
  readonly now?: () => number;
  readonly onError?: (error: SfError) => void;
}

export interface SliceHandle<T> {
  readonly key: string;
  readonly scope: SliceScope;
  /** Lifecycle state (LIFECYCLES §10). Reactive. */
  readonly state: SliceState;
  /** Current value (the default until loaded). Reactive, frozen. */
  readonly value: T;
  /** Last error for this slice (migration, budget, IO). Reactive. */
  readonly error: SfError | undefined;
  /** Unsaved local changes exist. */
  readonly dirty: boolean;
  whenReady(signal?: AbortSignal): Promise<Result<T>>;
  /** Validate, budget-check and set; persisted on the next batched flush. */
  set(next: T | ((previous: T) => T)): Result<void>;
  /** Back to the default value (persisted). */
  reset(): Result<void>;
}

export interface UserDataDocumentEntry {
  readonly scope: SliceScope;
  readonly state: SliceState;
  readonly v: number;
  readonly value: unknown;
  readonly updatedAt: number;
}

export interface UserData {
  /** Register (once per key) and load a slice. Different definitions for one key throw `SF-DATA-050`. */
  slice<T>(definition: SliceDefinition<T>): SliceHandle<T>;
  /** Write dirty slices now (one batched local write), then push synced scopes. */
  flush(): Promise<Result<void>>;
  /** Pull remote copies, resolve conflicts, then flush. */
  sync(): Promise<Result<void>>;
  /** Switch user/workspace: flush, then reload affected slices for the new identity (no wipe). */
  setIdentity(identity: UserIdentity): Promise<Result<void>>;
  /** Flush, wipe per policy, continue as guest. */
  logout(): Promise<Result<void>>;
  readonly identity: UserIdentity;
  /** Snapshot of all loaded slices (devtools, handoff). */
  document(): Readonly<Record<string, UserDataDocumentEntry>>;
  /** Reported errors (most recent last, capped at 50). Reactive. */
  readonly errors: readonly SfError[];
  /** Flush and stop timers. */
  dispose(): Promise<void>;
}

export const DEFAULT_LOGOUT_POLICY: LogoutPolicy = { wipe: ['user', 'workspace', 'session'] };

interface Entry {
  readonly definition: SliceDefinition<unknown>;
  readonly machine: Machine<SliceState, SliceEvent>;
  readonly value: Box<unknown>;
  readonly error: Box<SfError | undefined>;
  readonly dirtyBox: Box<boolean>;
  /** Bumped on every local change; flushes compare against it. */
  revision: number;
  localRevision: number;
  remoteRevision: number;
  updatedAt: number;
  /** Remote `updatedAt` last pulled or pushed. */
  remoteSeenAt: number;
  storageKey: string;
  loading: Promise<Result<unknown>> | undefined;
  handle: SliceHandle<unknown> | undefined;
}

const READY_STATES: readonly SliceState[] = ['ready', 'saving', 'conflicted'];

export function ownerFor(scope: SliceScope, identity: UserIdentity): string {
  const user = identity.userId ?? 'guest';
  if (scope === 'device') return identity.deviceId;
  if (scope === 'user') return user;
  if (scope === 'workspace') return `${user}@${identity.workspaceId ?? 'default'}`;
  return 'session';
}

export function storageKeyFor(definition: Pick<SliceDefinition<unknown>, 'scope' | 'key'>, identity: UserIdentity): string {
  return `sf-ud/${definition.scope}/${ownerFor(definition.scope, identity)}/${definition.key}`;
}

export function createUserData(options: UserDataOptions): UserData {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const now = options.now ?? Date.now;
  const local = options.local ?? createMemoryBackend();
  const sessionBackend = createMemoryBackend();
  const writeDelayMs = options.writeDelayMs ?? 250;
  const policy = options.logoutPolicy ?? DEFAULT_LOGOUT_POLICY;
  const entries = new Map<string, Entry>();
  const errors = box<readonly SfError[]>([]);
  let identity = options.identity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let chain: Promise<unknown> = Promise.resolve();

  /** Serialize all IO (load, flush, sync, identity changes). */
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn);
    chain = next.catch(() => undefined);
    return next;
  };

  const report = (entry: Entry | undefined, error: SfError): void => {
    errors.set([...untracked(() => errors.get()), error].slice(-50));
    entry?.error.set(error);
    telemetry.event('slice.error', { subsystem: DATA_SUBSYSTEMS.slice, level: 'critical', attrs: { key: entry?.definition.key ?? '*', code: error.code } });
    options.onError?.(error);
  };

  const send = (entry: Entry, event: SliceEvent): void => {
    const result = entry.machine.send(event);
    if (!result.ok) report(entry, result.error);
  };

  const backendFor = (entry: Entry): SliceBackend => (entry.definition.scope === 'session' ? sessionBackend : local);
  const syncs = (entry: Entry): boolean =>
    options.remote !== undefined && (entry.definition.scope === 'user' || entry.definition.scope === 'workspace') && identity.userId !== undefined;
  const isReady = (entry: Entry): boolean => READY_STATES.includes(untracked(() => entry.machine.state));
  const updateDirty = (entry: Entry): void => {
    entry.dirtyBox.set(entry.localRevision !== entry.revision || (syncs(entry) && entry.remoteRevision !== entry.revision));
  };

  const setValue = (entry: Entry, value: unknown, updatedAt: number): void => {
    entry.value.set(deepFreeze(clonePlain(value)));
    entry.updatedAt = updatedAt;
  };

  const resetToDefault = (entry: Entry): void => {
    batch(() => {
      setValue(entry, entry.definition.default(), 0);
      entry.revision = 0;
      entry.localRevision = 0;
      entry.remoteRevision = 0;
      entry.remoteSeenAt = 0;
      updateDirty(entry);
    });
  };

  const scheduleFlush = (): void => {
    if (timer !== undefined || disposed) return;
    timer = setTimeout(() => {
      timer = undefined;
      void userData.flush();
    }, writeDelayMs);
  };

  const markChanged = (entry: Entry): void => {
    entry.revision += 1;
    updateDirty(entry);
    scheduleFlush();
  };

  // ------------------------------------------------------------ load

  const loadEntry = (entry: Entry): Promise<Result<unknown>> => {
    const promise = serial(async (): Promise<Result<unknown>> => {
      entry.storageKey = storageKeyFor(entry.definition, identity);
      send(entry, 'load');
      const span = telemetry.span('slice.load', { subsystem: DATA_SUBSYSTEMS.slice, attrs: { key: entry.definition.key, scope: entry.definition.scope } });
      const read = await backendFor(entry).get([entry.storageKey]);
      const fallback = (error: SfError): Result<unknown> => {
        send(entry, 'fail');
        resetToDefault(entry);
        report(entry, error);
        send(entry, 'recover');
        span.end('error', error);
        return ok(untracked(() => entry.value.get()));
      };
      if (!read.ok) return fallback(read.error);
      const record = read.value[entry.storageKey];
      if (record === undefined) {
        resetToDefault(entry);
        send(entry, 'loaded');
        span.end('ok');
        return ok(untracked(() => entry.value.get()));
      }
      const needsMigration = record.v !== entry.definition.version;
      if (needsMigration) send(entry, 'migrate');
      const migrated = migrateRecord(entry.definition, record);
      if (!migrated.ok) return fallback(migrated.error);
      batch(() => {
        setValue(entry, migrated.value, record.updatedAt);
        entry.revision = 0;
        entry.localRevision = 0;
        // A local value the remote has never confirmed is pushed on the next sync.
        entry.remoteRevision = 0;
        entry.remoteSeenAt = 0;
        entry.error.set(undefined);
        updateDirty(entry);
      });
      send(entry, needsMigration ? 'migrated' : 'loaded');
      span.set('migrated', needsMigration);
      span.end('ok');
      return ok(untracked(() => entry.value.get()));
    });
    entry.loading = promise;
    void promise.then(() => {
      if (entry.loading === promise) entry.loading = undefined;
      if (syncs(entry)) void userData.sync();
    });
    return promise;
  };

  // ------------------------------------------------------------ remote reconcile

  const reconcile = (entry: Entry, remote: SliceRecord | undefined): void => {
    if (!isReady(entry)) return;
    if (remote === undefined) {
      // Nothing remote: push what we have if it is real data (remoteRevision ≠ revision marks "unpushed").
      if (entry.updatedAt > 0 && entry.remoteRevision === entry.revision) entry.remoteRevision = entry.revision - 1;
      updateDirty(entry);
      return;
    }
    const migrated = migrateRecord(entry.definition, remote);
    if (!migrated.ok) {
      report(entry, migrated.error);
      return;
    }
    const remoteChanged = remote.updatedAt > entry.remoteSeenAt;
    const localUnpushed = entry.remoteRevision !== entry.revision;
    if (remoteChanged && localUnpushed && remote.updatedAt !== entry.updatedAt) {
      send(entry, 'conflict');
      const conflict = entry.definition.conflict;
      if (conflict === 'lww') {
        if (remote.updatedAt >= entry.updatedAt) {
          setValue(entry, migrated.value, remote.updatedAt);
          entry.revision += 1;
          entry.remoteRevision = entry.revision;
        }
      } else {
        const merged = entry.definition.schema.validate(conflict.merge(untracked(() => entry.value.get()), migrated.value));
        if (merged.ok) {
          setValue(entry, merged.value, Math.max(now(), remote.updatedAt + 1));
          entry.revision += 1;
        } else {
          report(entry, merged.error);
        }
      }
      telemetry.event('slice.conflict', { subsystem: DATA_SUBSYSTEMS.slice, attrs: { key: entry.definition.key, policy: conflict === 'lww' ? 'lww' : 'merge' } });
      send(entry, 'resolve');
    } else if (remoteChanged && remote.updatedAt > entry.updatedAt) {
      setValue(entry, migrated.value, remote.updatedAt);
      entry.revision += 1;
      entry.remoteRevision = entry.revision;
    } else if (entry.updatedAt > remote.updatedAt && !localUnpushed) {
      entry.remoteRevision = entry.revision - 1;
    }
    entry.remoteSeenAt = Math.max(entry.remoteSeenAt, remote.updatedAt);
    updateDirty(entry);
  };

  // ------------------------------------------------------------ flush

  const flushNow = async (): Promise<Result<void>> => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    let failure: SfError | undefined;
    const writes = new Map<SliceBackend, { entry: Entry; revision: number; put: RecordPut }[]>();
    for (const entry of entries.values()) {
      if (untracked(() => entry.machine.state) !== 'ready' || entry.localRevision === entry.revision) continue;
      const put: RecordPut = {
        key: entry.storageKey,
        record: { v: entry.definition.version, value: untracked(() => entry.value.get()), updatedAt: entry.updatedAt },
      };
      const list = writes.get(backendFor(entry)) ?? [];
      list.push({ entry, revision: entry.revision, put });
      writes.set(backendFor(entry), list);
    }
    for (const [backend, list] of writes) {
      for (const item of list) send(item.entry, 'save');
      const written = await backend.write(
        list.map((i) => i.put),
        [],
      );
      for (const item of list) {
        if (written.ok) {
          item.entry.localRevision = item.revision;
          send(item.entry, 'saved');
          telemetry.record(DataMetrics.sliceBytes, byteSize(item.put.record.value), { key: item.entry.definition.key });
        } else {
          send(item.entry, 'saveFailed');
          report(item.entry, written.error);
          failure = written.error;
        }
        updateDirty(item.entry);
      }
    }
    if (options.remote !== undefined) {
      const pushes = [...entries.values()].filter((e) => isReady(e) && syncs(e) && e.remoteRevision !== e.revision);
      if (pushes.length > 0) {
        const revisions = pushes.map((e) => e.revision);
        const pushed = await options.remote.push(
          pushes.map((e) => ({ key: e.storageKey, record: { v: e.definition.version, value: untracked(() => e.value.get()), updatedAt: e.updatedAt } })),
          new AbortController().signal,
        );
        pushes.forEach((e, i) => {
          if (pushed.ok) {
            e.remoteRevision = revisions[i] ?? e.revision;
            e.remoteSeenAt = Math.max(e.remoteSeenAt, e.updatedAt);
          }
          updateDirty(e);
        });
        if (!pushed.ok) {
          const error = RemoteSyncError({ cause: pushed.error });
          report(undefined, error);
          failure = error;
        }
      }
    }
    return failure === undefined ? ok() : err(failure);
  };

  const pullNow = async (): Promise<Result<void>> => {
    if (options.remote === undefined) return ok();
    const synced = [...entries.values()].filter((e) => isReady(e) && syncs(e));
    if (synced.length === 0) return ok();
    const pulled = await options.remote.pull(
      synced.map((e) => e.storageKey),
      new AbortController().signal,
    );
    if (!pulled.ok) {
      const error = RemoteSyncError({ cause: pulled.error });
      report(undefined, error);
      return err(error);
    }
    batch(() => {
      for (const entry of synced) reconcile(entry, pulled.value[entry.storageKey]);
    });
    return ok();
  };

  // ------------------------------------------------------------ handles

  const makeHandle = (entry: Entry): SliceHandle<unknown> => {
    const set = (next: unknown): Result<void> => {
      if (!isReady(entry)) return err(SliceNotReadyError({ details: { key: entry.definition.key, state: untracked(() => entry.machine.state) } }));
      const current = untracked(() => entry.value.get());
      const value = typeof next === 'function' ? (next as (previous: unknown) => unknown)(current) : next;
      const validated = entry.definition.schema.validate(value);
      if (!validated.ok) return validated;
      let owned: unknown;
      try {
        owned = deepFreeze(clonePlain(validated.value));
      } catch (error) {
        return err(toSfError(error));
      }
      const bytes = byteSize(owned);
      if (bytes > entry.definition.budgetBytes) {
        const error = SliceBudgetError({ details: { key: entry.definition.key, bytes, budgetBytes: entry.definition.budgetBytes } });
        report(entry, error);
        return err(error);
      }
      batch(() => {
        entry.value.set(owned);
        entry.updatedAt = Math.max(now(), entry.updatedAt + 1);
        entry.error.set(undefined);
        markChanged(entry);
      });
      return ok();
    };
    return {
      key: entry.definition.key,
      scope: entry.definition.scope,
      get state() {
        return entry.machine.state;
      },
      get value() {
        return entry.value.get();
      },
      get error() {
        return entry.error.get();
      },
      get dirty() {
        return entry.dirtyBox.get();
      },
      async whenReady(signal) {
        const loading = entry.loading;
        if (loading !== undefined) {
          const aborted =
            signal === undefined
              ? (await loading, false)
              : await new Promise<boolean>((resolve) => {
                  if (signal.aborted) {
                    resolve(true);
                    return;
                  }
                  const detach = new AbortController();
                  signal.addEventListener('abort', () => resolve(true), { once: true, signal: detach.signal });
                  void loading.then(() => {
                    detach.abort();
                    resolve(false);
                  });
                });
          if (aborted) return err(AbortedError({ cause: signal?.reason }));
        }
        if (!isReady(entry)) return err(SliceNotReadyError({ details: { key: entry.definition.key, state: untracked(() => entry.machine.state) } }));
        return ok(untracked(() => entry.value.get()));
      },
      set,
      reset: () => set(entry.definition.default()),
    };
  };

  const userData: UserData = {
    get identity() {
      return identity;
    },
    get errors() {
      return errors.get();
    },

    slice<T>(definition: SliceDefinition<T>): SliceHandle<T> {
      const existing = entries.get(definition.key);
      if (existing !== undefined) {
        if (existing.definition !== (definition as SliceDefinition<unknown>)) {
          throw SliceKeyCollisionError({ details: { key: definition.key } });
        }
        return existing.handle as SliceHandle<T>;
      }
      const entry: Entry = {
        definition: definition as SliceDefinition<unknown>,
        machine: createMachine(SliceMachine) as Machine<SliceState, SliceEvent>,
        value: box<unknown>(deepFreeze(clonePlain(definition.default()))),
        error: box<SfError | undefined>(undefined),
        dirtyBox: box(false),
        revision: 0,
        localRevision: 0,
        remoteRevision: 0,
        updatedAt: 0,
        remoteSeenAt: 0,
        storageKey: storageKeyFor(definition as SliceDefinition<unknown>, identity),
        loading: undefined,
        handle: undefined,
      };
      entry.machine.onTransition((t) =>
        telemetry.event(`lifecycle.slice.${t.from}→${t.to}`, { subsystem: DATA_SUBSYSTEMS.slice, level: 'verbose', attrs: { key: definition.key } }),
      );
      entry.handle = makeHandle(entry);
      entries.set(definition.key, entry);
      void loadEntry(entry);
      return entry.handle as SliceHandle<T>;
    },

    flush: () => serial(flushNow),

    sync: () =>
      serial(async () => {
        const pulled = await pullNow();
        const flushed = await flushNow();
        return pulled.ok ? flushed : pulled;
      }),

    async setIdentity(next) {
      const flushed = await userData.flush();
      const affected = await serial(async () => {
        const previous = identity;
        identity = next;
        const changed = [...entries.values()].filter((e) => storageKeyFor(e.definition, previous) !== storageKeyFor(e.definition, next));
        for (const entry of changed) {
          if (untracked(() => entry.machine.state) === 'ready') {
            send(entry, 'flush');
            send(entry, 'clear');
          }
          resetToDefault(entry);
        }
        return changed;
      });
      await Promise.all(affected.map((entry) => loadEntry(entry)));
      return flushed;
    },

    async logout() {
      const flushed = await userData.flush();
      const wiped = await serial(async () => {
        const departing = identity;
        const prefixes = policy.wipe.map((scope) => `sf-ud/${scope}/${ownerFor(scope, departing)}/`);
        const cleared: Entry[] = [];
        for (const entry of entries.values()) {
          if (!policy.wipe.includes(entry.definition.scope)) continue;
          if (untracked(() => entry.machine.state) === 'ready') send(entry, 'flush');
          cleared.push(entry);
        }
        for (const backend of [local, sessionBackend]) {
          const keys: string[] = [];
          for (const prefix of prefixes) {
            const found = await backend.keys(prefix);
            if (found.ok) keys.push(...found.value);
            else report(undefined, found.error);
          }
          if (keys.length > 0) {
            const deleted = await backend.write([], keys);
            if (!deleted.ok) report(undefined, deleted.error);
          }
        }
        for (const entry of cleared) {
          if (untracked(() => entry.machine.state) === 'flushed') send(entry, 'clear');
          resetToDefault(entry);
        }
        identity = { userId: undefined, workspaceId: undefined, deviceId: departing.deviceId };
        telemetry.event('slice.logout', { subsystem: DATA_SUBSYSTEMS.slice, attrs: { wiped: cleared.length, scopes: [...policy.wipe] } });
        return cleared;
      });
      await Promise.all(wiped.map((entry) => loadEntry(entry)));
      return flushed;
    },

    document() {
      const out: Record<string, UserDataDocumentEntry> = {};
      for (const entry of entries.values()) {
        out[entry.definition.key] = {
          scope: entry.definition.scope,
          state: untracked(() => entry.machine.state),
          v: entry.definition.version,
          value: untracked(() => entry.value.get()),
          updatedAt: entry.updatedAt,
        };
      }
      return out;
    },

    async dispose() {
      if (disposed) return;
      await userData.flush();
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
  return userData;
}
