import { createMemorySink, createTelemetry, err, formatTraceparent, ok, sleep } from '@staticflux/core';
import { describe, expect, it, vi } from 'vitest';
import {
  Channels,
  createEnvelope,
  createLink,
  createMessageChannelPorts,
  createPortPair,
  createProtocolClient,
  createProtocolServer,
  defineProtocol,
  event,
  fromWireError,
  isEnvelope,
  replicaChannel,
  request,
  schema,
  toWireError,
  validateEnvelope,
  InvalidEnvelopeError,
  fromWorkerScope,
  type MessageTargetLike,
} from './index.js';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('envelopes', () => {
  it('validates structure and omits undefined optional fields', () => {
    const envelope = createEnvelope({ kind: 'event', channel: 'test/a', id: '1', epoch: 0, payload: { x: 1 }, version: undefined });
    expect('version' in envelope).toBe(false);
    expect(isEnvelope(envelope)).toBe(true);
    expect(isEnvelope({ ...envelope, kind: 'nope' })).toBe(false);
    expect(isEnvelope({ ...envelope, channel: 'nochannel' })).toBe(false);
    expect(isEnvelope({ kind: 'event', channel: 'a/b', id: '1', epoch: 0 })).toBe(false);
    expect(validateEnvelope(42).ok).toBe(false);
    expect(validateEnvelope(envelope).ok).toBe(true);
  });

  it('round-trips errors over the wire', () => {
    const original = InvalidEnvelopeError({ details: { channel: 'a/b', nested: { x: 1 } }, traceId: 't' });
    const back = fromWireError(toWireError(original));
    expect(back.code).toBe('SF-WK-001');
    expect(back.kind).toBe('validation');
    expect(back.fix).toBe(original.fix);
    expect(back.details['channel']).toBe('a/b');
    expect(typeof back.details['nested']).toBe('string');
    expect(back.traceId).toBe('t');
  });

  it('derives replica channels', () => {
    expect(replicaChannel('studio/doc')).toBe('sf/replica/studio/doc');
    expect(Channels.control).toBe('sf/control');
  });
});

describe('in-memory port pair', () => {
  it('delivers asynchronously, in order, structured-cloned', async () => {
    const pair = createPortPair();
    const received: unknown[] = [];
    pair.b.onMessage((data) => received.push(data));
    const message = { n: 1 };
    pair.a.postMessage(message);
    pair.a.postMessage({ n: 2 });
    expect(received).toEqual([]);
    await tick();
    expect(received).toEqual([{ n: 1 }, { n: 2 }]);
    expect(received[0]).not.toBe(message);
    expect(pair.a.sent).toBe(2);
  });

  it('freeze queues messages until thaw (frozen tab / hung worker)', async () => {
    const pair = createPortPair();
    const received: unknown[] = [];
    pair.b.onMessage((data) => received.push(data));
    pair.b.freeze();
    expect(pair.b.frozen).toBe(true);
    pair.a.postMessage(1);
    pair.a.postMessage(2);
    await tick();
    expect(received).toEqual([]);
    pair.b.thaw();
    expect(received).toEqual([1, 2]);
  });

  it('crash emits an error on side a and closes both sides', async () => {
    const pair = createPortPair();
    const onError = vi.fn();
    const received = vi.fn();
    pair.a.onError(onError);
    pair.b.onMessage(received);
    pair.crash(new Error('boom'));
    expect(onError).toHaveBeenCalledOnce();
    expect(pair.a.closed && pair.b.closed).toBe(true);
    pair.a.postMessage('late');
    await tick();
    expect(received).not.toHaveBeenCalled();
  });

  it('real MessageChannel adapter (feature-detected)', async () => {
    const ports = createMessageChannelPorts();
    if (ports === undefined) return;
    const got = new Promise((resolve) => ports.b.onMessage(resolve));
    ports.a.postMessage({ hello: 'world' });
    expect(await got).toEqual({ hello: 'world' });
    ports.a.close();
    ports.b.close();
  });

  it('worker-scope adapter wires message and error events', () => {
    const target = new EventTarget() as EventTarget & MessageTargetLike;
    const posted: unknown[] = [];
    (target as unknown as { postMessage: (m: unknown) => void }).postMessage = (m) => posted.push(m);
    const port = fromWorkerScope(target);
    const onMessage = vi.fn();
    const onError = vi.fn();
    port.onMessage(onMessage);
    port.onError(onError);
    const message = new Event('message') as Event & { data?: unknown };
    Object.defineProperty(message, 'data', { value: { a: 1 } });
    target.dispatchEvent(message);
    target.dispatchEvent(new Event('error'));
    target.dispatchEvent(new Event('messageerror'));
    port.postMessage('out');
    expect(onMessage).toHaveBeenCalledWith({ a: 1 });
    expect(onError).toHaveBeenCalledTimes(2);
    expect(posted).toEqual(['out']);
    port.close();
    target.dispatchEvent(message);
    expect(onMessage).toHaveBeenCalledTimes(1);
  });
});

describe('link', () => {
  const linked = () => {
    const pair = createPortPair();
    return { pair, a: createLink({ port: pair.a, name: 'a' }), b: createLink({ port: pair.b, name: 'b' }) };
  };

  it('request/response and events per channel', async () => {
    const { a, b } = linked();
    b.handle('test/echo', (payload) => ok({ echoed: payload }));
    const events: unknown[] = [];
    b.on('test/events', (payload) => events.push(payload));
    a.send('test/events', 'hi');
    a.send('test/other', 'ignored');
    const result = await a.request('test/echo', 42);
    expect(result).toEqual(ok({ echoed: 42 }));
    expect(events).toEqual(['hi']);
    expect(a.pending).toBe(0);
  });

  it('carries handler errors as typed SfErrors and maps throws', async () => {
    const { a, b } = linked();
    b.handle('test/fail', () => err(InvalidEnvelopeError()));
    b.handle('test/throw', () => {
      throw new Error('kaput');
    });
    const failed = await a.request('test/fail', null);
    expect(!failed.ok && failed.error.code).toBe('SF-WK-001');
    const thrown = await a.request('test/throw', null);
    expect(!thrown.ok && thrown.error.code).toBe('SF-CORE-000');
  });

  it('answers SF-WK-008 when no handler exists', async () => {
    const { a } = linked();
    const result = await a.request('test/missing', null);
    expect(!result.ok && result.error.code).toBe('SF-WK-008');
  });

  it('times out (SF-WK-006) and cancels the remote handler', async () => {
    const { a, b } = linked();
    let remoteSignal: AbortSignal | undefined;
    b.handle('test/slow', async (_payload, context) => {
      remoteSignal = context.signal;
      await sleep(1_000, context.signal);
      return ok('late');
    });
    const result = await a.request('test/slow', null, { timeoutMs: 5 });
    expect(!result.ok && result.error.code).toBe('SF-WK-006');
    await tick();
    expect(remoteSignal?.aborted).toBe(true);
  });

  it('propagates caller aborts as cancel envelopes', async () => {
    const { a, b } = linked();
    let remoteSignal: AbortSignal | undefined;
    b.handle('test/slow', async (_payload, context) => {
      remoteSignal = context.signal;
      await sleep(1_000, context.signal);
      return ok('late');
    });
    const controller = new AbortController();
    const pending = a.request('test/slow', null, { signal: controller.signal });
    await tick();
    controller.abort();
    const result = await pending;
    expect(!result.ok && result.error.kind).toBe('aborted');
    await tick();
    expect(remoteSignal?.aborted).toBe(true);
    const already = await a.request('test/slow', null, { signal: controller.signal });
    expect(!already.ok && already.error.kind).toBe('aborted');
  });

  it('close fails pending requests with SF-WK-009 and notifies listeners', async () => {
    const { a, b } = linked();
    b.handle('test/never', () => new Promise(() => undefined));
    const onClose = vi.fn();
    a.onClose(onClose);
    const pending = a.request('test/never', null);
    await tick();
    a.close();
    const result = await pending;
    expect(!result.ok && result.error.code).toBe('SF-WK-009');
    expect(onClose).toHaveBeenCalledOnce();
    expect(a.closed).toBe(true);
    const after = await a.request('test/never', null);
    expect(!after.ok && after.error.code).toBe('SF-WK-009');
  });

  it('reports invalid messages (SF-WK-001) to telemetry and onInvalid', async () => {
    const pair = createPortPair();
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'debug' });
    telemetry.addSink(sink);
    const onInvalid = vi.fn();
    createLink({ port: pair.b, telemetry, onInvalid });
    pair.a.postMessage({ not: 'an envelope' });
    await tick();
    expect(onInvalid.mock.calls[0]?.[0].code).toBe('SF-WK-001');
    expect(sink.records.some((r) => r.type === 'event' && r.name === 'worker.invalid-message')).toBe(true);
  });

  it('stamps epoch and propagates traceparent so remote spans join the trace', async () => {
    const { a, b } = linked();
    const telemetry = createTelemetry({ defaultLevel: 'debug' });
    const span = telemetry.span('root', { subsystem: 'test/x' });
    let seen: { epoch: number; traceId: string | undefined } | undefined;
    b.handle('test/trace', (_payload, context) => {
      seen = { epoch: context.envelope.epoch, traceId: context.parent?.traceId };
      return ok();
    });
    a.setEpoch(7);
    expect(a.epoch).toBe(7);
    await a.request('test/trace', null, { parent: span });
    expect(seen).toEqual({ epoch: 7, traceId: span.context?.traceId });
    const tp = formatTraceparent({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), sampled: true });
    const eventCtx = new Promise<string | undefined>((resolve) => b.on('test/ev', (_p, c) => resolve(c.parent?.spanId)));
    a.send('test/ev', null, { traceparent: tp });
    expect(await eventCtx).toBe('b'.repeat(16));
  });
});

describe('protocols', () => {
  const Proto = defineProtocol({
    id: 'test/proto',
    version: 2,
    requests: {
      add: request<{ a: number; b: number }, number>({
        args: schema('add-args', (v) => typeof (v as { a?: unknown })?.a === 'number'),
        result: schema('number', (v) => typeof v === 'number'),
      }),
      bad: request<void, number>({ result: schema('number', (v) => typeof v === 'number') }),
      unhandled: request<void, void>(),
    },
    events: { changed: event<{ n: number }>({ payload: schema('changed', (v) => typeof (v as { n?: unknown })?.n === 'number') }) },
  });

  const setup = () => {
    const pair = createPortPair();
    const a = createLink({ port: pair.a, name: 'a' });
    const b = createLink({ port: pair.b, name: 'b' });
    const server = createProtocolServer(b, Proto, {
      add: ({ a: x, b: y }) => ok(x + y),
      bad: () => ok('not a number' as unknown as number),
    });
    return { client: createProtocolClient(a, Proto), server };
  };

  it('defines protocols as frozen data', () => {
    expect(Proto.kind).toBe('protocol');
    expect(Proto.requests.add.idempotent).toBe(false);
    expect(Object.isFrozen(Proto)).toBe(true);
  });

  it('typed requests round-trip', async () => {
    const { client } = setup();
    const result = await client.request('add', { a: 2, b: 3 });
    expect(result).toEqual(ok(5));
  });

  it('validates args on both sides and results on the client (dev)', async () => {
    const { client } = setup();
    const badArgs = await client.request('add', { a: 'x' } as unknown as { a: number; b: number });
    expect(!badArgs.ok && badArgs.error.code).toBe('SF-WK-001');
    const badResult = await client.request('bad', undefined);
    expect(!badResult.ok && badResult.error.code).toBe('SF-WK-001');
    const missing = await client.request('unhandled', undefined);
    expect(!missing.ok && missing.error.code).toBe('SF-WK-008');
  });

  it('validates events on emit and filters invalid payloads on receive', async () => {
    const { client, server } = setup();
    const received: unknown[] = [];
    client.on('changed', (payload) => received.push(payload));
    expect(server.emit('changed', { n: 1 }).ok).toBe(true);
    expect(server.emit('changed', { n: 'x' } as unknown as { n: number }).ok).toBe(false);
    await tick();
    expect(received).toEqual([{ n: 1 }]);
  });

  it('handle() adds handlers later; dispose() removes the server', async () => {
    const { client, server } = setup();
    server.handle('unhandled', () => ok());
    expect((await client.request('unhandled', undefined)).ok).toBe(true);
    server.dispose();
    const gone = await client.request('add', { a: 1, b: 1 });
    expect(!gone.ok && gone.error.code).toBe('SF-WK-008');
  });
});
