/**
 * Plain-data helpers. Store and slice values must be structured-clone-safe
 * *and* JSON-persistable: plain objects, arrays, strings, finite numbers,
 * booleans, null (and `undefined` for optional keys). Anything else is
 * rejected with `SF-DATA-031` instead of being silently mangled.
 */
import { err, ok, type Result, toSfError } from '@staticflux/core';
import { NotCloneableError } from './errors.js';
import type { PathSegment } from './schema.js';

function reject(path: readonly PathSegment[], reason: string): never {
  throw NotCloneableError({
    message: `Value at ${path.length === 0 ? '<root>' : path.join('.')} is not plain data: ${reason}.`,
    details: { path: [...path], reason },
  });
}

function cloneInner(value: unknown, path: PathSegment[], seen: Set<object>): unknown {
  if (value === null || value === undefined) return value;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') {
    if (!Number.isFinite(value)) reject(path, 'non-finite number');
    return value;
  }
  if (type !== 'object') reject(path, type);
  const object = value as object;
  if (seen.has(object)) reject(path, 'cycle');
  seen.add(object);
  let out: unknown;
  if (Array.isArray(object)) {
    const copy: unknown[] = new Array<unknown>(object.length);
    for (let i = 0; i < object.length; i += 1) {
      path.push(i);
      copy[i] = cloneInner((object as unknown[])[i], path, seen);
      path.pop();
    }
    out = copy;
  } else {
    const proto = Object.getPrototypeOf(object) as unknown;
    if (proto !== Object.prototype && proto !== null) reject(path, 'class instance');
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(object)) {
      path.push(key);
      copy[key] = cloneInner((object as Record<string, unknown>)[key], path, seen);
      path.pop();
    }
    out = copy;
  }
  seen.delete(object);
  return out;
}

/** Deep-copy plain data. Throws `SF-DATA-031` (SfError) for non-plain values. */
export function clonePlain<T>(value: T): T {
  return cloneInner(value, [], new Set()) as T;
}

/** Result-returning variant of `clonePlain`. */
export function tryClonePlain<T>(value: T): Result<T> {
  try {
    return ok(clonePlain(value));
  } catch (error) {
    return err(toSfError(error));
  }
}

/** Deep-freeze plain data in place and return it. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/** Deterministic JSON (sorted object keys) for cache keys. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.keys(value)
    .sort()
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

/** Approximate persisted size in bytes (UTF-8 of the JSON form). */
export function byteSize(value: unknown): number {
  const json = JSON.stringify(value) ?? '';
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(json).length;
  return json.length * 2;
}
