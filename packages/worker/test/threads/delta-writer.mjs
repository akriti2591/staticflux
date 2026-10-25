// Thread fixture: the editor side of a delta stream. Appends `count` deltas
// (u32 pairs id/value), loses one delta at `gapAt` (announces a base the reader
// never saw), answers resnapshot requests with a snapshot, then reports its state.
import './register.mjs';
import { parentPort, workerData } from 'node:worker_threads';

const { createDeltaStream, defineDeltaStream, regionTransferList } = await import('@staticflux/worker/pipeline');

const Scene = defineDeltaStream({ id: workerData.id, capacityBytes: workerData.capacityBytes });
const created = createDeltaStream(Scene, { medium: workerData.medium, maxPendingBytes: 1 << 24 });
if (!created.ok) throw created.error;
const stream = created.value;
const doc = new Map();
let version = 0;
let snapshots = 0;

const encode = (pairs) => new Uint8Array(new Uint32Array(pairs.flat()).buffer);
const snapshot = () => {
  snapshots += 1;
  const written = stream.snapshot({ version, payload: encode([...doc]) });
  if (!written.ok) throw written.error;
};
stream.onResnapshot(() => snapshot());
snapshot();

const endpoint = stream.endpoint();
if (!endpoint.ok) throw endpoint.error;
parentPort.postMessage({ type: 'endpoint', endpoint: endpoint.value }, regionTransferList(endpoint.value));

const yieldNow = () => new Promise((resolve) => setImmediate(resolve));
for (let i = 1; i <= workerData.count; i++) {
  const id = i % 97;
  const value = i;
  doc.set(id, value);
  if (i === workerData.gapAt) {
    version += 2; // the delta for version - 1 is "lost"
    const appended = stream.append({ version, base: version - 1, payload: encode([[id, value]]) });
    if (!appended.ok) throw appended.error;
  } else {
    version += 1;
    const appended = stream.append({ version, payload: encode([[id, value]]) });
    if (!appended.ok) throw appended.error;
  }
  if (i % 64 === 0) await yieldNow();
}
while (!stream.flush()) await yieldNow();
parentPort.postMessage({ type: 'done', version, doc: [...doc].sort((a, b) => a[0] - b[0]), snapshots });
// Keep answering resnapshot requests until the main thread is done.
parentPort.on('message', (message) => {
  if (message === 'stop') {
    stream.close();
    process.exit(0);
  }
});
