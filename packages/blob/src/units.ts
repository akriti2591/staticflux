/**
 * DI: tokens and units for the blob store. Opening OPFS is asynchronous, so the
 * OPFS unit provides a `WorkspaceOpener` (single-flight `open()`) rather than a
 * half-initialized store.
 *
 * @example
 * units: [opfsWorkspaceOpenerUnit({ path: ['instaflow', wsId], lockPrefix: `iflow:${wsId}`, peer })]
 * // in the store worker:
 * const ws = await opener.open(signal); if (!ws.ok) return ws;
 */
import { ok, type Result, token, unit, type UnitDefinition } from '@staticflux/core';
import { createMemoryBlobStore } from './memory.js';
import { createWorkspaceStore, openOpfsDirectory, type WorkspaceStore, type WorkspaceStoreOptions } from './opfs.js';
import type { StorageManagerLike } from './quota.js';
import type { BlobStore } from './types.js';

export const BlobStoreToken = /* @__PURE__ */ token('blob/store').type<BlobStore>();
export const WorkspaceOpenerToken = /* @__PURE__ */ token('blob/workspace-opener').type<WorkspaceOpener>();

export interface WorkspaceOpener {
  /** Open the workspace once; later calls return the same store. */
  open(signal?: AbortSignal): Promise<Result<WorkspaceStore>>;
  dispose(): void;
}

export interface WorkspaceOpenerOptions extends WorkspaceStoreOptions {
  /** OPFS path of the workspace directory. */
  readonly path: readonly string[];
  readonly storage?: StorageManagerLike;
}

export function createWorkspaceOpener(options: WorkspaceOpenerOptions): WorkspaceOpener {
  let opening: Promise<Result<WorkspaceStore>> | undefined;
  return {
    open() {
      opening ??= (async () => {
        const root = await openOpfsDirectory(options.path, options.storage);
        if (!root.ok) return root;
        return createWorkspaceStore(root.value, options);
      })();
      const pending = opening;
      void pending.then((result) => {
        if (!result.ok && opening === pending) opening = undefined;
      });
      return pending;
    },
    dispose() {
      const pending = opening;
      opening = undefined;
      void pending?.then((result) => {
        if (result.ok) result.value.dispose();
      });
    },
  };
}

export const memoryBlobStoreUnit = /* @__PURE__ */ unit({
  id: 'blob/memory-store-unit',
  provides: BlobStoreToken,
  scope: 'app',
  create: (_deps, ctx) => {
    const store = createMemoryBlobStore();
    ctx.scope.defer(() => store.dispose());
    return store;
  },
  description: 'An in-memory BlobStore (tests, previews).',
});

/** The OPFS workspace opener for one workspace path. */
/* @__NO_SIDE_EFFECTS__ */
export function opfsWorkspaceOpenerUnit(options: WorkspaceOpenerOptions): UnitDefinition<WorkspaceOpener, Record<never, never>, 'blob/workspace-opener'> {
  return unit({
    id: 'blob/workspace-opener-unit',
    provides: WorkspaceOpenerToken,
    scope: 'workspace',
    create: (_deps, ctx) => {
      const opener = createWorkspaceOpener(options);
      ctx.scope.defer(() => opener.dispose());
      return opener;
    },
    init: () => ok(),
    description: `Opens the OPFS workspace at ${options.path.join('/')} (blobs, heads, journals).`,
  });
}
