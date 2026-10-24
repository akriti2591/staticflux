/**
 * Document worker entry (bundled separately by Vite: `new Worker(new URL(...), { type: 'module' })`).
 * Yjs and the document engine live only in this bundle, never in the main-thread chunk.
 */
import { fromWorkerScope } from '@staticflux/worker';
import { startDocumentWorker } from './document-host.js';

startDocumentWorker(fromWorkerScope(self as unknown as Parameters<typeof fromWorkerScope>[0]));
