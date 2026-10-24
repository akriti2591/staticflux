/**
 * Fixed-capacity ring buffer: the collector's only storage primitive, so its
 * memory is bounded no matter how long the app runs.
 */

export interface RingBuffer<T> {
  readonly capacity: number;
  readonly size: number;
  /** Total items ever pushed (including evicted ones). */
  readonly pushed: number;
  push(item: T): void;
  /** Oldest → newest. */
  toArray(): T[];
  /** Newest item, if any. */
  last(): T | undefined;
  clear(): void;
}

export function createRingBuffer<T>(capacity: number): RingBuffer<T> {
  const size = Math.max(1, Math.floor(capacity));
  const items: (T | undefined)[] = new Array<T | undefined>(size);
  let head = 0; // next write position
  let count = 0;
  let pushed = 0;
  return {
    capacity: size,
    get size() {
      return count;
    },
    get pushed() {
      return pushed;
    },
    push(item) {
      items[head] = item;
      head = (head + 1) % size;
      if (count < size) count += 1;
      pushed += 1;
    },
    toArray() {
      const out: T[] = [];
      const start = (head - count + size) % size;
      for (let i = 0; i < count; i += 1) out.push(items[(start + i) % size] as T);
      return out;
    },
    last() {
      if (count === 0) return undefined;
      return items[(head - 1 + size) % size];
    },
    clear() {
      items.fill(undefined);
      head = 0;
      count = 0;
    },
  };
}

/** Insertion-ordered map bounded to `capacity` keys; touching a key moves it to the newest end. */
export interface BoundedMap<K, V> {
  readonly size: number;
  get(key: K): V | undefined;
  /** Set (and touch) a key; evicts the least recently touched key when full. */
  set(key: K, value: V): void;
  has(key: K): boolean;
  delete(key: K): void;
  values(): V[];
  entries(): [K, V][];
  clear(): void;
}

export function createBoundedMap<K, V>(capacity: number): BoundedMap<K, V> {
  const limit = Math.max(1, Math.floor(capacity));
  const map = new Map<K, V>();
  return {
    get size() {
      return map.size;
    },
    get: (key) => map.get(key),
    has: (key) => map.has(key),
    set(key, value) {
      if (map.has(key)) map.delete(key);
      else if (map.size >= limit) {
        const oldest = map.keys().next();
        if (oldest.done !== true) map.delete(oldest.value);
      }
      map.set(key, value);
    },
    delete(key) {
      map.delete(key);
    },
    values: () => [...map.values()],
    entries: () => [...map.entries()],
    clear: () => map.clear(),
  };
}
