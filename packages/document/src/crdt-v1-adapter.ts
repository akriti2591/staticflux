/**
 * v1 → v2 bridge: the v1 `DocumentCRDT` interface (used by the ECS
 * `DocumentEngine` and Studio) implemented over any `DocumentCRDTv2` part, so
 * an existing engine can move from Yjs to Loro by passing one option:
 *
 *   createDocumentEngine({ clientId, components, crdt: adaptToV1(createLoroEngine().create({ peer: `${clientId}` }), { clientId }) })
 *
 * Mapping: an entity is a top-level node (`kind: 'entity'`); a component's
 * presence is the property `<component>` = `'struct' | 'text'`; struct fields
 * are `<component>.<field>`; a text component is rich text at `<component>`.
 * Semantics differ from the Yjs adapter in one place: deleting an entity wins
 * over concurrent edits on every peer, but re-creating the same id afterwards
 * is a new node (v1 Yjs lets a later `entity.create` resurrect it).
 *
 * Studio keeps the Yjs default; this adapter is the migration path.
 */
import { err, ok, type Result } from '@staticflux/core';
import type { CrdtChange, CrdtComponentState, CrdtEntityState, CrdtOrigin, DocumentCRDT, DocumentOp } from './crdt.js';
import type { DocumentCRDTv2, PartChange, PartOp, TransactionMeta } from './crdt-v2.js';
import type { ComponentId, EntityId } from './ecs.js';
import { InvalidFieldError } from './errors.js';
import { isJsonValue, type JsonValue } from './json.js';

export interface V1AdapterOptions {
  /** The v1 client id (uint32); entity ids are generated from it. */
  readonly clientId: number;
  /** Meta recorded on every commit (default: a `system` actor labelled "Edit"). */
  readonly meta?: TransactionMeta;
}

const ENTITY_KIND = 'entity';

function toV2(ops: readonly DocumentOp[], part: DocumentCRDTv2): Result<{ readonly ops: PartOp[]; readonly touched: Set<EntityId> }> {
  const out: PartOp[] = [];
  const touched = new Set<EntityId>();
  const presence = new Map<string, 'struct' | 'text' | null>();
  const present = (entity: EntityId, component: ComponentId): unknown => {
    const key = `${entity}\u0001${component}`;
    return presence.has(key) ? presence.get(key) : part.prop(entity, component);
  };
  const mark = (entity: EntityId, component: ComponentId, kind: 'struct' | 'text' | null): void => {
    presence.set(`${entity}\u0001${component}`, kind);
    out.push({ op: 'set', node: entity, path: component, value: kind });
  };
  const textLength = new Map<string, number>();
  const lengthOf = (entity: EntityId, component: ComponentId): number =>
    textLength.get(`${entity}\u0001${component}`) ?? part.text(entity, component)?.text.length ?? 0;
  for (const op of ops) {
    touched.add(op.entity);
    switch (op.type) {
      case 'entity.create':
        if (!part.has(op.entity)) out.push({ op: 'create', node: op.entity, kind: ENTITY_KIND, parent: null });
        break;
      case 'entity.delete':
        out.push({ op: 'delete', node: op.entity });
        break;
      case 'component.set':
        if (present(op.entity, op.component) !== 'struct') mark(op.entity, op.component, 'struct');
        for (const [field, value] of Object.entries(op.values)) {
          if (!isJsonValue(value)) return err(InvalidFieldError({ message: `Field "${op.component}.${field}" is not JSON data.` }));
          out.push({ op: 'set', node: op.entity, path: `${op.component}.${field}`, value: value as JsonValue });
        }
        break;
      case 'component.remove':
        mark(op.entity, op.component, null);
        break;
      case 'text.init':
        if (present(op.entity, op.component) !== 'text') mark(op.entity, op.component, 'text');
        out.push({ op: 'text.insert', node: op.entity, path: op.component, at: 0, text: '' });
        break;
      case 'text.insert': {
        if (present(op.entity, op.component) !== 'text') mark(op.entity, op.component, 'text');
        out.push({ op: 'text.insert', node: op.entity, path: op.component, at: op.index, text: op.text });
        const key = `${op.entity}\u0001${op.component}`;
        textLength.set(key, lengthOf(op.entity, op.component) + op.text.length);
        break;
      }
      case 'text.delete': {
        out.push({ op: 'text.delete', node: op.entity, path: op.component, from: op.index, to: op.index + op.length });
        const key = `${op.entity}\u0001${op.component}`;
        textLength.set(key, lengthOf(op.entity, op.component) - op.length);
        break;
      }
    }
  }
  return ok({ ops: out, touched });
}

function entitiesOf(change: PartChange): EntityId[] {
  return [...new Set([...change.created, ...change.deleted, ...change.moved, ...change.updated.keys()])];
}

/** Implement the v1 `DocumentCRDT` over a v2 part (the part is owned and disposed by the adapter). */
export function adaptToV1(part: DocumentCRDTv2, options: V1AdapterOptions): DocumentCRDT {
  const clientId = options.clientId >>> 0;
  const meta: TransactionMeta = options.meta ?? { actor: { kind: 'system', id: `v1-${clientId}` }, label: 'Edit' };
  const updateListeners = new Set<(update: Uint8Array) => void>();
  const observers = new Set<(change: CrdtChange) => void>();
  const seen = new Set<EntityId>();
  let importing: Exclude<CrdtOrigin, 'local'> | undefined;

  const stop = part.observe((change) => {
    if (change.origin === 'local') return; // local changes are reported by applyLocal
    const entities = entitiesOf(change);
    for (const e of entities) seen.add(e);
    const crdtChange: CrdtChange = { origin: importing ?? 'remote', entities };
    for (const observer of [...observers]) observer(crdtChange);
  });

  return {
    clientId,
    applyLocal(ops) {
      const converted = toV2(ops, part);
      if (!converted.ok) return converted;
      for (const e of converted.value.touched) seen.add(e);
      if (converted.value.ops.length === 0) return ok({ origin: 'local', entities: [...converted.value.touched] });
      const committed = part.transact(meta, converted.value.ops);
      if (!committed.ok) return committed;
      for (const listener of [...updateListeners]) listener(committed.value.update);
      const change: CrdtChange = { origin: 'local', entities: [...converted.value.touched] };
      for (const observer of [...observers]) observer(change);
      return ok(change);
    },
    applyRemote(update, origin = 'remote') {
      importing = origin;
      const imported = part.import(update);
      importing = undefined;
      if (!imported.ok) return imported;
      const entities = entitiesOf(imported.value.change);
      for (const e of entities) seen.add(e);
      return ok({ origin, entities });
    },
    encodeStateVector: () => part.version(),
    encodeUpdate: (stateVector) => ok(part.exportUpdates(stateVector)),
    readEntity(entity) {
      const node = part.node(entity);
      if (node === undefined) return seen.has(entity) ? { exists: false, components: new Map() } : undefined;
      const components = new Map<ComponentId, CrdtComponentState>();
      for (const [key, value] of Object.entries(node.props)) {
        if (key.includes('.') || (value !== 'struct' && value !== 'text')) continue;
        const component = key as ComponentId;
        if (value === 'text') {
          components.set(component, { kind: 'text', text: part.text(entity, component)?.text ?? '' });
          continue;
        }
        const values: Record<string, unknown> = {};
        const prefix = `${component}.`;
        for (const [path, fieldValue] of Object.entries(node.props)) if (path.startsWith(prefix)) values[path.slice(prefix.length)] = fieldValue;
        components.set(component, { kind: 'struct', values });
      }
      const state: CrdtEntityState = { exists: node.kind === ENTITY_KIND, components };
      return state;
    },
    entityIds() {
      const ids = new Set(seen);
      for (const id of part.children(null)) ids.add(id);
      return [...ids];
    },
    observe(listener) {
      observers.add(listener);
      return () => observers.delete(listener);
    },
    onLocalUpdate(listener) {
      updateListeners.add(listener);
      return () => updateListeners.delete(listener);
    },
    dispose() {
      stop();
      observers.clear();
      updateListeners.clear();
      part.dispose();
    },
  };
}
