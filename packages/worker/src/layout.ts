/**
 * Declared binary layouts (R11.18, R11.19). One declaration generates:
 *
 * - **AoS struct views** (`layout.view(buffer)`) — typed-array accessors over a
 *   buffer with fixed byte offsets and stride; zero decode per frame;
 * - **SoA column sets** (`layout.columns({ capacity })`) — one typed column per
 *   field in one buffer (ECS component columns that a document worker, a Wasm
 *   engine and a renderer read in place);
 * - **C / Rust source** (`layout.source('c' | 'rust')`) with the exact same
 *   offsets for Wasm authors (`#[repr(C)]`, explicit padding, size asserts).
 *
 * Fields keep declaration order and natural alignment (C rules); padding is
 * explicit. Wasm is little-endian; views refuse to bind on big-endian hosts.
 *
 * @example
 * export const Particle = defineLayout({ name: 'Particle', fields: { x: 'f32', y: 'f32', id: 'u32' } });
 * const view = unwrap(Particle.view(buffer, { count: 1024 }));
 * const p = view.at(3); p.x += 1;            // flyweight cursor, no allocation
 * const cols = unwrap(Particle.columns({ capacity: 1024, shared: true }));
 * cols.column('x')[3] = 1;                    // SoA column (Float32Array)
 */
import { err, ok, type Result } from '@staticflux/core';
import { LayoutInvalidError, LayoutViewError } from './channel-errors.js';

// ---------------------------------------------------------------- scalar types

interface ScalarInfo {
  readonly size: number;
  readonly c: string;
  readonly rust: string;
  readonly ctor: TypedArrayConstructor;
}

type TypedArrayConstructor = new (buffer: ArrayBufferLike, byteOffset: number, length: number) => AnyTypedArray;

export type AnyTypedArray =
  | Float32Array
  | Float64Array
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | BigInt64Array
  | BigUint64Array;

const SCALARS = {
  f32: { size: 4, c: 'float', rust: 'f32', ctor: Float32Array },
  f64: { size: 8, c: 'double', rust: 'f64', ctor: Float64Array },
  i8: { size: 1, c: 'int8_t', rust: 'i8', ctor: Int8Array },
  u8: { size: 1, c: 'uint8_t', rust: 'u8', ctor: Uint8Array },
  i16: { size: 2, c: 'int16_t', rust: 'i16', ctor: Int16Array },
  u16: { size: 2, c: 'uint16_t', rust: 'u16', ctor: Uint16Array },
  i32: { size: 4, c: 'int32_t', rust: 'i32', ctor: Int32Array },
  u32: { size: 4, c: 'uint32_t', rust: 'u32', ctor: Uint32Array },
  i64: { size: 8, c: 'int64_t', rust: 'i64', ctor: BigInt64Array },
  u64: { size: 8, c: 'uint64_t', rust: 'u64', ctor: BigUint64Array },
} as const satisfies Record<string, ScalarInfo>;

export type ScalarType = keyof typeof SCALARS;
export const SCALAR_TYPES: readonly ScalarType[] = Object.keys(SCALARS) as ScalarType[];

/** Byte size of a scalar type. */
export function scalarSize(type: ScalarType): number {
  return SCALARS[type].size;
}

export type TypedArrayOf<T extends ScalarType> = T extends 'f32'
  ? Float32Array
  : T extends 'f64'
    ? Float64Array
    : T extends 'i8'
      ? Int8Array
      : T extends 'u8'
        ? Uint8Array
        : T extends 'i16'
          ? Int16Array
          : T extends 'u16'
            ? Uint16Array
            : T extends 'i32'
              ? Int32Array
              : T extends 'u32'
                ? Uint32Array
                : T extends 'i64'
                  ? BigInt64Array
                  : BigUint64Array;

export type ScalarValue<T extends ScalarType> = T extends 'i64' | 'u64' ? bigint : number;

/** A field: a scalar, or a fixed-size array of scalars (`{ type: 'f32', count: 16 }` for a mat4). */
export type FieldSpec = ScalarType | { readonly type: ScalarType; readonly count: number };
export type LayoutFields = Readonly<Record<string, FieldSpec>>;

export type SpecType<S> = S extends ScalarType ? S : S extends { readonly type: infer T extends ScalarType } ? T : never;

/** Value of a field through a cursor: scalars read/write; array fields are typed-array windows. */
export type FieldValue<S> = S extends ScalarType ? ScalarValue<S> : TypedArrayOf<SpecType<S>>;

/** Keys of scalar (non-array) fields. */
export type ScalarKeys<F extends LayoutFields> = { [K in keyof F]: F[K] extends ScalarType ? K : never }[keyof F] & string;

/** A struct record through a cursor (scalar fields are settable). */
export type LayoutRecord<F extends LayoutFields> = {
  -readonly [K in keyof F]: FieldValue<F[K]>;
};

export interface FieldInfo {
  readonly name: string;
  readonly type: ScalarType;
  readonly count: number;
  /** Byte offset inside the struct. */
  readonly offset: number;
  /** Total byte size (`scalarSize(type) * count`). */
  readonly size: number;
}

export interface LayoutDescription {
  readonly name: string;
  /** Sum of fields plus inner padding (no trailing padding). */
  readonly size: number;
  /** Bytes between consecutive structs (size rounded up to `align`). */
  readonly stride: number;
  readonly align: number;
  readonly fields: readonly FieldInfo[];
  /** Padding runs as `{ offset, size }` (inner and trailing). */
  readonly padding: readonly { readonly offset: number; readonly size: number }[];
}

export type SourceLanguage = 'c' | 'rust';

export interface ViewOptions {
  readonly byteOffset?: number;
  /** Number of structs. Default: as many as fit. */
  readonly count?: number;
}

export interface ColumnsOptions {
  readonly capacity: number;
  /** Existing memory (Wasm linear memory, SharedArrayBuffer). Default: a new buffer. */
  readonly buffer?: ArrayBufferLike;
  readonly byteOffset?: number;
  /** Allocate a SharedArrayBuffer (only when isolated — see `sharedMemoryAvailable`). */
  readonly shared?: boolean;
}

/** Array-of-structs view over a buffer. Indices are not bounds-checked (hot path). */
export interface StructView<F extends LayoutFields> {
  readonly layout: Layout<F>;
  readonly buffer: ArrayBufferLike;
  readonly byteOffset: number;
  readonly count: number;
  get<K extends ScalarKeys<F>>(index: number, field: K): FieldValue<F[K]>;
  set<K extends ScalarKeys<F>>(index: number, field: K, value: FieldValue<F[K]>): void;
  /** Typed-array window over field `field` of struct `index` (length = field count). Allocates. */
  elements<K extends keyof F & string>(index: number, field: K): TypedArrayOf<SpecType<F[K]>>;
  /** Shared flyweight cursor pointed at `index` (the same object every call — no allocation). */
  at(index: number): LayoutRecord<F>;
  /** An independent cursor; move it with `cursor.index = n`. */
  cursor(index?: number): LayoutCursor<F>;
  /** Plain-object copy of a struct (debugging, tests). */
  toObject(index: number): Record<keyof F, number | bigint | number[] | bigint[]>;
}

export type LayoutCursor<F extends LayoutFields> = LayoutRecord<F> & { index: number };

/** Struct-of-arrays columns in one buffer; each column starts on a 16-byte boundary. */
export interface ColumnSet<F extends LayoutFields> {
  readonly layout: Layout<F>;
  readonly buffer: ArrayBufferLike;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly capacity: number;
  /** Column of `field`: `capacity * count` elements. */
  column<K extends keyof F & string>(field: K): TypedArrayOf<SpecType<F[K]>>;
  /** Byte offset of the column relative to `byteOffset`. */
  offsetOf(field: keyof F & string): number;
  get<K extends ScalarKeys<F>>(row: number, field: K): FieldValue<F[K]>;
  set<K extends ScalarKeys<F>>(row: number, field: K, value: FieldValue<F[K]>): void;
}

export interface Layout<F extends LayoutFields = LayoutFields> {
  readonly kind: 'layout';
  readonly name: string;
  readonly fields: readonly FieldInfo[];
  readonly size: number;
  readonly stride: number;
  readonly align: number;
  field(name: keyof F & string): FieldInfo;
  /** Bytes for `count` structs (AoS). */
  byteLength(count: number): number;
  view(buffer: ArrayBufferLike, options?: ViewOptions): Result<StructView<F>>;
  /** Allocate a fresh buffer for `count` structs and view it. */
  allocate(count: number, options?: { readonly shared?: boolean }): StructView<F>;
  /** Bytes for an SoA column set of `capacity` rows (columns aligned to 16). */
  columnsByteLength(capacity: number): number;
  columns(options: ColumnsOptions): Result<ColumnSet<F>>;
  describe(): LayoutDescription;
  /** C (`<stdint.h>`) or Rust (`#[repr(C)]`) struct with identical offsets. */
  source(language: SourceLanguage, options?: { readonly name?: string }): string;
  /** C `#define`s / Rust `const`s with the SoA column offsets for `capacity` rows. */
  columnsSource(language: SourceLanguage, capacity: number, options?: { readonly name?: string }): string;
}

export interface LayoutDeclaration<F extends LayoutFields> {
  /** Struct name used in generated sources. Default `Layout`. */
  readonly name?: string;
  readonly fields: F;
  /** Minimum struct alignment (power of two, e.g. 16 for SIMD). Default: largest field alignment. */
  readonly align?: number;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const COLUMN_ALIGN = 16;

/** True on little-endian hosts (all mainstream browsers). Wasm memory is little-endian. */
export const PLATFORM_LITTLE_ENDIAN: boolean = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

const roundUp = (value: number, align: number): number => Math.ceil(value / align) * align;
const isPowerOfTwo = (n: number): boolean => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;

function invalid(message: string, details: Record<string, unknown>): never {
  throw LayoutInvalidError({ message, details });
}

function normalizeField(name: string, spec: FieldSpec): { type: ScalarType; count: number } {
  if (!IDENTIFIER.test(name)) invalid(`Layout field "${name}" is not an identifier.`, { field: name });
  const type = typeof spec === 'string' ? spec : spec.type;
  const count = typeof spec === 'string' ? 1 : spec.count;
  if (!(type in SCALARS)) invalid(`Layout field "${name}" has unknown type "${String(type)}".`, { field: name, type });
  if (!Number.isInteger(count) || count < 1) invalid(`Layout field "${name}" has invalid count ${String(count)}.`, { field: name, count });
  return { type, count };
}

/**
 * Declare a binary layout. Invalid declarations throw SF-WK-019 at module
 * evaluation (they are programming errors, like a syntax error).
 */
export function defineLayout<const F extends LayoutFields>(declaration: LayoutDeclaration<F>): Layout<F> {
  const name = declaration.name ?? 'Layout';
  if (!IDENTIFIER.test(name)) invalid(`Layout name "${name}" is not an identifier.`, { name });
  const entries = Object.entries(declaration.fields);
  if (entries.length === 0) invalid('A layout needs at least one field.', { name });
  const fields: FieldInfo[] = [];
  const padding: { offset: number; size: number }[] = [];
  let offset = 0;
  let naturalAlign = 1;
  for (const [fieldName, spec] of entries) {
    const { type, count } = normalizeField(fieldName, spec);
    const elementSize = SCALARS[type].size;
    const aligned = roundUp(offset, elementSize);
    if (aligned > offset) padding.push({ offset, size: aligned - offset });
    fields.push(Object.freeze({ name: fieldName, type, count, offset: aligned, size: elementSize * count }));
    offset = aligned + elementSize * count;
    naturalAlign = Math.max(naturalAlign, elementSize);
  }
  if (declaration.align !== undefined && !isPowerOfTwo(declaration.align)) {
    invalid(`Layout align ${String(declaration.align)} is not a power of two.`, { name, align: declaration.align });
  }
  const align = Math.max(naturalAlign, declaration.align ?? 1);
  const size = offset;
  const stride = roundUp(size, align);
  if (stride > size) padding.push({ offset: size, size: stride - size });
  const byName = new Map(fields.map((f) => [f.name, f]));

  const description: LayoutDescription = Object.freeze({
    name,
    size,
    stride,
    align,
    fields: Object.freeze(fields),
    padding: Object.freeze(padding.map((p) => Object.freeze(p))),
  });

  const columnLayout = (capacity: number): { offsets: Map<string, number>; byteLength: number } => {
    const offsets = new Map<string, number>();
    let cursor = 0;
    for (const f of fields) {
      cursor = roundUp(cursor, COLUMN_ALIGN);
      offsets.set(f.name, cursor);
      cursor += f.size * capacity;
    }
    return { offsets, byteLength: roundUp(cursor, COLUMN_ALIGN) };
  };

  const layout: Layout<F> = {
    kind: 'layout',
    name,
    fields: description.fields,
    size,
    stride,
    align,
    field(fieldName) {
      const info = byName.get(fieldName);
      if (info === undefined) invalid(`Layout "${name}" has no field "${fieldName}".`, { name, field: fieldName });
      return info;
    },
    byteLength: (count) => stride * count,
    view: (buffer, options = {}) => createStructView(layout, byName, buffer, options),
    allocate(count, options = {}) {
      const bytes = stride * count;
      const buffer = options.shared === true ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
      const result = createStructView(layout, byName, buffer, { count });
      if (!result.ok) throw result.error;
      return result.value;
    },
    columnsByteLength: (capacity) => columnLayout(capacity).byteLength,
    columns: (options) => createColumnSet(layout, byName, columnLayout(options.capacity), options),
    describe: () => description,
    source: (language, options = {}) => structSource(description, language, options.name ?? name),
    columnsSource(language, capacity, options = {}) {
      return columnsSource(description, columnLayout(capacity), capacity, language, options.name ?? name);
    },
  };
  return Object.freeze(layout);
}

// ---------------------------------------------------------------- AoS view

interface BoundField {
  readonly info: FieldInfo;
  readonly array: AnyTypedArray;
  readonly strideElements: number;
  readonly offsetElements: number;
}

function checkRegion(
  buffer: ArrayBufferLike,
  byteOffset: number,
  byteLength: number,
  align: number,
  details: Record<string, unknown>,
): Result<void> {
  if (!PLATFORM_LITTLE_ENDIAN) {
    return err(LayoutViewError({ message: 'Binary layouts need a little-endian host (Wasm memory is little-endian).', details }));
  }
  if (!Number.isInteger(byteOffset) || byteOffset < 0 || byteOffset % align !== 0) {
    return err(LayoutViewError({ message: `byteOffset ${byteOffset} is not a multiple of ${align}.`, details }));
  }
  if (byteOffset + byteLength > buffer.byteLength) {
    return err(
      LayoutViewError({
        message: `Buffer too small: need ${byteOffset + byteLength} bytes, have ${buffer.byteLength}.`,
        details: { ...details, needed: byteOffset + byteLength, available: buffer.byteLength },
      }),
    );
  }
  return ok();
}

function createStructView<F extends LayoutFields>(
  layout: Layout<F>,
  byName: ReadonlyMap<string, FieldInfo>,
  buffer: ArrayBufferLike,
  options: ViewOptions,
): Result<StructView<F>> {
  const byteOffset = options.byteOffset ?? 0;
  const count = options.count ?? Math.max(0, Math.floor((buffer.byteLength - byteOffset) / layout.stride));
  if (!Number.isInteger(count) || count < 0) {
    return err(LayoutViewError({ message: `Invalid struct count ${String(count)}.`, details: { layout: layout.name } }));
  }
  const checked = checkRegion(buffer, byteOffset, count * layout.stride, layout.align, { layout: layout.name, byteOffset, count });
  if (!checked.ok) return checked;

  // One typed array per scalar type over the whole region; fields index into it.
  const arrays = new Map<ScalarType, AnyTypedArray>();
  const arrayOf = (type: ScalarType): AnyTypedArray => {
    let array = arrays.get(type);
    if (array === undefined) {
      const info = SCALARS[type];
      array = new (info.ctor as TypedArrayConstructor)(buffer, byteOffset, (count * layout.stride) / info.size);
      arrays.set(type, array);
    }
    return array;
  };
  const bound = new Map<string, BoundField>();
  for (const info of byName.values()) {
    const elementSize = SCALARS[info.type].size;
    bound.set(info.name, {
      info,
      array: arrayOf(info.type),
      strideElements: layout.stride / elementSize,
      offsetElements: info.offset / elementSize,
    });
  }
  const fieldOf = (field: string): BoundField => {
    const b = bound.get(field);
    if (b === undefined) throw LayoutViewError({ message: `Layout "${layout.name}" has no field "${field}".` });
    return b;
  };
  const indexOf = (b: BoundField, index: number): number => index * b.strideElements + b.offsetElements;
  const windowOf = (b: BoundField, index: number): AnyTypedArray => {
    const start = indexOf(b, index);
    return b.array.subarray(start, start + b.info.count);
  };

  const makeCursor = (initial: number): LayoutCursor<F> => {
    const state = { index: initial };
    const cursor = {} as Record<string, unknown>;
    Object.defineProperty(cursor, 'index', {
      get: () => state.index,
      set: (value: number) => {
        state.index = value;
      },
      enumerable: false,
    });
    for (const b of bound.values()) {
      if (b.info.count === 1) {
        Object.defineProperty(cursor, b.info.name, {
          get: () => b.array[indexOf(b, state.index)],
          set: (value: number | bigint) => {
            (b.array as unknown as (number | bigint)[])[indexOf(b, state.index)] = value;
          },
          enumerable: true,
        });
      } else {
        Object.defineProperty(cursor, b.info.name, { get: () => windowOf(b, state.index), enumerable: true });
      }
    }
    return cursor as LayoutCursor<F>;
  };
  const shared = makeCursor(0);

  const view: StructView<F> = {
    layout,
    buffer,
    byteOffset,
    count,
    get(index, field) {
      const b = fieldOf(field);
      return b.array[indexOf(b, index)] as FieldValue<F[typeof field]>;
    },
    set(index, field, value) {
      const b = fieldOf(field);
      (b.array as unknown as (number | bigint)[])[indexOf(b, index)] = value as number | bigint;
    },
    elements(index, field) {
      return windowOf(fieldOf(field), index) as TypedArrayOf<SpecType<F[typeof field]>>;
    },
    at(index) {
      shared.index = index;
      return shared;
    },
    cursor: (index = 0) => makeCursor(index),
    toObject(index) {
      const out: Record<string, number | bigint | number[] | bigint[]> = {};
      for (const b of bound.values()) {
        out[b.info.name] =
          b.info.count === 1
            ? (b.array[indexOf(b, index)] as number | bigint)
            : (Array.from(windowOf(b, index) as ArrayLike<number | bigint>) as number[] | bigint[]);
      }
      return out as Record<keyof F, number | bigint | number[] | bigint[]>;
    },
  };
  return ok(view);
}

// ---------------------------------------------------------------- SoA columns

function createColumnSet<F extends LayoutFields>(
  layout: Layout<F>,
  byName: ReadonlyMap<string, FieldInfo>,
  plan: { offsets: Map<string, number>; byteLength: number },
  options: ColumnsOptions,
): Result<ColumnSet<F>> {
  const { capacity } = options;
  if (!Number.isInteger(capacity) || capacity < 0) {
    return err(LayoutViewError({ message: `Invalid column capacity ${String(capacity)}.`, details: { layout: layout.name } }));
  }
  const byteOffset = options.byteOffset ?? 0;
  const buffer =
    options.buffer ?? (options.shared === true ? new SharedArrayBuffer(plan.byteLength) : new ArrayBuffer(plan.byteLength));
  const checked = checkRegion(buffer, byteOffset, plan.byteLength, COLUMN_ALIGN, { layout: layout.name, byteOffset, capacity });
  if (!checked.ok) return checked;
  const columns = new Map<string, AnyTypedArray>();
  for (const info of byName.values()) {
    const scalar = SCALARS[info.type];
    columns.set(info.name, new (scalar.ctor as TypedArrayConstructor)(buffer, byteOffset + (plan.offsets.get(info.name) ?? 0), capacity * info.count));
  }
  const columnOf = (field: string): AnyTypedArray => {
    const column = columns.get(field);
    if (column === undefined) throw LayoutViewError({ message: `Layout "${layout.name}" has no field "${field}".` });
    return column;
  };
  const strideOf = (field: string): number => byName.get(field)?.count ?? 1;
  return ok({
    layout,
    buffer,
    byteOffset,
    byteLength: plan.byteLength,
    capacity,
    column: (field) => columnOf(field) as TypedArrayOf<SpecType<F[typeof field]>>,
    offsetOf: (field) => {
      columnOf(field);
      return plan.offsets.get(field) ?? 0;
    },
    get: (row, field) => columnOf(field)[row * strideOf(field)] as FieldValue<F[typeof field]>,
    set(row, field, value) {
      (columnOf(field) as unknown as (number | bigint)[])[row * strideOf(field)] = value as number | bigint;
    },
  });
}

// ---------------------------------------------------------------- source generation

const HEADER = 'Generated by @staticflux/worker defineLayout — do not edit; regenerate from the TS declaration.';

function structSource(description: LayoutDescription, language: SourceLanguage, name: string): string {
  if (!IDENTIFIER.test(name)) invalid(`Struct name "${name}" is not an identifier.`, { name });
  // Interleave fields and padding in offset order.
  const items: { offset: number; line: (padIndex: number) => string; pad: boolean }[] = [];
  const raisedAlign = description.align > Math.max(...description.fields.map((f) => SCALARS[f.type].size));
  description.fields.forEach((f, i) => {
    const info = SCALARS[f.type];
    const alignAttr = i === 0 && raisedAlign && language === 'c' ? `_Alignas(${description.align}) ` : '';
    items.push({
      offset: f.offset,
      pad: false,
      line: () =>
        language === 'c'
          ? `  ${alignAttr}${info.c} ${f.name}${f.count > 1 ? `[${f.count}]` : ''}; /* offset ${f.offset}, ${f.size} bytes */`
          : `    pub ${f.name}: ${f.count > 1 ? `[${info.rust}; ${f.count}]` : info.rust}, // offset ${f.offset}, ${f.size} bytes`,
    });
  });
  for (const p of description.padding) {
    items.push({
      offset: p.offset,
      pad: true,
      line: (padIndex) =>
        language === 'c'
          ? `  uint8_t _pad${padIndex}[${p.size}]; /* offset ${p.offset} */`
          : `    pub _pad${padIndex}: [u8; ${p.size}], // offset ${p.offset}`,
    });
  }
  items.sort((a, b) => a.offset - b.offset || (a.pad === b.pad ? 0 : a.pad ? 1 : -1));
  let padIndex = 0;
  const body = items.map((item) => item.line(item.pad ? padIndex++ : padIndex)).join('\n');
  if (language === 'c') {
    return [
      `/* ${HEADER} */`,
      '#include <stdint.h>',
      `typedef struct ${name} {`,
      body,
      `} ${name};`,
      `_Static_assert(sizeof(${name}) == ${description.stride}, "${name}: size must be ${description.stride}");`,
      `_Static_assert(_Alignof(${name}) == ${description.align}, "${name}: align must be ${description.align}");`,
      '',
    ].join('\n');
  }
  return [
    `// ${HEADER}`,
    raisedAlign ? `#[repr(C, align(${description.align}))]` : '#[repr(C)]',
    '#[derive(Clone, Copy, Debug)]',
    `pub struct ${name} {`,
    body,
    '}',
    `const _: () = assert!(core::mem::size_of::<${name}>() == ${description.stride});`,
    `const _: () = assert!(core::mem::align_of::<${name}>() == ${description.align});`,
    '',
  ].join('\n');
}

function columnsSource(
  description: LayoutDescription,
  plan: { offsets: Map<string, number>; byteLength: number },
  capacity: number,
  language: SourceLanguage,
  name: string,
): string {
  if (!IDENTIFIER.test(name)) invalid(`Struct name "${name}" is not an identifier.`, { name });
  const prefix = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
  const constant = (key: string, value: number): string =>
    language === 'c' ? `#define ${prefix}_${key} ${value}u` : `pub const ${prefix}_${key}: usize = ${value};`;
  const lines = [
    language === 'c' ? `/* ${HEADER} (SoA columns) */` : `// ${HEADER} (SoA columns)`,
    constant('CAPACITY', capacity),
    constant('COLUMNS_BYTES', plan.byteLength),
    constant('COLUMN_ALIGN', COLUMN_ALIGN),
  ];
  for (const f of description.fields) {
    const key = f.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
    lines.push(constant(`${key}_OFFSET`, plan.offsets.get(f.name) ?? 0));
    lines.push(
      language === 'c'
        ? `/* ${f.name}: ${SCALARS[f.type].c}[${capacity * f.count}] */`
        : `// ${f.name}: [${SCALARS[f.type].rust}; ${capacity * f.count}]`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
