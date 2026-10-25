/**
 * Runs `sync.worker.ts` in a dedicated worker (where sync access handles
 * exist) and reports each worker test as a failure here if it failed there.
 */
import { describe, it, type SuiteResult } from '@staticflux/browser-test';

describe('dedicated worker (sync access handles)', () => {
  it(
    'every worker test passes',
    async () => {
      const worker = new Worker(new URL('./sync.worker.ts', import.meta.url), { type: 'module' });
      const result = await new Promise<SuiteResult>((resolve, reject) => {
        worker.onmessage = (event: MessageEvent<SuiteResult>) => resolve(event.data);
        worker.onerror = (event) => reject(new Error(`worker error: ${event.message}`));
      });
      worker.terminate();
      const failed = result.tests.filter((t) => !t.ok);
      if (result.tests.length === 0) throw new Error(`no worker tests ran ${result.error ?? ''}`);
      if (failed.length > 0) throw new Error(failed.map((t) => `${t.name}\n${t.error ?? ''}`).join('\n\n'));
      console.info(`worker: ${result.tests.length} tests passed: ${result.tests.map((t) => t.name).join('; ')}`);
    },
    { timeoutMs: 180_000 },
  );
});
