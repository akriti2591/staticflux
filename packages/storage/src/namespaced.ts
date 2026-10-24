/**
 * `namespaced(prefix)`: keys are stored as `prefix + key`; seek, clear and
 * watch only see this namespace. Include your separator in the prefix
 * (`namespaced('studio:')`). Namespaces nest: `namespaced('a:')(namespaced('b:')(s))`
 * stores under `b:a:key`.
 */
import { ok, type Result } from '@staticflux/core';
import { createCursor, createWatchers, guard, validateKey } from './base.js';
import type { AsyncStore, BatchOp, Entry, SeekOptions, StoreChange, StoreMiddleware } from './types.js';

export function namespaced<V>(prefix: string): StoreMiddleware<V, V> {
  return (inner) => namespacedStore(inner, prefix);
}

function namespacedStore<V>(inner: AsyncStore<V>, prefix: string): AsyncStore<V> {
  const id = `ns[${prefix}](${inner.id})`;
  let disposed = false;
  const full = (key: string): string => `${prefix}${key}`;
  const innerSeek = (options: SeekOptions): SeekOptions => ({
    ...options,
    prefix: full(options.prefix ?? ''),
    ...(options.gte === undefined ? {} : { gte: full(options.gte) }),
    ...(options.lt === undefined ? {} : { lt: full(options.lt) }),
  });
  let unsubscribe: (() => void) | undefined;
  const watchers = createWatchers<V>(
    () => {
      unsubscribe = inner.watch(
        (change) => {
          if (change.type === 'clear') {
            watchers.emit(change);
            return;
          }
          const mapped: StoreChange<V> = { ...change, key: change.key.slice(prefix.length) };
          watchers.emit(mapped);
        },
        prefix === '' ? {} : { prefix },
      );
    },
    () => {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  );
  const checked = (key: string, signal: AbortSignal | undefined): Result<void> => {
    const ready = guard(disposed, id, signal);
    return ready.ok ? validateKey(key) : ready;
  };
  return {
    id,
    capabilities: inner.capabilities,
    async get(key, options = {}) {
      const valid = checked(key, options.signal);
      return valid.ok ? inner.get(full(key), options) : valid;
    },
    async set(key, value, options = {}) {
      const valid = checked(key, options.signal);
      return valid.ok ? inner.set(full(key), value, options) : valid;
    },
    async delete(key, options = {}) {
      const valid = checked(key, options.signal);
      return valid.ok ? inner.delete(full(key), options) : valid;
    },
    async has(key, options = {}) {
      const valid = checked(key, options.signal);
      return valid.ok ? inner.has(full(key), options) : valid;
    },
    async clear(options = {}) {
      const ready = guard(disposed, id, options.signal);
      if (!ready.ok) return ready;
      if (prefix === '') return inner.clear(options);
      const keys = await inner.seek({ prefix, ...options }).keys();
      if (!keys.ok) return keys;
      return inner.batch(keys.value.map((key) => ({ type: 'delete', key })), options);
    },
    seek(options = {}) {
      return createCursor(async () => {
        const ready = guard(disposed, id, options.signal);
        if (!ready.ok) return ready;
        const loaded = await inner.seek(innerSeek(options)).toArray();
        if (!loaded.ok) return loaded;
        return ok(loaded.value.map(([key, value]): Entry<V> => [key.slice(prefix.length), value]));
      });
    },
    async batch(ops, options = {}) {
      const ready = guard(disposed, id, options.signal);
      if (!ready.ok) return ready;
      for (const op of ops) {
        const valid = validateKey(op.key);
        if (!valid.ok) return valid;
      }
      return inner.batch(
        ops.map((op): BatchOp<V> => ({ ...op, key: full(op.key) })),
        options,
      );
    },
    watch(listener, options = {}) {
      return disposed ? () => undefined : watchers.add(listener, options);
    },
    async dispose() {
      if (disposed) return ok();
      disposed = true;
      watchers.clear();
      return inner.dispose();
    },
  };
}
