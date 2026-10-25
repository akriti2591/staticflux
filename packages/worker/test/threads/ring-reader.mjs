// Thread fixture: a record ring reader (the editor draining the input ring).
// Shared memory: blocks in Atomics.wait between batches (S2 editor pattern);
// message medium: awaits. Checks order and payload of every record.
import './register.mjs';
import { parentPort, workerData } from 'node:worker_threads';

const { attachRecordRing, defineRecordRing } = await import('@staticflux/worker/pipeline');
const { defineLayout } = await import('@staticflux/worker/channels');

const Sample = defineLayout({ name: 'ThreadSample', fields: { seq: 'u32', value: 'f64' } });
const Ring = defineRecordRing({ id: workerData.id, layout: Sample, capacity: workerData.capacity });
const attached = await attachRecordRing(Ring, workerData.endpoint);
if (!attached.ok) throw attached.error;
const reader = attached.value;

let received = 0;
let outOfOrder = 0;
let badPayload = 0;
let blockingWaits = 0;
while (received < workerData.count) {
  reader.drain((record, seq) => {
    if (seq !== received || record.seq !== received) outOfOrder += 1;
    if (record.value !== received * 0.5) badPayload += 1;
    received += 1;
  });
  if (received >= workerData.count) break;
  if (reader.medium === 'shared') {
    reader.waitSync(50);
    blockingWaits += 1;
  } else {
    await reader.wait({ timeoutMs: 50 });
  }
}
parentPort.postMessage({ type: 'done', received, outOfOrder, badPayload, blockingWaits });
