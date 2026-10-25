/**
 * Content-addressed blob side channel (SF-Δ18): large payloads (geometry, paint,
 * glyph runs, image tiles) travel once, by digest, beside the delta stream.
 * Records reference blobs by digest; the reader's `apply()` blocks on a record
 * until its blobs arrived (`BlobResolver`), so the order of the stream is never
 * broken by the two channels racing.
 *
 * - The sender sends a digest at most once per receiver lifetime (dedupe); a
 *   receiver that starts (or `clear()`s) sends `reset`, so a respawned reader gets
 *   everything again.
 * - The receiver keeps blobs in an LRU under `budgetBytes` and tells the sender
 *   what it evicted. A record that needs an evicted blob `request()`s it: the
 *   sender re-sends from its own retained copies (`retainBytes`) or answers
 *   `gone`, and the delta reader resnapshots (SF-WK-041).
 * - Buffers are transferred (the sender keeps no extra copy unless retained).
 *
 * @example
 * export const SceneBlobs = defineBlobChannel('instaflow/scene-blobs');
 * const blobs = createBlobSender(peer.link, SceneBlobs);           // editor
 * const digest = blobs.put(encodePath(path));
 * deltas.append({ version, refs: [digest], payload });
 * const store = createBlobReceiver(link, SceneBlobs);              // render
 * scene.apply(applyRecord, { blobs: store });                     // blocks until blobs arrive
 */
import { AbortedError, createNoopTelemetry, err, metric, ok, type Result, type Telemetry } from '@staticflux/core';
import type { BlobResolver } from './delta-stream.js';
import type { ChannelId } from './envelope.js';
import { murmur3x86_128 } from './hash.js';
import type { Link } from './link.js';
import { PipeClosedError } from './pipeline-errors.js';
import type { RegionWaitOptions } from './region.js';

export interface BlobChannelDefinition<Id extends ChannelId = ChannelId> {
  readonly kind: 'blob-channel';
  readonly id: Id;
}

export function defineBlobChannel<const Id extends ChannelId>(id: Id): BlobChannelDefinition<Id> {
  return Object.freeze({ kind: 'blob-channel', id });
}

/** Default content digest: MurmurHash3 x86-128 as 32 hex characters (non-cryptographic, in-app use). */
export function digestBytes(bytes: Uint8Array): string {
  return murmur3x86_128(bytes);
}

export const BlobChannelMetrics = {
  sentBytes: /* @__PURE__ */ metric.counter('worker/blob-channel-sent-bytes', { unit: 'By', description: 'Blob bytes sent (after dedupe)' }),
  deduped: /* @__PURE__ */ metric.counter('worker/blob-channel-deduped', { description: 'Puts answered from the receiver cache' }),
  evicted: /* @__PURE__ */ metric.counter('worker/blob-channel-evicted', { description: 'Blobs evicted by the receiver budget' }),
} as const;

const sub = (id: ChannelId, part: 'put' | 'want' | 'gone' | 'evicted' | 'reset'): ChannelId => `${id}/${part}` as ChannelId;

interface PutMessage {
  readonly digest: string;
  readonly buffer: ArrayBuffer;
}
interface DigestsMessage {
  readonly digests: readonly string[];
}

const isDigests = (value: unknown): value is DigestsMessage =>
  typeof value === 'object' && value !== null && Array.isArray((value as DigestsMessage).digests);

// ---------------------------------------------------------------- sender

export interface BlobSenderStats {
  readonly sent: number;
  readonly sentBytes: number;
  readonly deduped: number;
  readonly resent: number;
  readonly gone: number;
  readonly retainedBytes: number;
}

export interface BlobSender {
  readonly id: ChannelId;
  /** Make `bytes` available to the receiver; returns its digest. Sends only if the receiver lacks it. */
  put(bytes: Uint8Array, options?: { readonly digest?: string }): Result<string>;
  /** True when the receiver is known to hold `digest`. */
  has(digest: string): boolean;
  /** Forget what the receiver holds (it is told to drop nothing; next puts re-send). */
  reset(): void;
  readonly stats: BlobSenderStats;
  close(): void;
}

export interface BlobSenderOptions {
  /** Bytes of sent blobs kept to answer re-requests. Default 32 MiB. */
  readonly retainBytes?: number;
  readonly digest?: (bytes: Uint8Array) => string;
  readonly telemetry?: Telemetry;
}

export function createBlobSender(link: Link, definition: BlobChannelDefinition, options: BlobSenderOptions = {}): BlobSender {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const retainBytes = options.retainBytes ?? 32 * 1024 * 1024;
  const digestOf = options.digest ?? digestBytes;
  const known = new Set<string>();
  const retained = new Map<string, Uint8Array>();
  const stats = { sent: 0, sentBytes: 0, deduped: 0, resent: 0, gone: 0 };
  let retainedBytes = 0;
  let closed = false;

  const retain = (digest: string, bytes: Uint8Array): void => {
    if (retainBytes <= 0 || bytes.byteLength > retainBytes) return;
    const existing = retained.get(digest);
    if (existing !== undefined) {
      retained.delete(digest);
      retained.set(digest, existing);
      return;
    }
    retained.set(digest, bytes.slice());
    retainedBytes += bytes.byteLength;
    for (const [oldest, copy] of retained) {
      if (retainedBytes <= retainBytes) break;
      retained.delete(oldest);
      retainedBytes -= copy.byteLength;
    }
  };
  const transmit = (digest: string, bytes: Uint8Array): void => {
    // A private copy is transferred (cross-thread) or passed by reference (in-process); the sender never touches it again.
    const buffer = bytes.slice().buffer;
    link.send(sub(definition.id, 'put'), { digest, buffer } satisfies PutMessage, { transfer: [buffer] });
    known.add(digest);
    stats.sent += 1;
    stats.sentBytes += bytes.byteLength;
    telemetry.record(BlobChannelMetrics.sentBytes, bytes.byteLength, { channel: definition.id });
  };

  const offs = [
    link.on(sub(definition.id, 'reset'), () => known.clear()),
    link.on(sub(definition.id, 'evicted'), (payload) => {
      if (isDigests(payload)) for (const digest of payload.digests) known.delete(digest);
    }),
    link.on(sub(definition.id, 'want'), (payload) => {
      if (closed || !isDigests(payload)) return;
      const gone: string[] = [];
      for (const digest of payload.digests) {
        const copy = retained.get(digest);
        if (copy === undefined) {
          gone.push(digest);
          continue;
        }
        transmit(digest, copy);
        stats.resent += 1;
      }
      if (gone.length > 0) {
        stats.gone += gone.length;
        link.send(sub(definition.id, 'gone'), { digests: gone } satisfies DigestsMessage);
      }
    }),
  ];

  return {
    id: definition.id,
    put(bytes, putOptions = {}) {
      if (closed) return err(PipeClosedError({ details: { pipe: definition.id } }));
      const digest = putOptions.digest ?? digestOf(bytes);
      retain(digest, bytes);
      if (known.has(digest)) {
        stats.deduped += 1;
        telemetry.record(BlobChannelMetrics.deduped, 1, { channel: definition.id });
        return ok(digest);
      }
      transmit(digest, bytes);
      return ok(digest);
    },
    has: (digest) => known.has(digest),
    reset: () => known.clear(),
    get stats() {
      return { ...stats, retainedBytes };
    },
    close() {
      if (closed) return;
      closed = true;
      for (const off of offs) off();
      retained.clear();
      retainedBytes = 0;
      known.clear();
    },
  };
}

// ---------------------------------------------------------------- receiver

export interface BlobReceiverStats {
  readonly received: number;
  readonly receivedBytes: number;
  readonly evicted: number;
  readonly requested: number;
  readonly bytes: number;
  readonly count: number;
}

export interface BlobReceiver extends BlobResolver {
  readonly id: ChannelId;
  get(digest: string): Uint8Array | undefined;
  /** Called for every blob that arrives. */
  onArrive(listener: (digest: string) => void): () => void;
  /** Resolve `ok(true)` once every digest is present (or `ok(false)` on timeout); fails when one is gone. */
  waitFor(digests: readonly string[], options?: RegionWaitOptions): Promise<Result<boolean>>;
  /** Drop everything and tell the sender to start over. */
  clear(): void;
  readonly stats: BlobReceiverStats;
  close(): void;
}

export interface BlobReceiverOptions {
  /** LRU budget. Default 256 MiB. */
  readonly budgetBytes?: number;
  readonly telemetry?: Telemetry;
  /** Timer for `waitFor` timeouts. Default global setTimeout. */
  readonly setTimer?: (fn: () => void, ms: number) => () => void;
}

const defaultTimer = (fn: () => void, ms: number): (() => void) => {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
};

export function createBlobReceiver(link: Link, definition: BlobChannelDefinition, options: BlobReceiverOptions = {}): BlobReceiver {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const budget = options.budgetBytes ?? 256 * 1024 * 1024;
  const setTimer = options.setTimer ?? defaultTimer;
  const blobs = new Map<string, Uint8Array>();
  const goneSet = new Set<string>();
  const requested = new Set<string>();
  const listeners = new Set<(digest: string) => void>();
  const stats = { received: 0, receivedBytes: 0, evicted: 0, requested: 0 };
  let bytes = 0;
  let closed = false;

  const evict = (): void => {
    const evicted: string[] = [];
    for (const [digest, blob] of blobs) {
      if (bytes <= budget || blobs.size <= 1) break;
      blobs.delete(digest);
      bytes -= blob.byteLength;
      evicted.push(digest);
    }
    if (evicted.length === 0) return;
    stats.evicted += evicted.length;
    telemetry.record(BlobChannelMetrics.evicted, evicted.length, { channel: definition.id });
    link.send(sub(definition.id, 'evicted'), { digests: evicted } satisfies DigestsMessage);
  };
  const notify = (digest: string): void => {
    for (const listener of [...listeners]) listener(digest);
  };

  const offs = [
    link.on(sub(definition.id, 'put'), (payload) => {
      const message = payload as Partial<PutMessage> | null;
      if (closed || typeof message?.digest !== 'string' || !(message.buffer instanceof ArrayBuffer)) return;
      const blob = new Uint8Array(message.buffer);
      const previous = blobs.get(message.digest);
      if (previous !== undefined) bytes -= previous.byteLength;
      blobs.delete(message.digest);
      blobs.set(message.digest, blob);
      bytes += blob.byteLength;
      goneSet.delete(message.digest);
      requested.delete(message.digest);
      stats.received += 1;
      stats.receivedBytes += blob.byteLength;
      evict();
      notify(message.digest);
    }),
    link.on(sub(definition.id, 'gone'), (payload) => {
      if (closed || !isDigests(payload)) return;
      for (const digest of payload.digests) {
        goneSet.add(digest);
        requested.delete(digest);
        notify(digest);
      }
    }),
  ];
  // A new receiver holds nothing: the sender must not assume otherwise (respawn).
  link.send(sub(definition.id, 'reset'), null);

  const receiver: BlobReceiver = {
    id: definition.id,
    has: (digest) => blobs.has(digest),
    get(digest) {
      const blob = blobs.get(digest);
      if (blob !== undefined) {
        blobs.delete(digest);
        blobs.set(digest, blob); // LRU touch
      }
      return blob;
    },
    gone: (digest) => goneSet.has(digest),
    request(digests) {
      const fresh = digests.filter((d) => !blobs.has(d) && !goneSet.has(d) && !requested.has(d));
      if (fresh.length === 0 || closed) return;
      for (const digest of fresh) requested.add(digest);
      stats.requested += fresh.length;
      link.send(sub(definition.id, 'want'), { digests: fresh } satisfies DigestsMessage);
    },
    onArrive(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    waitFor(digests, waitOptions = {}) {
      return new Promise((resolve) => {
        const { signal } = waitOptions;
        let cancelTimer: (() => void) | undefined;
        // Aborted to detach the abort listener once the wait settles.
        const detach = new AbortController();
        const finish = (result: Result<boolean>): void => {
          off();
          cancelTimer?.();
          detach.abort();
          resolve(result);
        };
        const check = (): void => {
          if (signal?.aborted === true) return finish(err(AbortedError({ cause: signal.reason })));
          const gone = digests.find((d) => goneSet.has(d));
          if (gone !== undefined) return finish(err(PipeClosedError({ message: `Blob ${gone} is gone.`, details: { pipe: definition.id, digest: gone } })));
          if (digests.every((d) => blobs.has(d))) return finish(ok(true));
          if (closed) return finish(err(PipeClosedError({ details: { pipe: definition.id } })));
        };
        const off = receiver.onArrive(check);
        signal?.addEventListener('abort', check, { once: true, signal: detach.signal });
        if (waitOptions.timeoutMs !== undefined) cancelTimer = setTimer(() => finish(ok(false)), waitOptions.timeoutMs);
        check();
      });
    },
    clear() {
      blobs.clear();
      bytes = 0;
      goneSet.clear();
      requested.clear();
      link.send(sub(definition.id, 'reset'), null);
    },
    get stats() {
      return { ...stats, bytes, count: blobs.size };
    },
    close() {
      if (closed) return;
      closed = true;
      for (const off of offs) off();
      blobs.clear();
      bytes = 0;
      for (const listener of [...listeners]) listener('');
      listeners.clear();
    },
  };
  return receiver;
}
