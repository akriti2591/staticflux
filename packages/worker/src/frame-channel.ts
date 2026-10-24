/**
 * Frame channels (R11.17, R11.16a): single-producer / single-consumer frames
 * between threads (render state, input batches, simulation output).
 *
 * - **shared** mode — a ring buffer over a SharedArrayBuffer; indices via
 *   `Atomics`, consumers wake with `Atomics.waitAsync` (or poll). Zero copies:
 *   writers fill slots in place, readers read them in place.
 * - **transfer** mode — the fallback when not cross-origin isolated (embedded
 *   hosts, COEP off): double-buffered ArrayBuffers ping-pong between the threads
 *   by transfer. Same API, one copy-free hop per frame, bounded memory.
 *
 * The producer picks the mode from injected `IsolationFacts`; the consumer
 * adopts it during the handshake. Feature code is identical in both modes.
 *
 * Ring memory format (little-endian, version 1):
 *   header (64 B, Int32): [0] writeSeq [1] readSeq [2] dropped [3] closed [4] slots [5] frameBytes [6] magic [7] version
 *   slot i at 64 + i * slotStride: Int32 length, Int32 seq, Float64 time, then `frameBytes` data (16-aligned).
 *
 * @example
 * export const SceneFrames = defineFrameChannel({ id: 'studio/scene-frames', layout: Sprite, count: 4096 });
 * // producer (document worker)
 * const producer = unwrap(openFrameProducer(link, SceneFrames, { isolation }));
 * producer.write((slot) => { const v = views(slot); …; return n * Sprite.stride; });
 * // consumer (render worker)
 * const frames = unwrap(await connectFrameConsumer(link, SceneFrames));
 * frames.readLatest((slot) => draw(views(slot), slot.length / Sprite.stride));
 */
import {
  AbortedError,
  createMachine,
  createNoopTelemetry,
  defineMachine,
  err,
  type Machine,
  metric,
  ok,
  type Result,
  type Telemetry,
} from '@staticflux/core';
import {
  FrameChannelClosedError,
  FrameChannelMismatchError,
  FrameTooLargeError,
  LayoutViewError,
  SharedMemoryUnavailableError,
} from './channel-errors.js';
import { type Clock, systemClock } from './clock.js';
import { transferOverLink } from './data-channel.js';
import type { ChannelId } from './envelope.js';
import { type IsolationFacts, type SharedMemoryGlobals, sharedMemoryAvailable } from './isolation.js';
import type { Layout, LayoutFields, StructView } from './layout.js';
import type { Link } from './link.js';

// ---------------------------------------------------------------- format

export const RING_MAGIC = 0x53465242; // 'SFRB'
export const RING_VERSION = 1;
export const RING_HEADER_BYTES = 64;
export const SLOT_HEADER_BYTES = 16;

const H_WRITE = 0;
const H_READ = 1;
const H_DROPPED = 2;
const H_CLOSED = 3;
const H_SLOTS = 4;
const H_FRAME_BYTES = 5;
const H_MAGIC = 6;
const H_VERSION = 7;

const roundUp16 = (n: number): number => Math.ceil(n / 16) * 16;

/** Bytes between slots for a frame size. */
export function slotStride(frameBytes: number): number {
  return SLOT_HEADER_BYTES + roundUp16(frameBytes);
}

/** Total bytes of a ring buffer. */
export function ringByteLength(frameBytes: number, slots: number): number {
  return RING_HEADER_BYTES + slots * slotStride(frameBytes);
}

// ---------------------------------------------------------------- shared API

export type FrameMode = 'shared' | 'transfer';

/** A slot being written. `bytes` covers the whole slot capacity (`frameBytes`). */
export interface WriteSlot {
  readonly bytes: Uint8Array;
  /** Backing buffer and byte offset of `bytes` (16-aligned) — bind layout views here. */
  readonly buffer: ArrayBufferLike;
  readonly byteOffset: number;
  /** Sequence number this frame will get. */
  readonly seq: number;
}

/** A slot being read. `bytes` covers the capacity; `length` is what the producer wrote. */
export interface ReadSlot extends WriteSlot {
  readonly length: number;
  /** Producer clock time (ms) when the frame was committed. */
  readonly time: number;
}

/** Fill the slot; return the number of bytes written (default: the whole slot). */
export type FrameFill = (slot: WriteSlot) => number | void;

export type FrameWriteOutcome =
  | { readonly written: true; readonly seq: number }
  | { readonly written: false; readonly reason: 'full' | 'no-consumer' };

export interface FrameStats {
  readonly written: number;
  readonly read: number;
  /** Frames the producer could not write (consumer too slow / not connected). */
  readonly dropped: number;
  /** Frames the consumer skipped with `readLatest`. */
  readonly skipped: number;
}

export interface FrameWriter {
  readonly mode: FrameMode;
  readonly frameBytes: number;
  readonly closed: boolean;
  /** Write one frame. `ok({ written: false })` is back-pressure, not an error. */
  write(fill: FrameFill): Result<FrameWriteOutcome>;
  readonly stats: FrameStats;
  close(): void;
}

export interface WaitOptions {
  readonly signal?: AbortSignal;
  /** Give up after this many ms (resolves `ok(false)`). Default: wait forever. */
  readonly timeoutMs?: number;
}

export interface FrameReader {
  readonly mode: FrameMode;
  readonly frameBytes: number;
  readonly closed: boolean;
  /** Frames ready to read. */
  readonly available: number;
  /** Read the oldest frame in place. Returns false when there is none. */
  read(consume: (slot: ReadSlot) => void): boolean;
  /** Skip to the newest frame (older ones count as skipped) and read it. */
  readLatest(consume: (slot: ReadSlot) => void): boolean;
  /** Resolve `ok(true)` when a frame is available, `ok(false)` on timeout; errors when closed/aborted. */
  waitForFrame(options?: WaitOptions): Promise<Result<boolean>>;
  /** Blocking wait (workers only, shared mode): `'ok' | 'timed-out' | 'unsupported'`. */
  waitSync(timeoutMs: number): 'ok' | 'timed-out' | 'unsupported';
  readonly stats: FrameStats;
  close(): void;
}

export type WaitStrategy = 'auto' | 'atomics' | 'polling';

export interface FrameTimingOptions {
  readonly clock?: Clock;
  /** How readers wait: `atomics` (Atomics.waitAsync), `polling`, or `auto` (atomics where available). */
  readonly wait?: WaitStrategy;
  /** Poll interval for the polling fallback. Default 4 ms. */
  readonly pollMs?: number;
}

type WaitAsyncFn = (
  array: Int32Array,
  index: number,
  value: number,
  timeout?: number,
) => { readonly async: false; readonly value: 'not-equal' | 'timed-out' } | { readonly async: true; readonly value: Promise<'ok' | 'timed-out'> };

const aborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

function abortedResult(signal: AbortSignal): Result<never> {
  return err(AbortedError({ cause: signal.reason }));
}

// ---------------------------------------------------------------- ring buffer

export interface RingBuffer {
  readonly buffer: SharedArrayBuffer | ArrayBuffer;
  readonly frameBytes: number;
  readonly slots: number;
  readonly shared: boolean;
  writer(): FrameWriter;
  reader(options?: FrameTimingOptions): FrameReader;
}

export interface RingBufferOptions extends FrameTimingOptions {
  readonly frameBytes: number;
  /** Number of slots. Default 3. */
  readonly slots?: number;
  /** Use a SharedArrayBuffer (default true when available). A plain ArrayBuffer works within one thread. */
  readonly shared?: boolean;
}

/** Create a ring buffer (writer + reader over one buffer). */
export function createRingBuffer(options: RingBufferOptions): Result<RingBuffer> {
  const slots = options.slots ?? 3;
  const { frameBytes } = options;
  if (!Number.isInteger(frameBytes) || frameBytes <= 0 || !Number.isInteger(slots) || slots < 1) {
    return err(LayoutViewError({ message: 'Ring buffers need integer frameBytes > 0 and slots ≥ 1.', details: { frameBytes, slots } }));
  }
  const shared = options.shared ?? typeof SharedArrayBuffer === 'function';
  if (shared && typeof SharedArrayBuffer !== 'function') return err(SharedMemoryUnavailableError());
  const bytes = ringByteLength(frameBytes, slots);
  const buffer = shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
  const header = new Int32Array(buffer, 0, RING_HEADER_BYTES / 4);
  header[H_SLOTS] = slots;
  header[H_FRAME_BYTES] = frameBytes;
  header[H_MAGIC] = RING_MAGIC;
  header[H_VERSION] = RING_VERSION;
  return ok(ringOver(buffer, frameBytes, slots, options));
}

/** Attach to a ring buffer created elsewhere (e.g. received over a link). */
export function attachRingBuffer(buffer: SharedArrayBuffer | ArrayBuffer, options: FrameTimingOptions = {}): Result<RingBuffer> {
  if (buffer.byteLength < RING_HEADER_BYTES) {
    return err(FrameChannelMismatchError({ message: 'Buffer too small for a ring header.' }));
  }
  const header = new Int32Array(buffer, 0, RING_HEADER_BYTES / 4);
  const magic = Atomics.load(header, H_MAGIC);
  const version = Atomics.load(header, H_VERSION);
  if (magic !== RING_MAGIC || version !== RING_VERSION) {
    return err(FrameChannelMismatchError({ message: 'Not a StaticFlux ring buffer (bad magic/version).', details: { magic, version } }));
  }
  const slots = Atomics.load(header, H_SLOTS);
  const frameBytes = Atomics.load(header, H_FRAME_BYTES);
  if (buffer.byteLength < ringByteLength(frameBytes, slots)) {
    return err(FrameChannelMismatchError({ message: 'Ring buffer is truncated.', details: { slots, frameBytes } }));
  }
  return ok(ringOver(buffer, frameBytes, slots, options));
}

function ringOver(
  buffer: SharedArrayBuffer | ArrayBuffer,
  frameBytes: number,
  slots: number,
  defaults: FrameTimingOptions,
): RingBuffer {
  const shared = typeof SharedArrayBuffer === 'function' && buffer instanceof SharedArrayBuffer;
  const header = new Int32Array(buffer, 0, RING_HEADER_BYTES / 4);
  const stride = slotStride(frameBytes);
  const slotOffset = (seq: number): number => RING_HEADER_BYTES + ((seq >>> 0) % slots) * stride;
  // Per-slot views are created once: reading and writing never allocate.
  const slotBytes = Array.from({ length: slots }, (_, i) => new Uint8Array(buffer, RING_HEADER_BYTES + i * stride + SLOT_HEADER_BYTES, frameBytes));
  const slotMeta = Array.from({ length: slots }, (_, i) => new Int32Array(buffer, RING_HEADER_BYTES + i * stride, 2));
  const slotTime = Array.from({ length: slots }, (_, i) => new Float64Array(buffer, RING_HEADER_BYTES + i * stride + 8, 1));
  const indexOf = (seq: number): number => (seq >>> 0) % slots;
  const pending = (): number => (Atomics.load(header, H_WRITE) - Atomics.load(header, H_READ)) | 0;
  const isClosed = (): boolean => Atomics.load(header, H_CLOSED) === 1;
  const close = (): void => {
    Atomics.store(header, H_CLOSED, 1);
    if (shared) Atomics.notify(header, H_WRITE);
  };

  const writer = (): FrameWriter => {
    const clock = defaults.clock ?? systemClock;
    let written = 0;
    const slot = { bytes: slotBytes[0] as Uint8Array, buffer, byteOffset: 0, seq: 0 };
    return {
      mode: 'shared',
      frameBytes,
      get closed() {
        return isClosed();
      },
      write(fill) {
        if (isClosed()) return err(FrameChannelClosedError());
        const w = Atomics.load(header, H_WRITE);
        if (((w - Atomics.load(header, H_READ)) | 0) >= slots) {
          Atomics.add(header, H_DROPPED, 1);
          return ok({ written: false, reason: 'full' });
        }
        const i = indexOf(w);
        slot.bytes = slotBytes[i] as Uint8Array;
        slot.byteOffset = slotOffset(w) + SLOT_HEADER_BYTES;
        slot.seq = w;
        const length = fill(slot) ?? frameBytes;
        if (!Number.isInteger(length) || length < 0 || length > frameBytes) {
          return err(FrameTooLargeError({ details: { length, frameBytes } }));
        }
        const meta = slotMeta[i] as Int32Array;
        meta[0] = length;
        meta[1] = w;
        (slotTime[i] as Float64Array)[0] = clock.now();
        Atomics.store(header, H_WRITE, (w + 1) | 0); // publish (release)
        if (shared) Atomics.notify(header, H_WRITE);
        written += 1;
        return ok({ written: true, seq: w });
      },
      get stats() {
        return { written, read: 0, dropped: Atomics.load(header, H_DROPPED), skipped: 0 };
      },
      close,
    };
  };

  const reader = (options: FrameTimingOptions = {}): FrameReader => {
    const clock = options.clock ?? defaults.clock ?? systemClock;
    const strategy = options.wait ?? defaults.wait ?? 'auto';
    const pollMs = options.pollMs ?? defaults.pollMs ?? 4;
    const waitAsync = (Atomics as unknown as { waitAsync?: WaitAsyncFn }).waitAsync;
    const useAtomics = shared && strategy !== 'polling' && typeof waitAsync === 'function';
    let read = 0;
    let skipped = 0;
    const slot = { bytes: slotBytes[0] as Uint8Array, buffer, byteOffset: 0, seq: 0, length: 0, time: 0 };
    const consumeAt = (r: number, consume: (s: ReadSlot) => void): void => {
      const i = indexOf(r);
      const meta = slotMeta[i] as Int32Array;
      slot.bytes = slotBytes[i] as Uint8Array;
      slot.byteOffset = slotOffset(r) + SLOT_HEADER_BYTES;
      slot.seq = meta[1] as number;
      slot.length = meta[0] as number;
      slot.time = (slotTime[i] as Float64Array)[0] as number;
      try {
        consume(slot);
      } finally {
        Atomics.store(header, H_READ, (r + 1) | 0); // release the slot
        read += 1;
      }
    };

    const waitAtomics = async (options: WaitOptions): Promise<Result<boolean>> => {
      const deadline = options.timeoutMs === undefined ? undefined : clock.now() + options.timeoutMs;
      const signal = options.signal;
      const onAbort = (): void => {
        Atomics.notify(header, H_WRITE); // wake our own waiter
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        for (;;) {
          if (signal?.aborted === true) return abortedResult(signal);
          if (pending() > 0) return ok(true);
          if (isClosed()) return err(FrameChannelClosedError());
          const remaining = deadline === undefined ? Infinity : deadline - clock.now();
          if (remaining <= 0) return ok(false);
          const w = Atomics.load(header, H_WRITE);
          const outcome = (waitAsync as WaitAsyncFn)(header, H_WRITE, w, remaining);
          const value = outcome.async ? await outcome.value : outcome.value;
          if (value === 'timed-out' && pending() === 0 && !isClosed() && !aborted(signal)) return ok(false);
        }
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    };

    const waitPolling = (options: WaitOptions): Promise<Result<boolean>> =>
      new Promise((resolve) => {
        const signal = options.signal;
        const deadline = options.timeoutMs === undefined ? undefined : clock.now() + options.timeoutMs;
        let timer: unknown;
        const finish = (result: Result<boolean>): void => {
          clock.clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(result);
        };
        const onAbort = (): void => finish(abortedResult(signal as AbortSignal));
        const check = (): void => {
          if (signal?.aborted === true) return finish(abortedResult(signal));
          if (pending() > 0) return finish(ok(true));
          if (isClosed()) return finish(err(FrameChannelClosedError()));
          if (deadline !== undefined && clock.now() >= deadline) return finish(ok(false));
          timer = clock.setTimeout(check, pollMs);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        check();
      });

    return {
      mode: 'shared',
      frameBytes,
      get closed() {
        return isClosed();
      },
      get available() {
        return pending();
      },
      read(consume) {
        if (pending() <= 0) return false;
        consumeAt(Atomics.load(header, H_READ), consume);
        return true;
      },
      readLatest(consume) {
        const w = Atomics.load(header, H_WRITE);
        const r = Atomics.load(header, H_READ);
        const count = (w - r) | 0;
        if (count <= 0) return false;
        if (count > 1) {
          skipped += count - 1;
          Atomics.store(header, H_READ, (w - 1) | 0);
        }
        consumeAt((w - 1) | 0, consume);
        return true;
      },
      waitForFrame(options = {}) {
        return useAtomics ? waitAtomics(options) : waitPolling(options);
      },
      waitSync(timeoutMs) {
        if (pending() > 0) return 'ok';
        if (!shared) return 'unsupported';
        try {
          const outcome = Atomics.wait(header as Int32Array<SharedArrayBuffer>, H_WRITE, Atomics.load(header, H_WRITE), timeoutMs);
          return outcome === 'timed-out' && pending() === 0 ? 'timed-out' : 'ok';
        } catch {
          return 'unsupported'; // main thread: Atomics.wait is not allowed
        }
      },
      get stats() {
        return { written: 0, read, dropped: Atomics.load(header, H_DROPPED), skipped };
      },
      close,
    };
  };

  return { buffer, frameBytes, slots, shared, writer, reader };
}

// ---------------------------------------------------------------- channel definition

export interface FrameChannelDefinition<Id extends ChannelId = ChannelId> {
  readonly kind: 'frame-channel';
  readonly id: Id;
  readonly frameBytes: number;
  /** Ring slots in shared mode. */
  readonly slots: number;
  /** Buffers in flight in transfer mode (2 = double buffering). */
  readonly buffers: number;
  /** `shared` fails with SF-WK-025 when not isolated; `auto` falls back to transfer. */
  readonly require: 'auto' | 'shared';
}

export type FrameChannelDeclaration<Id extends ChannelId> = {
  readonly id: Id;
  readonly slots?: number;
  readonly buffers?: number;
  readonly require?: 'auto' | 'shared';
} & (
  | { readonly frameBytes: number }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | { readonly layout: Layout<any>; readonly count: number }
);

export function defineFrameChannel<const Id extends ChannelId>(declaration: FrameChannelDeclaration<Id>): FrameChannelDefinition<Id> {
  const frameBytes = 'frameBytes' in declaration ? declaration.frameBytes : declaration.layout.byteLength(declaration.count);
  return Object.freeze({
    kind: 'frame-channel',
    id: declaration.id,
    frameBytes,
    slots: declaration.slots ?? 3,
    buffers: declaration.buffers ?? 2,
    require: declaration.require ?? 'auto',
  });
}

/** Pick the mode for a channel from isolation facts (R11.16a). */
export function selectFrameMode(facts: IsolationFacts, globals?: SharedMemoryGlobals): FrameMode {
  return sharedMemoryAvailable(facts, globals) ? 'shared' : 'transfer';
}

const sub = (id: ChannelId, part: 'connect' | 'frame' | 'return' | 'close'): ChannelId => `${id}/${part}` as ChannelId;

interface ConnectRequest {
  readonly frameBytes: number;
}

interface ConnectResponse {
  readonly mode: FrameMode;
  readonly frameBytes: number;
  readonly buffer?: SharedArrayBuffer;
}

// ---------------------------------------------------------------- producer

export const FrameChannelLifecycle = defineMachine({
  id: 'worker/frame-channel',
  initial: 'waiting',
  states: ['waiting', 'open', 'closed'],
  transitions: {
    waiting: { connect: 'open', close: 'closed' },
    open: { connect: 'open', close: 'closed' },
  },
  terminal: ['closed'],
});

export type FrameChannelState = (typeof FrameChannelLifecycle.states)[number];

export const FrameChannelMetrics = {
  dropped: metric.counter('worker/frame-channel-dropped', { description: 'Frames the producer could not write' }),
  skipped: metric.counter('worker/frame-channel-skipped', { description: 'Frames the consumer skipped (latest wins)' }),
} as const;

export interface FrameProducer extends FrameWriter {
  readonly id: ChannelId;
  /** `waiting` until a consumer connects; `closed` after close. Reactive. */
  readonly state: FrameChannelState;
  readonly machine: Machine<FrameChannelState, 'connect' | 'close'>;
}

export interface FrameProducerOptions {
  readonly isolation: IsolationFacts;
  readonly telemetry?: Telemetry;
  readonly clock?: Clock;
  /** Shared-memory globals (tests). */
  readonly globals?: SharedMemoryGlobals;
}

const SUBSYSTEM = 'worker/frame-channel';

/** Producer side: serves the handshake and writes frames in the selected mode. */
export function openFrameProducer(link: Link, definition: FrameChannelDefinition, options: FrameProducerOptions): Result<FrameProducer> {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const clock = options.clock ?? systemClock;
  const mode = selectFrameMode(options.isolation, options.globals);
  if (mode !== 'shared' && definition.require === 'shared') {
    return err(SharedMemoryUnavailableError({ details: { channel: definition.id } }));
  }
  const machine = createMachine(FrameChannelLifecycle);
  telemetry.event('worker.frame-channel.open', {
    subsystem: SUBSYSTEM,
    level: 'standard',
    attrs: { channel: definition.id, mode, frameBytes: definition.frameBytes },
  });
  const disposers: (() => void)[] = [];
  const markClosed = (): void => {
    if (machine.can('close')) machine.send('close');
    for (const dispose of disposers.splice(0)) dispose();
  };

  let inner: FrameWriter & { onConnect(): ConnectResponse };
  if (mode === 'shared') {
    const ringResult = createRingBuffer({ frameBytes: definition.frameBytes, slots: definition.slots, shared: true, clock });
    if (!ringResult.ok) return ringResult;
    const ring = ringResult.value;
    const writer = ring.writer();
    inner = Object.assign(writer, {
      onConnect: (): ConnectResponse => ({ mode, frameBytes: definition.frameBytes, buffer: ring.buffer as SharedArrayBuffer }),
    });
  } else {
    inner = transferWriter(link, definition, clock, () => machine.state, markClosed);
  }

  disposers.push(
    link.handle(sub(definition.id, 'connect'), (payload) => {
      const request = payload as Partial<ConnectRequest> | null;
      if (request?.frameBytes !== definition.frameBytes) {
        return err(
          FrameChannelMismatchError({ details: { channel: definition.id, expected: definition.frameBytes, got: request?.frameBytes } }),
        );
      }
      if (machine.state === 'closed') return err(FrameChannelClosedError({ details: { channel: definition.id } }));
      const response = inner.onConnect();
      machine.send('connect');
      return ok(response);
    }),
    link.on(sub(definition.id, 'close'), () => {
      inner.close();
      markClosed();
    }),
    link.onClose(() => markClosed()),
  );

  let reportedDropped = 0;
  const producer: FrameProducer = {
    id: definition.id,
    mode,
    frameBytes: definition.frameBytes,
    machine,
    get state() {
      return machine.state;
    },
    get closed() {
      return machine.state === 'closed' || inner.closed;
    },
    write(fill) {
      if (machine.state === 'closed') return err(FrameChannelClosedError({ details: { channel: definition.id } }));
      const result = inner.write(fill);
      const dropped = inner.stats.dropped;
      if (dropped > reportedDropped) {
        telemetry.record(FrameChannelMetrics.dropped, dropped - reportedDropped, { channel: definition.id, mode });
        reportedDropped = dropped;
      }
      return result;
    },
    get stats() {
      return inner.stats;
    },
    close() {
      if (machine.state === 'closed') return;
      inner.close();
      link.send(sub(definition.id, 'close'), null);
      markClosed();
    },
  };
  return ok(producer);
}

function transferWriter(
  link: Link,
  definition: FrameChannelDefinition,
  clock: Clock,
  state: () => FrameChannelState,
  onClosed: () => void,
): FrameWriter & { onConnect(): ConnectResponse } {
  const { frameBytes } = definition;
  const bytesPerBuffer = slotStride(frameBytes);
  let pool: ArrayBuffer[] = [];
  let generation = 0;
  let written = 0;
  let dropped = 0;
  let closed = false;
  let seq = 0;
  link.on(sub(definition.id, 'return'), (payload) => {
    const returned = (payload as { buffer?: unknown; generation?: unknown } | null) ?? {};
    // Buffers from an older connection (pre-respawn) are discarded; the pool was refilled.
    if (returned.generation !== generation || !(returned.buffer instanceof ArrayBuffer)) return;
    if (returned.buffer.byteLength === bytesPerBuffer && pool.length < definition.buffers) pool.push(returned.buffer);
  });
  return {
    mode: 'transfer',
    frameBytes,
    get closed() {
      return closed;
    },
    onConnect() {
      generation += 1;
      pool = Array.from({ length: definition.buffers }, () => new ArrayBuffer(bytesPerBuffer));
      return { mode: 'transfer', frameBytes };
    },
    write(fill) {
      if (closed) return err(FrameChannelClosedError());
      if (state() === 'waiting') {
        dropped += 1;
        return ok({ written: false, reason: 'no-consumer' });
      }
      const buffer = pool.pop();
      if (buffer === undefined) {
        dropped += 1;
        return ok({ written: false, reason: 'full' });
      }
      const slot: WriteSlot = { bytes: new Uint8Array(buffer, SLOT_HEADER_BYTES, frameBytes), buffer, byteOffset: SLOT_HEADER_BYTES, seq };
      let length: number;
      try {
        length = fill(slot) ?? frameBytes;
      } catch (error) {
        pool.push(buffer);
        throw error;
      }
      if (!Number.isInteger(length) || length < 0 || length > frameBytes) {
        pool.push(buffer);
        return err(FrameTooLargeError({ details: { length, frameBytes } }));
      }
      const meta = new Int32Array(buffer, 0, 2);
      meta[0] = length;
      meta[1] = seq;
      new Float64Array(buffer, 8, 1)[0] = clock.now();
      const sent = transferOverLink(link, sub(definition.id, 'frame'), { buffer, generation }, [buffer]);
      if (!sent.ok) return sent;
      written += 1;
      const outcome = { written: true as const, seq };
      seq = (seq + 1) | 0;
      return ok(outcome);
    },
    get stats() {
      return { written, read: 0, dropped, skipped: 0 };
    },
    close() {
      if (closed) return;
      closed = true;
      pool = [];
      onClosed();
    },
  };
}

// ---------------------------------------------------------------- consumer

export interface FrameConsumerOptions extends FrameTimingOptions {
  readonly signal?: AbortSignal;
  /** Handshake timeout. Default 10 s. */
  readonly timeoutMs?: number;
  readonly telemetry?: Telemetry;
}

/** Consumer side: handshake with the producer and read frames in its mode. */
export async function connectFrameConsumer(
  link: Link,
  definition: FrameChannelDefinition,
  options: FrameConsumerOptions = {},
): Promise<Result<FrameReader>> {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  // Install the transfer-mode listeners before the handshake so no frame is missed.
  const transfer = transferReader(link, definition, options);
  const response = await link.request(sub(definition.id, 'connect'), { frameBytes: definition.frameBytes } satisfies ConnectRequest, {
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 10_000,
  });
  if (!response.ok) {
    transfer.dispose();
    return response;
  }
  const config = response.value as ConnectResponse;
  if (config.frameBytes !== definition.frameBytes) {
    transfer.dispose();
    return err(FrameChannelMismatchError({ details: { channel: definition.id } }));
  }
  let reader: FrameReader;
  if (config.mode === 'shared' && config.buffer !== undefined) {
    transfer.dispose();
    const ring = attachRingBuffer(config.buffer, options);
    if (!ring.ok) return ring;
    const ringReader = ring.value.reader(options);
    const offClose = link.on(sub(definition.id, 'close'), () => ringReader.close());
    reader = forward(ringReader, {
      close() {
        offClose();
        if (!ringReader.closed) link.send(sub(definition.id, 'close'), null);
        ringReader.close();
      },
    });
  } else {
    reader = transfer.reader;
  }
  let reportedSkipped = 0;
  const base = reader;
  return ok(
    forward(base, {
      readLatest(consume) {
        const result = base.readLatest(consume);
        const skipped = base.stats.skipped;
        if (skipped > reportedSkipped) {
          telemetry.record(FrameChannelMetrics.skipped, skipped - reportedSkipped, { channel: definition.id, mode: base.mode });
          reportedSkipped = skipped;
        }
        return result;
      },
    }),
  );
}

/** Wrap a reader with live getters, optionally overriding `readLatest` / `close`. */
function forward(reader: FrameReader, overrides: Partial<Pick<FrameReader, 'readLatest' | 'close'>> = {}): FrameReader {
  return {
    get mode() {
      return reader.mode;
    },
    frameBytes: reader.frameBytes,
    get closed() {
      return reader.closed;
    },
    get available() {
      return reader.available;
    },
    read: (consume) => reader.read(consume),
    readLatest: overrides.readLatest ?? ((consume) => reader.readLatest(consume)),
    waitForFrame: (options) => reader.waitForFrame(options),
    waitSync: (timeoutMs) => reader.waitSync(timeoutMs),
    get stats() {
      return reader.stats;
    },
    close: overrides.close ?? (() => reader.close()),
  };
}

function transferReader(
  link: Link,
  definition: FrameChannelDefinition,
  options: FrameTimingOptions,
): { readonly reader: FrameReader; dispose(): void } {
  const { frameBytes } = definition;
  const inbox: { buffer: ArrayBuffer; generation: unknown }[] = [];
  const waiters = new Set<() => void>();
  const clock = options.clock ?? systemClock;
  let closed = false;
  let read = 0;
  let skipped = 0;
  const wake = (): void => {
    for (const waiter of [...waiters]) waiter();
  };
  const offFrame = link.on(sub(definition.id, 'frame'), (payload) => {
    const frame = payload as { buffer?: unknown; generation?: unknown } | null;
    if (closed || !(frame?.buffer instanceof ArrayBuffer)) return;
    inbox.push({ buffer: frame.buffer, generation: frame.generation });
    wake();
  });
  const markClosed = (): void => {
    closed = true;
    wake();
  };
  const offClose = link.on(sub(definition.id, 'close'), markClosed);
  const offLinkClose = link.onClose(markClosed);
  const giveBack = (entry: { buffer: ArrayBuffer; generation: unknown }): void => {
    if (closed) return;
    transferOverLink(link, sub(definition.id, 'return'), { buffer: entry.buffer, generation: entry.generation }, [entry.buffer]);
  };
  const consume = (entry: { buffer: ArrayBuffer; generation: unknown }, fn: (slot: ReadSlot) => void): void => {
    const meta = new Int32Array(entry.buffer, 0, 2);
    const slot: ReadSlot = {
      bytes: new Uint8Array(entry.buffer, SLOT_HEADER_BYTES, frameBytes),
      buffer: entry.buffer,
      byteOffset: SLOT_HEADER_BYTES,
      seq: meta[1] as number,
      length: meta[0] as number,
      time: new Float64Array(entry.buffer, 8, 1)[0] as number,
    };
    try {
      fn(slot);
    } finally {
      read += 1;
      giveBack(entry);
    }
  };
  const dispose = (): void => {
    offFrame();
    offClose();
    offLinkClose();
  };
  const reader: FrameReader = {
    mode: 'transfer',
    frameBytes,
    get closed() {
      return closed;
    },
    get available() {
      return inbox.length;
    },
    read(fn) {
      const entry = inbox.shift();
      if (entry === undefined) return false;
      consume(entry, fn);
      return true;
    },
    readLatest(fn) {
      while (inbox.length > 1) {
        skipped += 1;
        giveBack(inbox.shift() as { buffer: ArrayBuffer; generation: unknown });
      }
      return reader.read(fn);
    },
    waitForFrame(waitOptions = {}) {
      return new Promise((resolve) => {
        const signal = waitOptions.signal;
        let timer: unknown;
        const finish = (result: Result<boolean>): void => {
          waiters.delete(check);
          clock.clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(result);
        };
        const onAbort = (): void => finish(abortedResult(signal as AbortSignal));
        const check = (): void => {
          if (signal?.aborted === true) return finish(abortedResult(signal));
          if (inbox.length > 0) return finish(ok(true));
          if (closed) return finish(err(FrameChannelClosedError()));
        };
        waiters.add(check);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (waitOptions.timeoutMs !== undefined) timer = clock.setTimeout(() => finish(ok(false)), waitOptions.timeoutMs);
        check();
      });
    },
    waitSync: () => (inbox.length > 0 ? 'ok' : 'unsupported'),
    get stats() {
      return { written: 0, read, dropped: 0, skipped };
    },
    close() {
      if (closed) return;
      link.send(sub(definition.id, 'close'), null);
      markClosed();
      inbox.length = 0;
      dispose();
    },
  };
  return { reader, dispose };
}

// ---------------------------------------------------------------- layout views over slots

/**
 * Cache layout views per slot so frame code binds views without allocating
 * (shared mode reuses slots; transfer mode reuses buffers while they live).
 * Views span the whole slot capacity; use `slot.length / layout.stride` as the count.
 */
export function createSlotViews<F extends LayoutFields>(layout: Layout<F>): (slot: WriteSlot) => StructView<F> {
  const cache = new WeakMap<ArrayBufferLike, Map<number, StructView<F>>>();
  return (slot) => {
    let byOffset = cache.get(slot.buffer);
    if (byOffset === undefined) {
      byOffset = new Map();
      cache.set(slot.buffer, byOffset);
    }
    let view = byOffset.get(slot.byteOffset);
    if (view === undefined) {
      const result = layout.view(slot.buffer, { byteOffset: slot.byteOffset, count: Math.floor(slot.bytes.byteLength / layout.stride) });
      if (!result.ok) throw result.error;
      view = result.value;
      byOffset.set(slot.byteOffset, view);
    }
    return view;
  };
}
