/**
 * Data channels (R11.17): move transferable ArrayBuffers (snapshots, images,
 * meshes) over an existing Link with explicit ownership. After `send()` the
 * buffers belong to the receiver and are **detached on the sender** — also over
 * ports that copy instead of transfer (in-memory pairs, some polyfills), so the
 * ownership rule is the same everywhere.
 *
 * @example
 * export const MeshData = defineDataChannel<{ meshId: string }>('studio/mesh');
 * const meshes = createDataChannel(link, MeshData);
 * meshes.send({ meshId: 'a' }, [vertices.buffer]);   // vertices is now detached
 * meshes.on(({ meta, buffers }) => upload(meta.meshId, buffers[0]));
 */
import {
  createNoopTelemetry,
  err,
  metric,
  ok,
  type Result,
  type Telemetry,
} from '@staticflux/core';
import { BufferDetachedError, NotTransferableError } from './channel-errors.js';
import { PortClosedError } from './errors.js';
import type { ChannelId } from './envelope.js';
import type { Link, MessageContext, SendOptions } from './link.js';

export interface DataChannelDefinition<M, Id extends ChannelId = ChannelId> {
  readonly kind: 'data-channel';
  readonly id: Id;
  /** Optional runtime guard for `meta` on receive (dev validation). */
  readonly guard: ((meta: unknown) => meta is M) | undefined;
}

/** Declare a data channel; `M` is the structured-clone metadata sent with the buffers. */
export function defineDataChannel<M, const Id extends ChannelId = ChannelId>(
  id: Id,
  guard?: (meta: unknown) => meta is M,
): DataChannelDefinition<M, Id> {
  return Object.freeze({ kind: 'data-channel', id, guard });
}

export interface DataMessage<M> {
  readonly meta: M;
  /** Buffers now owned by this side. */
  readonly buffers: readonly ArrayBuffer[];
}

export interface DataChannelStats {
  readonly sentMessages: number;
  readonly sentBytes: number;
  readonly receivedMessages: number;
  readonly receivedBytes: number;
  /** Times a port copied instead of transferring and the sender copy was detached explicitly. */
  readonly forcedDetaches: number;
}

export interface DataChannel<M> {
  readonly id: ChannelId;
  /** Transfer `buffers` with `meta`. Fails (nothing is sent) if a buffer is shared, duplicated or already detached. */
  send(meta: M, buffers: readonly ArrayBuffer[], options?: Omit<SendOptions, 'transfer'>): Result<void>;
  on(listener: (message: DataMessage<M>, context: MessageContext) => void): () => void;
  /** True when this side gave `buffer` away through this channel. */
  transferred(buffer: ArrayBuffer): boolean;
  readonly stats: DataChannelStats;
  close(): void;
}

export const DataChannelMetrics = {
  bytesSent: metric.counter('worker/data-channel-bytes-sent', { unit: 'By', description: 'Bytes transferred by data channels' }),
  bytesReceived: metric.counter('worker/data-channel-bytes-received', { unit: 'By' }),
} as const;

/** True when `buffer` is detached (transferred away). */
export function isDetached(buffer: ArrayBuffer): boolean {
  const flag = (buffer as { detached?: boolean }).detached;
  if (typeof flag === 'boolean') return flag;
  // Fallback (older engines): a detached buffer reports byteLength 0 and refuses views.
  if (buffer.byteLength !== 0) return false;
  try {
    new Uint8Array(buffer);
    return false;
  } catch {
    return true;
  }
}

/** Detach `buffer` on this side (ownership moved). No-op if already detached. */
export function detachBuffer(buffer: ArrayBuffer): void {
  if (isDetached(buffer)) return;
  const transfer = (buffer as { transfer?: () => ArrayBuffer }).transfer;
  if (typeof transfer === 'function') {
    transfer.call(buffer);
    return;
  }
  structuredClone(buffer, { transfer: [buffer] });
}

/** Validate a transfer list (no SharedArrayBuffer, no duplicates, nothing detached). */
export function checkTransferable(buffers: readonly unknown[]): Result<void> {
  const seen = new Set<unknown>();
  for (const [index, buffer] of buffers.entries()) {
    if (typeof SharedArrayBuffer === 'function' && buffer instanceof SharedArrayBuffer) {
      return err(NotTransferableError({ message: `Buffer #${index} is a SharedArrayBuffer.`, details: { index } }));
    }
    if (!(buffer instanceof ArrayBuffer)) {
      return err(NotTransferableError({ message: `Buffer #${index} is not an ArrayBuffer.`, details: { index } }));
    }
    if (seen.has(buffer)) return err(NotTransferableError({ message: `Buffer #${index} is listed twice.`, details: { index } }));
    seen.add(buffer);
    if (isDetached(buffer)) return err(BufferDetachedError({ details: { index } }));
  }
  return ok();
}

/**
 * Send buffers over a link with transfer semantics and make sure the sender's
 * copies are detached afterwards. Returns how many had to be detached explicitly.
 */
export function transferOverLink(
  link: Link,
  channel: ChannelId,
  payload: unknown,
  buffers: readonly ArrayBuffer[],
  options: Omit<SendOptions, 'transfer'> = {},
): Result<number> {
  const checked = checkTransferable(buffers);
  if (!checked.ok) return checked;
  link.send(channel, payload, { ...options, transfer: buffers });
  let forced = 0;
  for (const buffer of buffers) {
    if (!isDetached(buffer)) {
      detachBuffer(buffer);
      forced += 1;
    }
  }
  return ok(forced);
}

interface WirePayload {
  readonly meta: unknown;
  readonly buffers: readonly ArrayBuffer[];
}

function isWirePayload(value: unknown): value is WirePayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    'buffers' in value &&
    Array.isArray((value as { buffers: unknown }).buffers) &&
    (value as { buffers: unknown[] }).buffers.every((b) => b instanceof ArrayBuffer)
  );
}

const SUBSYSTEM = 'worker/data-channel';

export function createDataChannel<M>(
  link: Link,
  definition: DataChannelDefinition<M>,
  options: { readonly telemetry?: Telemetry } = {},
): DataChannel<M> {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const given = new WeakSet<ArrayBuffer>();
  const unsubscribers = new Set<() => void>();
  let closed = false;
  const stats = { sentMessages: 0, sentBytes: 0, receivedMessages: 0, receivedBytes: 0, forcedDetaches: 0 };

  return {
    id: definition.id,
    send(meta, buffers, sendOptions = {}) {
      if (closed) return err(PortClosedError({ message: 'The data channel is closed.', details: { channel: definition.id } }));
      for (const buffer of buffers) {
        if (buffer instanceof ArrayBuffer && given.has(buffer)) {
          return err(BufferDetachedError({ message: 'This buffer was already sent on this channel.', details: { channel: definition.id } }));
        }
      }
      const bytes = buffers.reduce((sum, b) => sum + (b instanceof ArrayBuffer ? b.byteLength : 0), 0);
      const sent = transferOverLink(link, definition.id, { meta, buffers }, buffers, sendOptions);
      if (!sent.ok) {
        telemetry.event('worker.data-channel.rejected', {
          subsystem: SUBSYSTEM,
          level: 'critical',
          attrs: { channel: definition.id, code: sent.error.code },
        });
        return sent;
      }
      for (const buffer of buffers) given.add(buffer);
      stats.sentMessages += 1;
      stats.sentBytes += bytes;
      stats.forcedDetaches += sent.value;
      telemetry.record(DataChannelMetrics.bytesSent, bytes, { channel: definition.id });
      return ok();
    },
    on(listener) {
      const unsubscribe = link.on(definition.id, (payload, context) => {
        if (closed || !isWirePayload(payload)) return;
        if (definition.guard !== undefined && !definition.guard(payload.meta)) {
          telemetry.event('worker.data-channel.invalid-meta', {
            subsystem: SUBSYSTEM,
            level: 'critical',
            attrs: { channel: definition.id },
          });
          return;
        }
        const bytes = payload.buffers.reduce((sum, b) => sum + b.byteLength, 0);
        stats.receivedMessages += 1;
        stats.receivedBytes += bytes;
        telemetry.record(DataChannelMetrics.bytesReceived, bytes, { channel: definition.id });
        listener({ meta: payload.meta as M, buffers: payload.buffers }, context);
      });
      unsubscribers.add(unsubscribe);
      return () => {
        unsubscribe();
        unsubscribers.delete(unsubscribe);
      };
    },
    transferred: (buffer) => given.has(buffer),
    get stats() {
      return { ...stats };
    },
    close() {
      closed = true;
      for (const unsubscribe of unsubscribers) unsubscribe();
      unsubscribers.clear();
    },
  };
}
