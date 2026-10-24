/**
 * ECS document model (R11.8, research §6): entities are ids, components are
 * typed data declared once, systems observe change sets.
 *
 * - Struct components use SoA storage: numeric/boolean fields live in typed
 *   arrays (Float64Array / Int32Array / Uint8Array) indexed by a dense row,
 *   strings and JSON in plain arrays. Systems can read whole columns.
 * - Text components hold CRDT-backed text (materialized here as strings).
 * - Entity ids are deterministic: `<client base36>-<counter base36>`.
 * - Queries return entity ids sorted by id, so every replica iterates in the
 *   same order. Visual order uses fractional keys (`keyBetween`).
 *
 * The World is a materialized view: the DocumentEngine is the only writer.
 */
import { err, ok, type Result } from '@staticflux/core';
import { InvalidFieldError } from './errors.js';

export type EntityId = string;
export type ComponentId = `${string}/${string}`;

export type FieldType = 'f64' | 'i32' | 'u8' | 'bool' | 'string' | 'json';

export type FieldValue<T extends FieldType> = T extends 'f64' | 'i32' | 'u8'
  ? number
  : T extends 'bool'
    ? boolean
    : T extends 'string'
      ? string
      : unknown;

export type ComponentSchema = Readonly<Record<string, FieldType>>;

export type ComponentValues<S extends ComponentSchema> = { readonly [K in keyof S]: FieldValue<S[K]> };

export interface StructComponent<Id extends ComponentId = ComponentId, S extends ComponentSchema = ComponentSchema> {
  readonly kind: 'component';
  readonly storage: 'struct';
  readonly id: Id;
  readonly schema: S;
  readonly defaults: ComponentValues<S>;
}

export interface TextComponent<Id extends ComponentId = ComponentId> {
  readonly kind: 'component';
  readonly storage: 'text';
  readonly id: Id;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyStructComponent = StructComponent<ComponentId, any>;
export type AnyComponent = AnyStructComponent | TextComponent;

function defaultFor(type: FieldType): unknown {
  switch (type) {
    case 'f64':
    case 'i32':
    case 'u8':
      return 0;
    case 'bool':
      return false;
    case 'string':
      return '';
    case 'json':
      return null;
  }
}

/**
 * @example
 * export const Transform = defineComponent('studio/transform', { x: 'f64', y: 'f64', w: 'f64', h: 'f64' });
 * export const Image = defineComponent('studio/image', { src: 'string', alt: 'string' });
 */
export function defineComponent<const Id extends ComponentId, const S extends ComponentSchema>(
  id: Id,
  schema: S,
  defaults: Partial<ComponentValues<S>> = {},
): StructComponent<Id, S> {
  const values: Record<string, unknown> = {};
  for (const [field, type] of Object.entries(schema)) values[field] = defaultFor(type);
  return Object.freeze({
    kind: 'component',
    storage: 'struct',
    id,
    schema,
    defaults: Object.freeze({ ...values, ...defaults }) as ComponentValues<S>,
  });
}

/** A collaborative text component (Yjs-backed). */
export function defineTextComponent<const Id extends ComponentId>(id: Id): TextComponent<Id> {
  return Object.freeze({ kind: 'component', storage: 'text', id });
}

/** Check one value against a field type. */
export function isFieldValue(type: FieldType, value: unknown): boolean {
  switch (type) {
    case 'f64':
      return typeof value === 'number';
    case 'i32':
      return typeof value === 'number' && Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff;
    case 'u8':
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255;
    case 'bool':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'json':
      return value === null || ['string', 'number', 'boolean', 'object'].includes(typeof value);
  }
}

/** Validate partial component values against the schema. */
export function validateValues(component: AnyStructComponent, values: Readonly<Record<string, unknown>>): Result<void> {
  for (const [field, value] of Object.entries(values)) {
    const type = (component.schema as ComponentSchema)[field];
    if (type === undefined) {
      return err(InvalidFieldError({ message: `Unknown field "${field}" on component "${component.id}".`, details: { component: component.id, field } }));
    }
    if (!isFieldValue(type, value)) {
      return err(InvalidFieldError({ message: `Field "${component.id}.${field}" expects ${type}.`, details: { component: component.id, field, type } }));
    }
  }
  return ok();
}

// ---------------------------------------------------------------- ids

export interface IdGenerator {
  readonly clientId: number;
  next(): EntityId;
  /** Make sure future ids are greater than an existing id of this client (after restore). */
  observe(id: EntityId): void;
}

export function createIdGenerator(clientId: number, start = 0): IdGenerator {
  let counter = start;
  const prefix = `${clientId.toString(36)}-`;
  return {
    clientId,
    next() {
      counter += 1;
      return `${prefix}${counter.toString(36)}`;
    },
    observe(id) {
      if (!id.startsWith(prefix)) return;
      const n = Number.parseInt(id.slice(prefix.length), 36);
      if (Number.isFinite(n) && n > counter) counter = n;
    },
  };
}

// ---------------------------------------------------------------- fractional keys

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * A key strictly between `a` and `b` (lexicographic), for ordering blocks
 * without renumbering (Figma-style fractional indexing). Ties between peers
 * that pick the same key are broken by entity id.
 */
export function keyBetween(a: string | undefined, b: string | undefined): string {
  const lo = a ?? '';
  const hi = b;
  if (hi !== undefined && lo >= hi) return `${lo}${DIGITS[18] as string}`; // degenerate input: append after lo
  const digit = (s: string, i: number): number => (i < s.length ? DIGITS.indexOf(s[i] as string) : 0);
  let key = '';
  let bounded = hi !== undefined;
  for (let i = 0; i < 4096; i += 1) {
    const l = digit(lo, i);
    const h = bounded ? digit(hi as string, i) : DIGITS.length;
    if (h - l > 1) return key + (DIGITS[Math.floor((l + h) / 2)] as string);
    key += DIGITS[l] as string;
    if (h - l === 1) bounded = false; // prefix now strictly below hi: upper bound is open
  }
  return `${key}${DIGITS[18] as string}`;
}

// ---------------------------------------------------------------- SoA store

type Column = Float64Array | Int32Array | Uint8Array | unknown[];

function makeColumn(type: FieldType, capacity: number): Column {
  switch (type) {
    case 'f64':
      return new Float64Array(capacity);
    case 'i32':
      return new Int32Array(capacity);
    case 'u8':
    case 'bool':
      return new Uint8Array(capacity);
    case 'string':
    case 'json':
      return new Array<unknown>(capacity);
  }
}

function grow(column: Column, capacity: number): Column {
  if (Array.isArray(column)) {
    column.length = capacity;
    return column;
  }
  const next = new (column.constructor as new (n: number) => Float64Array | Int32Array | Uint8Array)(capacity);
  next.set(column);
  return next;
}

export interface StructStore<S extends ComponentSchema = ComponentSchema> {
  readonly component: StructComponent<ComponentId, S>;
  readonly size: number;
  has(entity: EntityId): boolean;
  get(entity: EntityId): ComponentValues<S> | undefined;
  /** Dense row of an entity (for column access), or undefined. */
  row(entity: EntityId): number | undefined;
  /** Entity at a dense row. */
  entityAt(row: number): EntityId | undefined;
  /** Raw SoA column (`size` valid rows). Booleans are stored as 0/1. */
  column<K extends keyof S & string>(field: K): Readonly<Column>;
  entities(): readonly EntityId[];
}

interface WritableStructStore<S extends ComponentSchema> extends StructStore<S> {
  write(entity: EntityId, values: Readonly<Record<string, unknown>>): void;
  delete(entity: EntityId): void;
}

function createStructStore<S extends ComponentSchema>(component: StructComponent<ComponentId, S>): WritableStructStore<S> {
  const fields = Object.entries(component.schema) as [string, FieldType][];
  let capacity = 8;
  const columns = new Map<string, Column>(fields.map(([field, type]) => [field, makeColumn(type, capacity)]));
  const rows = new Map<EntityId, number>();
  const ids: EntityId[] = [];

  const read = (row: number, field: string, type: FieldType): unknown => {
    const value = (columns.get(field) as Column)[row];
    return type === 'bool' ? value === 1 : value;
  };
  const writeCell = (row: number, field: string, type: FieldType, value: unknown): void => {
    const column = columns.get(field) as Column;
    (column as unknown[])[row] = type === 'bool' ? (value === true ? 1 : 0) : value;
  };

  return {
    component,
    get size() {
      return ids.length;
    },
    has: (entity) => rows.has(entity),
    row: (entity) => rows.get(entity),
    entityAt: (row) => ids[row],
    get(entity) {
      const row = rows.get(entity);
      if (row === undefined) return undefined;
      const out: Record<string, unknown> = {};
      for (const [field, type] of fields) out[field] = read(row, field, type);
      return out as ComponentValues<S>;
    },
    column: (field) => columns.get(field) as Column,
    entities: () => [...ids].sort(),
    write(entity, values) {
      let row = rows.get(entity);
      if (row === undefined) {
        row = ids.length;
        if (row >= capacity) {
          capacity *= 2;
          for (const [field, column] of columns) columns.set(field, grow(column, capacity));
        }
        ids.push(entity);
        rows.set(entity, row);
        for (const [field, type] of fields) writeCell(row, field, type, (component.defaults as Record<string, unknown>)[field]);
      }
      for (const [field, type] of fields) {
        if (field in values) writeCell(row, field, type, values[field]);
      }
    },
    delete(entity) {
      const row = rows.get(entity);
      if (row === undefined) return;
      const last = ids.length - 1;
      const moved = ids[last] as EntityId;
      if (row !== last) {
        for (const [field, type] of fields) writeCell(row, field, type, read(last, field, type));
        ids[row] = moved;
        rows.set(moved, row);
      }
      ids.pop();
      rows.delete(entity);
      for (const [field, type] of fields) {
        if (type === 'string' || type === 'json') (columns.get(field) as unknown[])[last] = undefined;
      }
    },
  };
}

// ---------------------------------------------------------------- world

export interface QueryOptions {
  readonly without?: readonly AnyComponent[];
}

export interface World {
  readonly components: readonly AnyComponent[];
  has(entity: EntityId): boolean;
  /** All entities, sorted by id. */
  entities(): readonly EntityId[];
  component(id: string): AnyComponent | undefined;
  get<S extends ComponentSchema>(entity: EntityId, component: StructComponent<ComponentId, S>): ComponentValues<S> | undefined;
  text(entity: EntityId, component: TextComponent): string | undefined;
  hasComponent(entity: EntityId, component: AnyComponent): boolean;
  store<S extends ComponentSchema>(component: StructComponent<ComponentId, S>): StructStore<S>;
  /** Entities having every component (and none of `without`), sorted by id. */
  query(components: readonly AnyComponent[], options?: QueryOptions): readonly EntityId[];
}

/** Write access for the engine (materialization only). */
export interface WorldWriter extends World {
  addEntity(entity: EntityId): void;
  removeEntity(entity: EntityId): void;
  writeStruct(entity: EntityId, component: AnyStructComponent, values: Readonly<Record<string, unknown>>): void;
  writeText(entity: EntityId, component: TextComponent, text: string): void;
  removeComponent(entity: EntityId, component: AnyComponent): void;
}

export function createWorld(components: readonly AnyComponent[]): WorldWriter {
  const byId = new Map<string, AnyComponent>(components.map((c) => [c.id, c]));
  const entities = new Set<EntityId>();
  const structs = new Map<string, WritableStructStore<ComponentSchema>>();
  const texts = new Map<string, Map<EntityId, string>>();
  for (const component of components) {
    if (component.storage === 'struct') structs.set(component.id, createStructStore(component));
    else texts.set(component.id, new Map());
  }

  const hasComponent = (entity: EntityId, component: AnyComponent): boolean =>
    component.storage === 'struct' ? (structs.get(component.id)?.has(entity) ?? false) : (texts.get(component.id)?.has(entity) ?? false);

  return {
    components,
    has: (entity) => entities.has(entity),
    entities: () => [...entities].sort(),
    component: (id) => byId.get(id),
    get(entity, component) {
      return structs.get(component.id)?.get(entity) as ComponentValues<never> | undefined;
    },
    text(entity, component) {
      return texts.get(component.id)?.get(entity);
    },
    hasComponent,
    store(component) {
      return structs.get(component.id) as unknown as StructStore<never>;
    },
    query(required, options = {}) {
      const without = options.without ?? [];
      if (required.length === 0) return [...entities].filter((e) => without.every((c) => !hasComponent(e, c))).sort();
      // Iterate the smallest store.
      const sizes = required.map((c) => (c.storage === 'struct' ? (structs.get(c.id)?.size ?? 0) : (texts.get(c.id)?.size ?? 0)));
      const smallest = required[sizes.indexOf(Math.min(...sizes))] as AnyComponent;
      const candidates =
        smallest.storage === 'struct' ? (structs.get(smallest.id)?.entities() ?? []) : [...(texts.get(smallest.id)?.keys() ?? [])];
      return candidates
        .filter((e) => required.every((c) => hasComponent(e, c)) && without.every((c) => !hasComponent(e, c)))
        .sort();
    },
    addEntity(entity) {
      entities.add(entity);
    },
    removeEntity(entity) {
      entities.delete(entity);
      for (const store of structs.values()) store.delete(entity);
      for (const map of texts.values()) map.delete(entity);
    },
    writeStruct(entity, component, values) {
      structs.get(component.id)?.write(entity, values);
    },
    writeText(entity, component, text) {
      texts.get(component.id)?.set(entity, text);
    },
    removeComponent(entity, component) {
      if (component.storage === 'struct') structs.get(component.id)?.delete(entity);
      else texts.get(component.id)?.delete(entity);
    },
  };
}

// ---------------------------------------------------------------- systems

export interface SystemContext<C> {
  readonly world: World;
  /** Entities matching the system query, sorted by id. */
  readonly entities: readonly EntityId[];
  /** The change set that triggered this run. */
  readonly changes: C;
}

export interface System<C = unknown> {
  readonly id: `${string}/${string}`;
  readonly query: readonly AnyComponent[];
  /** Only run when a change touches one of these components (default: the query). */
  readonly watches?: readonly AnyComponent[];
  run(context: SystemContext<C>): void;
}

export function defineSystem<C = unknown>(system: System<C>): System<C> {
  return Object.freeze(system);
}
