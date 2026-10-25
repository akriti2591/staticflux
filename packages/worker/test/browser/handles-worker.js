// Module worker for the Chromium handle-channel test: receives real platform handles,
// reports what arrived, closes them, and writes a shared-memory delta stream for the page.
import { createLink, fromWorkerScope } from '/pkg/worker/src/index.js';
import {
  classifyHandle,
  createDeltaStream,
  createHandleChannel,
  createHandleLedger,
  defineDeltaStream,
  defineHandleChannel,
} from '/pkg/worker/src/pipeline.js';

const link = createLink({ port: fromWorkerScope(self), name: 'worker' });
const Handles = defineHandleChannel({
  id: 'browser/handles',
  kinds: ['video-frame', 'audio-data', 'image-bitmap', 'offscreen-canvas', 'file-system-handle'],
});
const ledger = createHandleLedger();
const channel = createHandleChannel(link, Handles, { ledger });

channel.on(async ({ meta, handles }) => {
  const arrived = handles.map((owned) => {
    const value = owned.value;
    return {
      kind: owned.kind,
      classified: classifyHandle(value),
      width: value.width ?? value.codedWidth ?? value.numberOfFrames ?? null,
      name: value.name ?? null,
    };
  });
  const live = ledger.live;
  for (const owned of handles) owned.close();
  link.send('browser/report', { meta, arrived, live, totals: ledger.totals });
});

// Shared-memory delta stream across real threads: snapshot + deltas, answering resnapshots.
const Scene = defineDeltaStream({ id: 'browser/scene', capacityBytes: 4096 });
link.on('browser/start-stream', () => {
  const created = createDeltaStream(Scene, { medium: 'shared' });
  if (!created.ok) {
    link.send('browser/stream-error', created.error.message);
    return;
  }
  const stream = created.value;
  let version = 0;
  stream.onResnapshot(() => stream.snapshot({ version }));
  stream.snapshot({ version });
  const endpoint = stream.endpoint();
  link.send('browser/stream', endpoint.ok ? endpoint.value : null);
  for (let i = 1; i <= 200; i++) {
    version += 1;
    stream.append({ version, payload: new Uint8Array(new Uint32Array([i]).buffer) });
  }
});
