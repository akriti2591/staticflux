/**
 * URL codecs: typed parse/serialize for one query parameter value. Parsing
 * returns a `Result` (bad hand-edited URLs are expected, not exceptional).
 */
import { err, ok, type Result } from '@staticflux/core';
import { InvalidUrlValueError } from './errors.js';

export interface UrlCodec<T> {
  /** `raw` is the decoded value; `''` for a present-but-empty param (`?sf-debug`). */
  parse(raw: string): Result<T>;
  serialize(value: T): string;
  equals?(a: T, b: T): boolean;
}

const invalid = (raw: string, expected: string): Result<never> =>
  err(InvalidUrlValueError({ message: `Invalid URL value "${raw}" (expected ${expected}).`, details: { raw, expected } }));

export const codec = {
  string(options: { readonly maxLength?: number; readonly allowEmpty?: boolean } = {}): UrlCodec<string> {
    const max = options.maxLength ?? 2000;
    return {
      parse: (raw) =>
        raw.length > max ? invalid(raw.slice(0, 40), `≤ ${max} characters`) : raw === '' && options.allowEmpty !== true ? invalid(raw, 'a non-empty string') : ok(raw),
      serialize: (value) => value,
    };
  },

  enum<const V extends string>(values: readonly V[]): UrlCodec<V> {
    const set = new Set<string>(values);
    return {
      parse: (raw) => (set.has(raw) ? ok(raw as V) : invalid(raw, values.join(' | '))),
      serialize: (value) => value,
    };
  },

  int(options: { readonly min?: number; readonly max?: number } = {}): UrlCodec<number> {
    return {
      parse: (raw) => {
        if (!/^-?\d+$/.test(raw)) return invalid(raw, 'an integer');
        const n = Number(raw);
        if (!Number.isSafeInteger(n)) return invalid(raw, 'a safe integer');
        if (options.min !== undefined && n < options.min) return invalid(raw, `≥ ${options.min}`);
        if (options.max !== undefined && n > options.max) return invalid(raw, `≤ ${options.max}`);
        return ok(n);
      },
      serialize: (value) => String(Math.trunc(value)),
    };
  },

  number(): UrlCodec<number> {
    return {
      parse: (raw) => {
        const n = Number(raw);
        return raw.trim() === '' || !Number.isFinite(n) ? invalid(raw, 'a number') : ok(n);
      },
      serialize: (value) => String(value),
    };
  },

  /** `1|true|''` → true, `0|false` → false. */
  boolean(): UrlCodec<boolean> {
    return {
      parse: (raw) => (raw === '' || raw === '1' || raw === 'true' ? ok(true) : raw === '0' || raw === 'false' ? ok(false) : invalid(raw, 'a boolean')),
      serialize: (value) => (value ? '1' : '0'),
    };
  },

  /** Presence flag (`?sf-debug`): present = true; false removes the param. */
  flag(): UrlCodec<true> {
    return {
      parse: () => ok(true),
      serialize: () => '',
    };
  },

  list<T>(inner: UrlCodec<T>, separator = ','): UrlCodec<readonly T[]> {
    return {
      parse: (raw) => {
        if (raw === '') return ok([]);
        const out: T[] = [];
        for (const part of raw.split(separator)) {
          const parsed = inner.parse(part);
          if (!parsed.ok) return parsed;
          out.push(parsed.value);
        }
        return ok(out);
      },
      serialize: (value) => value.map((v) => inner.serialize(v)).join(separator),
      equals: (a, b) => a.length === b.length && a.every((v, i) => (inner.equals ?? Object.is)(v, b[i] as T)),
    };
  },

  custom<T>(definition: UrlCodec<T>): UrlCodec<T> {
    return definition;
  },
} as const;

/** Codec equality (defaults to `Object.is`). */
export function codecEquals<T>(c: UrlCodec<T>, a: T, b: T): boolean {
  return c.equals === undefined ? Object.is(a, b) : c.equals(a, b);
}
