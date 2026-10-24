/**
 * The handoff store: typed put / take (consume) / peek over the storage port,
 * with lifetimes, expiry, migrations and devtools inspection.
 *
 * - `take` consumes the entry for every lifetime; for one-shot slots it is the
 *   only way to read (consume-once). Operations on one key are serialized, so two
 *   concurrent `take`s never both receive the payload.
 * - Expired, malformed or unmigratable entries are removed on read and reported;
 *   readers get `undefined` (expired) or a typed error (invalid), never a throw.
 * - `clear({ lifetime: 'session' })` is what logout calls (R9.11).
 */
import {
  createMachine,
  createNoopTelemetry,
  defineError,
  defineMachine,
  err,
  metric,
  ok,
  type Result,
  type Telemetry,
} from '@staticflux/core';
import { createEnvelope, isEnvelope, parseEnvelope, type SnapshotEnvelope } from './envelope.js';
import { type AnyHandoffSlot, effectiveTtl, type HandoffScope, type HandoffSlot, type LifetimeKind, lifetimeKind } from './slot.js';
import type { HandoffStorage, HandoffStorages } from './storage.js';

export const SlotCollisionError = defineError(
  'SF-HANDOFF-007',
  'conflict',
  'Two different handoff slots use the same key.',
  'Slot keys are namespaced by package (`studio/…`); rename one, or share the single slot declaration.',
);

export const HandoffEntryMachine = defineMachine({
  id: 'handoff/entry',
  initial: 'empty',
  states: ['empty', 'stored', 'consumed', 'expired', 'discarded', 'invalid'],
  transitions: {
    empty: { put: 'stored', expire: 'expired', invalidate: 'invalid', take: 'consumed', discard: 'discarded' },
    stored: { put: 'stored', take: 'consumed', expire: 'expired', discard: 'discarded', invalidate: 'invalid' },
    consumed: { put: 'stored' },
    expired: { put: 'stored' },
    discarded: { put: 'stored' },
    invalid: { put: 'stored' },
  },
});
export type HandoffEntryState = (typeof HandoffEntryMachine.states)[number];
type EntryEvent = 'put' | 'take' | 'expire' | 'discard' | 'invalidate';

export const HandoffMetrics = {
  put: metric.counter('handoff/put', { description: 'Handoff entries written.' }),
  consumed: metric.counter('handoff/consumed', { description: 'Handoff entries taken.' }),
  expired: metric.counter('handoff/expired', { description: 'Handoff entries found expired.' }),
  invalid: metric.counter('handoff/invalid', { description: 'Handoff entries discarded as malformed/unmigratable.' }),
} as const;

const SUBSYSTEM = 'handoff/store';

export interface PutOptions {
  /** Overrides the slot TTL for this entry (still capped by `maxAgeMs`). */
  readonly ttlMs?: number;
}

export interface ClearFilter {
  readonly lifetime?: LifetimeKind;
  readonly scope?: HandoffScope;
}

export interface HandoffEntryInfo {
  readonly key: string;
  readonly scope: HandoffScope;
  readonly lifetime: LifetimeKind;
  readonly state: HandoffEntryState;
}

export interface HandoffStore {
  /** Register a slot (collision detection; enables sweep/clear for it). Idempotent for the same slot. */
  register(slot: AnyHandoffSlot): Result<void>;
  put<T>(slot: HandoffSlot<T>, data: T, options?: PutOptions): Promise<Result<SnapshotEnvelope<T>>>;
  /** Read and remove. `ok(undefined)` when absent or expired. */
  take<T>(slot: HandoffSlot<T>): Promise<Result<T | undefined>>;
  /** Read without consuming. */
  peek<T>(slot: HandoffSlot<T>): Promise<Result<T | undefined>>;
  /** Full envelope (for archives and migrations), without consuming. */
  peekEnvelope<T>(slot: HandoffSlot<T>): Promise<Result<SnapshotEnvelope<T> | undefined>>;
  discard(slot: AnyHandoffSlot): Promise<Result<void>>;
  /** Remove entries of registered slots matching the filter. Resolves to the number removed. */
  clear(filter?: ClearFilter): Promise<Result<number>>;
  /** Remove expired and malformed entries from every storage. Resolves to the number removed. */
  sweep(): Promise<Result<number>>;
  /** True if the scope's storage fell back to memory. */
  isDegraded(scope: HandoffScope): boolean;
  inspect(): readonly HandoffEntryInfo[];
}

export interface HandoffStoreOptions {
  readonly storages: HandoffStorages;
  readonly slots?: readonly AnyHandoffSlot[];
  /** Wall clock (epoch ms). Default `Date.now`. */
  readonly now?: () => number;
  readonly telemetry?: Telemetry;
}

interface Tracked {
  readonly slot: AnyHandoffSlot;
  readonly machine: ReturnType<typeof createMachine<HandoffEntryState, EntryEvent>>;
}

export function createHandoffStore(options: HandoffStoreOptions): HandoffStore {
  const now = options.now ?? Date.now;
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const slots = new Map<string, AnyHandoffSlot>();
  const tracked = new Map<string, Tracked>();
  const locks = new Map<string, Promise<unknown>>();

  const storageFor = (scope: HandoffScope): HandoffStorage => options.storages[scope];

  const track = (slot: AnyHandoffSlot): Tracked => {
    let entry = tracked.get(slot.key);
    if (entry === undefined) {
      const machine = createMachine(HandoffEntryMachine);
      machine.onTransition((r) =>
        telemetry.event(`lifecycle.${r.machine}.${r.from}→${r.to}`, { subsystem: SUBSYSTEM, level: 'verbose', attrs: { key: slot.key } }),
      );
      entry = { slot, machine };
      tracked.set(slot.key, entry);
    }
    return entry;
  };

  const transition = (slot: AnyHandoffSlot, event: EntryEvent): void => {
    const machine = track(slot).machine;
    if (machine.can(event)) machine.send(event);
  };

  /** Serialize operations per key. */
  const withLock = <R>(key: string, fn: () => Promise<R>): Promise<R> => {
    const previous = locks.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    locks.set(key, settled);
    void settled.then(() => {
      if (locks.get(key) === settled) locks.delete(key);
    });
    return run;
  };

  const register = (slot: AnyHandoffSlot): Result<void> => {
    const existing = slots.get(slot.key);
    if (existing !== undefined && existing !== slot) {
      return err(SlotCollisionError({ message: `Handoff key "${slot.key}" is declared by two different slots.`, details: { key: slot.key } }));
    }
    slots.set(slot.key, slot);
    return ok();
  };

  /** Read + validate; removes expired/invalid entries. */
  const readEnvelope = async <T>(slot: HandoffSlot<T>): Promise<Result<SnapshotEnvelope<T> | undefined>> => {
    const storage = storageFor(slot.scope);
    const raw = await storage.read(slot.key);
    if (!raw.ok) return raw;
    if (raw.value === undefined) return ok(undefined);
    const parsed = parseEnvelope<T>(raw.value, {
      key: slot.key,
      version: slot.version,
      schema: slot.schema,
      migrations: slot.migrations,
      now: now(),
    });
    if (parsed.ok) return parsed;
    await storage.remove(slot.key);
    if (parsed.error.code === 'SF-HANDOFF-004') {
      transition(slot, 'expire');
      telemetry.record(HandoffMetrics.expired, 1, { key: slot.key });
      telemetry.event('handoff.expired', { subsystem: SUBSYSTEM, attrs: { key: slot.key } });
      return ok(undefined);
    }
    transition(slot, 'invalidate');
    telemetry.record(HandoffMetrics.invalid, 1, { key: slot.key });
    telemetry.event('handoff.invalid', { subsystem: SUBSYSTEM, level: 'critical', attrs: { key: slot.key, code: parsed.error.code } });
    return parsed;
  };

  for (const slot of options.slots ?? []) {
    const r = register(slot);
    if (!r.ok) {
      telemetry.event('handoff.slot-collision', { subsystem: SUBSYSTEM, level: 'critical', attrs: { key: slot.key } });
    }
  }

  const store: HandoffStore = {
    register,
    put(slot, data, putOptions = {}) {
      return withLock(slot.key, async () => {
        const registered = register(slot);
        if (!registered.ok) return registered;
        const envelope = createEnvelope({ key: slot.key, version: slot.version, data, now: now(), ttlMs: effectiveTtl(slot, putOptions.ttlMs) });
        const written = await storageFor(slot.scope).write(slot.key, envelope);
        if (!written.ok) {
          telemetry.event('handoff.write-failed', { subsystem: SUBSYSTEM, level: 'critical', attrs: { key: slot.key } });
          return written;
        }
        transition(slot, 'put');
        telemetry.record(HandoffMetrics.put, 1, { key: slot.key, scope: slot.scope });
        return ok(envelope);
      });
    },
    take(slot) {
      return withLock(slot.key, async () => {
        const read = await readEnvelope(slot);
        if (!read.ok || read.value === undefined) return read.ok ? ok(undefined) : read;
        const removed = await storageFor(slot.scope).remove(slot.key);
        if (!removed.ok) return removed;
        transition(slot, 'take');
        telemetry.record(HandoffMetrics.consumed, 1, { key: slot.key });
        return ok(read.value.data);
      });
    },
    peek(slot) {
      return withLock(slot.key, async () => {
        const read = await readEnvelope(slot);
        return read.ok ? ok(read.value?.data) : read;
      });
    },
    peekEnvelope(slot) {
      return withLock(slot.key, () => readEnvelope(slot));
    },
    discard(slot) {
      return withLock(slot.key, async () => {
        const removed = await storageFor(slot.scope).remove(slot.key);
        if (removed.ok) transition(slot, 'discard');
        return removed;
      });
    },
    async clear(filter = {}) {
      let removed = 0;
      for (const slot of slots.values()) {
        if (filter.scope !== undefined && slot.scope !== filter.scope) continue;
        if (filter.lifetime !== undefined && lifetimeKind(slot.lifetime) !== filter.lifetime) continue;
        const result = await withLock(slot.key, async () => {
          const raw = await storageFor(slot.scope).read(slot.key);
          if (!raw.ok) return raw;
          if (raw.value === undefined) return ok(false);
          const r = await storageFor(slot.scope).remove(slot.key);
          if (!r.ok) return r;
          transition(slot, 'discard');
          return ok(true);
        });
        if (!result.ok) return result;
        if (result.value) removed += 1;
      }
      telemetry.event('handoff.cleared', { subsystem: SUBSYSTEM, attrs: { removed, lifetime: filter.lifetime ?? 'all', scope: filter.scope ?? 'all' } });
      return ok(removed);
    },
    async sweep() {
      let removed = 0;
      const at = now();
      const seen = new Set<HandoffStorage>();
      for (const scope of ['memory', 'tab', 'origin'] as const) {
        const storage = storageFor(scope);
        if (seen.has(storage)) continue;
        seen.add(storage);
        const keys = await storage.keys();
        if (!keys.ok) return keys;
        for (const key of keys.value) {
          const gone = await withLock(key, async () => {
            const raw = await storage.read(key);
            if (!raw.ok || raw.value === undefined) return false;
            const expired = isEnvelope(raw.value) && raw.value.expiresAt !== undefined && raw.value.expiresAt <= at;
            if (isEnvelope(raw.value) && !expired) return false;
            const r = await storage.remove(key);
            if (!r.ok) return false;
            const slot = slots.get(key);
            if (slot !== undefined) transition(slot, expired ? 'expire' : 'invalidate');
            return true;
          });
          if (gone) removed += 1;
        }
      }
      if (removed > 0) telemetry.event('handoff.swept', { subsystem: SUBSYSTEM, attrs: { removed } });
      return ok(removed);
    },
    isDegraded(scope) {
      return options.storages.degraded.includes(scope);
    },
    inspect() {
      return [...tracked.values()].map(({ slot, machine }) => ({
        key: slot.key,
        scope: slot.scope,
        lifetime: lifetimeKind(slot.lifetime),
        state: machine.state,
      }));
    },
  };
  return store;
}
