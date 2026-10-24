/**
 * A tiny schema DSL for capability inputs and outputs (R3.3, R19.18).
 *
 * One declaration gives three things:
 * - a TypeScript type (`Infer<typeof schema>`),
 * - runtime validation of untrusted values (agent / WebMCP / URL input),
 * - a JSON Schema export for agents (`toJsonSchema`).
 *
 * Kinds: object, string, number, boolean, enum, array, optional. Objects are
 * strict (unknown keys are rejected, `additionalProperties: false`) because
 * agent input is untrusted. Optional fields that are absent or `undefined`
 * are omitted from the parsed value (exactOptionalPropertyTypes-friendly).
 *
 * @example
 * const InsertImageInput = s.object({
 *   src: s.string({ format: 'uri', description: 'Image URL' }),
 *   alt: s.optional(s.string({ maxLength: 200 })),
 *   position: s.enum(['start', 'end'] as const),
 * });
 * type InsertImageInput = Infer<typeof InsertImageInput>;
 */
import { err, ok, type Result } from '@staticflux/core';
import { SchemaValidationError } from './errors.js';

export type SchemaKind = 'object' | 'string' | 'number' | 'boolean' | 'enum' | 'array';

/** JSON Schema (draft 2020-12 subset) as emitted for agents. */
export interface JsonSchema {
  readonly type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  readonly description?: string;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: JsonSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly enum?: readonly string[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: string;
  readonly minimum?: number;
  readonly maximum?: number;
}

/** One validation problem. `path` is a JSON-pointer-like path (`/items/0/src`). */
export interface SchemaIssue {
  readonly path: string;
  readonly message: string;
}

declare const schemaType: unique symbol;

/**
 * A schema for values of type `T`. `Opt` marks optional object fields
 * (created with `s.optional`).
 */
export interface Schema<T, Opt extends boolean = boolean> {
  readonly kind: SchemaKind;
  readonly optional: Opt;
  readonly description: string | undefined;
  /** Validate `value`; push issues; return the parsed (copied) value. */
  check(value: unknown, path: string, issues: SchemaIssue[]): T;
  /** JSON Schema for this node. */
  json(): JsonSchema;
  /** Phantom type carrier; never present at runtime. */
  readonly [schemaType]?: T;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySchema = Schema<any, boolean>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRequiredSchema = Schema<any, false>;

/** The TypeScript type a schema describes. */
export type Infer<S> = S extends Schema<infer T, boolean> ? T : never;

type Shape = Readonly<Record<string, AnySchema>>;
type OptionalKeys<S extends Shape> = { [K in keyof S]: S[K] extends Schema<unknown, true> ? K : never }[keyof S];
type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
export type InferShape<S extends Shape> = Simplify<
  { readonly [K in RequiredKeys<S>]: Infer<S[K]> } & { readonly [K in OptionalKeys<S>]?: Infer<S[K]> }
>;

interface CommonOptions {
  readonly description?: string;
}

export interface StringOptions extends CommonOptions {
  readonly minLength?: number;
  readonly maxLength?: number;
  /** ECMAScript regex source (also emitted as JSON Schema `pattern`). */
  readonly pattern?: string;
  /** Informational JSON Schema `format` (`uri`, `email`, `date-time`, …); `uri` is checked. */
  readonly format?: string;
}

export interface NumberOptions extends CommonOptions {
  readonly min?: number;
  readonly max?: number;
  readonly integer?: boolean;
}

export interface ArrayOptions extends CommonOptions {
  readonly minItems?: number;
  readonly maxItems?: number;
}

function describe(json: JsonSchema, description: string | undefined): JsonSchema {
  return description === undefined ? json : { ...json, description };
}

function isAbsoluteUri(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function string(options: StringOptions = {}): Schema<string, false> {
  const regex = options.pattern === undefined ? undefined : new RegExp(options.pattern, 'u');
  return {
    kind: 'string',
    optional: false,
    description: options.description,
    check(value, path, issues) {
      if (typeof value !== 'string') {
        issues.push({ path, message: `expected string, got ${typeName(value)}` });
        return '';
      }
      if (options.minLength !== undefined && value.length < options.minLength) {
        issues.push({ path, message: `must have at least ${options.minLength} characters` });
      }
      if (options.maxLength !== undefined && value.length > options.maxLength) {
        issues.push({ path, message: `must have at most ${options.maxLength} characters` });
      }
      if (regex !== undefined && !regex.test(value)) {
        issues.push({ path, message: `must match pattern ${options.pattern ?? ''}` });
      }
      if (options.format === 'uri' && !isAbsoluteUri(value)) {
        issues.push({ path, message: 'must be an absolute URI' });
      }
      return value;
    },
    json() {
      const json: { -readonly [K in keyof JsonSchema]: JsonSchema[K] } = { type: 'string' };
      if (options.minLength !== undefined) json.minLength = options.minLength;
      if (options.maxLength !== undefined) json.maxLength = options.maxLength;
      if (options.pattern !== undefined) json.pattern = options.pattern;
      if (options.format !== undefined) json.format = options.format;
      return describe(json, options.description);
    },
  };
}

function number(options: NumberOptions = {}): Schema<number, false> {
  return {
    kind: 'number',
    optional: false,
    description: options.description,
    check(value, path, issues) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        issues.push({ path, message: `expected finite number, got ${typeName(value)}` });
        return 0;
      }
      if (options.integer === true && !Number.isInteger(value)) issues.push({ path, message: 'must be an integer' });
      if (options.min !== undefined && value < options.min) issues.push({ path, message: `must be ≥ ${options.min}` });
      if (options.max !== undefined && value > options.max) issues.push({ path, message: `must be ≤ ${options.max}` });
      return value;
    },
    json() {
      const json: { -readonly [K in keyof JsonSchema]: JsonSchema[K] } = {
        type: options.integer === true ? 'integer' : 'number',
      };
      if (options.min !== undefined) json.minimum = options.min;
      if (options.max !== undefined) json.maximum = options.max;
      return describe(json, options.description);
    },
  };
}

function boolean(options: CommonOptions = {}): Schema<boolean, false> {
  return {
    kind: 'boolean',
    optional: false,
    description: options.description,
    check(value, path, issues) {
      if (typeof value !== 'boolean') {
        issues.push({ path, message: `expected boolean, got ${typeName(value)}` });
        return false;
      }
      return value;
    },
    json: () => describe({ type: 'boolean' }, options.description),
  };
}

function enumOf<const V extends string>(values: readonly V[], options: CommonOptions = {}): Schema<V, false> {
  if (values.length === 0) throw new Error('s.enum(): at least one value is required');
  const allowed = new Set<string>(values);
  return {
    kind: 'enum',
    optional: false,
    description: options.description,
    check(value, path, issues) {
      if (typeof value !== 'string' || !allowed.has(value)) {
        issues.push({ path, message: `expected one of ${values.map((v) => JSON.stringify(v)).join(', ')}` });
        return values[0] as V;
      }
      return value as V;
    },
    json: () => describe({ type: 'string', enum: [...values] }, options.description),
  };
}

function array<S extends AnyRequiredSchema>(item: S, options: ArrayOptions = {}): Schema<readonly Infer<S>[], false> {
  if (item.optional) throw new Error('s.array(): items cannot be optional');
  return {
    kind: 'array',
    optional: false,
    description: options.description,
    check(value, path, issues) {
      if (!Array.isArray(value)) {
        issues.push({ path, message: `expected array, got ${typeName(value)}` });
        return [];
      }
      if (options.minItems !== undefined && value.length < options.minItems) {
        issues.push({ path, message: `must have at least ${options.minItems} items` });
      }
      if (options.maxItems !== undefined && value.length > options.maxItems) {
        issues.push({ path, message: `must have at most ${options.maxItems} items` });
      }
      return value.map((entry, index) => item.check(entry, `${path}/${index}`, issues) as Infer<S>);
    },
    json() {
      const json: { -readonly [K in keyof JsonSchema]: JsonSchema[K] } = { type: 'array', items: item.json() };
      if (options.minItems !== undefined) json.minItems = options.minItems;
      if (options.maxItems !== undefined) json.maxItems = options.maxItems;
      return describe(json, options.description);
    },
  };
}

function object<const S extends Shape>(shape: S, options: CommonOptions = {}): Schema<InferShape<S>, false> {
  const keys = Object.keys(shape);
  return {
    kind: 'object',
    optional: false,
    description: options.description,
    check(value, path, issues) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        issues.push({ path, message: `expected object, got ${typeName(value)}` });
        return {} as InferShape<S>;
      }
      const input = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(input)) {
        if (!Object.hasOwn(shape, key)) issues.push({ path: `${path}/${key}`, message: 'unknown property' });
      }
      for (const key of keys) {
        const field = shape[key] as AnySchema;
        const present = Object.hasOwn(input, key) && input[key] !== undefined;
        if (!present) {
          if (!field.optional) issues.push({ path: `${path}/${key}`, message: 'required' });
          continue;
        }
        out[key] = field.check(input[key], `${path}/${key}`, issues);
      }
      return out as InferShape<S>;
    },
    json() {
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const key of keys) {
        const field = shape[key] as AnySchema;
        properties[key] = field.json();
        if (!field.optional) required.push(key);
      }
      return describe({ type: 'object', properties, required, additionalProperties: false }, options.description);
    },
  };
}

function optional<T>(inner: Schema<T, false>): Schema<T, true> {
  return {
    kind: inner.kind,
    optional: true,
    description: inner.description,
    check: (value, path, issues) => inner.check(value, path, issues),
    json: () => inner.json(),
  };
}

/** The schema DSL. */
export const s = {
  object,
  string,
  number,
  boolean,
  enum: enumOf,
  array,
  optional,
} as const;

/** Validate an untrusted value. Errors carry every issue in `details.issues` (SF-CAP-002). */
export function validate<T>(schema: Schema<T, false>, value: unknown, label = 'value'): Result<T> {
  const issues: SchemaIssue[] = [];
  const parsed = schema.check(value, '', issues);
  if (issues.length === 0) return ok(parsed);
  const summary = issues
    .slice(0, 5)
    .map((issue) => `${issue.path === '' ? '/' : issue.path}: ${issue.message}`)
    .join('; ');
  return err(SchemaValidationError({ message: `Invalid ${label}: ${summary}`, details: { issues } }));
}

/** JSON Schema for agents / WebMCP (`inputSchema`, `outputSchema`). */
export function toJsonSchema(schema: AnySchema): JsonSchema {
  return schema.json();
}
