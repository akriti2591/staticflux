/**
 * Yjs-backed DocumentCRDT: Y.Text for text components, an LWW-per-property
 * map for structure. Both halves travel in one composite update:
 *
 *   'S' 'F' 0x01 | u32 lwwLength | lww JSON (utf-8) | Yjs update bytes
 *
 * Text components map to top-level `Y.Text`s named `<entity>\u0001<component>`
 * (top-level types merge by name, so concurrent creation never conflicts).
 * Yjs types never leave this file.
 */
import { err, ok, type Result, toSfError } from '@staticflux/core';
import * as Y from 'yjs';
import type { CrdtChange, CrdtComponentState, CrdtEntityState, CrdtOrigin, DocumentCRDT, DocumentOp } from './crdt.js';
import type { ComponentId, EntityId } from './ecs.js';
import { InvalidUpdateError } from './errors.js';
import { createLwwMap, isLwwEntry, type LwwEntry, type LwwStateVector } from './lww.js';

const SEP = '\u0001';
const MAGIC = [0x53, 0x46, 0x01] as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const entityKey = (entity: EntityId): string => entity;
const componentKey = (entity: EntityId, component: ComponentId): string => `${entity}${SEP}${component}`;
const fieldKey = (entity: EntityId, component: ComponentId, field: string): string => `${entity}${SEP}${component}${SEP}${field}`;
const textName = (entity: EntityId, component: ComponentId): string => `${entity}${SEP}${component}`;

interface Composite {
  readonly lww: unknown;
  readonly yjs: Uint8Array;
}

function encodeComposite(lww: unknown, yjs: Uint8Array): Uint8Array {
  const json = encoder.encode(JSON.stringify(lww));
  const out = new Uint8Array(MAGIC.length + 4 + json.length + yjs.length);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(MAGIC.length, json.length);
  out.set(json, MAGIC.length + 4);
  out.set(yjs, MAGIC.length + 4 + json.length);
  return out;
}

function decodeComposite(bytes: Uint8Array): Result<Composite> {
  if (!(bytes instanceof Uint8Array) || bytes.length < MAGIC.length + 4 || MAGIC.some((b, i) => bytes[i] !== b)) {
    return err(InvalidUpdateError({ message: 'Not a StaticFlux document update.' }));
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(MAGIC.length);
  const start = MAGIC.length + 4;
  if (start + length > bytes.length) return err(InvalidUpdateError({ message: 'Truncated document update.' }));
  try {
    const lww = JSON.parse(decoder.decode(bytes.subarray(start, start + length))) as unknown;
    return ok({ lww, yjs: bytes.subarray(start + length) });
  } catch (error) {
    return err(InvalidUpdateError({ cause: toSfError(error) }));
  }
}

export interface YjsDocumentCRDTOptions {
  /** Unique uint32 per peer. Deterministic in tests. */
  readonly clientId: number;
}

export function createYjsDocumentCRDT(options: YjsDocumentCRDTOptions): DocumentCRDT {
  const clientId = options.clientId >>> 0;
  const doc = new Y.Doc();
  doc.clientID = clientId;
  const lww = createLwwMap(clientId);
  const LOCAL = { origin: 'local' };
  const REMOTE = { origin: 'remote' };
  const observers = new Set<(change: CrdtChange) => void>();
  const updateListeners = new Set<(update: Uint8Array) => void>();
  const index = new Map<EntityId, Set<string>>();
  const names = new Map<unknown, string>();
  let touched: Set<EntityId> | undefined;
  let localYjs: Uint8Array[] = [];

  const indexKey = (key: string): EntityId => {
    const entity = key.split(SEP)[0] as EntityId;
    let set = index.get(entity);
    if (set === undefined) {
      set = new Set();
      index.set(entity, set);
    }
    set.add(key);
    return entity;
  };

  const nameOf = (type: unknown): string | undefined => {
    const cached = names.get(type);
    if (cached !== undefined) return cached;
    for (const [name, shared] of doc.share) names.set(shared, name);
    return names.get(type);
  };

  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === LOCAL) localYjs.push(update);
  });
  doc.on('afterTransaction', (transaction: Y.Transaction) => {
    if (touched === undefined) return;
    for (const type of transaction.changed.keys()) {
      if (type._item !== null) continue;
      const name = nameOf(type);
      if (name === undefined) continue;
      touched.add(name.split(SEP)[0] as EntityId);
    }
  });

  const getText = (entity: EntityId, component: ComponentId): Y.Text => doc.getText(textName(entity, component));

  const ensurePresent = (entries: LwwEntry[], entity: EntityId, component: ComponentId, kind: 'struct' | 'text'): void => {
    const key = componentKey(entity, component);
    if (lww.get(key) === kind) return;
    entries.push(lww.set(key, kind));
    indexKey(key);
  };

  const notify = (change: CrdtChange): void => {
    for (const observer of [...observers]) observer(change);
  };

  const crdt: DocumentCRDT = {
    clientId,
    applyLocal(ops) {
      const entries: LwwEntry[] = [];
      touched = new Set();
      localYjs = [];
      const set = (key: string, value: unknown): void => {
        entries.push(lww.set(key, value));
        touched?.add(indexKey(key));
      };
      try {
        doc.transact(() => {
          for (const op of ops) {
            switch (op.type) {
              case 'entity.create':
                set(entityKey(op.entity), true);
                break;
              case 'entity.delete':
                set(entityKey(op.entity), false);
                break;
              case 'component.set':
                ensurePresent(entries, op.entity, op.component, 'struct');
                for (const [field, value] of Object.entries(op.values)) set(fieldKey(op.entity, op.component, field), value);
                touched?.add(op.entity);
                break;
              case 'component.remove':
                set(componentKey(op.entity, op.component), null);
                break;
              case 'text.init':
                ensurePresent(entries, op.entity, op.component, 'text');
                getText(op.entity, op.component);
                touched?.add(op.entity);
                break;
              case 'text.insert':
                ensurePresent(entries, op.entity, op.component, 'text');
                getText(op.entity, op.component).insert(op.index, op.text);
                touched?.add(op.entity);
                break;
              case 'text.delete':
                getText(op.entity, op.component).delete(op.index, op.length);
                touched?.add(op.entity);
                break;
            }
          }
        }, LOCAL);
      } catch (error) {
        touched = undefined;
        return err(toSfError(error));
      }
      const change: CrdtChange = { origin: 'local', entities: [...touched] };
      touched = undefined;
      const yjs = localYjs.length === 0 ? new Uint8Array(0) : localYjs.length === 1 ? (localYjs[0] as Uint8Array) : Y.mergeUpdates(localYjs);
      localYjs = [];
      if (entries.length > 0 || yjs.length > 0) {
        const update = encodeComposite(entries, yjs);
        for (const listener of [...updateListeners]) listener(update);
      }
      notify(change);
      return ok(change);
    },
    applyRemote(update, origin: Exclude<CrdtOrigin, 'local'> = 'remote') {
      const decoded = decodeComposite(update);
      if (!decoded.ok) return decoded;
      const entries = decoded.value.lww;
      if (!Array.isArray(entries) || !entries.every(isLwwEntry)) return err(InvalidUpdateError({ message: 'Malformed structure entries.' }));
      touched = new Set();
      for (const key of lww.merge(entries)) touched.add(indexKey(key));
      for (const entry of entries) indexKey(entry.key);
      try {
        if (decoded.value.yjs.length > 0) Y.applyUpdate(doc, decoded.value.yjs, REMOTE);
      } catch (error) {
        touched = undefined;
        return err(InvalidUpdateError({ cause: toSfError(error) }));
      }
      const change: CrdtChange = { origin, entities: [...touched] };
      touched = undefined;
      notify(change);
      return ok(change);
    },
    encodeStateVector() {
      return encodeComposite(lww.stateVector(), Y.encodeStateVector(doc));
    },
    encodeUpdate(stateVector) {
      let lwwVector: LwwStateVector | undefined;
      let yjsVector: Uint8Array | undefined;
      if (stateVector !== undefined) {
        const decoded = decodeComposite(stateVector);
        if (!decoded.ok) return decoded;
        lwwVector = (decoded.value.lww ?? {}) as LwwStateVector;
        yjsVector = decoded.value.yjs.length > 0 ? decoded.value.yjs : undefined;
      }
      try {
        return ok(encodeComposite(lww.diff(lwwVector), Y.encodeStateAsUpdate(doc, yjsVector)));
      } catch (error) {
        return err(InvalidUpdateError({ cause: toSfError(error) }));
      }
    },
    readEntity(entity) {
      const keys = index.get(entity);
      if (keys === undefined) return undefined;
      const components = new Map<ComponentId, CrdtComponentState>();
      const fields = new Map<ComponentId, Record<string, unknown>>();
      for (const key of keys) {
        const parts = key.split(SEP);
        if (parts.length === 3) {
          const component = parts[1] as ComponentId;
          let values = fields.get(component);
          if (values === undefined) {
            values = {};
            fields.set(component, values);
          }
          values[parts[2] as string] = lww.get(key);
        }
      }
      for (const key of keys) {
        const parts = key.split(SEP);
        if (parts.length !== 2) continue;
        const component = parts[1] as ComponentId;
        const present = lww.get(key);
        if (present === 'struct') components.set(component, { kind: 'struct', values: fields.get(component) ?? {} });
        else if (present === 'text') components.set(component, { kind: 'text', text: getText(entity, component).toString() });
      }
      const state: CrdtEntityState = { exists: lww.get(entityKey(entity)) === true, components };
      return state;
    },
    entityIds: () => [...index.keys()],
    observe(listener) {
      observers.add(listener);
      return () => observers.delete(listener);
    },
    onLocalUpdate(listener) {
      updateListeners.add(listener);
      return () => updateListeners.delete(listener);
    },
    dispose() {
      observers.clear();
      updateListeners.clear();
      doc.destroy();
    },
  };
  return crdt;
}

/** Combine several composite updates into one (e.g. to batch a burst of edits). */
export function mergeDocumentUpdates(updates: readonly Uint8Array[]): Result<Uint8Array> {
  const entries: unknown[] = [];
  const yjs: Uint8Array[] = [];
  for (const update of updates) {
    const decoded = decodeComposite(update);
    if (!decoded.ok) return decoded;
    if (Array.isArray(decoded.value.lww)) entries.push(...(decoded.value.lww as unknown[]));
    if (decoded.value.yjs.length > 0) yjs.push(decoded.value.yjs);
  }
  try {
    return ok(encodeComposite(entries, yjs.length === 0 ? new Uint8Array(0) : Y.mergeUpdates(yjs)));
  } catch (error) {
    return err(InvalidUpdateError({ cause: toSfError(error) }));
  }
}
