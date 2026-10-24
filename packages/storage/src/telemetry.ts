/**
 * `withTelemetry(telemetry, subsystem)`: a span per operation (`storage.get`,
 * `storage.set`, …; reads at `verbose`, writes at `standard`) plus declared
 * metrics: op count, op duration, failures by code. Attributes never include
 * values (keys only at `debug`).
 */
import { metric, type Result, type Subsystem, type Telemetry } from '@staticflux/core';
import { createCursor } from './base.js';
import type { AsyncStore } from './types.js';

export const StorageMetrics = {
  ops: metric.counter('storage/ops', { description: 'Storage operations by op and store.' }),
  duration: metric.histogram('storage/op-duration', { unit: 'ms', description: 'Storage operation duration.' }),
  failures: metric.counter('storage/failures', { description: 'Failed storage operations by error code.' }),
  seekEntries: metric.histogram('storage/seek-entries', { description: 'Entries returned per seek.' }),
} as const;

export const STORAGE_SUBSYSTEM = 'storage/store' satisfies Subsystem;

type Op = 'get' | 'set' | 'delete' | 'has' | 'clear' | 'seek' | 'batch';
const READS: ReadonlySet<Op> = new Set(['get', 'has', 'seek']);

export function withTelemetry<V>(telemetry: Telemetry, subsystem: Subsystem = STORAGE_SUBSYSTEM): (inner: AsyncStore<V>) => AsyncStore<V> {
  return (inner) => {
    const traced = async <T>(op: Op, key: string | undefined, size: number | undefined, run: () => Promise<Result<T>>): Promise<Result<T>> => {
      const level = READS.has(op) ? 'verbose' : 'standard';
      const attrs: Record<string, string | number> = { op, store: inner.id };
      if (size !== undefined) attrs['ops'] = size;
      if (key !== undefined && telemetry.enabled(subsystem, 'debug')) attrs['key'] = key;
      const span = telemetry.span(`storage.${op}`, { subsystem, level, attrs });
      const start = telemetry.now();
      const result = await run();
      telemetry.record(StorageMetrics.ops, 1, { op, store: inner.id }, span);
      telemetry.record(StorageMetrics.duration, telemetry.now() - start, { op, store: inner.id }, span);
      if (result.ok) span.end('ok');
      else {
        telemetry.record(StorageMetrics.failures, 1, { op, store: inner.id, code: result.error.code }, span);
        span.end(result.error.kind === 'aborted' ? 'cancelled' : 'error', result.error);
      }
      return result;
    };
    return {
      id: inner.id,
      capabilities: inner.capabilities,
      get: (key, options) => traced('get', key, undefined, () => inner.get(key, options)),
      set: (key, value, options) => traced('set', key, undefined, () => inner.set(key, value, options)),
      delete: (key, options) => traced('delete', key, undefined, () => inner.delete(key, options)),
      has: (key, options) => traced('has', key, undefined, () => inner.has(key, options)),
      clear: (options) => traced('clear', undefined, undefined, () => inner.clear(options)),
      batch: (ops, options) => traced('batch', undefined, ops.length, () => inner.batch(ops, options)),
      seek: (options = {}) =>
        createCursor(() =>
          traced('seek', options.prefix, undefined, async () => {
            const loaded = await inner.seek(options).toArray();
            if (loaded.ok) telemetry.record(StorageMetrics.seekEntries, loaded.value.length, { store: inner.id });
            return loaded;
          }),
        ),
      watch: (listener, options) => inner.watch(listener, options),
      dispose: () => inner.dispose(),
    };
  };
}
