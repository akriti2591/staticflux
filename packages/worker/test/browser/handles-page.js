// Page script for the Chromium handle-channel test. Result goes to window.__result.
import { createLink, fromWorker } from '/pkg/worker/src/index.js';
import {
  attachDeltaStream,
  classifyHandle,
  createHandleChannel,
  createHandleLedger,
  defineDeltaStream,
  defineHandleChannel,
} from '/pkg/worker/src/pipeline.js';

async function run() {
  const worker = new Worker('/fixture/handles-worker.js', { type: 'module' });
  const link = createLink({ port: fromWorker(worker), name: 'page' });
  const Handles = defineHandleChannel({
    id: 'browser/handles',
    kinds: ['video-frame', 'audio-data', 'image-bitmap', 'offscreen-canvas', 'file-system-handle'],
  });
  const ledger = createHandleLedger();
  const channel = createHandleChannel(link, Handles, { ledger });

  const canvas = new OffscreenCanvas(8, 8);
  const bitmap = await createImageBitmap(new ImageData(4, 4));
  const frameSource = new OffscreenCanvas(16, 16);
  frameSource.getContext('2d').fillRect(0, 0, 16, 16);
  const frame = new VideoFrame(frameSource, { timestamp: 0 });
  const audio = new AudioData({ format: 'f32', sampleRate: 48_000, numberOfFrames: 128, numberOfChannels: 1, timestamp: 0, data: new Float32Array(128) });
  const directory = await navigator.storage.getDirectory();
  const raw = { frame, audio, bitmap, canvas, directory };
  const classified = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, classifyHandle(v)]));
  const owned = [frame, audio, bitmap, canvas, directory].map((value) => {
    const result = ledger.own(value);
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  });

  const report = new Promise((resolve) => link.on('browser/report', resolve));
  const sent = channel.send({ n: 1 }, owned);
  let useAfterSend = null;
  try {
    void owned[0].value;
  } catch (error) {
    useAfterSend = error.code;
  }
  const after = {
    bitmapWidth: bitmap.width,
    frameFormat: frame.format,
    audioFormat: audio.format,
    directoryName: directory.name,
  };
  const received = await report;

  // Shared delta stream written by the worker.
  const Scene = defineDeltaStream({ id: 'browser/scene', capacityBytes: 4096 });
  const endpoint = await new Promise((resolve) => {
    link.on('browser/stream', resolve);
    link.on('browser/stream-error', (message) => resolve({ error: message }));
    link.send('browser/start-stream', null);
  });
  let stream = { error: 'no endpoint' };
  if (endpoint !== null && endpoint.error === undefined) {
    const attached = await attachDeltaStream(Scene, endpoint);
    if (attached.ok) {
      const reader = attached.value;
      let sum = 0;
      for (let i = 0; i < 200 && reader.version < 200; i++) {
        reader.apply((record) => {
          if (record.kind === 'delta') sum += new Uint32Array(record.payload.slice().buffer)[0];
        });
        if (reader.version < 200) await reader.wait({ timeoutMs: 50 });
      }
      stream = { version: reader.version, state: reader.state, sum, medium: reader.medium };
    } else {
      stream = { error: attached.error.message };
    }
  } else if (endpoint?.error !== undefined) {
    stream = { error: endpoint.error };
  }

  return {
    isolated: globalThis.crossOriginIsolated,
    classified,
    sent: sent.ok,
    released: owned.map((o) => o.released),
    useAfterSend,
    after,
    senderTotals: ledger.totals,
    received,
    stream,
  };
}

run().then(
  (result) => {
    window.__result = result;
  },
  (error) => {
    window.__result = { error: String(error && error.stack ? error.stack : error) };
  },
);
