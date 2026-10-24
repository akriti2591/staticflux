/**
 * Envelopes: the one message shape on every worker port.
 *
 *   { kind, channel, id, epoch, version?, traceparent?, payload }
 *
 * - `kind`     request | response | event | cancel
 * - `channel`  namespaced logical channel (`sf/control`, a protocol id, a replica channel, …)
 * - `id`       unique per sender; responses and cancels reuse the request id
 * - `epoch`    app epoch of the sender when the message was created
 * - `version`  optional store version (replication)
 * - `traceparent` W3C trace context so worker spans join one timeline (R11.6)
 */
import { err, ok, type Result, sfError, type SfError, type ErrorCode, type ErrorKind } from '@staticflux/core';
import { InvalidEnvelopeError } from './errors.js';

export const ENVELOPE_KINDS = ['request', 'response', 'event', 'cancel'] as const;
export type EnvelopeKind = (typeof ENVELOPE_KINDS)[number];

/** Namespaced channel id, like tokens (`package/name`). */
export type ChannelId = `${string}/${string}`;

export interface Envelope<P = unknown> {
  readonly kind: EnvelopeKind;
  readonly channel: ChannelId;
  readonly id: string;
  readonly epoch: number;
  readonly version?: number;
  readonly traceparent?: string;
  readonly payload: P;
}

/** Framework channels. Feature protocols use their own protocol id as channel. */
export const Channels = {
  control: 'sf/control',
  context: 'sf/context',
  telemetry: 'sf/telemetry',
  broker: 'sf/broker',
} as const satisfies Record<string, ChannelId>;

/** Channel of a replicated store. */
export function replicaChannel<const Id extends ChannelId>(id: Id): `sf/replica/${Id}` {
  return `sf/replica/${id}`;
}

const KIND_SET = new Set<string>(ENVELOPE_KINDS);

/** Structural envelope check (cheap; always on). */
export function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v['kind'] !== 'string' || !KIND_SET.has(v['kind'])) return false;
  if (typeof v['channel'] !== 'string' || !v['channel'].includes('/')) return false;
  if (typeof v['id'] !== 'string' || v['id'].length === 0) return false;
  if (typeof v['epoch'] !== 'number' || !Number.isFinite(v['epoch'])) return false;
  if (v['version'] !== undefined && typeof v['version'] !== 'number') return false;
  if (v['traceparent'] !== undefined && typeof v['traceparent'] !== 'string') return false;
  return 'payload' in v;
}

export function validateEnvelope(value: unknown): Result<Envelope> {
  if (isEnvelope(value)) return ok(value);
  return err(
    InvalidEnvelopeError({
      message: 'Received a message that is not a StaticFlux envelope.',
      details: { received: typeof value },
    }),
  );
}

export interface EnvelopeInit<P> {
  readonly kind: EnvelopeKind;
  readonly channel: ChannelId;
  readonly id: string;
  readonly epoch: number;
  readonly payload: P;
  readonly version?: number | undefined;
  readonly traceparent?: string | undefined;
}

/** Create an envelope, omitting undefined optional fields (structured-clone friendly). */
export function createEnvelope<P>(init: EnvelopeInit<P>): Envelope<P> {
  const envelope: { -readonly [K in keyof Envelope<P>]: Envelope<P>[K] } = {
    kind: init.kind,
    channel: init.channel,
    id: init.id,
    epoch: init.epoch,
    payload: init.payload,
  };
  if (init.version !== undefined) envelope.version = init.version;
  if (init.traceparent !== undefined) envelope.traceparent = init.traceparent;
  return envelope;
}

// ---------------------------------------------------------------- errors on the wire

export interface WireError {
  readonly code: string;
  readonly kind: string;
  readonly message: string;
  readonly fix?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly traceId?: string;
}

export type WireResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: WireError };

export function toWireError(error: SfError): WireError {
  const wire: { -readonly [K in keyof WireError]: WireError[K] } = {
    code: error.code,
    kind: error.kind,
    message: error.message,
  };
  if (error.fix !== undefined) wire.fix = error.fix;
  if (Object.keys(error.details).length > 0) wire.details = safeDetails(error.details);
  if (error.traceId !== undefined) wire.traceId = error.traceId;
  return wire;
}

function safeDetails(details: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    const t = typeof value;
    if (value === null || t === 'string' || t === 'number' || t === 'boolean') out[key] = value;
    else out[key] = String(value);
  }
  return out;
}

export function fromWireError(wire: WireError): SfError {
  return sfError({
    code: wire.code as ErrorCode,
    kind: wire.kind as ErrorKind,
    message: wire.message,
    ...(wire.fix === undefined ? {} : { fix: wire.fix }),
    ...(wire.details === undefined ? {} : { details: wire.details }),
    ...(wire.traceId === undefined ? {} : { traceId: wire.traceId }),
  });
}

export function toWireResult(result: Result<unknown>): WireResult {
  return result.ok ? { ok: true, value: result.value } : { ok: false, error: toWireError(result.error) };
}

export function isWireResult(value: unknown): value is WireResult {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v['ok'] === true) return 'value' in v;
  if (v['ok'] === false) {
    const e = v['error'] as Record<string, unknown> | undefined;
    return typeof e === 'object' && e !== null && typeof e['code'] === 'string' && typeof e['message'] === 'string';
  }
  return false;
}

export function fromWireResult(wire: WireResult): Result<unknown> {
  return wire.ok ? ok(wire.value) : err(fromWireError(wire.error));
}
