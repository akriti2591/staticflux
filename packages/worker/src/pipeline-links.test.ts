import { AbortedError, createMemorySink, createTelemetry, err, ok, type Result } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { createJsonSource, createLink, createPortPair, createPublisher, createReplica, defineReplica, type Link } from './index.js';
import {
  acceptPeer,
  BlobChannelMetrics,
  classifyHandle,
  createBlobReceiver,
  createBlobSender,
  createHandleChannel,
  createHandleLedger,
  createMemoryWindowedSource,
  createOptimisticIntents,
  createPeerBroker,
  createPeerPair,
  createWindowedPublisher,
  createWindowedReplica,
  defineBlobChannel,
  defineHandleChannel,
  definePeer,
  defineWindowedReplica,
  followReplica,
  HANDLE_KINDS,
  HandleMetrics,
  HandleReleasedError,
  isCloseableKind,
  linkHost,
  memoryWire,
  messageChannelWire,
  type OverlayChange,
  PeerChannelLifecycle,
  PeerChannels,
  PipeClosedError,
  replicaSender,
  type SupervisedWorkerLike,
  workerHost,
} from './pipeline.js';

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const settle = async (n = 5): Promise<void> => {
  for (let i = 0; i < n; i++) await tick();
};

function links(): { a: Link; b: Link; close(): void } {
  const pair = createPortPair({ clone: false });
  return { a: createLink({ port: pair.a, name: 'a' }), b: createLink({ port: pair.b, name: 'b' }), close: () => pair.close() };
}

// Duck-typed handle fakes (see testkit createFakeHandle).
const fakeFrame = () => ({ closed: false, codedWidth: 2, codedHeight: 2, timestamp: 0, close() { this.closed = true; }, clone() { return fakeFrame(); } });
const fakeBitmap = () => ({ closed: false, width: 1, height: 1, close() { this.closed = true; } });

describe('blob side channel', () => {
  it('records telemetry and stops after close', async () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'debug' });
    telemetry.addSink(sink);
    const { a, b, close } = links();
    const Blobs = defineBlobChannel('test/blobs');
    expect(Blobs).toEqual({ kind: 'blob-channel', id: 'test/blobs' });
    const receiver = createBlobReceiver(b, Blobs, { telemetry, budgetBytes: 2 });
    const sender = createBlobSender(a, Blobs, { telemetry, digest: (bytes) => `len-${bytes.byteLength}` });
    expect(sender.put(new Uint8Array([1, 2])).ok).toBe(true);
    sender.put(new Uint8Array([3, 4]));
    expect(sender.put(new Uint8Array([5])).ok && sender.has('len-1')).toBe(true);
    await settle();
    const metrics = sink.records.filter((r) => r.type === 'metric').map((r) => (r as { metric: string }).metric);
    expect(metrics).toContain(BlobChannelMetrics.sentBytes.id);
    expect(metrics).toContain(BlobChannelMetrics.deduped.id);
    expect(metrics).toContain(BlobChannelMetrics.evicted.id);
    expect(receiver.stats).toMatchObject({ count: 1, bytes: 1 });
    sender.close();
    const closed = sender.put(new Uint8Array([9]));
    expect(!closed.ok && closed.error.code).toBe(PipeClosedError.code);
    const waiting = receiver.waitFor(['never']);
    receiver.close();
    const outcome = await waiting;
    expect(!outcome.ok && outcome.error.code).toBe(PipeClosedError.code);
    close();
  });

  it('clear() drops everything and tells the sender to start over', async () => {
    const { a, b, close } = links();
    const Blobs = defineBlobChannel('test/blobs');
    const receiver = createBlobReceiver(b, Blobs);
    const sender = createBlobSender(a, Blobs);
    const digest = sender.put(new Uint8Array([1]));
    await settle();
    expect(digest.ok && receiver.get(digest.value)?.[0]).toBe(1);
    receiver.clear();
    await settle();
    expect(receiver.stats.count).toBe(0);
    expect(digest.ok && sender.has(digest.value)).toBe(false);
    close();
  });
});

describe('handle ledger and channel', () => {
  it('classifies handle kinds by platform class or shape', () => {
    expect(classifyHandle(fakeFrame())).toBe('video-frame');
    expect(classifyHandle({ close() {}, numberOfFrames: 1, sampleRate: 48_000 })).toBe('audio-data');
    expect(classifyHandle(fakeBitmap())).toBe('image-bitmap');
    expect(classifyHandle({ getContext() {}, transferToImageBitmap() {}, width: 1, height: 1 })).toBe('offscreen-canvas');
    expect(classifyHandle({ kind: 'file', name: 'a.iflow', isSameEntry() {} })).toBe('file-system-handle');
    expect(classifyHandle({ width: 1 })).toBeUndefined();
    expect(classifyHandle(42)).toBeUndefined();
    class VideoFrame {
      close(): void {}
    }
    const original = (globalThis as Record<string, unknown>)['VideoFrame'];
    (globalThis as Record<string, unknown>)['VideoFrame'] = VideoFrame;
    try {
      expect(classifyHandle(new VideoFrame())).toBe('video-frame');
    } finally {
      (globalThis as Record<string, unknown>)['VideoFrame'] = original;
    }
    expect(HANDLE_KINDS.filter(isCloseableKind)).toEqual(['video-frame', 'audio-data', 'image-bitmap']);
  });

  it('own(): explicit kinds must match; release() hands over; dispose closes', () => {
    const ledger = createHandleLedger({ finalization: () => undefined });
    expect(ledger.own(fakeBitmap(), 'video-frame').ok).toBe(false);
    const frame = fakeFrame();
    const owned = ledger.own(frame);
    if (!owned.ok) throw new Error('own');
    expect(owned.value.release()).toBe(frame);
    expect(owned.value.released && !frame.closed).toBe(true);
    expect(() => owned.value.release()).toThrow(expect.objectContaining({ code: HandleReleasedError.code }));
    const bitmap = fakeBitmap();
    const second = ledger.own(bitmap);
    if (!second.ok) throw new Error('own');
    second.value[Symbol.dispose]();
    expect(bitmap.closed && second.value.closed).toBe(true);
    second.value.close(); // idempotent
    expect(ledger.totals).toMatchObject({ owned: 2, released: 1, closed: 1 });
    expect(ledger.inspect().live['image-bitmap']).toBe(0);
  });

  it('dev guards off: values stay readable after release (measured production hot paths)', () => {
    const ledger = createHandleLedger({ devGuards: false, finalization: () => undefined });
    const owned = ledger.own(fakeFrame());
    if (!owned.ok) throw new Error('own');
    owned.value.release();
    expect(() => owned.value.value).not.toThrow();
  });

  it('a collected wrapper is a leak: the handle is closed and reported', () => {
    let collect: ((held: unknown) => void) | undefined;
    const held: unknown[] = [];
    const leaks: string[] = [];
    const ledger = createHandleLedger({
      finalization: (onCollected) => {
        collect = onCollected;
        return { register: (_target, value) => void held.push(value), unregister: () => undefined };
      },
      onLeak: (error) => leaks.push(error.code),
    });
    const frame = fakeFrame();
    expect(ledger.own(frame).ok).toBe(true);
    expect(ledger.own({ kind: 'directory', name: 'w', isSameEntry() {} }).ok).toBe(true); // not closeable: not registered
    expect(held).toHaveLength(1);
    collect?.(held[0]);
    expect(frame.closed).toBe(true);
    expect(leaks).toEqual(['SF-WK-038']);
    expect(ledger.totals.leaked).toBe(1);
    expect(ledger.live['video-frame']).toBe(0);
    collect?.(held[0]); // a second notification for the same entry is ignored
    expect(ledger.totals.leaked).toBe(1);
  });

  it('reports pressure above per-kind limits and the live gauge', () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'debug' });
    telemetry.addSink(sink);
    const ledger = createHandleLedger({ telemetry, limits: { 'video-frame': 1 }, finalization: () => undefined });
    ledger.own(fakeFrame());
    ledger.own(fakeFrame());
    const names = sink.records.map((r) => ('name' in r ? r.name : (r as { metric: string }).metric));
    expect(names).toContain('worker.handle-pressure');
    expect(names).toContain(HandleMetrics.live.id);
    ledger.dispose();
  });

  it('a closed channel refuses sends and stops delivering', async () => {
    const { a, b, close } = links();
    const Frames = defineHandleChannel<null>({ id: 'test/frames', kinds: ['video-frame'], guard: (m): m is null => m === null });
    const ledger = createHandleLedger({ finalization: () => undefined });
    const sender = createHandleChannel(a, Frames, { ledger });
    const receiver = createHandleChannel(b, Frames, { ledger: createHandleLedger({ finalization: () => undefined }) });
    let got = 0;
    const off = receiver.on(() => {
      got += 1;
    });
    const owned = ledger.own(fakeFrame());
    if (!owned.ok) throw new Error('own');
    expect(sender.send('bad meta' as unknown as null, [owned.value]).ok).toBe(true);
    await settle();
    expect(receiver.stats.rejected).toBe(1); // guard failed
    off();
    receiver.close();
    sender.close();
    const again = ledger.own(fakeFrame());
    if (!again.ok) throw new Error('own');
    expect(sender.send(null, [again.value]).ok).toBe(false);
    expect(got).toBe(0);
    expect(() => createHandleChannel(a, Frames, { ledger: {} as never })).toThrow(/createHandleLedger/);
    close();
  });
});

describe('peer channels and broker', () => {
  const Peer = definePeer('test/peer');

  it('definitions, wires and the lifecycle table', () => {
    expect(Peer).toEqual({ kind: 'peer', id: 'test/peer' });
    expect(PeerChannelLifecycle.transitions.connected).toEqual({ connect: 'connected', disconnect: 'disconnected', close: 'closed' });
    const memory = memoryWire().create();
    expect(memoryWire().transfer(memory.a)).toEqual([]);
    const channel = messageChannelWire.create();
    expect(messageChannelWire.transfer(channel.a)).toEqual([channel.a]);
    (channel.a as MessagePort).close();
    (channel.b as MessagePort).close();
  });

  it('linkHost reports the link until it closes', () => {
    const { a, close } = links();
    const host = linkHost(a);
    const seen: (Link | undefined)[] = [];
    host.onLink((link) => seen.push(link));
    expect(host.id).toBe('a');
    expect(host.link).toBe(a);
    close();
    expect(host.link).toBeUndefined();
    expect(seen).toEqual([undefined]);
  });

  it('workerHost follows a supervised worker through crash and respawn', () => {
    const listeners = new Set<(r: { to: string }) => void>();
    const first = links();
    const second = links();
    const worker: SupervisedWorkerLike & { state: string; link: Link | undefined } = {
      id: 'test/render',
      state: 'ready',
      link: first.a,
      onStateChange(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const go = (state: string, link: Link | undefined): void => {
      worker.state = state;
      worker.link = link;
      for (const l of listeners) l({ to: state });
    };
    const host = workerHost(worker);
    const seen: (string | undefined)[] = [];
    host.onLink((link) => seen.push(link?.name));
    go('busy', first.a); // same link: no event
    go('crashed', first.a);
    go('respawning', undefined);
    go('handshaking', second.a);
    go('ready', second.a);
    expect(seen).toEqual([undefined, 'a']);
    expect(host.link).toBe(second.a);
    first.close();
    second.close();
  });

  it('broker: duplicate announcements do not re-wire, a new session does, dispose sends down', async () => {
    const toA = links();
    const toB = links();
    const broker = createPeerBroker({ wire: memoryWire() });
    const connection = broker.connect(Peer, linkHost(toA.a), linkHost(toB.a));
    expect(connection.rewire()).toBe(false); // nobody announced yet
    const a = acceptPeer(toA.b, Peer);
    const b = acceptPeer(toB.b, Peer);
    await settle();
    expect(connection.connected && connection.generation === a.generation && a.generation === b.generation).toBe(true);
    const wirings = connection.wirings;
    toA.b.send(PeerChannels.ready, { peer: 'test/other', session: 'x' }); // another peer's announcement
    await settle();
    expect(connection.wirings).toBe(wirings);
    b.close();
    const b2 = acceptPeer(toB.b, Peer); // a new PeerChannel instance on the same link
    await settle();
    expect(connection.wirings).toBe(wirings + 1);
    expect(b2.generation).toBe(connection.generation);
    expect(broker.connections).toEqual([connection]);
    broker.dispose();
    await settle();
    expect(a.state).toBe('disconnected');
    expect(broker.connections).toEqual([]);
    toA.close();
    toB.close();
  });

  it('acceptPeer ignores stale generations and offers for other peers', async () => {
    const { a: main, b: worker, close } = links();
    const peer = acceptPeer(worker, Peer);
    const pair = createPortPair({ clone: false });
    main.send(PeerChannels.offer, { peer: 'test/other', generation: 1, side: 'a', port: pair.a });
    await settle();
    expect(peer.state).toBe('waiting');
    main.send(PeerChannels.offer, { peer: 'test/peer', generation: 2, side: 'a', port: pair.a });
    await settle();
    expect(peer.generation).toBe(2);
    const stale = createPortPair({ clone: false });
    main.send(PeerChannels.offer, { peer: 'test/peer', generation: 1, side: 'a', port: stale.a });
    await settle();
    expect(peer.generation).toBe(2);
    expect(stale.a.closed).toBe(true); // a stale offer's port is closed
    main.send(PeerChannels.down, { peer: 'test/peer', generation: 1 }); // stale down: ignored
    await settle();
    expect(peer.state).toBe('connected');
    close(); // the link to main goes away: the peer disconnects
    expect(peer.state).toBe('disconnected');
    pair.close();
  });

  it('createPeerPair can structured-clone like a real channel', async () => {
    const pair = createPeerPair(Peer, { clone: true });
    const got: unknown[] = [];
    pair.b.on('test/ping', (payload) => got.push(payload));
    const payload = { nested: [1, 2] };
    pair.a.send('test/ping', payload);
    await settle();
    expect(got).toEqual([payload]);
    expect(got[0]).not.toBe(payload);
    const aborted = new AbortController();
    pair.disconnect();
    const waiting = pair.a.whenConnected(aborted.signal);
    aborted.abort();
    expect((await waiting).ok).toBe(false);
    pair.close();
  });
});

describe('optimistic intents (supersede-on-ack)', () => {
  const ack = (version: number) => async (): Promise<Result<{ version: number; value: string }>> => ok({ version, value: `v${version}` });

  it('keeps the overlay until the acked version is applied, then removes it in that step (E-2)', async () => {
    const intents = createOptimisticIntents<{ dx: number }>();
    const changes: OverlayChange[] = [];
    intents.subscribe((c) => changes.push(c));
    intents.stage('g1', { dx: 1 });
    intents.stage('g1', { dx: 5 }); // ephemeral edit of the same gesture
    expect([...intents.overlays]).toEqual([['g1', { dx: 5 }]]);
    const result = await intents.commit('g1', { dx: 5 }, ack(4));
    expect(result).toEqual(ok('v4'));
    expect(intents.entries()).toEqual([{ key: 'g1', overlay: { dx: 5 }, phase: 'acked', ackVersion: 4 }]);
    expect(intents.advance(3)).toEqual([]); // the frame still shows v3: keep the overlay
    expect(intents.overlays.has('g1')).toBe(true);
    expect(intents.advance(4)).toEqual(['g1']); // the frame applying v4 drops it
    expect(intents.overlays.size).toBe(0);
    expect(changes.map((c) => c.reason)).toEqual(['staged', 'staged', 'committed', 'superseded-by-ack']);
  });

  it('a late ack of an older intent never removes a newer overlay on the same key', async () => {
    const intents = createOptimisticIntents<string>();
    let releaseOld: (() => void) | undefined;
    const old = intents.commit('node-1', 'old', () => new Promise((resolve) => (releaseOld = () => resolve(ok({ version: 2 })))));
    const newer = intents.commit('node-1', 'new', ack(3));
    await newer;
    releaseOld?.();
    await old;
    intents.advance(2);
    expect(intents.overlays.get('node-1')).toBe('new');
    intents.advance(3);
    expect(intents.overlays.size).toBe(0);
  });

  it('rejections and cancels drop the overlay; cancel aborts the in-flight send', async () => {
    const intents = createOptimisticIntents<string>();
    const rejected = await intents.commit('k', 'x', async () => err(PipeClosedError()));
    expect(!rejected.ok && intents.overlays.size).toBe(0);
    let signal: AbortSignal | undefined;
    const pending = intents.commit('k', 'y', (s) => {
      signal = s;
      return new Promise((resolve) => s.addEventListener('abort', () => resolve(err(AbortedError()))));
    });
    expect(intents.pending).toBe(1);
    expect(intents.cancel('k')).toBe(true);
    expect(signal?.aborted).toBe(true);
    await pending;
    expect(intents.cancel('k')).toBe(false);
    const external = new AbortController();
    external.abort();
    const early = await intents.commit('k', 'z', ack(1), { signal: external.signal });
    expect(!early.ok && early.error.kind).toBe('aborted');
  });

  it('an ack at or below the applied version supersedes immediately; reset keeps staged gestures', async () => {
    const intents = createOptimisticIntents<string>({ version: 10 });
    await intents.commit('a', 'x', ack(9));
    expect(intents.overlays.size).toBe(0);
    intents.stage('drag', 'in progress');
    void intents.commit('b', 'y', () => new Promise(() => undefined));
    intents.reset(0, { keepStaged: true });
    expect([...intents.overlays.keys()]).toEqual(['drag']);
    expect(intents.version).toBe(0);
    intents.reset();
    expect(intents.overlays.size).toBe(0);
    intents.dispose();
    const after = await intents.commit('c', 'z', ack(1));
    expect(after.ok).toBe(false);
    intents.stage('ignored', 'x');
    expect(intents.overlays.size).toBe(0);
  });

  it('replicaSender + followReplica: the overlay goes away when the intent resolves', async () => {
    const Doc = defineReplica('test/doc').type<{ x: number }, { move: { args: number; result: number } }>();
    const source = createJsonSource({ x: 0 }, {
      move: (dx, api) => {
        const next = api.state.x + (dx as number);
        const applied = api.apply([{ op: 'replace', path: ['x'], value: next }]);
        return applied.ok ? ok(next) : applied;
      },
    });
    const publisher = createPublisher({ definition: Doc, source });
    const { a, b, close } = links();
    publisher.attach(a);
    const replica = createReplica(Doc);
    expect((await replica.attach(b)).ok).toBe(true);
    const intents = createOptimisticIntents<number>();
    const stop = followReplica(intents, replica);
    const result = await intents.commit('drag', 5, replicaSender(replica, 'move', 5));
    expect(result).toEqual(ok(5));
    expect(replica.state.x).toBe(5);
    expect(intents.overlays.size).toBe(0);
    stop();
    publisher.dispose();
    close();
  });
});

describe('windowed replicas', () => {
  const Visible = defineWindowedReplica('test/visible').type<{ x: number }, { min: number; max: number }>();
  const inside = (w: { min: number; max: number }, _k: string, e: { x: number }): boolean => e.x >= w.min && e.x <= w.max;

  it('definition and the memory source', () => {
    expect(Visible).toMatchObject({ kind: 'windowed-replica', id: 'test/visible', channel: 'sf/windowed/test/visible' });
    const source = createMemoryWindowedSource(inside, [['a', { x: 1 }]]);
    const batches: number[] = [];
    source.onChanges((changes) => batches.push(changes.length));
    source.batch([
      { key: 'b', entity: { x: 2 } },
      { key: 'a', entity: undefined },
    ]);
    expect(source.size).toBe(1);
    expect(source.get('b')).toEqual({ x: 2 });
    expect(source.delete('missing')).toBe(false);
    expect([...source.query({ min: 0, max: 5 })]).toEqual([['b', { x: 2 }]]);
    expect(batches).toEqual([2]);
  });

  it('a gap (lost delta) makes the replica re-request its window and reset', async () => {
    const source = createMemoryWindowedSource(inside, [['a', { x: 1 }]]);
    const publisher = createWindowedPublisher({ definition: Visible, source });
    const { a, b, close } = links();
    publisher.attach(a);
    const replica = createWindowedReplica(Visible);
    await replica.attach(b);
    await replica.setWindow({ min: 0, max: 10 });
    const resets: boolean[] = [];
    replica.subscribe((e) => resets.push(e.reset));
    a.send(Visible.channel, { type: 'delta', epoch: publisher.epoch, from: 99, to: 100, upserts: [['ghost', { x: 1 }]], removes: [] });
    await settle();
    expect(resets).toContain(true);
    expect([...replica.entries.keys()]).toEqual(['a']);
    expect(replica.status).toBe('live');
    publisher.dispose();
    close();
  });

  it('requires an owner; aborted window moves fail fast; detach stops updates', async () => {
    const replica = createWindowedReplica(Visible);
    const unattached = await replica.setWindow({ min: 0, max: 1 });
    expect(unattached.ok).toBe(false);
    const controller = new AbortController();
    controller.abort();
    expect((await replica.setWindow({ min: 0, max: 1 }, { signal: controller.signal })).ok).toBe(false);
    const source = createMemoryWindowedSource(inside);
    const publisher = createWindowedPublisher({ definition: Visible, source });
    const { a, b, close } = links();
    const detachOwner = publisher.attach(a);
    expect(publisher.attach(a)).toBe(detachOwner);
    expect(publisher.peers).toBe(1);
    expect((await replica.attach(b)).ok).toBe(true); // re-requests the last window
    replica.detach();
    source.set('late', { x: 0 });
    await settle();
    expect(replica.entries.has('late')).toBe(false);
    expect(replica.status).toBe('detached');
    const bad = await b.request(Visible.channel, { type: 'nope' });
    expect(bad.ok).toBe(false);
    detachOwner();
    expect(publisher.peers).toBe(0);
    publisher.dispose();
    close();
  });
});
