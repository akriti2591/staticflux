/**
 * Component definitions v2 (SF-Δ6): typed, versioned components with
 * migrations, a registry that validates property paths and generates JSON
 * Schema (for change-set validation and agent tools), and first-class `role`
 * and `name` node fields (IF-4.1).
 *
 * Property paths are `component.field` (and `component.field.key` for `map`
 * fields). Storage in a part follows the field type:
 * - scalars, `enum`, `ref`, `vec2`, `color`, `ticks`, `json`: one LWW register per path;
 * - `map`: one LWW register per key (`comp.field.key`), so concurrent key edits merge;
 * - `richtext`: a CRDT text at the path; `list`: a CRDT movable list at the path.
 *
 * Component ids and field names are part of the persisted format (IF-4.14):
 * changes are additive, or a version bump with a migration.
 *
 * @example
 * export const Spatial = defineComponent('spatial', { x: 'f64', y: 'f64', rotation: 'f64' }, { version: 1 });
 * export const Temporal = defineComponent('temporal', { start: 'ticks', duration: 'ticks' });
 * export const Style = defineComponent('style', { fill: 'color', blend: field.enum(['normal', 'multiply']), vars: field.map('f64') }, {
 *   version: 2,
 *   migrations: { 2: (v) => ({ ...v, fill: v['color'] ?? null, color: null }) },
 * });
 * const registry = createComponentRegistry({ version: 3, components: [Spatial, Temporal, Style], roles: ['headline', 'body'] });
 */
import { err, ok, type Result } from '@staticflux/core';
import type { PartOp, PropertyPath } from './crdt-v2.js';
import { InvalidFieldError, MigrationError, UnknownComponentError } from './errors.js';
import { isJsonValue, type JsonObject, type JsonValue } from './json.js';

// ---------------------------------------------------------------- field types

export type ScalarFieldType = 'f64' | 'i32' | 'u8' | 'bool' | 'string' | 'json' | 'ticks' | 'color' | 'vec2' | 'richtext';

export interface EnumField {
  readonly type: 'enum';
  readonly values: readonly string[];
}
export interface RefField {
  readonly type: 'ref';
  /** `node`: a NodeId string. `asset`: `{ asset, at? }` (blob id, or tree asset pinned / following). */
  readonly to: 'node' | 'asset';
}
export interface MapField {
  readonly type: 'map';
  readonly values: FieldSpec;
}
export interface ListField {
  readonly type: 'list';
  readonly items: FieldSpec;
}

export type FieldSpec = ScalarFieldType | EnumField | RefField | MapField | ListField;

/** Builders for parametric field types. */
export const field = {
  enum: <const V extends string>(values: readonly V[]): EnumField & { readonly values: readonly V[] } => Object.freeze({ type: 'enum', values }),
  ref: (to: 'node' | 'asset'): RefField => Object.freeze({ type: 'ref', to }),
  map: (values: FieldSpec): MapField => Object.freeze({ type: 'map', values }),
  list: (items: FieldSpec): ListField => Object.freeze({ type: 'list', items }),
} as const;

export type AssetRefValue = { readonly asset: string; readonly at?: string };

/** TypeScript value type of a field. */
export type FieldValueOf<F extends FieldSpec> = F extends 'f64' | 'i32' | 'u8' | 'ticks'
  ? number
  : F extends 'bool'
    ? boolean
    : F extends 'string' | 'color'
      ? string
      : F extends 'vec2'
        ? readonly [number, number]
        : F extends 'richtext'
          ? { readonly text: string; readonly spans: readonly { readonly start: number; readonly end: number; readonly marks: JsonObject }[] }
          : F extends EnumField
            ? F['values'][number]
            : F extends RefField
              ? F['to'] extends 'node'
                ? string
                : AssetRefValue
              : F extends MapField
                ? Readonly<Record<string, FieldValueOf<F['values']>>>
                : F extends ListField
                  ? readonly FieldValueOf<F['items']>[]
                  : JsonValue;

export type ComponentSchemaV2 = Readonly<Record<string, FieldSpec>>;
export type ComponentValuesV2<S extends ComponentSchemaV2> = { readonly [K in keyof S]: FieldValueOf<S[K]> };

/** A pure upgrade from version `n - 1` to `n` of one component's values (`null` removes a field). */
export type ComponentMigration = (values: Readonly<Record<string, JsonValue>>) => Readonly<Record<string, JsonValue>>;

export interface ComponentOptionsV2<S extends ComponentSchemaV2> {
  /** Current version (default 1). */
  readonly version?: number;
  /** `migrations[n]` upgrades version n-1 → n. Every step 2…version must exist. */
  readonly migrations?: Readonly<Record<number, ComponentMigration>>;
  /** Values assumed when a field has no local opinion (omitted from canonical parts). */
  readonly defaults?: Partial<ComponentValuesV2<S>>;
  readonly description?: string;
}

export interface ComponentDefinitionV2<Id extends string = string, S extends ComponentSchemaV2 = ComponentSchemaV2> {
  readonly kind: 'component/v2';
  readonly id: Id;
  readonly schema: S;
  readonly version: number;
  readonly migrations: Readonly<Record<number, ComponentMigration>>;
  readonly defaults: Readonly<Record<string, JsonValue>>;
  readonly description?: string;
}

const COMPONENT_ID = /^[a-z][A-Za-z0-9]*$/;
const FIELD_NAME = /^[a-z][A-Za-z0-9]*$/;

/**
 * Define a versioned component. Ids are plain identifiers (`spatial`, `audioMix`): they become the first
 * segment of property paths.
 */
/* @__NO_SIDE_EFFECTS__ */
export function defineComponent<const Id extends string, const S extends ComponentSchemaV2>(
  id: Id,
  schema: S,
  options: ComponentOptionsV2<S> = {},
): ComponentDefinitionV2<Id, S> {
  if (!COMPONENT_ID.test(id)) throw new Error(`defineComponent: "${id}" is not a valid component id (lowerCamel identifier).`);
  for (const name of Object.keys(schema)) {
    if (!FIELD_NAME.test(name)) throw new Error(`defineComponent: field "${id}.${name}" is not a valid field name.`);
  }
  const version = options.version ?? 1;
  if (!Number.isInteger(version) || version < 1) throw new Error(`defineComponent: "${id}" version must be an integer ≥ 1.`);
  const migrations = options.migrations ?? {};
  for (let v = 2; v <= version; v += 1) {
    if (typeof migrations[v] !== 'function') throw new Error(`defineComponent: "${id}" is missing the migration to version ${v}.`);
  }
  return Object.freeze({
    kind: 'component/v2',
    id,
    schema,
    version,
    migrations: Object.freeze({ ...migrations }),
    defaults: Object.freeze({ ...(options.defaults as Record<string, JsonValue> | undefined) }),
    ...(options.description === undefined ? {} : { description: options.description }),
  });
}

// ---------------------------------------------------------------- value validation

const COLOR = /^(#[0-9a-fA-F]{3,4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\([^()]*\)|[a-zA-Z]+)$/;
const COLOR_PATTERN = COLOR.source;

/** Check one value against a field spec. */
export function isFieldValueV2(spec: FieldSpec, value: unknown): boolean {
  if (typeof spec === 'string') {
    switch (spec) {
      case 'f64':
        return typeof value === 'number' && Number.isFinite(value);
      case 'i32':
        return typeof value === 'number' && Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff;
      case 'u8':
        return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255;
      case 'ticks':
        return typeof value === 'number' && Number.isSafeInteger(value);
      case 'bool':
        return typeof value === 'boolean';
      case 'string':
        return typeof value === 'string';
      case 'color':
        return typeof value === 'string' && COLOR.test(value);
      case 'vec2':
        return Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number' && Number.isFinite(n));
      case 'richtext': {
        if (typeof value !== 'object' || value === null) return false;
        const v = value as { text?: unknown; spans?: unknown };
        return typeof v.text === 'string' && Array.isArray(v.spans) && isJsonValue(v.spans);
      }
      case 'json':
        return isJsonValue(value);
    }
  }
  switch (spec.type) {
    case 'enum':
      return typeof value === 'string' && spec.values.includes(value);
    case 'ref':
      if (spec.to === 'node') return typeof value === 'string' && value.length > 0;
      return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { asset?: unknown }).asset === 'string' &&
        ((value as { at?: unknown }).at === undefined || typeof (value as { at?: unknown }).at === 'string') &&
        Object.keys(value).every((k) => k === 'asset' || k === 'at')
      );
    case 'map':
      return (
        typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every((v) => isFieldValueV2(spec.values, v))
      );
    case 'list':
      return Array.isArray(value) && value.every((v) => isFieldValueV2(spec.items, v));
  }
}

/** Where a field lives in a part. */
export function fieldStorage(spec: FieldSpec): 'register' | 'map' | 'text' | 'list' {
  if (spec === 'richtext') return 'text';
  if (typeof spec === 'object' && spec.type === 'map') return 'map';
  if (typeof spec === 'object' && spec.type === 'list') return 'list';
  return 'register';
}

// ---------------------------------------------------------------- JSON Schema

/** JSON Schema (2020-12) for one field. */
export function fieldJsonSchema(spec: FieldSpec): JsonObject {
  if (typeof spec === 'string') {
    switch (spec) {
      case 'f64':
        return { type: 'number' };
      case 'i32':
        return { type: 'integer', minimum: -0x80000000, maximum: 0x7fffffff };
      case 'u8':
        return { type: 'integer', minimum: 0, maximum: 255 };
      case 'ticks':
        return { type: 'integer', description: 'Time in integer ticks.' };
      case 'bool':
        return { type: 'boolean' };
      case 'string':
        return { type: 'string' };
      case 'color':
        return { type: 'string', pattern: COLOR_PATTERN, description: 'CSS Color 4 value.' };
      case 'vec2':
        return { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 };
      case 'richtext':
        return {
          type: 'object',
          properties: {
            text: { type: 'string' },
            spans: {
              type: 'array',
              items: {
                type: 'object',
                properties: { start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 0 }, marks: { type: 'object' } },
                required: ['start', 'end', 'marks'],
              },
            },
          },
          required: ['text', 'spans'],
        };
      case 'json':
        return {};
    }
  }
  switch (spec.type) {
    case 'enum':
      return { type: 'string', enum: [...spec.values] };
    case 'ref':
      return spec.to === 'node'
        ? { type: 'string', minLength: 1, description: 'Node id.' }
        : {
            type: 'object',
            properties: { asset: { type: 'string' }, at: { type: 'string' } },
            required: ['asset'],
            additionalProperties: false,
            description: 'Asset reference (pinned to a milestone with `at`, or following).',
          };
    case 'map':
      return { type: 'object', additionalProperties: fieldJsonSchema(spec.values) };
    case 'list':
      return { type: 'array', items: fieldJsonSchema(spec.items) };
  }
}

/** JSON Schema of one component's values. */
export function componentJsonSchema(component: ComponentDefinitionV2): JsonObject {
  const properties: Record<string, JsonValue> = {};
  for (const [name, spec] of Object.entries(component.schema)) properties[name] = fieldJsonSchema(spec);
  return {
    type: 'object',
    properties,
    additionalProperties: false,
    'x-version': component.version,
    ...(component.description === undefined ? {} : { description: component.description }),
  };
}

// ---------------------------------------------------------------- migrations

/** Upgrade one component's values from `from` to the component's current version. */
export function migrateComponentValues(
  component: ComponentDefinitionV2,
  values: Readonly<Record<string, JsonValue>>,
  from: number,
): Result<Readonly<Record<string, JsonValue>>> {
  if (!Number.isInteger(from) || from < 1 || from > component.version) {
    return err(MigrationError({ message: `"${component.id}" has no migration from version ${from} (current ${component.version}).`, details: { component: component.id, from } }));
  }
  let current = values;
  for (let v = from + 1; v <= component.version; v += 1) {
    const step = component.migrations[v] as ComponentMigration;
    try {
      const next = step(current);
      const cleaned: Record<string, JsonValue> = {};
      for (const [k, value] of Object.entries(next)) if (value !== null && value !== undefined) cleaned[k] = value;
      current = cleaned;
    } catch (cause) {
      return err(MigrationError({ message: `Migration of "${component.id}" to version ${v} threw.`, cause, details: { component: component.id, to: v } }));
    }
  }
  return ok(current);
}

// ---------------------------------------------------------------- registry

export interface ComponentRegistryOptions {
  /** The registry version (`treeSchema` in heads and canonical parts). Bump on every component version change. */
  readonly version: number;
  readonly components: readonly ComponentDefinitionV2[];
  /** Closed, extensible role enum (IF-4.1). Omitted: any string. */
  readonly roles?: readonly string[];
  /** Components each node kind may carry. Omitted: any component on any kind. */
  readonly kinds?: Readonly<Record<string, readonly string[]>>;
}

export interface ResolvedPath {
  readonly path: PropertyPath;
  /** `undefined` for first-class fields (`name`, `role`). */
  readonly component: ComponentDefinitionV2 | undefined;
  readonly field: string;
  readonly key?: string;
  /** Spec of the value written at this path (the map's value spec for `comp.field.key`). */
  readonly spec: FieldSpec;
  readonly storage: 'register' | 'text' | 'list';
}

export interface ComponentRegistry {
  readonly version: number;
  readonly components: readonly ComponentDefinitionV2[];
  readonly roles: readonly string[] | undefined;
  component(id: string): ComponentDefinitionV2 | undefined;
  resolve(path: PropertyPath): ResolvedPath | undefined;
  /** Validate one write (`null` = remove the opinion, always valid on a known path). */
  validate(path: PropertyPath, value: JsonValue, kind?: string): Result<void>;
  /** Validate the property writes in a batch of part ops (`kindOf` names existing nodes' kinds). */
  validateOps(ops: readonly PartOp[], kindOf?: (node: string) => string | undefined): Result<void>;
  /** Component versions, for canonical parts. */
  versions(): Readonly<Record<string, number>>;
  /** `{ $defs: { <component>: schema } }` plus the node kinds. */
  jsonSchema(): JsonObject;
  /** Schema of `Record<PropertyPath, value>` for change sets (`nullable`: allow `null` = remove). */
  pathSchema(options?: { readonly kind?: string; readonly nullable?: boolean }): JsonObject;
}

export function createComponentRegistry(options: ComponentRegistryOptions): ComponentRegistry {
  const byId = new Map<string, ComponentDefinitionV2>();
  for (const component of options.components) {
    if (byId.has(component.id)) throw new Error(`createComponentRegistry: duplicate component "${component.id}".`);
    byId.set(component.id, component);
  }
  const roles = options.roles;
  const kinds = options.kinds;

  const resolve = (path: PropertyPath): ResolvedPath | undefined => {
    if (path === 'name') return { path, component: undefined, field: 'name', spec: 'string', storage: 'register' };
    if (path === 'role') return { path, component: undefined, field: 'role', spec: roles === undefined ? 'string' : { type: 'enum', values: roles }, storage: 'register' };
    const [componentId, fieldName, ...rest] = path.split('.');
    const component = byId.get(componentId ?? '');
    if (component === undefined || fieldName === undefined) return undefined;
    const spec = component.schema[fieldName];
    if (spec === undefined) return undefined;
    const storage = fieldStorage(spec);
    if (storage === 'map') {
      if (rest.length === 0) return undefined; // maps are written per key
      return { path, component, field: fieldName, key: rest.join('.'), spec: (spec as MapField).values, storage: 'register' };
    }
    if (rest.length > 0) return undefined;
    return { path, component, field: fieldName, spec, storage };
  };

  const fieldError = (message: string, details: Record<string, unknown>): Result<never> => err(InvalidFieldError({ message, details }));

  const validate = (path: PropertyPath, value: JsonValue, kind?: string): Result<void> => {
    const resolved = resolve(path);
    if (resolved === undefined) {
      const componentId = path.split('.')[0] ?? '';
      if (!byId.has(componentId) && path !== 'name' && path !== 'role') {
        return err(UnknownComponentError({ message: `No component "${componentId}" in the registry (path "${path}").`, details: { path } }));
      }
      return fieldError(`Unknown property path "${path}".`, { path });
    }
    if (kind !== undefined && kinds !== undefined && resolved.component !== undefined) {
      const allowed = kinds[kind];
      if (allowed !== undefined && !allowed.includes(resolved.component.id)) {
        return fieldError(`Node kind "${kind}" cannot carry component "${resolved.component.id}".`, { path, kind });
      }
    }
    if (value === null) return ok();
    if (!isFieldValueV2(resolved.spec, value)) {
      return fieldError(`"${path}" expects ${describe(resolved.spec)}.`, { path, expected: describe(resolved.spec) });
    }
    return ok();
  };

  const validateOps = (ops: readonly PartOp[], kindOf?: (node: string) => string | undefined): Result<void> => {
    const kindsInBatch = new Map<string, string>();
    const kindOfNode = (node: string): string | undefined => kindsInBatch.get(node) ?? kindOf?.(node);
    const expect = (path: PropertyPath, storage: ResolvedPath['storage'], op: number): Result<void> => {
      const resolved = resolve(path);
      if (resolved === undefined) return fieldError(`Op ${op}: unknown property path "${path}".`, { path, op });
      if (resolved.storage !== storage) return fieldError(`Op ${op}: "${path}" is stored as ${resolved.storage}, not ${storage}.`, { path, op });
      return ok();
    };
    for (let i = 0; i < ops.length; i += 1) {
      const op = ops[i] as PartOp;
      let r: Result<void> = ok();
      switch (op.op) {
        case 'create':
          kindsInBatch.set(op.node, op.kind);
          for (const [path, value] of Object.entries(op.props ?? {})) {
            r = expect(path, 'register', i);
            if (r.ok) r = validate(path, value, op.kind);
            if (!r.ok) return r;
          }
          for (const [path, value] of Object.entries(op.texts ?? {})) {
            r = expect(path, 'text', i);
            if (r.ok) r = validate(path, value as unknown as JsonValue, op.kind);
            if (!r.ok) return r;
          }
          for (const [path, values] of Object.entries(op.lists ?? {})) {
            r = expect(path, 'list', i);
            if (r.ok) r = validate(path, values as JsonValue, op.kind);
            if (!r.ok) return r;
          }
          break;
        case 'set':
          r = expect(op.path, 'register', i);
          if (r.ok) r = validate(op.path, op.value, kindOfNode(op.node));
          break;
        case 'text.insert':
        case 'text.delete':
        case 'text.mark':
          r = expect(op.path, 'text', i);
          break;
        case 'list.insert':
        case 'list.set': {
          r = expect(op.path, 'list', i);
          const resolved = resolve(op.path);
          if (r.ok && resolved !== undefined && !isFieldValueV2((resolved.spec as ListField).items, op.value)) {
            r = fieldError(`Op ${i}: list "${op.path}" items expect ${describe((resolved.spec as ListField).items)}.`, { path: op.path, op: i });
          }
          break;
        }
        case 'list.delete':
        case 'list.move':
          r = expect(op.path, 'list', i);
          break;
        case 'move':
        case 'delete':
          break;
      }
      if (!r.ok) return r;
    }
    return ok();
  };

  const pathSchema = (opts: { readonly kind?: string; readonly nullable?: boolean } = {}): JsonObject => {
    const wrap = (schema: JsonObject): JsonObject => (opts.nullable === true ? { anyOf: [schema, { type: 'null' }] } : schema);
    const properties: Record<string, JsonValue> = {
      name: wrap({ type: 'string' }),
      role: wrap(roles === undefined ? { type: 'string' } : { type: 'string', enum: [...roles] }),
    };
    const patternProperties: Record<string, JsonValue> = {};
    const allowed = opts.kind !== undefined && kinds !== undefined ? kinds[opts.kind] : undefined;
    for (const component of byId.values()) {
      if (allowed !== undefined && !allowed.includes(component.id)) continue;
      for (const [name, spec] of Object.entries(component.schema)) {
        const storage = fieldStorage(spec);
        if (storage === 'map') {
          patternProperties[`^${component.id}\\.${name}\\..+$`] = wrap(fieldJsonSchema((spec as MapField).values));
        } else if (storage === 'register') {
          properties[`${component.id}.${name}`] = wrap(fieldJsonSchema(spec));
        }
      }
    }
    return { type: 'object', properties, patternProperties, additionalProperties: false };
  };

  return {
    version: options.version,
    components: [...byId.values()],
    roles,
    component: (id) => byId.get(id),
    resolve,
    validate,
    validateOps,
    versions: () => Object.fromEntries([...byId.values()].map((c) => [c.id, c.version])),
    jsonSchema() {
      const defs: Record<string, JsonValue> = {};
      for (const component of [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) defs[component.id] = componentJsonSchema(component);
      return {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        'x-treeSchema': options.version,
        $defs: defs,
        ...(roles === undefined ? {} : { 'x-roles': [...roles] }),
        ...(kinds === undefined ? {} : { 'x-kinds': Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, [...v]])) }),
      };
    },
    pathSchema,
  };
}

function describe(spec: FieldSpec): string {
  if (typeof spec === 'string') return spec;
  switch (spec.type) {
    case 'enum':
      return `one of ${spec.values.join(' | ')}`;
    case 'ref':
      return `a ${spec.to} reference`;
    case 'map':
      return `a map of ${describe(spec.values)}`;
    case 'list':
      return `a list of ${describe(spec.items)}`;
  }
}
