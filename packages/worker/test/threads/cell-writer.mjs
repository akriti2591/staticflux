// Thread fixture: a seqlock cell writer hammering a 4 KiB frame (every Int32 = the
// generation) until the control word says stop. The main thread reads concurrently.
import './register.mjs';
import { parentPort, workerData } from 'node:worker_threads';

const { createCell, defineCell } = await import('@staticflux/worker/pipeline');

const Frame = defineCell({ id: workerData.id, bytes: workerData.bytes, checksum: true });
const created = createCell(Frame, { medium: 'shared' });
if (!created.ok) throw created.error;
const cell = created.value;
const endpoint = cell.endpoint();
if (!endpoint.ok) throw endpoint.error;
const control = new Int32Array(workerData.control);
const words = workerData.bytes / 4;

parentPort.postMessage({ type: 'endpoint', endpoint: endpoint.value });
let writes = 0;
while (Atomics.load(control, 0) === 0) {
  cell.write(({ bytes }) => {
    const data = new Int32Array(bytes.buffer, bytes.byteOffset, words);
    const value = writes + 1;
    for (let i = 0; i < words; i++) data[i] = value;
  });
  writes += 1;
}
parentPort.postMessage({ type: 'done', writes });
