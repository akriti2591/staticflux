/**
 * Binary render projection (SF-Δ25, ARCHITECTURE §3.1/§4): document v2 → the payloads of
 * the scene delta stream (`@staticflux/worker/pipeline` `defineDeltaStream`) that the
 * render module applies. The editor module owns a **projector** over its part; the render
 * module owns a **scene store** that decodes the same payloads into SoA columns. Neither
 * side shares objects: the wire format below is the whole contract.
 *
 * - `defineRenderProjection({ id, kinds, fields })` declares which node kinds are drawn and
 *   which numeric property paths become columns (`spatial.x` → `x: f64` …).
 * - Nodes get dense **slots** (reused after delete), so the renderer indexes arrays, never
 *   strings. Structure records (create / move / snapshot) also carry the node id, parent slot
 *   and fractional order key.
 * - `projector.project(change, { supersedes })` turns one `PartChange` into one delta
 *   payload; `supersedes` lists the gesture ids whose overlays this delta replaces (E-2).
 *   `projector.snapshot()` encodes every projected node (resnapshot, E-1).
 *
 * Wire format (format 1, little-endian):
 *   0 u32 magic 'SFRP' · 4 u16 format · 6 u16 schema version · 8 u32 projection hash · 12 u8 kind (1 delta,
 *   2 snapshot) · 13..15 reserved · 16 u32 supersedes · 20 u32 deletes · 24 u32 upserts · 28 reserved ·
 *   32 u32 gesture ids · u32 deleted slots · (pad 8) · upserts: u32 slot · u32 parent slot (0xFFFFFFFF none) ·
 *   u16 kind code · u8 flags (1 = structure) · u8 0 · [u16 id bytes · u16 order bytes · UTF-8 id · UTF-8 order] ·
 *   (pad 8) · f64 × fields (declaration order). Deletes apply before upserts (a freed slot may be reused).
 *
 * @example
 * export const Scene = defineRenderProjection({ id: 'app/scene', kinds: ['shape'], fields: { x: { path: 'spatial.x' }, y: { path: 'spatial.y' } } });
 * const projector = createRenderProjector(Scene, part);                 // editor module
 * deltas.snapshot({ version: 0, payload: projector.snapshot() });
 * const payload = projector.project(commit.change, { supersedes: [gestureId] });
 * const scene = createSceneStore(Scene);                                  // render module
 * reader.apply((record) => scene.apply(record.payload), { upTo: frame.docVersion });
 */
import { err, ok, type Result } from '@staticflux/core';
import type { DocumentCRDTv2, NodeId, NodeRecord, PartChange, PropertyPath } from './crdt-v2.js';
import { ProjectionMismatchError, ProjectionPayloadError } from './errors.js';

export const PROJECTION_MAGIC = 0x50524653; // 'SFRP' little-endian
export const PROJECTION_FORMAT = 1;
export const PROJECTION_HEADER_BYTES = 32;
/** Parent slot of a node whose parent is not projected (or the root). */
export const NO_SLOT = 0xffffffff;

const KIND_DELTA = 1;
const KIND_SNAPSHOT = 2;
const FLAG_STRUCTURE = 1;

export type ProjectedFieldType = 'f64' | 'f32' | 'i32' | 'u32';

export interface ProjectedFieldSpec {
  readonly path: PropertyPath;
  /** Column type in the scene store (the wire always carries f64). Default 'f64'. */
  readonly type?: ProjectedFieldType;
  /** Value when the property is absent or not a number. Default 0. */
  readonly default?: number;
}

export interface ProjectedField {
  readonly name: string;
  readonly path: PropertyPath;
  readonly type: ProjectedFieldType;
  readonly default: number;
}

export interface RenderProjection<F extends string = string> {
  readonly kind: 'render-projection';
  readonly id: string;
  readonly version: number;
  /** Projected node kinds; the index is the kind code on the wire. */
  readonly kinds: readonly string[];
  readonly fields: readonly ProjectedField[];
  readonly fieldIndex: Readonly<Record<F, number>>;
  /** FNV-1a of id, kinds and fields: both ends must agree. */
  readonly hash: number;
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Declare a render projection. Throws at definition time for malformed declarations (like `defineComponent`). */
export function defineRenderProjection<const F extends Readonly<Record<string, ProjectedFieldSpec>>>(declaration: {
  readonly id: string;
  readonly version?: number;
  readonly kinds: readonly string[];
  readonly fields: F;
}): RenderProjection<keyof F & string> {
  const names = Object.keys(declaration.fields);
  if (declaration.kinds.length === 0 || declaration.kinds.length > 0xffff) throw ProjectionMismatchError({ message: `Render projection "${declaration.id}" needs 1–65535 kinds.` });
  if (new Set(declaration.kinds).size !== declaration.kinds.length) throw ProjectionMismatchError({ message: `Render projection "${declaration.id}" lists a kind twice.` });
  const fields = names.map((name): ProjectedField => {
    const spec = declaration.fields[name] as ProjectedFieldSpec;
    return { name, path: spec.path, type: spec.type ?? 'f64', default: spec.default ?? 0 };
  });
  const fieldIndex = Object.fromEntries(names.map((name, i) => [name, i])) as Record<keyof F & string, number>;
  const version = declaration.version ?? 1;
  const hash = fnv1a(`${declaration.id}|${version}|${declaration.kinds.join(',')}|${fields.map((f) => `${f.name}:${f.path}:${f.type}:${f.default}`).join(',')}`);
  return Object.freeze({ kind: 'render-projection', id: declaration.id, version, kinds: Object.freeze([...declaration.kinds]), fields: Object.freeze(fields), fieldIndex: Object.freeze(fieldIndex), hash });
}

/** A property value as a projected number (finite numbers as is, booleans 0/1, anything else the default). */
export function projectValue(value: unknown, fallback: number): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return fallback;
}

// ---------------------------------------------------------------- encoding

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const pad8 = (n: number): number => (n + 7) & ~7;

interface Upsert {
  readonly slot: number;
  readonly parent: number;
  readonly kind: number;
  readonly structure: { readonly id: Uint8Array; readonly order: Uint8Array } | undefined;
  readonly values: readonly number[];
}

function encodePayload(projection: RenderProjection, kind: number, supersedes: readonly number[], deletes: readonly number[], upserts: readonly Upsert[]): Uint8Array {
  const fieldBytes = projection.fields.length * 8;
  let size = pad8(PROJECTION_HEADER_BYTES + 4 * (supersedes.length + deletes.length));
  // Every upsert starts 8-aligned: 12-byte head, then 4 bytes of padding or the structure block (padded).
  for (const u of upserts) size += (u.structure === undefined ? 16 : pad8(16 + u.structure.id.byteLength + u.structure.order.byteLength)) + fieldBytes;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, PROJECTION_MAGIC, true);
  view.setUint16(4, PROJECTION_FORMAT, true);
  view.setUint16(6, projection.version, true);
  view.setUint32(8, projection.hash, true);
  view.setUint8(12, kind);
  view.setUint32(16, supersedes.length, true);
  view.setUint32(20, deletes.length, true);
  view.setUint32(24, upserts.length, true);
  let at = PROJECTION_HEADER_BYTES;
  for (const g of supersedes) {
    view.setUint32(at, g >>> 0, true);
    at += 4;
  }
  for (const slot of deletes) {
    view.setUint32(at, slot, true);
    at += 4;
  }
  at = pad8(at);
  for (const u of upserts) {
    view.setUint32(at, u.slot, true);
    view.setUint32(at + 4, u.parent, true);
    view.setUint16(at + 8, u.kind, true);
    view.setUint8(at + 10, u.structure === undefined ? 0 : FLAG_STRUCTURE);
    at += 12;
    if (u.structure !== undefined) {
      view.setUint16(at, u.structure.id.byteLength, true);
      view.setUint16(at + 2, u.structure.order.byteLength, true);
      out.set(u.structure.id, at + 4);
      out.set(u.structure.order, at + 4 + u.structure.id.byteLength);
      at = pad8(at + 4 + u.structure.id.byteLength + u.structure.order.byteLength);
    } else {
      at += 4; // keeps the values 8-aligned
    }
    for (const value of u.values) {
      view.setFloat64(at, value, true);
      at += 8;
    }
  }
  return out;
}

// ---------------------------------------------------------------- projector (editor module)

export interface ProjectOptions {
  /** Gesture ids whose overlays this delta supersedes (E-2: overlay off, committed on, in one frame). */
  readonly supersedes?: readonly number[];
}

export interface RenderProjector {
  readonly projection: RenderProjection;
  /** Projected nodes. */
  readonly size: number;
  /** Encode every projected node (snapshot payload). Slots of known nodes are kept. */
  snapshot(): Uint8Array;
  /** Encode one change. Returns undefined when nothing projected changed and nothing is superseded. */
  project(change: PartChange, options?: ProjectOptions): Uint8Array | undefined;
  slotOf(node: NodeId): number | undefined;
  nodeOf(slot: number): NodeId | undefined;
  /** Current values of a projected node (by field order), for checks and hit-test reads. */
  values(node: NodeId): readonly number[] | undefined;
}

export interface RenderProjectorOptions {
  /** Extra filter on top of `kinds` (e.g. hidden nodes). */
  readonly include?: (node: NodeRecord) => boolean;
}

/** The editor-side projector over one part (see the module header). */
export function createRenderProjector(projection: RenderProjection, part: DocumentCRDTv2, options: RenderProjectorOptions = {}): RenderProjector {
  const kindCodes = new Map(projection.kinds.map((kind, i) => [kind, i]));
  const slots = new Map<NodeId, number>();
  const nodes: (NodeId | undefined)[] = [];
  const free: number[] = [];
  const fieldPaths = new Set(projection.fields.map((f) => f.path));

  const projected = (record: NodeRecord | undefined): record is NodeRecord =>
    record !== undefined && kindCodes.has(record.kind) && (options.include === undefined || options.include(record));
  const allocate = (node: NodeId): number => {
    const existing = slots.get(node);
    if (existing !== undefined) return existing;
    const slot = free.length > 0 ? (free.pop() as number) : nodes.length;
    slots.set(node, slot);
    nodes[slot] = node;
    return slot;
  };
  const release = (node: NodeId): number | undefined => {
    const slot = slots.get(node);
    if (slot === undefined) return undefined;
    slots.delete(node);
    nodes[slot] = undefined;
    return slot;
  };
  const valuesOf = (record: NodeRecord): number[] => projection.fields.map((field) => projectValue(record.props[field.path], field.default));
  const upsert = (record: NodeRecord, structure: boolean): Upsert => ({
    slot: allocate(record.id),
    parent: record.parent === null ? NO_SLOT : (slots.get(record.parent) ?? NO_SLOT),
    kind: kindCodes.get(record.kind) as number,
    structure: structure ? { id: encoder.encode(record.id), order: encoder.encode(record.order) } : undefined,
    values: valuesOf(record),
  });

  return {
    projection,
    get size() {
      return slots.size;
    },
    snapshot() {
      const seen = new Set<NodeId>();
      const records: NodeRecord[] = [];
      part.forEachNode((record) => {
        if (!projected(record)) return;
        seen.add(record.id);
        records.push(record);
      });
      for (const node of [...slots.keys()]) if (!seen.has(node)) free.push(release(node) as number);
      // Parents first so parent slots resolve (forEachNode is depth-first from the root).
      for (const record of records) allocate(record.id);
      return encodePayload(projection, KIND_SNAPSHOT, [], [], records.map((record) => upsert(record, true)));
    },
    project(change, projectOptions = {}) {
      const supersedes = projectOptions.supersedes ?? [];
      const deletes: number[] = [];
      for (const node of change.deleted) {
        const slot = release(node);
        if (slot !== undefined) deletes.push(slot);
      }
      const structural = new Set<NodeId>([...change.created, ...change.moved]);
      const order: NodeId[] = [...structural];
      for (const [node, paths] of change.updated) if (!structural.has(node) && paths.some((path) => fieldPaths.has(path))) order.push(node);
      const upserts: Upsert[] = [];
      const freed: number[] = [];
      for (const node of order) {
        if (change.deleted.includes(node)) continue;
        const record = part.node(node);
        if (!projected(record)) {
          const slot = release(node); // e.g. now filtered out
          if (slot !== undefined) freed.push(slot);
          continue;
        }
        upserts.push(upsert(record, structural.has(node) || !slots.has(node)));
      }
      // Slots freed by deletes are reusable from the next change on (they were deleted before this change's upserts).
      free.push(...deletes, ...freed);
      deletes.push(...freed);
      if (deletes.length === 0 && upserts.length === 0 && supersedes.length === 0) return undefined;
      return encodePayload(projection, KIND_DELTA, supersedes, deletes, upserts);
    },
    slotOf: (node) => slots.get(node),
    nodeOf: (slot) => nodes[slot],
    values(node) {
      const record = slots.has(node) ? part.node(node) : undefined;
      return record === undefined ? undefined : valuesOf(record);
    },
  };
}

// ---------------------------------------------------------------- scene store (render module)

export type ProjectedColumn = Float64Array | Float32Array | Int32Array | Uint32Array;

export interface SceneApplyReport {
  readonly kind: 'delta' | 'snapshot';
  readonly upserts: number;
  readonly deletes: number;
  /** Gesture ids superseded by this payload (copy). */
  readonly supersedes: readonly number[];
}

export interface SceneStore<F extends string = string> {
  readonly projection: RenderProjection<F>;
  /** Allocated slots (columns have at least this length). */
  readonly capacity: number;
  /** One past the highest slot ever used. */
  readonly slots: number;
  /** Live projected nodes. */
  readonly count: number;
  /** Bumped whenever columns are reallocated (backends re-fetch column views). */
  readonly layout: number;
  /** Decode one payload (snapshot replaces everything). */
  apply(payload: Uint8Array): Result<SceneApplyReport>;
  column(field: F): ProjectedColumn;
  alive(slot: number): boolean;
  kindOf(slot: number): string | undefined;
  parentOf(slot: number): number;
  idOf(slot: number): NodeId | undefined;
  orderOf(slot: number): string | undefined;
  /** Visit live slots in slot order. */
  forEach(visit: (slot: number) => void): void;
  clear(): void;
}

const COLUMN_TYPES = { f64: Float64Array, f32: Float32Array, i32: Int32Array, u32: Uint32Array } as const;

/** The render-side store for one projection (see the module header). */
export function createSceneStore<F extends string>(projection: RenderProjection<F>, options: { readonly capacity?: number } = {}): SceneStore<F> {
  let capacity = Math.max(16, options.capacity ?? 1024);
  let columns: ProjectedColumn[] = [];
  let alive = new Uint8Array(0);
  let kinds = new Uint16Array(0);
  let parents = new Uint32Array(0);
  let ids: (NodeId | undefined)[] = [];
  let orders: (string | undefined)[] = [];
  let high = 0;
  let count = 0;
  let layout = 0;
  const allocate = (size: number): void => {
    const grow = <T extends ProjectedColumn | Uint8Array | Uint16Array | Uint32Array>(old: T, make: (n: number) => T): T => {
      const next = make(size);
      next.set(old.subarray(0, Math.min(old.length, size)) as never);
      return next;
    };
    columns = projection.fields.map((field, i) => grow(columns[i] ?? new COLUMN_TYPES[field.type](0), (n) => new COLUMN_TYPES[field.type](n)));
    alive = grow(alive, (n) => new Uint8Array(n));
    kinds = grow(kinds, (n) => new Uint16Array(n));
    parents = grow(parents, (n) => new Uint32Array(n).fill(NO_SLOT));
    capacity = size;
    layout += 1;
  };
  allocate(capacity);
  const ensure = (slot: number): void => {
    if (slot < capacity) return;
    let size = capacity;
    while (size <= slot) size *= 2;
    allocate(size);
  };
  const reset = (): void => {
    alive.fill(0);
    parents.fill(NO_SLOT);
    ids = [];
    orders = [];
    high = 0;
    count = 0;
  };
  const bad = (message: string): Result<SceneApplyReport> => err(ProjectionPayloadError({ message, details: { projection: projection.id } }));

  return {
    projection,
    get capacity() {
      return capacity;
    },
    get slots() {
      return high;
    },
    get count() {
      return count;
    },
    get layout() {
      return layout;
    },
    apply(payload) {
      if (payload.byteLength < PROJECTION_HEADER_BYTES) return bad('Payload shorter than its header.');
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      if (view.getUint32(0, true) !== PROJECTION_MAGIC || view.getUint16(4, true) !== PROJECTION_FORMAT) {
        return err(ProjectionMismatchError({ message: 'Not a render projection payload, or an unknown format.', details: { projection: projection.id } }));
      }
      if (view.getUint16(6, true) !== projection.version || view.getUint32(8, true) !== projection.hash) {
        return err(ProjectionMismatchError({ details: { projection: projection.id, version: view.getUint16(6, true), expectedVersion: projection.version } }));
      }
      const kind = view.getUint8(12) === KIND_SNAPSHOT ? 'snapshot' : 'delta';
      const nSup = view.getUint32(16, true);
      const nDel = view.getUint32(20, true);
      const nUp = view.getUint32(24, true);
      const fieldCount = projection.fields.length;
      let at = PROJECTION_HEADER_BYTES;
      if (at + 4 * (nSup + nDel) > payload.byteLength) return bad('Truncated payload (gesture ids or deletes).');
      const supersedes: number[] = [];
      for (let i = 0; i < nSup; i++, at += 4) supersedes.push(view.getUint32(at, true));
      if (kind === 'snapshot') reset();
      for (let i = 0; i < nDel; i++, at += 4) {
        const slot = view.getUint32(at, true);
        if (slot < capacity && alive[slot] === 1) {
          alive[slot] = 0;
          ids[slot] = undefined;
          orders[slot] = undefined;
          parents[slot] = NO_SLOT;
          count -= 1;
        }
      }
      at = pad8(at);
      for (let i = 0; i < nUp; i++) {
        if (at + 12 > payload.byteLength) return bad('Truncated upsert header.');
        const slot = view.getUint32(at, true);
        const parent = view.getUint32(at + 4, true);
        const kindCode = view.getUint16(at + 8, true);
        const flags = view.getUint8(at + 10);
        at += 12;
        if (kindCode >= projection.kinds.length || slot >= 1 << 26) return bad('Upsert with an unknown kind code or an out-of-range slot.');
        ensure(slot);
        if ((flags & FLAG_STRUCTURE) !== 0) {
          const idBytes = view.getUint16(at, true);
          const orderBytes = view.getUint16(at + 2, true);
          if (at + 4 + idBytes + orderBytes > payload.byteLength) return bad('Truncated structure record.');
          // Copy before decoding: payloads are views into a SharedArrayBuffer on the shared medium,
          // and browsers' TextDecoder refuses shared views (Node accepts them).
          const base = at + 4;
          ids[slot] = decoder.decode(payload.slice(base, base + idBytes));
          orders[slot] = decoder.decode(payload.slice(base + idBytes, base + idBytes + orderBytes));
          at = pad8(at + 4 + idBytes + orderBytes);
        } else {
          at += 4;
        }
        if (at + 8 * fieldCount > payload.byteLength) return bad('Truncated field values.');
        for (let f = 0; f < fieldCount; f++, at += 8) (columns[f] as ProjectedColumn)[slot] = view.getFloat64(at, true);
        if (alive[slot] !== 1) count += 1;
        alive[slot] = 1;
        kinds[slot] = kindCode;
        parents[slot] = parent;
        if (slot >= high) high = slot + 1;
      }
      return ok({ kind, upserts: nUp, deletes: nDel, supersedes });
    },
    column(field) {
      return columns[projection.fieldIndex[field]] as ProjectedColumn;
    },
    alive: (slot) => slot < capacity && alive[slot] === 1,
    kindOf: (slot) => (slot < capacity && alive[slot] === 1 ? projection.kinds[kinds[slot] as number] : undefined),
    parentOf: (slot) => (slot < capacity ? (parents[slot] as number) : NO_SLOT),
    idOf: (slot) => ids[slot],
    orderOf: (slot) => orders[slot],
    forEach(visit) {
      for (let slot = 0; slot < high; slot++) if (alive[slot] === 1) visit(slot);
    },
    clear: reset,
  };
}
