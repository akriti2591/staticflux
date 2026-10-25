import { createBlobStore, createDirectoryObjectStore, createMemoryDirectory, createMemoryObjectStore, type Digest, objectPath } from '@staticflux/blob';
import { describe, expect, it } from 'vitest';
import { blobStoreContractCases, runBlobStoreContract } from './index.js';

const runner = { describe, it };

runBlobStoreContract(
  'memory',
  () => {
    const objects = createMemoryObjectStore();
    return { store: createBlobStore(objects), corrupt: (digest: Digest, bytes: Uint8Array) => objects.corrupt(digest, bytes) };
  },
  runner,
);

// The OPFS code path (directory object store) over the in-memory file system, both write modes.
for (const writeMode of ['writable', 'sync'] as const) {
  runBlobStoreContract(
    `directory over memory fs (${writeMode})`,
    () => {
      const fs = createMemoryDirectory();
      const objects = createDirectoryObjectStore(fs.root, { writeMode, syncAvailable: true });
      return {
        store: createBlobStore(objects),
        corrupt: (digest: Digest, bytes: Uint8Array) => {
          const [path, name] = objectPath(digest);
          fs.write(`${[...path, name].join('/')}`, bytes);
        },
      };
    },
    runner,
  );
}

describe('blob store contract suite', () => {
  it('has uniquely named cases and skips by name', () => {
    const names = blobStoreContractCases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    const registered: string[] = [];
    runBlobStoreContract('skip', () => ({ store: createBlobStore(createMemoryObjectStore()) }), {
      describe: (_n, fn) => fn(),
      it: (n) => registered.push(n),
    }, { skip: [names[0] ?? ''] });
    expect(registered).toHaveLength(names.length - 1);
  });
});
