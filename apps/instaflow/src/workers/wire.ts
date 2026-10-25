/**
 * Plain data across the worker boundary (B9). Structured clone keeps objects, arrays and typed arrays, but an
 * `SfError` (an `Error` subclass) loses its code, fix and details. `toWire` replaces every `SfError` inside a value
 * with a marked `WireError`; `fromWire` restores them, so a `Result` or a save state that carries an error reads the
 * same on both sides.
 */
import { SfError } from '@staticflux/core';
import { fromWireError, toWireError, type WireError } from '@staticflux/worker';

/** Marks a wire error inside a value (a key no document value uses). */
export const WIRE_ERROR_KEY = '__sfWireError';

interface MarkedError {
  readonly [WIRE_ERROR_KEY]: WireError;
}

const isMarked = (value: object): value is MarkedError => Object.prototype.hasOwnProperty.call(value, WIRE_ERROR_KEY);

const isPlainObject = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
};

/** A copy of `value` with every `SfError` marked (plain values and typed arrays pass through). */
export function toWire(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object' || depth > 64) return value;
  if (value instanceof SfError) return { [WIRE_ERROR_KEY]: toWireError(value) } satisfies MarkedError;
  if (ArrayBuffer.isView(value)) return value;
  if (Array.isArray(value)) return value.map((v) => toWire(v, depth + 1));
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (typeof v !== 'function') out[k] = toWire(v, depth + 1);
  return out;
}

/** The inverse of `toWire`. */
export function fromWire<T>(value: unknown, depth = 0): T {
  if (value === null || typeof value !== 'object' || depth > 64 || ArrayBuffer.isView(value)) return value as T;
  if (isMarked(value)) return fromWireError(value[WIRE_ERROR_KEY]) as T;
  if (Array.isArray(value)) return value.map((v) => fromWire(v, depth + 1)) as T;
  if (!isPlainObject(value)) return value as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = fromWire(v, depth + 1);
  return out as T;
}
