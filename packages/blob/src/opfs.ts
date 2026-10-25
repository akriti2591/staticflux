/**
 * OPFS entry points: feature detection, opening a workspace directory, and
 * `createWorkspaceStore` — the blob store, head store and journals of one
 * workspace directory wired together (DOCUMENT-FORMAT §5.1 layout). The same
 * function serves OPFS (`root` from `openOpfsDirectory`) and a picked folder.
 */
import { err, ok, type Result, type Telemetry } from '@staticflux/core';
import { createBlobStore } from './blob-store.js';
import type { BlobCatalog } from './catalog.js';
import { createDirectoryObjectStore, type DirectoryObjectStore, detectSyncAccessHandles, type WriteModePolicy } from './directory.js';
import { BlobUnavailableError, toBlobError } from './errors.js';
import type { DirectoryHandleLike } from './fs.js';
import { createHeadStore, type HeadStore } from './heads.js';
import { createJournal, type Journal, type JournalMode } from './journal.js';
import { detectLocks, type LockManagerLike } from './locks.js';
import { detectStorageManager, type StorageManagerLike } from './quota.js';
import type { BlobStore, StoreObserver } from './types.js';

export interface OpfsSupport {
  readonly opfs: boolean;
  /** Only true inside a dedicated worker. */
  readonly syncAccessHandles: boolean;
  /** `FileSystemFileHandle.prototype.move` (S6: not on `FileSystemHandle.prototype`). */
  readonly move: boolean;
  readonly locks: boolean;
  readonly broadcastChannel: boolean;
}

/** What this context supports (synchronous; no permission prompts). */
export function detectOpfs(storage: StorageManagerLike | undefined = detectStorageManager()): OpfsSupport {
  const g = globalThis as { FileSystemFileHandle?: { prototype?: { move?: unknown } }; BroadcastChannel?: unknown };
  return {
    opfs: typeof storage?.getDirectory === 'function',
    syncAccessHandles: detectSyncAccessHandles(),
    move: typeof g.FileSystemFileHandle?.prototype?.move === 'function',
    locks: detectLocks() !== undefined,
    broadcastChannel: typeof g.BroadcastChannel === 'function',
  };
}

/** Open (creating) `path` below the OPFS root, e.g. `['instaflow', 'ws_01J…']`. */
export async function openOpfsDirectory(
  path: readonly string[],
  storage: StorageManagerLike | undefined = detectStorageManager(),
): Promise<Result<DirectoryHandleLike>> {
  if (storage?.getDirectory === undefined) return err(BlobUnavailableError({ message: 'OPFS (`navigator.storage.getDirectory`) is not available.' }));
  try {
    let dir = await storage.getDirectory();
    for (const part of path) dir = await dir.getDirectoryHandle(part, { create: true });
    return ok(dir);
  } catch (cause) {
    return err(toBlobError(cause, 'open-opfs', path.join('/')));
  }
}

export interface WorkspaceStoreOptions {
  /** Lock namespace (the workspace id). */
  readonly lockPrefix: string;
  /** This writer's peer id (journal segment names). */
  readonly peer: string;
  readonly locks?: LockManagerLike;
  readonly catalog?: BlobCatalog;
  readonly observer?: StoreObserver;
  readonly telemetry?: Telemetry;
  /** Blob write mode (default `auto`: sync handles for objects >= 1 MiB when available). */
  readonly writeMode?: WriteModePolicy;
  /** Journal mode (default: `append` when sync handles are available, else `segments`). */
  readonly journalMode?: JournalMode;
  readonly syncAvailable?: boolean;
  readonly now?: () => number;
}

export interface WorkspaceStore {
  readonly root: DirectoryHandleLike;
  readonly objects: DirectoryObjectStore;
  readonly blobs: BlobStore;
  readonly heads: HeadStore;
  readonly journalMode: JournalMode;
  /** The journal of one stream (asset). Only the leader opens journals. */
  journal(stream: string): Journal;
  dispose(): void;
}

export function createWorkspaceStore(root: DirectoryHandleLike, options: WorkspaceStoreOptions): Result<WorkspaceStore> {
  const locks = options.locks ?? detectLocks();
  if (locks === undefined) return err(BlobUnavailableError({ message: 'Web Locks are required: head compare-and-swap is unsafe without them (S6).' }));
  const syncAvailable = options.syncAvailable ?? detectSyncAccessHandles();
  const objects = createDirectoryObjectStore(root, {
    ...(options.writeMode === undefined ? {} : { writeMode: options.writeMode }),
    ...(options.observer === undefined ? {} : { observer: options.observer }),
    syncAvailable,
  });
  const blobs = createBlobStore(objects, {
    ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
    ...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const heads = createHeadStore(root, {
    locks,
    lockPrefix: options.lockPrefix,
    ...(options.observer === undefined ? {} : { observer: options.observer }),
  });
  const journalMode = options.journalMode ?? (syncAvailable ? 'append' : 'segments');
  return ok({
    root,
    objects,
    blobs,
    heads,
    journalMode,
    journal: (stream) =>
      createJournal(root, { stream, peer: options.peer, mode: journalMode, ...(options.observer === undefined ? {} : { observer: options.observer }) }),
    dispose: () => blobs.dispose(),
  });
}
