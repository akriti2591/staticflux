/**
 * Canonical part encoding (SF-Δ6, DOCUMENT-FORMAT §6.2): an engine-independent,
 * deterministic JSON form of one part, canonicalized per RFC 8785, for
 * milestones, `.iflow` bundles and engine swaps. Two parts with the same
 * content produce the same bytes (and digest) on every peer and engine.
 *
 * - Nodes sorted by id; sibling `order` normalized to fixed-width rank keys
 *   (engine fractional indexes are internal).
 * - `props` grouped by component (`{ spatial: { x: 1 } }`), local opinions only;
 *   with a registry, values equal to component defaults are omitted and `map`
 *   fields nest (`{ style: { vars: { gap: 4 } } }`).
 * - Rich text as `{ text, spans }`, lists as arrays. Paths unknown to the
 *   registry keep their storage with `{ "$text": … }` / `{ "$list": … }`.
 * - CRDT metadata (peers, history, tree ids) is excluded.
 *
 * `buildPartFromCanonical` rebuilds a fresh CRDT (new peer, one commit of
 * history) — "New document from milestone" (§6.1) — after `parse → migrate`.
 */
import { err, ok, type Result } from '@staticflux/core';
import { type ComponentRegistry, migrateComponentValues } from './components.js';
import type { CrdtEngine, DocumentCRDTv2, NodeId, PartOp, PeerId, PropertyPath, RichTextValue, TransactionMeta } from './crdt-v2.js';
import { CanonicalEncodingError, MigrationError } from './errors.js';
import { canonicalJsonBytes, isJsonValue, type JsonObject, type JsonValue, sha256Digest } from './json.js';

export interface CanonicalNode {
  readonly id: NodeId;
  readonly kind: string;
  readonly name?: string;
  readonly role?: string;
  readonly parent: NodeId | null;
  readonly order: string;
  readonly props: Readonly<Record<string, JsonObject>>;
}

export interface CanonicalPart {
  readonly schema: string;
  readonly part: string;
  /** Registry version the part was written with. */
  readonly treeSchema: number;
  /** Component versions the part was written with (additive field: needed to migrate on read). */
  readonly components?: Readonly<Record<string, number>>;
  readonly nodes: readonly CanonicalNode[];
}

export interface CanonicalEncodeOptions {
  /** Part id (`root`, `page:<id>`, …). */
  readonly part: string;
  /** Record schema string (the app's, e.g. `instaflow.part/1`). Default `sf.part/1`. */
  readonly schema?: string;
  readonly registry?: ComponentRegistry;
  /** Default: the registry version, else 1. */
  readonly treeSchema?: number;
}

export interface EncodedPart {
  readonly part: CanonicalPart;
  /** RFC 8785 bytes. */
  readonly bytes: Uint8Array;
}

const TEXT_MARKER = '$text';
const LIST_MARKER = '$list';
/** Pseudo-component for top-level paths without a component segment (other than `name` / `role`). */
const LOOSE = '$';

/** Fixed-width rank keys: sortable, deterministic, independent of the engine's fractional index. */
export function rankKeys(count: number): readonly string[] {
  let width = 1;
  while (36 ** width < count) width += 1;
  return Array.from({ length: count }, (_, i) => `a${i.toString(36).padStart(width, '0')}`);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function sortedSpans(value: RichTextValue): JsonObject {
  const spans = [...value.spans].sort((x, y) => x.start - y.start || x.end - y.end).map((s) => ({ start: s.start, end: s.end, marks: s.marks as JsonObject }));
  return { text: value.text, spans };
}

/** Encode one part canonically (O(part size); call per part, never on a whole multi-part document at once). */
export function encodeCanonicalPart(crdt: DocumentCRDTv2, options: CanonicalEncodeOptions): Result<EncodedPart> {
  const registry = options.registry;
  const nodes: CanonicalNode[] = [];
  const childrenOf = new Map<NodeId | null, NodeId[]>();
  const records: { id: NodeId; kind: string; parent: NodeId | null; name?: string; role?: string; props: Record<string, Record<string, JsonValue>> }[] = [];
  let failure: Result<never> | undefined;

  const place = (props: Record<string, Record<string, JsonValue>>, path: PropertyPath, value: JsonValue, storage: 'register' | 'text' | 'list'): void => {
    const dot = path.indexOf('.');
    const componentId = dot < 0 ? LOOSE : path.slice(0, dot);
    const rest = dot < 0 ? path : path.slice(dot + 1);
    const resolved = registry?.resolve(path);
    const component = (props[componentId] ??= {});
    if (resolved?.component !== undefined && resolved.storage === storage) {
      if (resolved.key !== undefined) {
        const map = (component[resolved.field] ??= {}) as Record<string, JsonValue>;
        map[resolved.key] = value;
        return;
      }
      const fallback = resolved.component.defaults[resolved.field];
      if (storage === 'register' && fallback !== undefined && deepEqual(fallback, value)) return;
      component[resolved.field] = value;
      return;
    }
    // Unknown to the registry (or no registry): keep the path tail and the storage kind.
    component[rest] = storage === 'text' ? { [TEXT_MARKER]: value } : storage === 'list' ? { [LIST_MARKER]: value } : value;
  };

  crdt.forEachNode((node) => {
    const props: Record<string, Record<string, JsonValue>> = {};
    let name: string | undefined;
    let role: string | undefined;
    for (const [path, value] of Object.entries(node.props)) {
      if (path === 'name' && typeof value === 'string') name = value;
      else if (path === 'role' && typeof value === 'string') role = value;
      else if (!isJsonValue(value)) {
        failure = err(CanonicalEncodingError({ message: `Node "${node.id}" path "${path}" is not JSON data.`, details: { node: node.id, path } }));
        return false;
      } else place(props, path, value, 'register');
    }
    for (const path of node.texts) {
      const value = crdt.text(node.id, path);
      if (value !== undefined) place(props, path, sortedSpans(value), 'text');
    }
    for (const path of node.lists) {
      const value = crdt.list(node.id, path);
      if (value !== undefined) place(props, path, [...value], 'list');
    }
    for (const [key, value] of Object.entries(props)) if (Object.keys(value).length === 0) delete props[key];
    records.push({ id: node.id, kind: node.kind, parent: node.parent, ...(name === undefined ? {} : { name }), ...(role === undefined ? {} : { role }), props });
    const siblings = childrenOf.get(node.parent) ?? [];
    siblings.push(node.id);
    childrenOf.set(node.parent, siblings);
    return true;
  });
  if (failure !== undefined) return failure;

  const orderOf = new Map<NodeId, string>();
  for (const siblings of childrenOf.values()) {
    const keys = rankKeys(siblings.length);
    siblings.forEach((id, i) => orderOf.set(id, keys[i] as string));
  }
  for (const r of records) nodes.push({ ...r, order: orderOf.get(r.id) as string });
  nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const part: CanonicalPart = {
    schema: options.schema ?? 'sf.part/1',
    part: options.part,
    treeSchema: options.treeSchema ?? registry?.version ?? 1,
    ...(registry === undefined ? {} : { components: registry.versions() }),
    nodes,
  };
  const bytes = canonicalJsonBytes(part);
  return bytes.ok ? ok({ part, bytes: bytes.value }) : bytes;
}

/** `sha256:<hex>` of a canonical part's bytes (milestones share unchanged parts by digest). */
export function canonicalPartDigest(encoded: EncodedPart): Promise<`sha256:${string}`> {
  return sha256Digest(encoded.bytes);
}

const decoder = /* @__PURE__ */ new TextDecoder();

/** Parse canonical bytes (or text) into a part, checking its shape. */
export function parseCanonicalPart(input: Uint8Array | string): Result<CanonicalPart> {
  let value: unknown;
  try {
    value = JSON.parse(typeof input === 'string' ? input : decoder.decode(input));
  } catch (cause) {
    return err(CanonicalEncodingError({ message: 'Canonical part is not valid JSON.', cause }));
  }
  const v = value as Partial<CanonicalPart>;
  if (typeof v !== 'object' || v === null || typeof v.schema !== 'string' || typeof v.part !== 'string' || typeof v.treeSchema !== 'number' || !Array.isArray(v.nodes)) {
    return err(CanonicalEncodingError({ message: 'Not a canonical part (schema, part, treeSchema, nodes).' }));
  }
  for (const n of v.nodes as unknown[]) {
    const node = n as Partial<CanonicalNode>;
    if (typeof node?.id !== 'string' || typeof node.kind !== 'string' || typeof node.order !== 'string' || (node.parent !== null && typeof node.parent !== 'string') || typeof node.props !== 'object') {
      return err(CanonicalEncodingError({ message: 'Malformed canonical node.', details: { node: (node as { id?: unknown })?.id } }));
    }
  }
  return ok(v as CanonicalPart);
}

/** Upgrade every component in a part to the registry's current versions (`parse → migrate → validate`). */
export function migrateCanonicalPart(part: CanonicalPart, registry: ComponentRegistry): Result<CanonicalPart> {
  const nodes: CanonicalNode[] = [];
  for (const node of part.nodes) {
    const props: Record<string, JsonObject> = {};
    for (const [componentId, values] of Object.entries(node.props)) {
      const component = registry.component(componentId);
      if (component === undefined) {
        props[componentId] = values; // unknown components are carried, never dropped
        continue;
      }
      const from = part.components?.[componentId] ?? 1;
      if (from > component.version) {
        return err(MigrationError({ message: `Part written with "${componentId}" v${from}; this app knows v${component.version}.`, details: { component: componentId, from } }));
      }
      const migrated = migrateComponentValues(component, values, from);
      if (!migrated.ok) return migrated;
      if (Object.keys(migrated.value).length > 0) props[componentId] = migrated.value;
    }
    nodes.push({ ...node, props });
  }
  return ok({ ...part, treeSchema: registry.version, components: registry.versions(), nodes });
}

export interface BuildFromCanonicalOptions {
  readonly peer: PeerId;
  readonly registry?: ComponentRegistry;
  /** Meta of the single commit (default: a `system` actor). */
  readonly meta?: TransactionMeta;
}

/** Flatten one canonical node back into create-op fields. */
function flatten(node: CanonicalNode, registry: ComponentRegistry | undefined): Pick<Extract<PartOp, { op: 'create' }>, 'props' | 'texts' | 'lists'> {
  const props: Record<string, JsonValue> = {};
  const texts: Record<string, RichTextValue> = {};
  const lists: Record<string, readonly JsonValue[]> = {};
  if (node.name !== undefined) props['name'] = node.name;
  if (node.role !== undefined) props['role'] = node.role;
  for (const [componentId, values] of Object.entries(node.props)) {
    const component = registry?.component(componentId);
    for (const [fieldName, value] of Object.entries(values)) {
      const path = componentId === LOOSE ? fieldName : `${componentId}.${fieldName}`;
      const marker = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;
      if (marker !== undefined && Object.keys(marker).length === 1 && TEXT_MARKER in marker) {
        texts[path] = marker[TEXT_MARKER] as unknown as RichTextValue;
        continue;
      }
      if (marker !== undefined && Object.keys(marker).length === 1 && LIST_MARKER in marker) {
        lists[path] = marker[LIST_MARKER] as readonly JsonValue[];
        continue;
      }
      const spec = component?.schema[fieldName];
      if (spec === 'richtext') texts[path] = value as unknown as RichTextValue;
      else if (typeof spec === 'object' && spec.type === 'list') lists[path] = value as readonly JsonValue[];
      else if (typeof spec === 'object' && spec.type === 'map' && marker !== undefined) {
        for (const [key, v] of Object.entries(marker)) props[`${path}.${key}`] = v;
      } else props[path] = value;
    }
  }
  return { props, texts, lists };
}

/** Rebuild a fresh CRDT part (own peer, one commit of history) from a canonical part. */
export function buildPartFromCanonical(engine: CrdtEngine, input: CanonicalPart, options: BuildFromCanonicalOptions): Result<DocumentCRDTv2> {
  let part = input;
  if (options.registry !== undefined) {
    const migrated = migrateCanonicalPart(input, options.registry);
    if (!migrated.ok) return migrated;
    part = migrated.value;
  }
  const byParent = new Map<NodeId | null, CanonicalNode[]>();
  const known = new Set(part.nodes.map((n) => n.id));
  for (const node of part.nodes) {
    const parent = node.parent !== null && known.has(node.parent) ? node.parent : null;
    const list = byParent.get(parent) ?? [];
    list.push(node);
    byParent.set(parent, list);
  }
  for (const list of byParent.values()) list.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : 1));
  const ops: PartOp[] = [];
  const visit = (parent: NodeId | null): void => {
    for (const node of byParent.get(parent) ?? []) {
      ops.push({ op: 'create', node: node.id, kind: node.kind, parent, ...flatten(node, options.registry) });
      visit(node.id);
    }
  };
  visit(null);
  const crdt = engine.create({ peer: options.peer });
  const meta: TransactionMeta = options.meta ?? { actor: { kind: 'system', id: 'canonical-import' }, label: `Restore ${part.part}` };
  const committed = crdt.transact(meta, ops);
  if (!committed.ok) {
    crdt.dispose();
    return committed;
  }
  return ok(crdt);
}
