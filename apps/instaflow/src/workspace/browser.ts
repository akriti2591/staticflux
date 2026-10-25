/**
 * The browser bindings of the local workspace (C0; IF-28.1): its documents in IndexedDB (heads, part snapshots, commit
 * logs) here, and its blobs in OPFS (`blobs.ts`). Home opens only the documents (to read the Home index, no engine);
 * Studio opens both.
 * One local workspace in M1 (guest, D3); the namespace keeps room for more.
 */
import { ok, type Result } from '@staticflux/core';
import type { DocumentStore } from '@staticflux/document/v2';
import { createIndexedDbStore, type IdbFactoryLike, type IdbKeyRangeLike } from '@staticflux/storage';
import { documentStoreFromAsyncStore, type WorkspaceLocks } from './document-store.js';

/** The local workspace: IndexedDB database, object store and OPFS folder names. */
export const LOCAL_WORKSPACE = Object.freeze({ id: 'ws_local', database: 'instaflow', namespace: 'ws_local', opfs: ['instaflow', 'ws_local'] as readonly string[] });

export interface WorkspaceDocuments {
  readonly store: DocumentStore;
  dispose(): Promise<void>;
}

export interface OpenWorkspaceDocumentsOptions {
  /** Injectable IndexedDB (default `globalThis.indexedDB`); tests pass a fake. */
  readonly indexedDB?: IdbFactoryLike | null;
  readonly keyRange?: IdbKeyRangeLike | null;
  readonly locks?: WorkspaceLocks | null;
  readonly workspace?: typeof LOCAL_WORKSPACE;
}

/** Open the workspace's document store in IndexedDB (SF-STORE-002 when IndexedDB is unavailable). */
export function openWorkspaceDocuments(options: OpenWorkspaceDocumentsOptions = {}): Result<WorkspaceDocuments> {
  const workspace = options.workspace ?? LOCAL_WORKSPACE;
  const idb = createIndexedDbStore<unknown>({
    namespace: workspace.namespace,
    dbName: workspace.database,
    ...(options.indexedDB === undefined ? {} : { indexedDB: options.indexedDB }),
    ...(options.keyRange === undefined ? {} : { keyRange: options.keyRange }),
    broadcast: null,
  });
  if (!idb.ok) return idb;
  const store = documentStoreFromAsyncStore(idb.value, { lockPrefix: `instaflow/${workspace.id}`, ...(options.locks === undefined ? {} : { locks: options.locks }) });
  return ok({
    store,
    dispose: async () => {
      await idb.value.dispose();
    },
  });
}
