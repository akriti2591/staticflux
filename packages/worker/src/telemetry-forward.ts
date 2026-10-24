/**
 * Worker telemetry joins the main-thread timeline (R11.6). Inside a worker,
 * a forwarding sink batches records and sends them on `sf/telemetry`; the
 * main thread receives them into a sink (exact records, tagged with the
 * worker id) and/or re-emits them into a Telemetry instance.
 */
import type { Attrs, MetricDefinition, Telemetry, TelemetryRecord, TelemetrySink } from '@staticflux/core';
import { type FlushScheduler, microtaskScheduler } from './clock.js';
import { Channels } from './envelope.js';
import type { Link } from './link.js';

export interface ForwardingSink extends TelemetrySink {
  flush(): void;
  readonly buffered: number;
}

export interface ForwardingSinkOptions {
  readonly schedule?: FlushScheduler;
  /** Records kept while the link is closed or the batch is unsent. Default 500 (oldest dropped). */
  readonly limit?: number;
}

interface TelemetryBatch {
  readonly records: readonly TelemetryRecord[];
  readonly dropped: number;
}

export function createForwardingSink(link: Link, options: ForwardingSinkOptions = {}): ForwardingSink {
  const schedule = options.schedule ?? microtaskScheduler;
  const limit = options.limit ?? 500;
  let buffer: TelemetryRecord[] = [];
  let dropped = 0;
  let scheduled = false;
  const flush = (): void => {
    scheduled = false;
    if (buffer.length === 0 || link.closed) return;
    const batch: TelemetryBatch = { records: buffer, dropped };
    buffer = [];
    dropped = 0;
    link.send(Channels.telemetry, batch);
  };
  return {
    receive(record) {
      buffer.push(record);
      if (buffer.length > limit) {
        buffer.shift();
        dropped += 1;
      }
      if (!scheduled) {
        scheduled = true;
        schedule(flush);
      }
    },
    flush,
    get buffered() {
      return buffer.length;
    },
  };
}

export interface ForwardTarget {
  /** Receives the exact worker records (attrs tagged with `worker.id`). */
  readonly sink?: TelemetrySink;
  /** Re-emit into this telemetry: events → events, metrics → metrics, spans → `worker.span` events. */
  readonly telemetry?: Telemetry;
}

function tag(attrs: Attrs, workerId: string): Attrs {
  return { ...attrs, 'worker.id': workerId };
}

function tagRecord(record: TelemetryRecord, workerId: string): TelemetryRecord {
  return { ...record, attrs: tag(record.attrs, workerId) } as TelemetryRecord;
}

/** Receive forwarded worker telemetry on `link`. Returns unsubscribe. */
export function receiveForwardedTelemetry(link: Link, target: ForwardTarget, workerId: string): () => void {
  return link.on(Channels.telemetry, (payload) => {
    const batch = payload as TelemetryBatch;
    if (!Array.isArray(batch?.records)) return;
    for (const record of batch.records) {
      const tagged = tagRecord(record, workerId);
      target.sink?.receive(tagged);
      const telemetry = target.telemetry;
      if (telemetry === undefined) continue;
      switch (tagged.type) {
        case 'event':
          telemetry.event(tagged.name, {
            subsystem: tagged.subsystem,
            level: tagged.level,
            attrs: tagged.attrs,
            parent:
              tagged.traceId === undefined || tagged.spanId === undefined
                ? undefined
                : { traceId: tagged.traceId, spanId: tagged.spanId, sampled: true },
          });
          break;
        case 'metric': {
          const definition: MetricDefinition = {
            kind: 'metric',
            metricKind: tagged.kind,
            id: tagged.metric,
            unit: tagged.unit,
            description: undefined,
          };
          telemetry.record(definition, tagged.value, tagged.attrs);
          break;
        }
        case 'span':
          telemetry.event('worker.span', {
            subsystem: tagged.subsystem,
            level: tagged.level,
            attrs: { ...tagged.attrs, name: tagged.name, duration: tagged.duration, status: tagged.status },
            parent: tagged.context,
          });
          break;
        case 'span-start':
          break;
      }
    }
    if (batch.dropped > 0) {
      target.telemetry?.event('worker.telemetry-dropped', {
        subsystem: 'worker/telemetry',
        level: 'standard',
        attrs: { 'worker.id': workerId, dropped: batch.dropped },
      });
    }
  });
}
