/**
 * A minimal schema DSL for structured-clone-safe data (stores, slices,
 * endpoint payloads). Schemas are explicit values, so serialization never
 * depends on reflection over class fields (research §13).
 *
 * @example
 * const Doc = s.object({ id: s.string(), title: s.string(), tags: s.array(s.string()), pinned: s.optional(s.boolean()) });
 * type Doc = Infer<typeof Doc>;
 * const parsed = Doc.validate(json); // Result<Doc>
 */
import { err, ok, type Result } from '@staticflux/core';
import { SchemaValidationError } from './errors.js';

export type PathSegment = string | number;
export type Path = readonly PathSegment[];

export type SchemaKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  | 'literal'
  | 'enum'
  | 'array'
  | 'object'
  | 'record'
  | 'optional'
  | 'nullable'
  | 'union'
  | 'unknown';

export interface Schema<T> {
  readonly kind: SchemaKind;
  /** Validate and return the value typed (no coercion, no copying). */
  validate(value: unknown, path?: Path): Result<T>;
  /** Phantom type carrier. */
  readonly __type?: T;
}

export interface OptionalSchema<T> extends Schema<T | undefined> {
  readonly kind: 'optional';
  readonly inner: Schema<T>;
}
export interface NullableSchema<T> extends Schema<T | null> {
  readonly kind: 'nullable';
  readonly inner: Schema<T>;
}
export interface ArraySchema<T> extends Schema<T[]> {
  readonly kind: 'array';
  readonly element: Schema<T>;
}
export interface RecordSchema<T> extends Schema<Record<string, T>> {
  readonly kind: 'record';
  readonly value: Schema<T>;
}
export type Shape = Readonly<Record<string, Schema<unknown>>>;
export interface ObjectSchema<Sh extends Shape> extends Schema<InferShape<Sh>> {
  readonly kind: 'object';
  readonly shape: Sh;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

type OptionalKeys<Sh extends Shape> = { [K in keyof Sh]: Sh[K] extends OptionalSchema<unknown> ? K : never }[keyof Sh];
type RequiredKeys<Sh extends Shape> = Exclude<keyof Sh, OptionalKeys<Sh>>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
export type InferShape<Sh extends Shape> = Simplify<
  { [K in RequiredKeys<Sh>]: Infer<Sh[K]> } & {
    [K in OptionalKeys<Sh>]?: Sh[K] extends OptionalSchema<infer T> ? T : never;
  }
>;

function fail(path: Path, expected: string, value: unknown): Result<never> {
  return err(
    SchemaValidationError({
      message: `Expected ${expected} at ${path.length === 0 ? '<root>' : path.join('.')}.`,
      details: { path: [...path], expected, received: value === null ? 'null' : typeof value },
    }),
  );
}

function primitive<T>(kind: SchemaKind, check: (v: unknown) => boolean, expected: string): Schema<T> {
  return {
    kind,
    validate: (value, path = []) => (check(value) ? ok(value as T) : fail(path, expected, value)),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

export const s = {
  string: (): Schema<string> => primitive('string', (v) => typeof v === 'string', 'string'),
  /** Finite numbers only (NaN/Infinity do not survive JSON persistence). */
  number: (): Schema<number> => primitive('number', (v) => typeof v === 'number' && Number.isFinite(v), 'finite number'),
  boolean: (): Schema<boolean> => primitive('boolean', (v) => typeof v === 'boolean', 'boolean'),
  null: (): Schema<null> => primitive('null', (v) => v === null, 'null'),
  unknown: (): Schema<unknown> => ({ kind: 'unknown', validate: (value) => ok(value) }),
  literal: <const L extends string | number | boolean>(literal: L): Schema<L> =>
    primitive('literal', (v) => v === literal, JSON.stringify(literal)),
  enum: <const L extends readonly (string | number)[]>(values: L): Schema<L[number]> =>
    primitive('enum', (v) => values.includes(v as L[number]), `one of ${JSON.stringify(values)}`),
  optional: <T>(inner: Schema<T>): OptionalSchema<T> => ({
    kind: 'optional',
    inner,
    validate: (value, path = []) => (value === undefined ? ok(undefined) : inner.validate(value, path)),
  }),
  nullable: <T>(inner: Schema<T>): NullableSchema<T> => ({
    kind: 'nullable',
    inner,
    validate: (value, path = []) => (value === null ? ok(null) : inner.validate(value, path)),
  }),
  array: <T>(element: Schema<T>): ArraySchema<T> => ({
    kind: 'array',
    element,
    validate(value, path = []) {
      if (!Array.isArray(value)) return fail(path, 'array', value);
      for (let i = 0; i < value.length; i += 1) {
        const r = element.validate(value[i], [...path, i]);
        if (!r.ok) return r;
      }
      return ok(value as T[]);
    },
  }),
  record: <T>(valueSchema: Schema<T>): RecordSchema<T> => ({
    kind: 'record',
    value: valueSchema,
    validate(value, path = []) {
      if (!isPlainObject(value)) return fail(path, 'object', value);
      for (const [k, v] of Object.entries(value)) {
        const r = valueSchema.validate(v, [...path, k]);
        if (!r.ok) return r;
      }
      return ok(value as Record<string, T>);
    },
  }),
  object: <const Sh extends Shape>(shape: Sh): ObjectSchema<Sh> => ({
    kind: 'object',
    shape,
    validate(value, path = []) {
      if (!isPlainObject(value)) return fail(path, 'object', value);
      for (const [k, schema] of Object.entries(shape)) {
        const r = schema.validate(value[k], [...path, k]);
        if (!r.ok) return r;
      }
      for (const k of Object.keys(value)) {
        if (!(k in shape)) return fail([...path, k], 'no extra keys', value[k]);
      }
      return ok(value as InferShape<Sh>);
    },
  }),
  union: <const M extends readonly Schema<unknown>[]>(...members: M): Schema<Infer<M[number]>> => ({
    kind: 'union',
    validate(value, path = []) {
      for (const member of members) {
        if (member.validate(value, path).ok) return ok(value as Infer<M[number]>);
      }
      return fail(path, `one of ${members.map((m) => m.kind).join(' | ')}`, value);
    },
  }),
} as const;

/**
 * The schema governing the value at `path` (for validating patch values without
 * re-validating the whole tree). `undefined` when the path leaves the schema.
 */
export function schemaAt(schema: Schema<unknown>, path: Path): Schema<unknown> | undefined {
  let current: Schema<unknown> | undefined = schema;
  for (const segment of path) {
    current = unwrapOptional(current);
    if (current === undefined) return undefined;
    if (current.kind === 'unknown') return current;
    if (current.kind === 'array') current = (current as ArraySchema<unknown>).element;
    else if (current.kind === 'record') current = (current as RecordSchema<unknown>).value;
    else if (current.kind === 'object') current = (current as ObjectSchema<Shape>).shape[String(segment)];
    else return undefined;
  }
  return current;
}

function unwrapOptional(schema: Schema<unknown> | undefined): Schema<unknown> | undefined {
  let current = schema;
  while (current !== undefined && (current.kind === 'optional' || current.kind === 'nullable')) {
    current = (current as OptionalSchema<unknown>).inner;
  }
  return current;
}

/** Whether the key `segment` may be removed from the container governed by `parent`. */
export function isRemovable(parent: Schema<unknown> | undefined, segment: PathSegment): boolean {
  const container = unwrapOptional(parent);
  if (container === undefined) return false;
  if (container.kind === 'array' || container.kind === 'record' || container.kind === 'unknown') return true;
  if (container.kind === 'object') return (container as ObjectSchema<Shape>).shape[String(segment)]?.kind === 'optional';
  return false;
}
