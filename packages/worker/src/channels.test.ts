import { createInjector, createMemorySink, createTelemetry, unwrap } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import {
  attachRingBuffer,
  BufferDetachedError,
  checkTransferable,
  COLUMN_ALIGN,
  connectFrameConsumer,
  createDataChannel,
  createLink,
  createMessageChannelPorts,
  createPortPair,
  createRingBuffer,
  createSlotViews,
  defineDataChannel,
  defineFrameChannel,
  defineLayout,
  detachBuffer,
  detectIsolationFacts,
  FrameChannelClosedError,
  FrameChannelMismatchError,
  FrameTooLargeError,
  IsolationFactsToken,
  isDetached,
  isolationFactsUnit,
  LayoutInvalidError,
  LayoutViewError,
  NotTransferableError,
  openFrameProducer,
  type ReadSlot,
  ringByteLength,
  selectFrameMode,
  SharedMemoryUnavailableError,
  sharedMemoryAvailable,
  slotStride,
  type Clock,
} from './index.js';

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isolated = { crossOriginIsolated: true } as const;
const notIsolated = { crossOriginIsolated: false } as const;

function linkPair(clone = true) {
  const pair = createPortPair({ clone });
  return { pair, a: createLink({ port: pair.a, name: 'a' }), b: createLink({ port: pair.b, name: 'b' }) };
}

function manualClock(start = 0): Clock & { advance(ms: number): void; time: number } {
  let time = start;
  return {
    get time() {
      return time;
    },
    now: () => time,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 1)),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    advance(ms) {
      time += ms;
    },
  };
}

// ---------------------------------------------------------------- layouts

describe('defineLayout', () => {
  it('computes C-compatible offsets, stride, alignment and padding', () => {
    const Particle = defineLayout({ name: 'Particle', fields: { x: 'f32', y: 'f32', id: 'u32' } });
    expect(Particle.size).toBe(12);
    expect(Particle.stride).toBe(12);
    expect(Particle.align).toBe(4);
    expect(Particle.fields.map((f) => [f.name, f.offset])).toEqual([
      ['x', 0],
      ['y', 4],
      ['id', 8],
    ]);

    const Mixed = defineLayout({ fields: { a: 'u8', b: 'f64', c: 'u16' } });
    expect(Mixed.field('b').offset).toBe(8);
    expect(Mixed.field('c').offset).toBe(16);
    expect(Mixed.size).toBe(18);
    expect(Mixed.stride).toBe(24);
    expect(Mixed.align).toBe(8);
    expect(Mixed.describe().padding).toEqual([
      { offset: 1, size: 7 },
      { offset: 18, size: 6 },
    ]);
    expect(Mixed.byteLength(10)).toBe(240);
  });

  it('supports array fields and raised alignment', () => {
    const Transform = defineLayout({ name: 'Transform', align: 16, fields: { matrix: { type: 'f32', count: 16 }, flags: 'u8' } });
    expect(Transform.field('matrix').size).toBe(64);
    expect(Transform.size).toBe(65);
    expect(Transform.stride).toBe(80);
    expect(Transform.align).toBe(16);
  });

  it('rejects invalid declarations with SF-WK-019', () => {
    const codeOf = (fn: () => unknown): string | undefined => {
      try {
        fn();
        return undefined;
      } catch (error) {
        return (error as { code?: string }).code;
      }
    };
    expect(codeOf(() => defineLayout({ fields: {} }))).toBe(LayoutInvalidError.code);
    expect(codeOf(() => defineLayout({ fields: { '1x': 'f32' } }))).toBe(LayoutInvalidError.code);
    expect(codeOf(() => defineLayout({ fields: { x: 'f16' as 'f32' } }))).toBe(LayoutInvalidError.code);
    expect(codeOf(() => defineLayout({ fields: { x: { type: 'f32', count: 0 } } }))).toBe(LayoutInvalidError.code);
    expect(codeOf(() => defineLayout({ align: 3, fields: { x: 'f32' } }))).toBe(LayoutInvalidError.code);
    expect(codeOf(() => defineLayout({ name: 'bad name', fields: { x: 'f32' } }))).toBe(LayoutInvalidError.code);
    const ok = defineLayout({ fields: { x: 'f32' } });
    expect(codeOf(() => ok.field('nope' as 'x'))).toBe(LayoutInvalidError.code);
    expect(codeOf(() => ok.source('c', { name: 'not ok' }))).toBe(LayoutInvalidError.code);
  });
});

describe('struct views (AoS)', () => {
  const Particle = defineLayout({ name: 'Particle', fields: { x: 'f32', y: 'f32', id: 'u32', kind: 'u8', mass: 'f64' } });

  it('reads and writes in place with get/set, flyweight cursors and toObject', () => {
    expect(Particle.stride).toBe(24);
    const view = Particle.allocate(4);
    expect(view.count).toBe(4);
    view.set(1, 'x', 1.5);
    view.set(1, 'id', 42);
    const p = view.at(2);
    p.y = -3;
    p.mass = 9.75;
    p.kind = 7;
    expect(view.at(2)).toBe(p); // same object, re-pointed
    expect(view.get(2, 'y')).toBe(-3);
    expect(view.get(1, 'x')).toBe(1.5);
    expect(view.toObject(1)).toEqual({ x: 1.5, y: 0, id: 42, kind: 0, mass: 0 });

    const c = view.cursor(3);
    c.x = 2;
    c.index = 1;
    expect(c.x).toBe(1.5);
    expect(view.get(3, 'x')).toBe(2);

    // Bytes are exactly where the C struct would put them (little-endian).
    const data = new DataView(view.buffer as ArrayBuffer);
    expect(data.getFloat32(24 + 0, true)).toBe(1.5);
    expect(data.getUint32(24 + 8, true)).toBe(42);
    expect(data.getFloat64(48 + 16, true)).toBe(9.75);
    expect(data.getUint8(48 + 12)).toBe(7);
  });

  it('exposes array fields as typed-array windows', () => {
    const Mesh = defineLayout({ fields: { id: 'u32', pos: { type: 'f32', count: 3 } } });
    const view = Mesh.allocate(2);
    view.elements(1, 'pos').set([1, 2, 3]);
    expect(Array.from(view.at(1).pos)).toEqual([1, 2, 3]);
    expect(view.toObject(1)).toEqual({ id: 0, pos: [1, 2, 3] });
    expect(Array.from(new Float32Array(view.buffer, Mesh.stride + 4, 3))).toEqual([1, 2, 3]);
  });

  it('handles 64-bit integers as bigint', () => {
    const Ids = defineLayout({ fields: { id: 'u64', delta: 'i64' } });
    const view = Ids.allocate(1);
    view.set(0, 'id', 2n ** 63n);
    view.at(0).delta = -5n;
    expect(view.get(0, 'id')).toBe(2n ** 63n);
    expect(view.get(0, 'delta')).toBe(-5n);
  });

  it('binds views at offsets (e.g. Wasm memory) and validates alignment and size', () => {
    const memory = new ArrayBuffer(256);
    const view = unwrap(Particle.view(memory, { byteOffset: 64, count: 2 }));
    view.set(0, 'id', 7);
    expect(new Uint32Array(memory, 64 + 8, 1)[0]).toBe(7);
    expect(unwrap(Particle.view(memory)).count).toBe(10);

    const misaligned = Particle.view(memory, { byteOffset: 4, count: 1 });
    expect(misaligned.ok ? undefined : misaligned.error.code).toBe(LayoutViewError.code);
    const tooSmall = Particle.view(memory, { byteOffset: 0, count: 11 });
    expect(tooSmall.ok ? undefined : tooSmall.error.code).toBe(LayoutViewError.code);
    const badCount = Particle.view(memory, { count: -1 });
    expect(badCount.ok).toBe(false);
  });

  it('allocates shared views when asked', () => {
    const view = Particle.allocate(2, { shared: true });
    expect(view.buffer).toBeInstanceOf(SharedArrayBuffer);
  });
});

describe('SoA columns', () => {
  const Transform = defineLayout({ name: 'Transform', fields: { x: 'f64', y: 'f64', flags: 'u8', id: 'i32' } });

  it('lays out one 16-aligned column per field', () => {
    const cols = unwrap(Transform.columns({ capacity: 5 }));
    expect(cols.offsetOf('x')).toBe(0);
    expect(cols.offsetOf('y')).toBe(48); // 40 → 48
    expect(cols.offsetOf('flags')).toBe(96); // 88 → 96
    expect(cols.offsetOf('id')).toBe(112); // 101 → 112
    expect(cols.byteLength).toBe(Transform.columnsByteLength(5));
    expect(cols.byteLength % COLUMN_ALIGN).toBe(0);
    expect(cols.column('x')).toBeInstanceOf(Float64Array);
    expect(cols.column('x').length).toBe(5);
    cols.column('x')[3] = 2.5;
    cols.set(4, 'id', -9);
    expect(cols.get(3, 'x')).toBe(2.5);
    expect(new Int32Array(cols.buffer, 112, 5)[4]).toBe(-9);
  });

  it('lives in existing memory (shared or Wasm) at an aligned offset', () => {
    const shared = new SharedArrayBuffer(1024);
    const writer = unwrap(Transform.columns({ capacity: 4, buffer: shared, byteOffset: 128 }));
    const reader = unwrap(Transform.columns({ capacity: 4, buffer: shared, byteOffset: 128 }));
    writer.column('y')[2] = 11;
    expect(reader.get(2, 'y')).toBe(11);
    expect(unwrap(Transform.columns({ capacity: 4, shared: true })).buffer).toBeInstanceOf(SharedArrayBuffer);
    const misaligned = Transform.columns({ capacity: 4, buffer: shared, byteOffset: 8 });
    expect(misaligned.ok).toBe(false);
    const tooSmall = Transform.columns({ capacity: 400, buffer: shared });
    expect(tooSmall.ok ? undefined : tooSmall.error.code).toBe(LayoutViewError.code);
    expect(Transform.columns({ capacity: -1 }).ok).toBe(false);
  });

  it('counts array fields per row', () => {
    const Bones = defineLayout({ fields: { m: { type: 'f32', count: 4 } } });
    const cols = unwrap(Bones.columns({ capacity: 3 }));
    expect(cols.column('m').length).toBe(12);
  });
});

describe('struct source generation', () => {
  const Particle = defineLayout({ name: 'Particle', fields: { kind: 'u8', mass: 'f64', pos: { type: 'f32', count: 2 } } });

  it('emits a C struct with explicit padding and size/align asserts', () => {
    const c = Particle.source('c');
    expect(c).toContain('#include <stdint.h>');
    expect(c).toContain('typedef struct Particle {');
    expect(c).toContain('  uint8_t kind; /* offset 0, 1 bytes */');
    expect(c).toContain('  uint8_t _pad0[7]; /* offset 1 */');
    expect(c).toContain('  double mass; /* offset 8, 8 bytes */');
    expect(c).toContain('  float pos[2]; /* offset 16, 8 bytes */');
    expect(c).toContain('_Static_assert(sizeof(Particle) == 24');
    expect(c).toContain('_Static_assert(_Alignof(Particle) == 8');
    expect(c.indexOf('kind')).toBeLessThan(c.indexOf('_pad0'));
    expect(c.indexOf('_pad0')).toBeLessThan(c.indexOf('mass'));
  });

  it('emits a #[repr(C)] Rust struct with the same offsets', () => {
    const rust = Particle.source('rust', { name: 'Body' });
    expect(rust).toContain('#[repr(C)]');
    expect(rust).toContain('pub struct Body {');
    expect(rust).toContain('    pub kind: u8, // offset 0, 1 bytes');
    expect(rust).toContain('    pub _pad0: [u8; 7], // offset 1');
    expect(rust).toContain('    pub pos: [f32; 2], // offset 16, 8 bytes');
    expect(rust).toContain('assert!(core::mem::size_of::<Body>() == 24)');
  });

  it('marks raised alignment and trailing padding', () => {
    const Vec3 = defineLayout({ name: 'Vec3', align: 16, fields: { x: 'f32', y: 'f32', z: 'f32' } });
    expect(Vec3.source('rust')).toContain('#[repr(C, align(16))]');
    const c = Vec3.source('c');
    expect(c).toContain('_Alignas(16) float x;');
    expect(c).toContain('uint8_t _pad0[4]; /* offset 12 */');
  });

  it('emits SoA column offsets for Wasm authors', () => {
    const Transform = defineLayout({ name: 'SceneTransform', fields: { posX: 'f64', flags: 'u8' } });
    const c = Transform.columnsSource('c', 5);
    expect(c).toContain('#define SCENE_TRANSFORM_CAPACITY 5u');
    expect(c).toContain('#define SCENE_TRANSFORM_POS_X_OFFSET 0u');
    expect(c).toContain('#define SCENE_TRANSFORM_FLAGS_OFFSET 48u');
    expect(c).toContain(`#define SCENE_TRANSFORM_COLUMNS_BYTES ${Transform.columnsByteLength(5)}u`);
    const rust = Transform.columnsSource('rust', 5);
    expect(rust).toContain('pub const SCENE_TRANSFORM_FLAGS_OFFSET: usize = 48;');
  });
});

// ---------------------------------------------------------------- isolation

describe('isolation facts', () => {
  it('selects shared memory only when isolated, not off, not embedded, and globals exist', () => {
    expect(sharedMemoryAvailable(isolated)).toBe(true);
    expect(sharedMemoryAvailable(notIsolated)).toBe(false);
    expect(sharedMemoryAvailable({ crossOriginIsolated: true, mode: 'off' })).toBe(false);
    expect(sharedMemoryAvailable({ crossOriginIsolated: true, embedded: true })).toBe(false);
    expect(sharedMemoryAvailable(isolated, { Atomics })).toBe(false);
    expect(selectFrameMode(isolated)).toBe('shared');
    expect(selectFrameMode(notIsolated)).toBe('transfer');
    expect(detectIsolationFacts({ crossOriginIsolated: true }, 'required')).toEqual({ crossOriginIsolated: true, mode: 'required' });
    expect(detectIsolationFacts({}).crossOriginIsolated).toBe(false);
  });

  it('is provided by a DI unit', async () => {
    const injector = createInjector({
      units: [isolationFactsUnit({ mode: 'preferred', embedded: true, globals: { crossOriginIsolated: true } })],
    });
    const facts = unwrap(await injector.get(IsolationFactsToken));
    expect(facts).toEqual({ crossOriginIsolated: true, mode: 'preferred', embedded: true });
    expect(sharedMemoryAvailable(facts)).toBe(false);
    await injector.dispose();
  });
});

// ---------------------------------------------------------------- data channels

describe('data channels', () => {
  const Mesh = defineDataChannel<{ meshId: string }>(
    'test/mesh',
    (meta): meta is { meshId: string } => typeof (meta as { meshId?: unknown }).meshId === 'string',
  );

  it('transfers buffers and detaches them on the sender (copying in-memory port)', async () => {
    const { a, b } = linkPair(true);
    const sink = createMemorySink();
    const telemetry = createTelemetry();
    telemetry.addSink(sink);
    const sender = createDataChannel(a, Mesh, { telemetry });
    const receiver = createDataChannel(b, Mesh);
    const received: { meshId: string; data: number[] }[] = [];
    receiver.on(({ meta, buffers }) => received.push({ meshId: meta.meshId, data: Array.from(new Float32Array(buffers[0] as ArrayBuffer)) }));

    const vertices = new Float32Array([1, 2, 3]);
    expect(sender.send({ meshId: 'm1' }, [vertices.buffer]).ok).toBe(true);
    expect(isDetached(vertices.buffer)).toBe(true);
    expect(sender.transferred(vertices.buffer)).toBe(true);
    expect(sender.stats).toMatchObject({ sentMessages: 1, sentBytes: 12, forcedDetaches: 1 });
    await tick();
    expect(received).toEqual([{ meshId: 'm1', data: [1, 2, 3] }]);
    expect(receiver.stats).toMatchObject({ receivedMessages: 1, receivedBytes: 12 });
    expect(sink.records.some((r) => r.type === 'metric' && r.metric === 'worker/data-channel-bytes-sent' && r.value === 12)).toBe(true);
  });

  it('relies on the platform transfer over a real MessageChannel', async () => {
    const ports = createMessageChannelPorts();
    if (ports === undefined) return;
    const a = createLink({ port: ports.a });
    const b = createLink({ port: ports.b });
    const sender = createDataChannel(a, Mesh);
    const receiver = createDataChannel(b, Mesh);
    const got = new Promise<number>((resolve) => receiver.on(({ buffers }) => resolve((buffers[0] as ArrayBuffer).byteLength)));
    const buffer = new ArrayBuffer(64);
    expect(sender.send({ meshId: 'x' }, [buffer]).ok).toBe(true);
    expect(isDetached(buffer)).toBe(true);
    expect(await got).toBe(64);
    a.close();
    b.close();
    ports.a.close();
    ports.b.close();
  });

  it('rejects shared, duplicate, detached and re-sent buffers', () => {
    const { a } = linkPair();
    const channel = createDataChannel(a, Mesh);
    const shared = channel.send({ meshId: 'a' }, [new SharedArrayBuffer(8) as unknown as ArrayBuffer]);
    expect(shared.ok ? undefined : shared.error.code).toBe(NotTransferableError.code);
    const buffer = new ArrayBuffer(8);
    const duplicate = channel.send({ meshId: 'a' }, [buffer, buffer]);
    expect(duplicate.ok ? undefined : duplicate.error.code).toBe(NotTransferableError.code);
    expect(isDetached(buffer)).toBe(false); // nothing was sent
    expect(channel.send({ meshId: 'a' }, [buffer]).ok).toBe(true);
    const again = channel.send({ meshId: 'a' }, [buffer]);
    expect(again.ok ? undefined : again.error.code).toBe(BufferDetachedError.code);
    const detached = new ArrayBuffer(4);
    detachBuffer(detached);
    const result = channel.send({ meshId: 'a' }, [detached]);
    expect(result.ok ? undefined : result.error.code).toBe(BufferDetachedError.code);
    expect(checkTransferable([{}]).ok).toBe(false);
    channel.close();
    expect(channel.send({ meshId: 'a' }, []).ok).toBe(false);
  });

  it('drops messages failing the meta guard and stops listening after close', async () => {
    const { a, b } = linkPair();
    const receiver = createDataChannel(b, Mesh);
    const seen: unknown[] = [];
    receiver.on(({ meta }) => seen.push(meta));
    a.send('test/mesh', { meta: { wrong: true }, buffers: [] });
    a.send('test/mesh', { nonsense: true });
    await tick();
    expect(seen).toEqual([]);
    receiver.close();
    createDataChannel(a, Mesh).send({ meshId: 'late' }, []);
    await tick();
    expect(seen).toEqual([]);
  });

  it('isDetached / detachBuffer handle zero-length and already-detached buffers', () => {
    const empty = new ArrayBuffer(0);
    expect(isDetached(empty)).toBe(false);
    detachBuffer(empty);
    expect(isDetached(empty)).toBe(true);
    detachBuffer(empty); // no-op
  });
});

// ---------------------------------------------------------------- ring buffer

describe('ring buffer (shared memory, SPSC)', () => {
  it('writes and reads frames in place with seq, length and time', () => {
    const clock = manualClock(100);
    const ring = unwrap(createRingBuffer({ frameBytes: 10, slots: 3, clock }));
    expect(ring.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(ring.buffer.byteLength).toBe(ringByteLength(10, 3));
    expect(slotStride(10)).toBe(32);
    const writer = ring.writer();
    const reader = ring.reader();
    expect(reader.read(() => undefined)).toBe(false);
    const first = writer.write((slot) => {
      expect(slot.bytes.length).toBe(10);
      expect(slot.byteOffset % 16).toBe(0);
      slot.bytes.set([1, 2, 3]);
      return 3;
    });
    expect(unwrap(first)).toEqual({ written: true, seq: 0 });
    clock.advance(5);
    writer.write((slot) => {
      slot.bytes[0] = 9;
    });
    expect(reader.available).toBe(2);
    const seen: Pick<ReadSlot, 'seq' | 'length' | 'time'>[] = [];
    reader.read((slot) => {
      seen.push({ seq: slot.seq, length: slot.length, time: slot.time });
      expect(Array.from(slot.bytes.subarray(0, slot.length))).toEqual([1, 2, 3]);
    });
    reader.read((slot) => seen.push({ seq: slot.seq, length: slot.length, time: slot.time }));
    expect(seen).toEqual([
      { seq: 0, length: 3, time: 100 },
      { seq: 1, length: 10, time: 105 },
    ]);
    expect(writer.stats.written).toBe(2);
    expect(reader.stats.read).toBe(2);
  });

  it('drops when full and skips to the latest frame', () => {
    const ring = unwrap(createRingBuffer({ frameBytes: 4, slots: 3 }));
    const writer = ring.writer();
    const reader = ring.reader();
    for (let i = 0; i < 3; i += 1) writer.write((slot) => void (slot.bytes[0] = i));
    expect(unwrap(writer.write(() => 1))).toEqual({ written: false, reason: 'full' });
    expect(writer.stats.dropped).toBe(1);
    let latest = -1;
    expect(reader.readLatest((slot) => (latest = slot.bytes[0] as number))).toBe(true);
    expect(latest).toBe(2);
    expect(reader.stats.skipped).toBe(2);
    expect(reader.readLatest(() => undefined)).toBe(false);
  });

  it('wraps around the slots for many frames', () => {
    const ring = unwrap(createRingBuffer({ frameBytes: 4, slots: 2 }));
    const writer = ring.writer();
    const reader = ring.reader();
    const out: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      writer.write((slot) => {
        new Uint32Array(slot.buffer, slot.byteOffset, 1)[0] = i * 10;
      });
      reader.read((slot) => out.push(new Uint32Array(slot.buffer, slot.byteOffset, 1)[0] as number));
    }
    expect(out).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80]);
  });

  it('rejects frames larger than the slot and invalid configs', () => {
    const ring = unwrap(createRingBuffer({ frameBytes: 4, slots: 1 }));
    const writer = ring.writer();
    const tooLarge = writer.write(() => 5);
    expect(tooLarge.ok ? undefined : tooLarge.error.code).toBe(FrameTooLargeError.code);
    expect(createRingBuffer({ frameBytes: 0 }).ok).toBe(false);
    expect(createRingBuffer({ frameBytes: 4, slots: 0 }).ok).toBe(false);
  });

  it('attaches from the raw buffer and validates the format', () => {
    const ring = unwrap(createRingBuffer({ frameBytes: 8, slots: 2 }));
    const attached = unwrap(attachRingBuffer(ring.buffer));
    expect(attached.frameBytes).toBe(8);
    expect(attached.slots).toBe(2);
    ring.writer().write((slot) => void (slot.bytes[0] = 77));
    let value = 0;
    attached.reader().read((slot) => (value = slot.bytes[0] as number));
    expect(value).toBe(77);
    const bad = attachRingBuffer(new SharedArrayBuffer(128));
    expect(bad.ok ? undefined : bad.error.code).toBe(FrameChannelMismatchError.code);
    expect(attachRingBuffer(new SharedArrayBuffer(8)).ok).toBe(false);
    const truncated = new SharedArrayBuffer(64);
    new Uint8Array(truncated).set(new Uint8Array(ring.buffer, 0, 64));
    expect(attachRingBuffer(truncated).ok).toBe(false);
  });

  it('wakes waiting readers with Atomics.waitAsync, times out, aborts and reports close', async () => {
    const ring = unwrap(createRingBuffer({ frameBytes: 4, slots: 2 }));
    const writer = ring.writer();
    const reader = ring.reader({ wait: 'atomics' });
    const waiting = reader.waitForFrame();
    setTimeout(() => writer.write(() => 1), 5);
    expect(unwrap(await waiting)).toBe(true);
    reader.read(() => undefined);
    expect(unwrap(await reader.waitForFrame({ timeoutMs: 5 }))).toBe(false);
    const controller = new AbortController();
    const aborted = reader.waitForFrame({ signal: controller.signal });
    setTimeout(() => controller.abort(), 2);
    const abortedResult = await aborted;
    expect(abortedResult.ok ? undefined : abortedResult.error.kind).toBe('aborted');
    const closing = reader.waitForFrame();
    setTimeout(() => writer.close(), 2);
    const closed = await closing;
    expect(closed.ok ? undefined : closed.error.code).toBe(FrameChannelClosedError.code);
    expect(reader.closed).toBe(true);
    const afterClose = writer.write(() => 1);
    expect(afterClose.ok ? undefined : afterClose.error.code).toBe(FrameChannelClosedError.code);
  });

  it('falls back to polling (non-shared buffer or explicit strategy)', async () => {
    const ring = unwrap(createRingBuffer({ frameBytes: 4, slots: 2, shared: false }));
    expect(ring.shared).toBe(false);
    const writer = ring.writer();
    const reader = ring.reader({ pollMs: 1 });
    const waiting = reader.waitForFrame();
    setTimeout(() => writer.write(() => 1), 3);
    expect(unwrap(await waiting)).toBe(true);
    reader.read(() => undefined);
    expect(unwrap(await reader.waitForFrame({ timeoutMs: 3 }))).toBe(false);
    const controller = new AbortController();
    controller.abort();
    expect((await reader.waitForFrame({ signal: controller.signal })).ok).toBe(false);
    const controller2 = new AbortController();
    const pendingAbort = reader.waitForFrame({ signal: controller2.signal });
    controller2.abort();
    expect((await pendingAbort).ok).toBe(false);
    writer.close();
    expect((await reader.waitForFrame()).ok).toBe(false);

    const shared = unwrap(createRingBuffer({ frameBytes: 4, slots: 2 }));
    const polling = shared.reader({ wait: 'polling', pollMs: 1 });
    const p = polling.waitForFrame();
    setTimeout(() => shared.writer().write(() => 1), 2);
    expect(unwrap(await p)).toBe(true);
  });

  it('offers a blocking wait for workers', () => {
    const ring = unwrap(createRingBuffer({ frameBytes: 4, slots: 2 }));
    const reader = ring.reader();
    expect(['timed-out', 'unsupported']).toContain(reader.waitSync(1));
    ring.writer().write(() => 1);
    expect(reader.waitSync(1)).toBe('ok');
    const local = unwrap(createRingBuffer({ frameBytes: 4, shared: false }));
    expect(local.reader().waitSync(1)).toBe('unsupported');
  });
});

// ---------------------------------------------------------------- frame channels over links

describe('frame channels', () => {
  const Sprite = defineLayout({ name: 'Sprite', fields: { x: 'f32', y: 'f32', id: 'u32' } });
  const Frames = defineFrameChannel({ id: 'test/frames', layout: Sprite, count: 8 });

  it('declares sizes from a layout', () => {
    expect(Frames.frameBytes).toBe(96);
    expect(Frames.slots).toBe(3);
    expect(Frames.buffers).toBe(2);
    expect(defineFrameChannel({ id: 'test/raw', frameBytes: 10, slots: 5, buffers: 3, require: 'shared' })).toMatchObject({
      frameBytes: 10,
      slots: 5,
      buffers: 3,
      require: 'shared',
    });
  });

  it('shared mode: ring buffer over a SharedArrayBuffer, zero-copy, layout views cached per slot', async () => {
    const { a, b } = linkPair(true);
    const sink = createMemorySink();
    const telemetry = createTelemetry();
    telemetry.addSink(sink);
    const producer = unwrap(openFrameProducer(a, Frames, { isolation: isolated, telemetry }));
    expect(producer.mode).toBe('shared');
    expect(producer.state).toBe('waiting');
    // Shared mode buffers frames before the consumer connects.
    const views = createSlotViews(Sprite);
    producer.write((slot) => {
      const view = views(slot);
      view.at(0).x = 1;
      view.at(0).id = 5;
      return Sprite.stride;
    });
    const consumer = unwrap(await connectFrameConsumer(b, Frames, { telemetry }));
    expect(consumer.mode).toBe('shared');
    expect(producer.state).toBe('open');
    const readViews = createSlotViews(Sprite);
    let first: Record<string, unknown> | undefined;
    let firstView: unknown;
    consumer.read((slot) => {
      firstView = readViews(slot);
      first = readViews(slot).toObject(0);
      expect(slot.length / Sprite.stride).toBe(1);
    });
    expect(first).toEqual({ x: 1, y: 0, id: 5 });
    // Wraps back to slot 0 after `slots` frames: the cached view is reused.
    for (let i = 0; i < 3; i += 1) {
      producer.write(() => 0);
      let again: unknown;
      consumer.read((slot) => (again = readViews(slot)));
      if (i === 2) expect(again).toBe(firstView);
    }
    for (let i = 0; i < 4; i += 1) producer.write(() => 0);
    expect(producer.stats.dropped).toBe(1);
    expect(consumer.readLatest(() => undefined)).toBe(true);
    expect(consumer.stats.skipped).toBe(2);
    expect(sink.records.some((r) => r.type === 'metric' && r.metric === 'worker/frame-channel-dropped')).toBe(true);
    expect(sink.records.some((r) => r.type === 'metric' && r.metric === 'worker/frame-channel-skipped' && r.value === 2)).toBe(true);
    expect(sink.records.some((r) => r.type === 'event' && r.name === 'worker.frame-channel.open')).toBe(true);

    const waiting = consumer.waitForFrame();
    producer.close();
    const closed = await waiting;
    expect(closed.ok ? undefined : closed.error.code).toBe(FrameChannelClosedError.code);
    expect(producer.state).toBe('closed');
    expect(producer.write(() => 0).ok).toBe(false);
  });

  it('shared mode: consumer close reaches the producer', async () => {
    const { a, b } = linkPair(true);
    const producer = unwrap(openFrameProducer(a, Frames, { isolation: isolated }));
    const consumer = unwrap(await connectFrameConsumer(b, Frames));
    consumer.close();
    expect(consumer.closed).toBe(true);
    await tick();
    expect(producer.state).toBe('closed');
    expect(producer.closed).toBe(true);
  });

  it('transfer mode: double-buffered ping-pong with the same API', async () => {
    const { a, b } = linkPair(true);
    const producer = unwrap(openFrameProducer(a, Frames, { isolation: notIsolated }));
    expect(producer.mode).toBe('transfer');
    expect(unwrap(producer.write(() => 0))).toEqual({ written: false, reason: 'no-consumer' });

    const consumer = unwrap(await connectFrameConsumer(b, Frames));
    expect(consumer.mode).toBe('transfer');
    expect(producer.state).toBe('open');

    const sent: ArrayBufferLike[] = [];
    const write = (value: number) =>
      unwrap(
        producer.write((slot) => {
          sent.push(slot.buffer);
          const view = Sprite.view(slot.buffer, { byteOffset: slot.byteOffset, count: 1 });
          unwrap(view).set(0, 'id', value);
          return Sprite.stride;
        }),
      );
    expect(write(1)).toEqual({ written: true, seq: 0 });
    expect(write(2)).toEqual({ written: true, seq: 1 });
    expect(write(3)).toEqual({ written: false, reason: 'full' }); // both buffers in flight
    expect(sent.every((buffer) => isDetached(buffer as ArrayBuffer))).toBe(true);

    expect(unwrap(await consumer.waitForFrame())).toBe(true);
    await tick();
    expect(consumer.available).toBe(2);
    let id = 0;
    consumer.readLatest((slot) => {
      id = unwrap(Sprite.view(slot.buffer, { byteOffset: slot.byteOffset, count: 1 })).get(0, 'id');
      expect(slot.length).toBe(Sprite.stride);
      expect(slot.seq).toBe(1);
    });
    expect(id).toBe(2);
    expect(consumer.stats.skipped).toBe(1);
    await tick();
    // Both buffers came back to the producer.
    expect(write(4).written).toBe(true);
    expect(write(5).written).toBe(true);
    expect(producer.stats.dropped).toBe(2);
    await tick();
    const ids: number[] = [];
    while (consumer.read((slot) => ids.push(unwrap(Sprite.view(slot.buffer, { byteOffset: slot.byteOffset, count: 1 })).get(0, 'id')))) {
      /* drain */
    }
    expect(ids).toEqual([4, 5]);
    expect(consumer.waitSync(1)).toBe('unsupported');
    expect(unwrap(await consumer.waitForFrame({ timeoutMs: 2 }))).toBe(false);
    const controller = new AbortController();
    const aborted = consumer.waitForFrame({ signal: controller.signal });
    controller.abort();
    expect((await aborted).ok).toBe(false);

    const tooLarge = producer.write(() => 1000);
    expect(tooLarge.ok ? undefined : tooLarge.error.code).toBe(FrameTooLargeError.code);
    expect(() => producer.write(() => {
      throw new Error('fill failed');
    })).toThrow('fill failed');
    expect(write(6).written).toBe(true); // the buffer went back to the pool after both failures

    const waiting = consumer.waitForFrame();
    await tick();
    consumer.read(() => undefined);
    const nextWait = consumer.waitForFrame();
    consumer.close();
    await waiting;
    const closed = await nextWait;
    expect(closed.ok ? undefined : closed.error.code).toBe(FrameChannelClosedError.code);
    await tick();
    expect(producer.state).toBe('closed');
  });

  it('transfer mode: producer close and link close reach the consumer', async () => {
    const { a, b, pair } = linkPair(true);
    const producer = unwrap(openFrameProducer(a, Frames, { isolation: { crossOriginIsolated: true, mode: 'off' } }));
    expect(producer.mode).toBe('transfer');
    const consumer = unwrap(await connectFrameConsumer(b, Frames));
    producer.close();
    producer.close();
    await tick();
    expect(consumer.closed).toBe(true);

    const second = linkPair(true);
    const p2 = unwrap(openFrameProducer(second.a, Frames, { isolation: notIsolated }));
    const c2 = unwrap(await connectFrameConsumer(second.b, Frames));
    second.pair.close();
    second.a.close();
    second.b.close();
    expect(c2.closed).toBe(true);
    expect(p2.state).toBe('closed');
    pair.close();
  });

  it('transfer mode: a reconnecting consumer gets a fresh pool; stale returns are ignored', async () => {
    const { a, b } = linkPair(true);
    const producer = unwrap(openFrameProducer(a, Frames, { isolation: notIsolated }));
    const first = unwrap(await connectFrameConsumer(b, Frames));
    producer.write(() => 0);
    producer.write(() => 0);
    await tick();
    expect(first.available).toBe(2);
    // A respawned consumer reconnects; buffers held by the old one are written off.
    const second = unwrap(await connectFrameConsumer(b, Frames));
    expect(second.mode).toBe('transfer');
    first.read(() => undefined); // returns a stale-generation buffer
    await tick();
    expect(producer.write(() => 0).ok).toBe(true);
    expect(producer.write(() => 0).ok).toBe(true);
    expect(unwrap(producer.write(() => 0))).toEqual({ written: false, reason: 'full' });
  });

  it('fails with SF-WK-025 when shared memory is required but unavailable', () => {
    const { a } = linkPair();
    const Required = defineFrameChannel({ id: 'test/required', frameBytes: 16, require: 'shared' });
    const result = openFrameProducer(a, Required, { isolation: notIsolated });
    expect(result.ok ? undefined : result.error.code).toBe(SharedMemoryUnavailableError.code);
    expect(result.ok ? undefined : result.error.fix).toContain('Cross-Origin-Embedder-Policy');
    expect(openFrameProducer(a, Required, { isolation: isolated }).ok).toBe(true);
  });

  it('rejects mismatched consumers and connects after close fail', async () => {
    const { a, b } = linkPair();
    const producer = unwrap(openFrameProducer(a, Frames, { isolation: isolated }));
    const Other = defineFrameChannel({ id: 'test/frames', frameBytes: 8 });
    const mismatch = await connectFrameConsumer(b, Other);
    expect(mismatch.ok ? undefined : mismatch.error.code).toBe(FrameChannelMismatchError.code);
    producer.close();
    const afterClose = await connectFrameConsumer(b, Frames);
    expect(afterClose.ok).toBe(false);
    const nobody = await connectFrameConsumer(b, defineFrameChannel({ id: 'test/nobody', frameBytes: 8 }), { timeoutMs: 50 });
    expect(nobody.ok).toBe(false);
  });
});
