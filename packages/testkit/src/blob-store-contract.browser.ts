/**
 * `BlobStore` contract in real Chromium over real OPFS: on the main thread
 * (`createWritable` path) and in a dedicated worker (sync access handles for
 * large objects). Run: `pnpm test:browser`.
 */
import { describe, it, type SuiteResult } from '@staticflux/browser-test';
import { runOpfsBlobStoreContract } from './blob-store-contract.opfs.js';

runOpfsBlobStoreContract('OPFS main thread (writable)', 'writable', { describe, it });

describe('BlobStore contract: OPFS dedicated worker (auto: sync handles for large objects)', () => {
  it(
    'every contract case passes in the worker',
    async () => {
      const worker = new Worker(new URL('./blob-store-contract.worker.ts', import.meta.url), { type: 'module' });
      const result = await new Promise<SuiteResult>((resolve, reject) => {
        worker.onmessage = (event: MessageEvent<SuiteResult>) => resolve(event.data);
        worker.onerror = (event) => reject(new Error(`worker error: ${event.message}`));
      });
      worker.terminate();
      if (result.tests.length === 0) throw new Error(`no contract cases ran in the worker ${result.error ?? ''}`);
      const failed = result.tests.filter((t) => !t.ok);
      if (failed.length > 0) throw new Error(failed.map((t) => `${t.name}\n${t.error ?? ''}`).join('\n\n'));
    },
    { timeoutMs: 180_000 },
  );
});
