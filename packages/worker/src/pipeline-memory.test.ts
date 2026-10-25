import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPortPair } from './index.js';
import { defineLayout } from './channels.js';
import { SharedMemoryUnavailableError } from './channel-errors.js';
import {
  attachCell,
  attachDeltaStream,
  attachRecordRing,
  attachRegion,
  CELL_HEADER_BYTES,
  cellByteLength,
  checkPipeHeader,
  CLOCK_STATES,
  ClockCellLayout,
  createCell,
  createDeltaStream,
  createRecordRing,
  createRegion,
  defineCell,
  defineClockCell,
  defineDeltaStream,
  defineRecordRing,
  DELTA_HEADER_BYTES,
  DeltaReaderLifecycle,
  deltaStreamByteLength,
  digestBytes,
  extrapolateClock,
  fnv1aString,
  fnv1aWords,
  isMessagePortLike,
  isRegionEndpoint,
  MAX_RING_READERS,
  murmur3x86_128,
  PipeClosedError,
  PipeEndpointTakenError,
  PipeMismatchError,
  RecordTooLargeError,
  recordRingByteLength,
  recordRingHeaderBytes,
  regionTransferList,
  selectMedium,
  toPort,
} from './pipeline.js';

const encoder = new TextEncoder();
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('hashes', () => {
  it('MurmurHash3 x86-128 matches reference vectors', () => {
    expect(murmur3x86_128(new Uint8Array(0))).toBe('00000000000000000000000000000000');
    expect(murmur3x86_128(encoder.encode('hello'))).toBe('2b2444a0db91def79adb31b69adb31b6');
    expect(murmur3x86_128(encoder.encode('The quick brown fox jumps over the lazy dog'))).toBe('2f1583c3ecee2c675d7bf66ce5e91d2c');
    expect(murmur3x86_128(encoder.encode('staticflux pipeline'), 42)).toBe('b28f260000011e03e05e5acc723b69de');
  });

  it('digestBytes is the 128-bit content digest', () => {
    const bytes = encoder.encode('a path');
    expect(digestBytes(bytes)).toBe(murmur3x86_128(bytes));
    expect(digestBytes(bytes)).toMatch(/^[0-9a-f]{32}$/);
    expect(digestBytes(encoder.encode('a path!'))).not.toBe(digestBytes(bytes));
  });

  it('FNV-1a over words and strings', () => {
    const words = new Int32Array([1, 2, 3, 4]);
    expect(fnv1aWords(words)).toBe(fnv1aWords(new Int32Array([1, 2, 3, 4])));
    expect(fnv1aWords(words, 1, 3)).toBe(fnv1aWords(new Int32Array([2, 3])));
    expect(fnv1aWords(words)).not.toBe(fnv1aWords(new Int32Array([1, 2, 4, 3])));
    expect(fnv1aString('instaflow/view-frame')).toBe(fnv1aString('instaflow/view-frame'));
    expect(fnv1aString('a/b')).not.toBe(fnv1aString('a/c'));
  });
});

describe('regions and media', () => {
  const sharedGlobals = { SharedArrayBuffer, Atomics, crossOriginIsolated: true };

  it('selectMedium: colocated → local; split → shared when isolated, else message', () => {
    expect(selectMedium({ topology: 'colocated' })).toBe('local');
    expect(selectMedium({ topology: 'split', isolation: { crossOriginIsolated: true }, globals: sharedGlobals })).toBe('shared');
    expect(selectMedium({ topology: 'split', isolation: { crossOriginIsolated: false }, globals: sharedGlobals })).toBe('message');
    expect(selectMedium({ topology: 'split', isolation: { crossOriginIsolated: true, mode: 'off' }, globals: sharedGlobals })).toBe('message');
    expect(selectMedium({ topology: 'split', globals: sharedGlobals })).toBe('shared'); // detected from globals
  });

  it('validates sizes and needs SharedArrayBuffer for the shared medium', () => {
    for (const byteLength of [8, 20, 2 ** 31]) {
      const created = createRegion({ medium: 'local', byteLength });
      expect(!created.ok && created.error.code).toBe(PipeMismatchError.code);
    }
    vi.stubGlobal('SharedArrayBuffer', undefined);
    const shared = createRegion({ medium: 'shared', byteLength: 64 });
    expect(!shared.ok && shared.error.code).toBe(SharedMemoryUnavailableError.code);
  });

  it('endpoint helpers: guards, transfer lists, port detection', () => {
    const shared = createRegion({ medium: 'shared', byteLength: 64 });
    const message = createRegion({ medium: 'message', byteLength: 64 });
    if (!shared.ok || !message.ok) throw new Error('regions');
    const sharedEndpoint = shared.value.endpoint();
    const messageEndpoint = message.value.endpoint();
    if (!sharedEndpoint.ok || !messageEndpoint.ok) throw new Error('endpoints');
    expect(isRegionEndpoint(sharedEndpoint.value)).toBe(true);
    expect(isRegionEndpoint({ sf: 'region', medium: 'carrier-pigeon', byteLength: 64 })).toBe(false);
    expect(isRegionEndpoint(null)).toBe(false);
    expect(regionTransferList(sharedEndpoint.value)).toEqual([]);
    const transfer = regionTransferList(messageEndpoint.value);
    expect(transfer).toHaveLength(1);
    expect(isMessagePortLike(transfer[0])).toBe(true);
    const pair = createPortPair();
    expect(isMessagePortLike(pair.a)).toBe(false);
    expect(toPort(pair.a)).toBe(pair.a);
    expect(toPort(transfer[0])).toBeDefined();
    expect(toPort({ postMessage: 1 })).toBeUndefined();
    message.value.close();
    pair.close();
  });

  it('attachRegion refuses bad endpoints', async () => {
    const notEndpoint = await attachRegion({ sf: 'nope' } as never);
    expect(!notEndpoint.ok && notEndpoint.error.code).toBe(PipeMismatchError.code);
    const posted = await attachRegion({ sf: 'region', medium: 'local', byteLength: 64, hub: {} });
    expect(!posted.ok && posted.error.message).toMatch(/another thread/);
    const noBuffer = await attachRegion({ sf: 'region', medium: 'shared', byteLength: 64, buffer: new ArrayBuffer(64) as never });
    expect(!noBuffer.ok && noBuffer.error.code).toBe(SharedMemoryUnavailableError.code);
    const noPort = await attachRegion({ sf: 'region', medium: 'message', byteLength: 64, port: {} });
    expect(!noPort.ok && noPort.error.code).toBe(PipeMismatchError.code);
  });

  it('message attach: one reader per endpoint, timeout and abort while syncing', async () => {
    const region = createRegion({ medium: 'message', byteLength: 64 });
    if (!region.ok) throw new Error('region');
    const endpoint = region.value.endpoint();
    if (!endpoint.ok) throw new Error('endpoint');
    expect((await attachRegion(endpoint.value)).ok).toBe(true);
    const twice = await attachRegion(endpoint.value);
    expect(!twice.ok && twice.error.code).toBe(PipeEndpointTakenError.code);

    const silent = new MessageChannel(); // nobody answers the hello
    const timedOut = await attachRegion({ sf: 'region', medium: 'message', byteLength: 64, port: silent.port1 }, { timeoutMs: 10 });
    expect(!timedOut.ok && timedOut.error.code).toBe(PipeClosedError.code);
    const controller = new AbortController();
    const other = new MessageChannel();
    const pending = attachRegion({ sf: 'region', medium: 'message', byteLength: 64, port: other.port1 }, { signal: controller.signal });
    controller.abort();
    const aborted = await pending;
    expect(!aborted.ok && aborted.error.kind).toBe('aborted');
    silent.port2.close();
    other.port2.close();
    region.value.close();
  });

  it('local medium: remote notifications, independent reader close, owner close ends everyone', async () => {
    const owner = createRegion({ medium: 'local', byteLength: 64 });
    if (!owner.ok) throw new Error('region');
    const endpoint = owner.value.endpoint();
    if (!endpoint.ok) throw new Error('endpoint');
    const reader = await attachRegion(endpoint.value);
    const second = await attachRegion(endpoint.value);
    if (!reader.ok || !second.ok) throw new Error('attach');
    let remote = 0;
    reader.value.onRemote(() => {
      remote += 1;
    });
    let own = 0;
    owner.value.onRemote(() => {
      own += 1;
    });
    owner.value.words[4] = 9;
    owner.value.publish([4]);
    await tick();
    expect([remote, own]).toEqual([1, 0]); // a side is not notified of its own publishes
    expect(reader.value.waitSync(4, 9, 0)).toBe('unsupported'); // blocking waits need shared memory
    second.value.close();
    expect(second.value.closed).toBe(true);
    expect(owner.value.closed).toBe(false);
    let closed = false;
    reader.value.onClose(() => {
      closed = true;
    });
    owner.value.close();
    expect(closed && reader.value.closed).toBe(true);
    const waited = await reader.value.wait(4, 9);
    expect(!waited.ok && waited.error.code).toBe(PipeClosedError.code);
  });

  it('shared medium: blocking waits time out or return when the word changed', async () => {
    const owner = createRegion({ medium: 'shared', byteLength: 64 });
    if (!owner.ok) throw new Error('region');
    expect(owner.value.waitSync(2, 0, 1)).toBe('timed-out'); // Node allows Atomics.wait on the main thread
    Atomics.store(owner.value.words, 2, 5);
    expect(owner.value.waitSync(2, 0, 1)).toBe('ok');
    const waited = await owner.value.wait(3, 0, { timeoutMs: 5 });
    expect(waited.ok && waited.value).toBe(false);
    owner.value.close();
    const closed = await owner.value.wait(3, 0);
    expect(!closed.ok && closed.error.code).toBe(PipeClosedError.code);
  });

  it('message medium: the reader mirror syncs, then follows publishes in order', async () => {
    const owner = createRegion({ medium: 'message', byteLength: 64 });
    if (!owner.ok) throw new Error('region');
    owner.value.bytes.set([1, 2, 3], 32);
    owner.value.words[1] = 77;
    const endpoint = owner.value.endpoint();
    if (!endpoint.ok) throw new Error('endpoint');
    const reader = await attachRegion(endpoint.value);
    if (!reader.ok) throw new Error('attach');
    expect([...reader.value.bytes.subarray(32, 35)]).toEqual([1, 2, 3]);
    expect(reader.value.words[1]).toBe(77); // initial sync carries unpublished state
    owner.value.bytes.set([7], 40);
    owner.value.words[2] = 1;
    owner.value.publish([2], [[40, 41]]);
    expect(await reader.value.wait(2, 0, { timeoutMs: 1000 })).toEqual({ ok: true, value: true });
    expect(reader.value.bytes[40]).toBe(7);
    reader.value.words[3] = 5; // reader-owned word flows back
    reader.value.publish([3]);
    expect(await owner.value.wait(3, 0, { timeoutMs: 1000 })).toEqual({ ok: true, value: true });
    owner.value.close();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(reader.value.closed).toBe(true);
  });
});

const Probe = defineLayout({ name: 'Probe', fields: { a: 'i32', b: 'i32', c: 'i32', d: 'i32' } });

describe('seqlock cells', () => {
  it('defines cells from layouts or bytes and validates sizes', () => {
    const cell = defineCell({ id: 'test/probe', layout: Probe, checksum: true });
    expect(cell).toMatchObject({ kind: 'cell', bytes: 16, version: 1, checksum: true });
    expect(cellByteLength(cell)).toBe(CELL_HEADER_BYTES + 16);
    expect(cellByteLength(defineCell({ id: 'test/raw', bytes: 5 }))).toBe(CELL_HEADER_BYTES + 8);
    expect(() => defineCell({ id: 'test/empty', bytes: 0 })).toThrow(/bytes > 0/);
  });

  it('detects torn reads without the seqlock (S2 seqlock=0) and never returns one with it', async () => {
    const Cell = defineCell({ id: 'test/probe', layout: Probe, checksum: true });
    const writer = createCell(Cell, { medium: 'local' });
    if (!writer.ok) throw new Error('cell');
    const endpoint = writer.value.endpoint();
    if (!endpoint.ok) throw new Error('endpoint');
    const unsafe = await attachCell(Cell, endpoint.value, { seqlock: false });
    const safe = await attachCell(Cell, endpoint.value, { maxRetries: 3 });
    if (!unsafe.ok || !safe.ok) throw new Error('attach');
    const fill = (n: number) => (slot: { record: { a: number; b: number; c: number; d: number } }) => {
      slot.record.a = n;
      slot.record.b = n;
    };
    writer.value.write(fill(1));
    writer.value.write(({ record }) => {
      record.c = 1;
      record.d = 1;
    });
    expect(safe.value.read()?.record.a).toBe(1);
    let torn: boolean | undefined;
    let stale: { stale: boolean; a: number } | undefined;
    writer.value.write(({ record }) => {
      record.a = 2; // half written: b, c, d still 1
      torn = unsafe.value.read()?.torn;
      const snapshot = safe.value.read();
      stale = snapshot === undefined ? undefined : { stale: snapshot.stale, a: snapshot.record.a };
      record.b = 2;
    });
    expect(torn).toBe(true);
    expect(unsafe.value.stats.torn).toBe(1);
    expect(stale).toEqual({ stale: true, a: 1 }); // the writer is mid-write: last good copy
    expect(safe.value.stats).toMatchObject({ torn: 0, contended: 1 });
    expect(safe.value.stats.retries).toBeGreaterThan(0);
    const after = safe.value.read();
    expect({ a: after?.record.a, b: after?.record.b, stale: after?.stale }).toEqual({ a: 2, b: 2, stale: false });
    writer.value.close();
  });

  it('blocking waits on the shared medium', async () => {
    const Cell = defineCell({ id: 'test/probe', layout: Probe });
    const writer = createCell(Cell, { medium: 'shared' });
    if (!writer.ok) throw new Error('cell');
    const endpoint = writer.value.endpoint();
    if (!endpoint.ok) throw new Error('endpoint');
    const reader = await attachCell(Cell, endpoint.value);
    if (!reader.ok) throw new Error('attach');
    expect(reader.value.waitSync(1)).toBe('timed-out');
    writer.value.write(() => undefined);
    expect(reader.value.waitSync(1)).toBe('ok');
    reader.value.close();
    expect(reader.value.closed).toBe(true);
    writer.value.close();
  });

  it('checkPipeHeader compares magic, format, id and schema version', () => {
    const region = createRegion({ medium: 'local', byteLength: 32 });
    if (!region.ok) throw new Error('region');
    const words = { magic: 0, format: 1, schema: 2, id: 3 };
    const expected = { id: 'test/pipe' as const, magic: 77, format: 1, schema: 4 };
    region.value.words.set([77, 1, 4, fnv1aString('test/pipe')]);
    expect(checkPipeHeader(region.value, expected, words).ok).toBe(true);
    region.value.words[2] = 5;
    const version = checkPipeHeader(region.value, expected, words);
    expect(!version.ok && version.error.details).toMatchObject({ expectedVersion: 4, version: 5 });
    region.value.words[2] = 4;
    region.value.words[3] = fnv1aString('test/other');
    expect(checkPipeHeader(region.value, expected, words).ok).toBe(false);
    region.value.words[0] = 1;
    const magic = checkPipeHeader(region.value, expected, words);
    expect(!magic.ok && magic.error.code).toBe(PipeMismatchError.code);
  });

  it('a throwing fill still leaves the sequence even (readers never spin forever)', async () => {
    const Cell = defineCell({ id: 'test/probe', layout: Probe });
    const writer = createCell(Cell, { medium: 'local' });
    if (!writer.ok) throw new Error('cell');
    expect(() =>
      writer.value.write(() => {
        throw new Error('bug');
      }),
    ).toThrow('bug');
    expect(writer.value.generation).toBe(1);
  });
});

describe('clock cell', () => {
  it('extrapolates only while playing', () => {
    const base = { position: 10, rate: 1, anchor: 1_000, epoch: 0 } as const;
    expect(extrapolateClock({ ...base, state: 'playing' }, 3_000)).toBe(12);
    expect(extrapolateClock({ ...base, state: 'playing', rate: -0.5 }, 3_000)).toBe(9);
    expect(extrapolateClock({ ...base, state: 'paused' }, 3_000)).toBe(10);
    expect(extrapolateClock({ ...base, state: 'seeking' }, 3_000)).toBe(10);
    expect(CLOCK_STATES).toEqual(['stopped', 'playing', 'paused', 'seeking']);
  });

  it('declares a checksummed cell over the shared ClockCell layout (Wasm/AudioWorklet readers)', () => {
    const clock = defineClockCell({ id: 'test/playhead' });
    expect(clock).toMatchObject({ kind: 'cell', checksum: true, bytes: ClockCellLayout.stride });
    expect(ClockCellLayout.source('rust')).toContain('pub position: f64');
  });
});

const Sample = defineLayout({ name: 'Sample', fields: { value: 'u32' } });

describe('record rings', () => {
  it('validates declarations and computes sizes', () => {
    expect(() => defineRecordRing({ id: 'test/r', layout: Sample, capacity: 12 })).toThrow(/power of two/);
    expect(() => defineRecordRing({ id: 'test/r', layout: Sample, capacity: 1 << 21 })).toThrow(/power of two/);
    expect(() => defineRecordRing({ id: 'test/r', layout: Sample, readers: 0 })).toThrow(/readers/);
    expect(() => defineRecordRing({ id: 'test/r', layout: Sample, readers: MAX_RING_READERS + 1 })).toThrow(/readers/);
    const ring = defineRecordRing({ id: 'test/r', layout: Sample, capacity: 16, readers: 3 });
    expect(recordRingHeaderBytes(ring)).toBe(96); // (16 + 2 × 3) words → 88 bytes → 96 (16-aligned)
    expect(recordRingByteLength(ring)).toBe(96 + 64);
  });

  it('drains with a limit and commits what a throwing consumer already took', async () => {
    const Ring = defineRecordRing({ id: 'test/r', layout: Sample, capacity: 16 });
    const writer = createRecordRing(Ring, { medium: 'shared' });
    if (!writer.ok) throw new Error('ring');
    const endpoint = writer.value.endpoint(0);
    if (!endpoint.ok) throw new Error('endpoint');
    const reader = await attachRecordRing(Ring, endpoint.value);
    if (!reader.ok) throw new Error('attach');
    expect(reader.value.waitSync(1)).toBe('timed-out');
    for (let i = 0; i < 6; i++) writer.value.push((r) => void (r.value = i));
    expect(reader.value.waitSync(1)).toBe('ok');
    const seen: number[] = [];
    expect(reader.value.drain((r) => void seen.push(r.value), 2)).toBe(2);
    expect(() =>
      reader.value.drain((r) => {
        if (r.value === 3) throw new Error('consumer bug');
        seen.push(r.value);
      }),
    ).toThrow('consumer bug');
    expect(seen).toEqual([0, 1, 2]);
    expect(reader.value.available).toBe(3); // record 3 is still unread
    writer.value.close();
    expect(reader.value.closed).toBe(true);
    const push = writer.value.push(() => undefined);
    expect(!push.ok && push.error.code).toBe(PipeClosedError.code);
  });

  it('refuses endpoints of the wrong size or without a reader index', async () => {
    const Ring = defineRecordRing({ id: 'test/r', layout: Sample, capacity: 16 });
    const Bigger = defineRecordRing({ id: 'test/r', layout: Sample, capacity: 32 });
    const writer = createRecordRing(Ring, { medium: 'local' });
    if (!writer.ok) throw new Error('ring');
    const endpoint = writer.value.endpoint(0);
    if (!endpoint.ok) throw new Error('endpoint');
    const wrongSize = await attachRecordRing(Bigger, endpoint.value);
    expect(!wrongSize.ok && wrongSize.error.code).toBe(PipeMismatchError.code);
    const { reader: _reader, ...withoutIndex } = endpoint.value as typeof endpoint.value & { reader: number };
    const noIndex = await attachRecordRing(Ring, withoutIndex);
    expect(!noIndex.ok && noIndex.error.code).toBe(PipeMismatchError.code);
  });
});

describe('delta streams', () => {
  it('validates declarations and computes sizes', () => {
    expect(() => defineDeltaStream({ id: 'test/d', capacityBytes: 1000 })).toThrow(/power of two/);
    expect(() => defineDeltaStream({ id: 'test/d', capacityBytes: 128 })).toThrow(/power of two/);
    const stream = defineDeltaStream({ id: 'test/d', capacityBytes: 1024, version: 3 });
    expect(stream).toMatchObject({ kind: 'delta-stream', capacityBytes: 1024, version: 3 });
    expect(deltaStreamByteLength(stream)).toBe(DELTA_HEADER_BYTES + 1024);
  });

  it('lifecycle table mirrors docs/LIFECYCLES.md', () => {
    expect(DeltaReaderLifecycle.transitions).toEqual({
      'awaiting-snapshot': { snapshot: 'live', close: 'closed' },
      live: { snapshot: 'live', gap: 'resyncing', close: 'closed' },
      resyncing: { snapshot: 'live', gap: 'resyncing', close: 'closed' },
    });
  });

  it('peek, refs and flags round-trip; bad digests are refused', async () => {
    const Stream = defineDeltaStream({ id: 'test/d', capacityBytes: 1024 });
    const writer = createDeltaStream(Stream, { medium: 'local' });
    if (!writer.ok) throw new Error('stream');
    const endpoint = writer.value.endpoint();
    if (!endpoint.ok) throw new Error('endpoint');
    const reader = await attachDeltaStream(Stream, endpoint.value);
    if (!reader.ok) throw new Error('attach');
    expect(reader.value.peek()).toBeUndefined();
    writer.value.snapshot({ version: 1, flags: 3, refs: ['abc', 'd'.repeat(64)] });
    expect(reader.value.peek()).toEqual({ kind: 'snapshot', epoch: 1, version: 1, base: Number.NaN, flags: 3 });
    const seen: { refs: readonly string[]; flags: number }[] = [];
    reader.value.apply((r) => void seen.push({ refs: r.refs, flags: r.flags }));
    expect(seen).toEqual([{ refs: ['abc', 'd'.repeat(64)], flags: 3 }]);
    const bad = writer.value.append({ version: 2, refs: ['has space'] });
    expect(!bad.ok && bad.error.code).toBe(RecordTooLargeError.code);
    writer.value.close();
    expect(reader.value.closed).toBe(true);
    const closed = writer.value.append({ version: 3 });
    expect(!closed.ok && closed.error.code).toBe(PipeClosedError.code);
  });

  it('a throwing handler leaves its record unconsumed', async () => {
    const Stream = defineDeltaStream({ id: 'test/d', capacityBytes: 1024 });
    const writer = createDeltaStream(Stream, { medium: 'local' });
    if (!writer.ok) throw new Error('stream');
    const endpoint = writer.value.endpoint();
    if (!endpoint.ok) throw new Error('endpoint');
    const reader = await attachDeltaStream(Stream, endpoint.value);
    if (!reader.ok) throw new Error('attach');
    writer.value.snapshot({ version: 0 });
    writer.value.append({ version: 1 });
    expect(() =>
      reader.value.apply((r) => {
        if (r.kind === 'delta') throw new Error('handler bug');
      }),
    ).toThrow('handler bug');
    expect(reader.value.version).toBe(0);
    expect(reader.value.peek()?.version).toBe(1);
  });

  it('resnapshot listeners run after append returns (no re-entrant version clash)', async () => {
    const Stream = defineDeltaStream({ id: 'test/d', capacityBytes: 1024 });
    const writer = createDeltaStream(Stream, { medium: 'local', maxPendingBytes: 64 });
    if (!writer.ok) throw new Error('stream');
    const endpoint = writer.value.endpoint();
    if (!endpoint.ok) throw new Error('endpoint');
    const reader = await attachDeltaStream(Stream, endpoint.value);
    if (!reader.ok) throw new Error('attach');
    let version = 0;
    const reasons: string[] = [];
    // The app snapshots inline from the listener, with a version that already includes the delta being appended.
    writer.value.onResnapshot((reason) => {
      reasons.push(reason);
      expect(writer.value.snapshot({ version }).ok).toBe(true);
    });
    writer.value.snapshot({ version });
    reader.value.requestResnapshot(); // seen by the writer during the next append
    version += 1;
    expect(writer.value.append({ version }).ok).toBe(true);
    expect(reasons).toEqual(['reader']);
    expect(writer.value.epoch).toBe(2);
    // Overflow: the inline snapshot from the listener must clear the debt.
    for (let i = 0; i < 40; i++) {
      version += 1; // 56-byte records: ~18 fit in the ring, then the 64-byte queue overflows
      writer.value.append({ version, payload: new Uint8Array(24) });
    }
    expect(reasons).toContain('overflow');
    expect(writer.value.resnapshotRequested).toBe(false);
    version += 1;
    expect(writer.value.append({ version })).toEqual({ ok: true, value: 'queued' }); // deltas flow again after the snapshot
  });

  it('requestResnapshot while live ignores snapshots of the current epoch', async () => {
    const Stream = defineDeltaStream({ id: 'test/d', capacityBytes: 1024 });
    const writer = createDeltaStream(Stream, { medium: 'local' });
    if (!writer.ok) throw new Error('stream');
    const endpoint = writer.value.endpoint();
    if (!endpoint.ok) throw new Error('endpoint');
    const reader = await attachDeltaStream(Stream, endpoint.value);
    if (!reader.ok) throw new Error('attach');
    writer.value.snapshot({ version: 0 });
    reader.value.apply(() => undefined);
    let asked = 0;
    writer.value.onResnapshot(() => {
      asked += 1;
    });
    reader.value.requestResnapshot();
    await tick();
    expect(asked).toBe(1);
    expect(writer.value.resnapshotRequested).toBe(true);
    writer.value.snapshot({ version: 0 });
    expect(writer.value.resnapshotRequested).toBe(false);
    reader.value.apply(() => undefined);
    expect({ epoch: reader.value.epoch, snapshots: reader.value.stats.snapshots }).toEqual({ epoch: 2, snapshots: 2 });
    reader.value.close();
    expect(reader.value.state).toBe('closed');
  });
});
