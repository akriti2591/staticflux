/**
 * Resource-limit primitives for plugin traffic: a payload size estimate that
 * stops as soon as the budget is exceeded (an attacker cannot make the host walk
 * a huge message), and a token-bucket rate limiter on an injectable clock.
 */

const MAX_DEPTH = 64;

/**
 * Estimated structured-clone size of `value` in bytes. Returns a number greater
 * than `budget` as soon as the budget is exceeded (or the value is too deep).
 */
export function estimateBytes(value: unknown, budget: number = Number.POSITIVE_INFINITY): number {
  let total = 0;
  const over = (): boolean => total > budget;
  const seen = new Set<object>();
  const walk = (v: unknown, depth: number): void => {
    if (over()) return;
    if (depth > MAX_DEPTH) {
      total = budget + 1;
      return;
    }
    switch (typeof v) {
      case 'string':
        total += v.length * 2;
        return;
      case 'number':
      case 'bigint':
        total += 8;
        return;
      case 'boolean':
      case 'undefined':
        total += 1;
        return;
      case 'object':
        break;
      default:
        total += 8;
        return;
    }
    if (v === null) {
      total += 1;
      return;
    }
    const object = v as object;
    if (seen.has(object)) return;
    seen.add(object);
    if (object instanceof ArrayBuffer) {
      total += object.byteLength;
      return;
    }
    if (ArrayBuffer.isView(object)) {
      total += object.byteLength;
      return;
    }
    if (object instanceof Map) {
      for (const [key, entry] of object) {
        walk(key, depth + 1);
        walk(entry, depth + 1);
        if (over()) return;
      }
      return;
    }
    if (object instanceof Set) {
      for (const entry of object) {
        walk(entry, depth + 1);
        if (over()) return;
      }
      return;
    }
    if (Array.isArray(object)) {
      total += 8;
      for (const entry of object) {
        walk(entry, depth + 1);
        if (over()) return;
      }
      return;
    }
    for (const key of Object.keys(object)) {
      total += key.length * 2;
      walk((object as Record<string, unknown>)[key], depth + 1);
      if (over()) return;
    }
  };
  walk(value, 0);
  return total;
}

export interface RateLimiter {
  /** Take one token; false when the bucket is empty. */
  take(): boolean;
  readonly available: number;
}

/** Token bucket: `perSecond` tokens per second, burst `burst` (default `perSecond`). */
export function createRateLimiter(perSecond: number, now: () => number, burst: number = perSecond): RateLimiter {
  let tokens = burst;
  let last = now();
  const refill = (): void => {
    const t = now();
    const elapsed = Math.max(0, t - last);
    last = t;
    tokens = Math.min(burst, tokens + (elapsed / 1000) * perSecond);
  };
  return {
    take() {
      refill();
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
    get available() {
      refill();
      return Math.floor(tokens);
    },
  };
}
