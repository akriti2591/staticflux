/**
 * The folder mirror (SF-Δ2, PHASE0 finding 3): in folder mode commits are
 * acknowledged by the **OPFS journal** (sub-ms) and this mirror copies the
 * workspace to the picked folder in batches. A real folder head swap costs
 * ≈113 ms against 0.8 ms in OPFS (S6 owner run), so the folder is never on
 * the ack path.
 *
 * - Writers report changes through `mirror.notify` (pass it as the workspace
 *   store's `observer`). The mirror coalesces them per path.
 * - A flush copies new immutable objects (create-only), rewrites changed log
 *   segments, applies deletions, and only then swaps the folder heads (temp +
 *   `move()` under a Web Lock), so a folder head never names a missing object.
 * - Flush policy: after `idleMs` without changes, at most once per
 *   `minIntervalMs`, and at the latest `maxDelayMs` after the first unflushed
 *   change. `flush()` (milestone) and `close()` flush immediately.
 * - Permission (IF-3.12): when the folder's `readwrite` permission lapses the
 *   mirror pauses (`readOnly`), keeps pending changes, and reports
 *   `SF-BLOB-004`. `regrant()` (from a user gesture) asks again, then runs a
 *   full sync. `checkExternal()` (call on focus) reports folder heads that
 *   something else advanced.
 *
 * Lifecycle `blob/folder-mirror` (docs/LIFECYCLES.md).
 */
import { createMachine, defineMachine, err, ok, type Result, type SfError } from '@staticflux/core';
import { BlobPermissionError, toBlobError } from './errors.js';
import {
  createDirectoryCache,
  type DirectoryHandleLike,
  fileExists,
  isTempName,
  listDirectories,
  listFiles,
  publishFile,
  readFile,
  removeFile,
  statFile,
} from './fs.js';
import { createHeadStore, type Head } from './heads.js';
import type { LockManagerLike } from './locks.js';
import { runPool } from './pool.js';
import type { StoreChange, StoreObserver } from './types.js';

export const FolderMirrorMachine = /* @__PURE__ */ defineMachine({
  id: 'blob/folder-mirror',
  initial: 'idle',
  states: ['idle', 'scheduled', 'flushing', 'paused', 'disposed'],
  transitions: {
    idle: { change: 'scheduled', flush: 'flushing', lapse: 'paused', dispose: 'disposed' },
    scheduled: { change: 'scheduled', flush: 'flushing', lapse: 'paused', dispose: 'disposed' },
    flushing: { done: 'idle', more: 'scheduled', lapse: 'paused', dispose: 'disposed' },
    paused: { change: 'paused', regrant: 'flushing', dispose: 'disposed' },
  },
  terminal: ['disposed'],
});

export type FolderMirrorState = (typeof FolderMirrorMachine.states)[number];

export interface MirrorPolicy {
  /** Quiet time before a flush (default 300 ms). */
  readonly idleMs: number;
  /** Minimum time between flush starts (default 1000 ms: "at most about once per second"). */
  readonly minIntervalMs: number;
  /** Upper bound from the first unflushed change to its flush (default 5000 ms). */
  readonly maxDelayMs: number;
}

export const DEFAULT_MIRROR_POLICY: MirrorPolicy = { idleMs: 300, minIntervalMs: 1000, maxDelayMs: 5000 };

export interface MirrorClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const globalClock: MirrorClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

export interface FolderMirrorOptions {
  /** The OPFS workspace directory (the journal and the source of truth for acks). */
  readonly source: DirectoryHandleLike;
  /** The picked folder's workspace directory. */
  readonly target: DirectoryHandleLike;
  readonly locks: LockManagerLike;
  /** Lock namespace (the workspace id). Folder heads lock `<prefix>:folder:head:<name>`. */
  readonly lockPrefix: string;
  readonly policy?: Partial<MirrorPolicy>;
  readonly clock?: MirrorClock;
  /** Copies in flight per flush (default 8). */
  readonly concurrency?: number;
  readonly onError?: (error: SfError) => void;
}

export interface FlushReport {
  readonly objects: number;
  readonly logs: number;
  readonly deletes: number;
  readonly heads: number;
}

export interface ExternalChange {
  readonly name: string;
  readonly folderGeneration: number;
  readonly knownGeneration: number;
}

export interface FolderMirror {
  readonly state: FolderMirrorState;
  /** True while folder permission is lost: the app must not accept edits. */
  readonly readOnly: boolean;
  /** Changes waiting for the next flush. */
  readonly pending: number;
  readonly lastError: SfError | undefined;
  /** Pass as the workspace store's `observer`. */
  readonly notify: StoreObserver;
  /** Flush now, ignoring the batching policy (milestones). */
  flush(signal?: AbortSignal): Promise<Result<FlushReport>>;
  /** Copy everything the folder lacks (first enable, after a re-grant). */
  fullSync(signal?: AbortSignal): Promise<Result<FlushReport>>;
  /** Query permission; a lapse pauses the mirror. */
  checkPermission(): Promise<Result<boolean>>;
  /** Ask for permission again (needs a user gesture); on success sync and resume. */
  regrant(): Promise<Result<boolean>>;
  /** Folder heads whose generation is ahead of what this mirror knows (call on focus). */
  checkExternal(): Promise<Result<readonly ExternalChange[]>>;
  onStateChange(listener: (state: FolderMirrorState) => void): () => void;
  /** Final flush, then dispose. */
  close(): Promise<Result<FlushReport>>;
  dispose(): void;
}

const keyOf = (path: readonly string[], name: string): string => `${path.join('/')}/${name}`;

export function createFolderMirror(options: FolderMirrorOptions): FolderMirror {
  const policy: MirrorPolicy = { ...DEFAULT_MIRROR_POLICY, ...options.policy };
  const clock = options.clock ?? globalClock;
  const concurrency = options.concurrency ?? 8;
  const machine = createMachine(FolderMirrorMachine);
  const sourceDirs = createDirectoryCache(options.source);
  const targetDirs = createDirectoryCache(options.target);
  const sourceHeads = createHeadStore(options.source, { locks: options.locks, lockPrefix: options.lockPrefix });
  const targetHeads = createHeadStore(options.target, { locks: options.locks, lockPrefix: `${options.lockPrefix}:folder` });
  const pending = new Map<string, StoreChange>();
  const known = new Map<string, number>();
  const listeners = new Set<(state: FolderMirrorState) => void>();
  let timer: unknown;
  let firstPendingAt: number | undefined;
  let lastChangeAt = 0;
  let lastFlushAt = -Infinity;
  let lastError: SfError | undefined;
  let running: Promise<Result<FlushReport>> | undefined;

  machine.onTransition(({ to }) => {
    for (const listener of [...listeners]) listener(to);
  });

  const report = (error: SfError): void => {
    lastError = error;
    options.onError?.(error);
  };

  const lapse = (error: SfError): void => {
    if (machine.can('lapse')) machine.send('lapse');
    report(error);
  };

  const schedule = (): void => {
    if (!machine.is('idle', 'scheduled')) return;
    if (pending.size === 0) return;
    const now = clock.now();
    firstPendingAt ??= now;
    const earliest = lastFlushAt + policy.minIntervalMs;
    const idleDue = lastChangeAt + policy.idleMs;
    const due = Math.max(earliest, Math.min(idleDue, firstPendingAt + policy.maxDelayMs));
    if (timer !== undefined) clock.clearTimeout(timer);
    machine.send('change');
    timer = clock.setTimeout(
      () => {
        timer = undefined;
        if (machine.is('scheduled')) void runFlush();
      },
      Math.max(0, due - now),
    );
  };

  const copyFile = async (path: readonly string[], name: string, createOnly: boolean): Promise<Result<boolean>> => {
    const from = await sourceDirs.get(path, false);
    if (!from.ok) return from;
    if (from.value === undefined) return ok(false);
    const to = await targetDirs.get(path, true);
    if (!to.ok) return to;
    if (to.value === undefined) return ok(false);
    if (createOnly) {
      const exists = await fileExists(to.value, name);
      if (!exists.ok) return exists;
      if (exists.value) return ok(false);
    } else {
      const [a, b] = await Promise.all([statFile(from.value, name), statFile(to.value, name)]);
      if (a.ok && b.ok && a.value.size === b.value.size && b.value.lastModified >= a.value.lastModified) return ok(false);
    }
    const bytes = await readFile(from.value, name);
    if (!bytes.ok) return bytes.error.code === 'SF-BLOB-005' ? ok(false) : bytes;
    const written = await publishFile(to.value, name, bytes.value, 'writable');
    return written.ok ? ok(true) : written;
  };

  const replicateHead = async (name: string): Promise<Result<boolean>> => {
    const head = await sourceHeads.read<Head>(name);
    if (!head.ok) return head;
    if (head.value === undefined) return ok(false);
    const written = await targetHeads.replicate(name, head.value);
    if (written.ok) known.set(name, Math.max(known.get(name) ?? 0, head.value.generation));
    return written;
  };

  const apply = async (changes: readonly StoreChange[], signal: AbortSignal | undefined): Promise<Result<FlushReport>> => {
    let objects = 0;
    let logs = 0;
    let deletes = 0;
    let heads = 0;
    let failure: SfError | undefined;
    const files = changes.filter((c) => c.kind === 'object' || c.kind === 'log');
    await runPool(files, concurrency, async (change) => {
      if (failure !== undefined || signal?.aborted === true) return;
      if (change.kind !== 'object' && change.kind !== 'log') return;
      const copied = await copyFile(change.path, change.name, change.kind === 'object');
      if (!copied.ok) failure = copied.error;
      else if (copied.value) {
        if (change.kind === 'object') objects += 1;
        else logs += 1;
      }
    });
    if (failure !== undefined) return err(failure);
    for (const change of changes) {
      if (change.kind !== 'delete') continue;
      const dir = await targetDirs.get(change.path, false);
      if (!dir.ok) return dir;
      if (dir.value === undefined) continue;
      const removed = await removeFile(dir.value, change.name);
      if (!removed.ok) return removed;
      deletes += 1;
    }
    for (const change of changes) {
      if (change.kind !== 'head') continue;
      const written = await replicateHead(change.name);
      if (!written.ok) return written;
      if (written.value) heads += 1;
    }
    return ok({ objects, logs, deletes, heads });
  };

  const permitted = async (): Promise<Result<boolean>> => {
    if (options.target.queryPermission === undefined) return ok(true);
    try {
      return ok((await options.target.queryPermission({ mode: 'readwrite' })) === 'granted');
    } catch (cause) {
      return err(toBlobError(cause, 'query-permission'));
    }
  };

  const runFlush = (signal?: AbortSignal, changesOverride?: () => Promise<Result<StoreChange[]>>): Promise<Result<FlushReport>> => {
    if (running !== undefined) {
      // Chain: a flush requested during a flush runs right after it.
      return running.then(() => runFlush(signal, changesOverride));
    }
    const task = (async (): Promise<Result<FlushReport>> => {
      if (machine.is('disposed')) return ok({ objects: 0, logs: 0, deletes: 0, heads: 0 });
      if (machine.is('paused') && changesOverride === undefined) return err(BlobPermissionError());
      const allowed = await permitted();
      if (!allowed.ok || !allowed.value) {
        const error = allowed.ok ? BlobPermissionError() : allowed.error;
        lapse(error);
        return err(error);
      }
      if (machine.can('flush')) machine.send('flush');
      else if (machine.is('paused')) machine.send('regrant');
      if (timer !== undefined) {
        clock.clearTimeout(timer);
        timer = undefined;
      }
      const started = clock.now();
      lastFlushAt = started;
      firstPendingAt = undefined;
      const batch = [...pending.values()];
      pending.clear();
      let changes: StoreChange[] = batch;
      if (changesOverride !== undefined) {
        const listed = await changesOverride();
        if (!listed.ok) {
          for (const change of batch) pending.set(keyOf('path' in change ? change.path : ['heads'], change.name), change);
          finishWith('done');
          return listed;
        }
        changes = [...batch, ...listed.value];
      }
      const applied = await apply(changes, signal);
      if (!applied.ok) {
        // Keep the changes for the next attempt (newer notifications win).
        for (const change of changes) {
          const key = keyOf('path' in change ? change.path : ['heads'], change.name);
          if (!pending.has(key)) pending.set(key, change);
        }
        if (applied.error.code === 'SF-BLOB-004') lapse(applied.error);
        else {
          report(applied.error);
          finishWith('more');
        }
        return applied;
      }
      lastError = undefined;
      finishWith(pending.size > 0 ? 'more' : 'done');
      return applied;
    })();
    running = task;
    void task.finally(() => {
      if (running === task) running = undefined;
    });
    return task;
  };

  const finishWith = (event: 'done' | 'more'): void => {
    if (!machine.is('flushing')) return;
    if (event === 'more') {
      machine.send('done');
      schedule();
    } else machine.send('done');
  };

  /** Everything in the source the folder may lack. */
  const inventory = async (): Promise<Result<StoreChange[]>> => {
    const out: StoreChange[] = [];
    const walk = async (path: readonly string[]): Promise<Result<void>> => {
      const dir = await sourceDirs.get(path, false);
      if (!dir.ok) return dir;
      if (dir.value === undefined) return ok();
      const files = await listFiles(dir.value);
      if (!files.ok) return files;
      const top = path[0];
      for (const name of files.value) {
        if (isTempName(name)) continue;
        if (top === 'heads') {
          if (name.endsWith('.json')) out.push({ kind: 'head', name: name.slice(0, -5) });
        } else if (top === 'log') out.push({ kind: 'log', path, name });
        else out.push({ kind: 'object', path, name });
      }
      const subdirs = await listDirectories(dir.value);
      if (!subdirs.ok) return subdirs;
      for (const sub of subdirs.value) {
        if (path.length === 0 && sub === 'quarantine') continue;
        const walked = await walk([...path, sub]);
        if (!walked.ok) return walked;
      }
      return ok();
    };
    const walked = await walk([]);
    return walked.ok ? ok(out) : walked;
  };

  const mirror: FolderMirror = {
    get state() {
      return machine.state;
    },
    get readOnly() {
      return machine.is('paused');
    },
    get pending() {
      return pending.size;
    },
    get lastError() {
      return lastError;
    },
    notify(change) {
      if (machine.is('disposed')) return;
      const key = keyOf('path' in change ? change.path : ['heads'], change.name);
      pending.delete(key);
      pending.set(key, change);
      lastChangeAt = clock.now();
      schedule();
    },
    flush: (signal) => runFlush(signal),
    fullSync: (signal) => runFlush(signal, inventory),
    async checkPermission() {
      const allowed = await permitted();
      if (allowed.ok && !allowed.value) lapse(BlobPermissionError());
      return allowed;
    },
    async regrant() {
      if (machine.is('disposed')) return ok(false);
      if (options.target.requestPermission !== undefined) {
        try {
          const state = await options.target.requestPermission({ mode: 'readwrite' });
          if (state !== 'granted') return ok(false);
        } catch (cause) {
          return err(toBlobError(cause, 'request-permission'));
        }
      }
      const synced = await runFlush(undefined, inventory);
      return synced.ok ? ok(true) : synced;
    },
    async checkExternal() {
      const names = await targetHeads.list();
      if (!names.ok) return names;
      const changes: ExternalChange[] = [];
      for (const name of names.value) {
        const folder = await targetHeads.read<Head>(name);
        if (!folder.ok) return folder;
        if (folder.value === undefined) continue;
        const source = await sourceHeads.read<Head>(name);
        const sourceGeneration = source.ok ? (source.value?.generation ?? 0) : 0;
        const knownGeneration = Math.max(known.get(name) ?? 0, sourceGeneration);
        if (folder.value.generation > knownGeneration) {
          changes.push({ name, folderGeneration: folder.value.generation, knownGeneration });
        }
      }
      return ok(changes);
    },
    onStateChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      const flushed = machine.is('paused') ? err(BlobPermissionError()) : await runFlush();
      mirror.dispose();
      return flushed;
    },
    dispose() {
      if (machine.is('disposed')) return;
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = undefined;
      machine.send('dispose');
    },
  };
  return mirror;
}
