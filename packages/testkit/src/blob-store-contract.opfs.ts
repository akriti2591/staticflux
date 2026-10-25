/**
 * The `BlobStore` contract over real OPFS, shared by the main-thread browser
 * suite and the worker suite. Browser-only (excluded from the build).
 */
import { asDirectoryHandle, createBlobStore, createDirectoryObjectStore, type Digest, objectPath, type WriteModePolicy } from '@staticflux/blob';
import type { ContractRunner } from './contract-runner.js';
import { runBlobStoreContract } from './blob-store-contract.js';

export function runOpfsBlobStoreContract(name: string, writeMode: WriteModePolicy, runner: ContractRunner): void {
  runBlobStoreContract(
    name,
    async () => {
      const opfs = await navigator.storage.getDirectory();
      const base = await opfs.getDirectoryHandle('sf-contract', { create: true });
      const dirName = `run-${crypto.randomUUID()}`;
      const root = asDirectoryHandle(await base.getDirectoryHandle(dirName, { create: true }));
      return {
        store: createBlobStore(createDirectoryObjectStore(root, { writeMode })),
        async corrupt(digest: Digest, bytes: Uint8Array) {
          const [path, file] = objectPath(digest);
          let dir = root;
          for (const part of path) dir = await dir.getDirectoryHandle(part);
          const writable = await (await dir.getFileHandle(file)).createWritable();
          await writable.write(bytes);
          await writable.close();
        },
        cleanup: () => base.removeEntry(dirName, { recursive: true }),
      };
    },
    runner,
  );
}
