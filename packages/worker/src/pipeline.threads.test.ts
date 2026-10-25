/**
 * Real concurrency (Node worker_threads; SharedArrayBuffer + Atomics, and
 * MessagePorts between threads). The contract suites in testkit run every case on
 * every medium in one thread; these tests run the cross-thread paths S2 measured:
 * torn reads without the seqlock, gap → resnapshot across threads, a lossless
 * input ring under back-pressure, and a peer channel re-wired after a real worker
 * is terminated and respawned. Fixtures live in `packages/worker/test/threads/`
 * and load the TypeScript sources through a module hook (no build needed).
 * No wall-clock assertions: only counts and equality.
 */
import { type SfError, toSfError } from '@staticflux/core';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { defineLayout } from './channels.js';
import { createLink, type Link, type Port } from './index.js';
import {
  attachCell,
  attachDeltaStream,
  createPeerBroker,
  createRecordRing,
  defineCell,
  defineDeltaStream,
  definePeer,
  defineRecordRing,
  type DeltaStreamReader,
  messageChannelWire,
  type PeerHost,
  type PipeMedium,
  type RegionEndpoint,
  regionTransferList,
} from './pipeline.js';

// Built with node:path: Vite rewrites the literal `new URL('…', import.meta.url)` pattern as an asset.
const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'threads');
const fixture = (name: string): URL => pathToFileURL(join(fixtures, name));
const workers: Worker[] = [];

function spawn(name: string, workerData: unknown, transferList: Transferable[] = []): Worker {
  const worker = new Worker(fixture(name), { workerData, transferList: transferList as never });
  workers.push(worker);
  return worker;
}

function next<T>(worker: Worker, type: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: { type?: string }): void => {
      if (message?.type !== type) return;
      worker.off('message', onMessage);
      resolve(message as T);
    };
    worker.on('message', onMessage);
    worker.once('error', reject);
  });
}

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
});

const TIMEOUT = 20_000;

describe('seqlock cell across threads', () => {
  it('without the seqlock the checksum catches torn reads; with it none are ever returned', async () => {
    const bytes = 4096;
    const Frame = defineCell({ id: 'threads/frame', bytes, checksum: true });
    const control = new SharedArrayBuffer(8);
    const writer = spawn('cell-writer.mjs', { id: 'threads/frame', bytes, control });
    const { endpoint } = await next<{ endpoint: RegionEndpoint }>(writer, 'endpoint');
    const unsafe = await attachCell(Frame, endpoint, { seqlock: false });
    const safe = await attachCell(Frame, endpoint, { maxRetries: 1_000_000 });
    if (!unsafe.ok || !safe.ok) throw new Error('attach');
    // Wait until the writer is producing.
    while (safe.value.latest < 10) await new Promise((resolve) => setTimeout(resolve, 1));
    let inconsistent = 0;
    let safeReads = 0;
    // Bounded by read counts, not time: S2 saw hundreds of torn reads per run.
    for (let round = 0; round < 200_000 && unsafe.value.stats.torn < 20; round++) {
      unsafe.value.read();
      const snapshot = safe.value.read();
      if (snapshot === undefined || snapshot.stale) continue;
      safeReads += 1;
      const words = new Int32Array(snapshot.bytes.buffer, snapshot.bytes.byteOffset, bytes / 4);
      const first = words[0];
      if (!words.every((w) => w === first)) inconsistent += 1;
    }
    Atomics.store(new Int32Array(control), 0, 1);
    const done = await next<{ writes: number }>(writer, 'done');
    expect(done.writes).toBeGreaterThan(0);
    expect(unsafe.value.stats.torn).toBeGreaterThan(0); // the detector works (S2: seqlock=0 → torn reads)
    expect(safe.value.stats.torn).toBe(0);
    expect(inconsistent).toBe(0); // every returned frame is whole
    expect(safeReads).toBeGreaterThan(0);
    expect(safe.value.stats.retries).toBeGreaterThan(0); // the reader really raced the writer
  }, TIMEOUT);
});

describe.each(['shared', 'message'] as const)('delta stream across threads (%s)', (medium: PipeMedium) => {
  it('stays equal to the writer through a lost delta: gap → resnapshot → converge', async () => {
    const Scene = defineDeltaStream({ id: 'threads/scene', capacityBytes: 1 << 14 });
    const writer = spawn('delta-writer.mjs', { id: 'threads/scene', capacityBytes: 1 << 14, medium, count: 4000, gapAt: 2000 });
    const { endpoint } = await next<{ endpoint: RegionEndpoint }>(writer, 'endpoint');
    const done = next<{ version: number; doc: [number, number][]; snapshots: number }>(writer, 'done');
    const attached = await attachDeltaStream(Scene, endpoint);
    if (!attached.ok) throw new Error(attached.error.message);
    const reader: DeltaStreamReader = attached.value;
    const mirror = new Map<number, number>();
    let finished: { version: number; doc: [number, number][]; snapshots: number } | undefined;
    void done.then((value) => {
      finished = value;
    });
    let versions = 0;
    for (;;) {
      reader.apply((record) => {
        versions += 1;
        if (record.kind === 'snapshot') mirror.clear();
        const words = new Uint32Array(record.payload.slice().buffer);
        for (let i = 0; i + 1 < words.length; i += 2) mirror.set(words[i] as number, words[i + 1] as number);
      });
      if (finished !== undefined && reader.state === 'live' && reader.version === finished.version) break;
      await reader.wait({ timeoutMs: 20 });
    }
    writer.postMessage('stop');
    const final = finished as { version: number; doc: [number, number][]; snapshots: number };
    expect([...mirror].sort((a, b) => a[0] - b[0])).toEqual(final.doc);
    expect(reader.stats.gaps).toBe(1);
    expect(reader.epoch).toBeGreaterThanOrEqual(2); // resnapshotted under a new epoch
    expect(final.snapshots).toBeGreaterThanOrEqual(2);
    expect(versions).toBeGreaterThan(0);
  }, TIMEOUT);
});

const Sample = defineLayout({ name: 'ThreadSample', fields: { seq: 'u32', value: 'f64' } });

describe.each(['shared', 'message'] as const)('input ring across threads (%s)', (medium: PipeMedium) => {
  it('is lossless and ordered under back-pressure (small ring, many records)', async () => {
    const capacity = 64;
    const count = 20_000;
    const Ring = defineRecordRing({ id: 'threads/input', layout: Sample, capacity });
    const created = createRecordRing(Ring, { medium, maxPending: count });
    if (!created.ok) throw created.error;
    const ring = created.value;
    const endpoint = ring.endpoint(0);
    if (!endpoint.ok) throw endpoint.error;
    const reader = spawn('ring-reader.mjs', { id: 'threads/input', capacity, count, endpoint: endpoint.value }, regionTransferList(endpoint.value));
    const done = next<{ received: number; outOfOrder: number; badPayload: number; blockingWaits: number }>(reader, 'done');
    let queued = 0;
    for (let i = 0; i < count; i++) {
      const pushed = ring.push((r) => {
        r.seq = i;
        r.value = i * 0.5;
      });
      if (!pushed.ok) throw pushed.error;
      if (pushed.value === 'queued') queued += 1;
      if (i % 256 === 0) await new Promise((resolve) => setImmediate(resolve)); // let flushes and port messages run
    }
    while (ring.stats.pending > 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const result = await done;
    expect(result).toMatchObject({ received: count, outOfOrder: 0, badPayload: 0 });
    expect(queued).toBeGreaterThan(0); // back-pressure really happened
    if (medium === 'shared') expect(result.blockingWaits).toBeGreaterThanOrEqual(0);
    ring.close();
  }, TIMEOUT);
});

/** Main-thread Port over a Node worker. */
function nodeWorkerPort(worker: Worker): Port {
  const messages = new Set<(data: unknown) => void>();
  const errors = new Set<(error: SfError) => void>();
  const closes = new Set<() => void>();
  let closed = false;
  worker.on('message', (data: unknown) => {
    for (const listener of [...messages]) listener(data);
  });
  worker.on('error', (error: unknown) => {
    for (const listener of [...errors]) listener(toSfError(error));
  });
  worker.on('exit', () => port.close());
  const port: Port = {
    postMessage: (message, transfer = []) => {
      if (!closed) worker.postMessage(message, [...transfer] as never);
    },
    onMessage: (listener) => {
      messages.add(listener);
      return () => messages.delete(listener);
    },
    onError: (listener) => {
      errors.add(listener);
      return () => errors.delete(listener);
    },
    onClose: (listener) => {
      closes.add(listener);
      return () => closes.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const listener of [...closes]) listener();
      closes.clear();
    },
  };
  return port;
}

function host(id: string): PeerHost & { set(link: Link | undefined): void } {
  let current: Link | undefined;
  const listeners = new Set<(link: Link | undefined) => void>();
  return {
    id,
    get link() {
      return current;
    },
    onLink(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(link) {
      current = link;
      for (const listener of [...listeners]) listener(link);
    },
  };
}

describe('brokered peer channel across real threads', () => {
  it('re-wires to a respawned worker: new generation, the surviving side keeps its listeners', async () => {
    const EditorRender = definePeer('threads/editor-render');
    const broker = createPeerBroker({ wire: messageChannelWire });
    const editorHost = host('editor');
    const renderHost = host('render');
    broker.connect(EditorRender, editorHost, renderHost);
    const editorLink = createLink({ port: nodeWorkerPort(spawn('peer-worker.mjs', { role: 'editor', instance: 1 })), name: 'main→editor' });
    editorHost.set(editorLink);
    const startRender = (instance: number): { worker: Worker; link: Link } => {
      const worker = spawn('peer-worker.mjs', { role: 'render', instance });
      const link = createLink({ port: nodeWorkerPort(worker), name: `main→render-${instance}` });
      renderHost.set(link);
      return { worker, link };
    };
    type Status = { generation: number; state: string; pongs: { from: number; generation: number }[] };
    const status = async (): Promise<Status> => {
      const reply = await editorLink.request('threads/status', null, { timeoutMs: TIMEOUT });
      if (!reply.ok) throw new Error(reply.error.message);
      return reply.value as Status;
    };
    const until = async (accept: (s: Status) => boolean): Promise<Status> => {
      for (let i = 0; i < 2_000; i++) {
        const s = await status();
        if (accept(s)) return s;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`peer did not reach the expected state: ${JSON.stringify(await status())}`);
    };

    const first = startRender(1);
    const connected = await until((s) => s.pongs.some((p) => p.from === 1));
    expect(connected.state).toBe('connected');

    await first.worker.terminate(); // the render worker dies
    renderHost.set(undefined);
    first.link.close();
    await until((s) => s.state === 'disconnected');

    startRender(2); // respawned
    const rewired = await until((s) => s.pongs.some((p) => p.from === 2));
    expect(rewired.generation).toBeGreaterThan(connected.generation);
    expect(rewired.pongs.find((p) => p.from === 2)?.generation).toBe(rewired.generation);
    broker.dispose();
  }, TIMEOUT);
});
