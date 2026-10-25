/** The local workspace's blobs in OPFS (C0; IF-28.1): Studio's images and other media survive reloads. Studio only. */
import { type BlobStore, createBlobStore, createDirectoryObjectStore, createMemoryObjectStore, openOpfsDirectory } from '@staticflux/blob';
import { LOCAL_WORKSPACE } from './browser.js';

/** The workspace's blob store in OPFS; an in-memory one where OPFS is unavailable (nothing survives a reload then). */
export async function openWorkspaceBlobs(workspace: typeof LOCAL_WORKSPACE = LOCAL_WORKSPACE): Promise<{ readonly blobs: BlobStore; readonly persistent: boolean }> {
  const dir = await openOpfsDirectory(workspace.opfs);
  if (!dir.ok) return { blobs: createBlobStore(createMemoryObjectStore()), persistent: false };
  return { blobs: createBlobStore(createDirectoryObjectStore(dir.value, { id: `opfs(${workspace.id})` })), persistent: true };
}
