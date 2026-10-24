/**
 * Telemetry subsystems and declared metrics of the data layer (R17.11 — metrics are typed values).
 */
import { metric, type Subsystem } from '@staticflux/core';

export const DATA_SUBSYSTEMS = {
  request: 'data/request',
  cache: 'data/cache',
  store: 'data/store',
  slice: 'data/slice',
  transport: 'data/transport',
} as const satisfies Record<string, Subsystem>;

export const DataMetrics = {
  requestDuration: /* @__PURE__ */ metric.histogram('data/request-duration', { unit: 'ms', description: 'Duration of one logical request (all attempts).' }),
  requestFailure: /* @__PURE__ */ metric.counter('data/request-failure', { description: 'Logical requests that ended in an error.' }),
  cacheHit: /* @__PURE__ */ metric.counter('data/cache-hit', { description: 'Resource reads served from a fresh cache entry.' }),
  cacheStaleHit: /* @__PURE__ */ metric.counter('data/cache-stale-hit', { description: 'Reads served stale while revalidating (SWR).' }),
  cacheMiss: /* @__PURE__ */ metric.counter('data/cache-miss', { description: 'Resource reads with no cached entry.' }),
  staleEpochDiscarded: /* @__PURE__ */ metric.counter('data/stale-epoch-discarded', { description: 'Responses discarded because their epoch was older (I-10).' }),
  breakerState: /* @__PURE__ */ metric.gauge('data/breaker-state', { description: 'Endpoint circuit state: 0 closed, 1 half-open, 2 open.' }),
  batchSize: /* @__PURE__ */ metric.histogram('data/batch-size', { description: 'Keys per coalesced batch call.' }),
  storePatches: /* @__PURE__ */ metric.histogram('data/store-patches', { description: 'Patch ops flushed per outermost store action.' }),
  sliceBytes: /* @__PURE__ */ metric.gauge('data/slice-bytes', { unit: 'By', description: 'Persisted size of a user-data slice.' }),
} as const;
