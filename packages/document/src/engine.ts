/**
 * DocumentEngine = ECS world (materialized view) + DocumentCRDT (source of
 * truth). Every write is a CRDT transaction; local and remote changes both
 * re-materialize the touched entities, so every peer's world is a pure
 * function of CRDT state (convergence by construction).
 *
 * The engine is a `ReplicableSource<DocumentView>`: a document worker
 * publishes it with `createPublisher`, the main thread holds a read-only
 * replica and sends `DocumentIntents`; projections consume change sets.
 */
import {
  createNoopTelemetry,
  err,
  metric,
  ok,
  type Result,
  type SfError,
  type Telemetry,
} from '@staticflux/core';
import { type Patch, type ReplicableSource, UnknownIntentError } from '@staticflux/worker';
import type { CrdtChange, CrdtOrigin, DocumentCRDT, DocumentOp } from './crdt.js';
import {
  type AnyComponent,
  type AnyStructComponent,
  type ComponentId,
  type ComponentSchema,
  type ComponentValues,
  createIdGenerator,
  createWorld,
  type EntityId,
  isFieldValue,
  type QueryOptions,
  type StructComponent,
  type System,
  type TextComponent,
  validateValues,
  type World,
} from './ecs.js';
import { TextRangeError, UnknownComponentError, UnknownEntityError, UnsupportedArchiveError } from './errors.js';
import { createYjsDocumentCRDT } from './yjs-crdt.js';

// ---------------------------------------------------------------- view & changes

export type ComponentNode =
  | { readonly kind: 'struct'; readonly values: Readonly<Record<string, unknown>> }
  | { readonly kind: 'text'; readonly text: string };

export type EntityView = Readonly<Record<ComponentId, ComponentNode>>;

/** Serializable document view (what replicas hold). */
export interface DocumentView {
  readonly entities: Readonly<Record<EntityId, EntityView>>;
}

export type DocumentChange =
  | { readonly type: 'entity.created'; readonly entity: EntityId }
  | { readonly type: 'entity.deleted'; readonly entity: EntityId }
  | {
      readonly type: 'component.set';
      readonly entity: EntityId;
      readonly component: ComponentId;
      readonly values: Readonly<Record<string, unknown>>;
      readonly changed: readonly string[];
    }
  | { readonly type: 'component.removed'; readonly entity: EntityId; readonly component: ComponentId }
  | { readonly type: 'text.changed'; readonly entity: EntityId; readonly component: ComponentId; readonly text: string };

export interface ChangeSet {
  readonly origin: CrdtOrigin;
  readonly changes: readonly DocumentChange[];
}

// ---------------------------------------------------------------- intents

/** Writes a replica (main-thread UI, agent) may send to the owning engine. */
export type DocumentIntents = {
  readonly createEntity: {
    readonly args: { readonly components?: Readonly<Record<ComponentId, Readonly<Record<string, unknown>> | string>> };
    readonly result: EntityId;
  };
  readonly set: {
    readonly args: { readonly entity: EntityId; readonly component: ComponentId; readonly values: Readonly<Record<string, unknown>> };
    readonly result: null;
  };
  readonly remove: { readonly args: { readonly entity: EntityId; readonly component: ComponentId }; readonly result: null };
  readonly destroy: { readonly args: { readonly entity: EntityId }; readonly result: null };
  readonly insertText: {
    readonly args: { readonly entity: EntityId; readonly component: ComponentId; readonly index: number; readonly text: string };
    readonly result: null;
  };
  readonly deleteText: {
    readonly args: { readonly entity: EntityId; readonly component: ComponentId; readonly index: number; readonly length: number };
    readonly result: null;
  };
};

export const DocumentIntentNames = ['createEntity', 'set', 'remove', 'destroy', 'insertText', 'deleteText'] as const satisfies readonly (keyof DocumentIntents)[];

// ---------------------------------------------------------------- component init

export interface ComponentInit {
  readonly component: AnyComponent;
  readonly value: Readonly<Record<string, unknown>> | string;
}

export function withComponent<S extends ComponentSchema>(
  component: StructComponent<ComponentId, S>,
  values: Partial<ComponentValues<S>> = {},
): ComponentInit {
  return { component, value: values as Readonly<Record<string, unknown>> };
}

export function withText(component: TextComponent, text = ''): ComponentInit {
  return { component, value: text };
}

// ---------------------------------------------------------------- archive

export interface DocumentArchive {
  readonly format: 'sf-document';
  readonly version: 1;
  readonly clientId: number;
  /** Full CRDT state. */
  readonly update: Uint8Array;
}

export function isDocumentArchive(value: unknown): value is DocumentArchive {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v['format'] === 'sf-document' && v['version'] === 1 && typeof v['clientId'] === 'number' && v['update'] instanceof Uint8Array;
}

// ---------------------------------------------------------------- engine

export interface DocumentTransaction {
  createEntity(components?: readonly ComponentInit[]): Result<EntityId>;
  set<S extends ComponentSchema>(entity: EntityId, component: StructComponent<ComponentId, S>, values: Partial<ComponentValues<S>>): Result<void>;
  remove(entity: EntityId, component: AnyComponent): Result<void>;
  destroy(entity: EntityId): Result<void>;
  insertText(entity: EntityId, component: TextComponent, index: number, text: string): Result<void>;
  deleteText(entity: EntityId, component: TextComponent, index: number, length: number): Result<void>;
}

export interface DocumentEngine extends ReplicableSource<DocumentView>, DocumentTransaction {
  readonly clientId: number;
  readonly world: World;
  readonly crdt: DocumentCRDT;
  has(entity: EntityId): boolean;
  get<S extends ComponentSchema>(entity: EntityId, component: StructComponent<ComponentId, S>): ComponentValues<S> | undefined;
  text(entity: EntityId, component: TextComponent): string | undefined;
  query(components: readonly AnyComponent[], options?: QueryOptions): readonly EntityId[];
  /** Several writes as one CRDT transaction (one update, one change set). All-or-nothing validation. */
  transact(fn: (tx: DocumentTransaction) => Result<unknown> | void): Result<ChangeSet>;
  /** Change sets for projections (local, remote and restore). */
  observe(listener: (changes: ChangeSet) => void): () => void;
  applyRemote(update: Uint8Array): Result<ChangeSet>;
  encodeStateVector(): Uint8Array;
  encodeUpdate(stateVector?: Uint8Array): Result<Uint8Array>;
  onLocalUpdate(listener: (update: Uint8Array) => void): () => void;
  view(): DocumentView;
  snapshot(): Result<DocumentArchive>;
  /** Merge an archive into this engine (rehydrate after respawn / unarchive). */
  restore(archive: DocumentArchive): Result<ChangeSet>;
  addSystem(system: System<ChangeSet>): () => void;
  dispose(): void;
}

export interface DocumentEngineOptions {
  readonly clientId: number;
  readonly components: readonly AnyComponent[];
  readonly systems?: readonly System<ChangeSet>[];
  /** Default: Yjs text + LWW structure. */
  readonly crdt?: DocumentCRDT;
  readonly telemetry?: Telemetry;
}

export const DocumentMetrics = {
  ops: metric.counter('document/ops', { description: 'Local document ops applied.' }),
  remoteUpdates: metric.counter('document/remote-updates'),
} as const;

const SUBSYSTEM = 'document/engine';

export function createDocumentEngine(options: DocumentEngineOptions): DocumentEngine {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const crdt = options.crdt ?? createYjsDocumentCRDT({ clientId: options.clientId });
  const world = createWorld(options.components);
  const ids = createIdGenerator(crdt.clientId);
  const systems = new Set<System<ChangeSet>>(options.systems ?? []);
  const observers = new Set<(changes: ChangeSet) => void>();
  const patchListeners = new Set<(patches: readonly Patch[]) => void>();

  const componentOf = (id: string): Result<AnyComponent> => {
    const component = world.component(id);
    return component === undefined ? err(UnknownComponentError({ details: { component: id } })) : ok(component);
  };
  const registered = (component: AnyComponent): Result<AnyComponent> =>
    world.component(component.id) === component ? ok(component) : componentOf(component.id);

  const entityView = (entity: EntityId): EntityView => {
    const out: Record<ComponentId, ComponentNode> = {};
    for (const component of world.components) {
      if (component.storage === 'struct') {
        const values = world.get(entity, component);
        if (values !== undefined) out[component.id] = { kind: 'struct', values: { ...values } };
      } else {
        const text = world.text(entity, component);
        if (text !== undefined) out[component.id] = { kind: 'text', text };
      }
    }
    return out;
  };

  const sanitize = (component: AnyStructComponent, values: Readonly<Record<string, unknown>>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...(component.defaults as Record<string, unknown>) };
    for (const [field, type] of Object.entries(component.schema as ComponentSchema)) {
      const value = values[field];
      if (value !== undefined && isFieldValue(type, value)) out[field] = value;
    }
    return out;
  };

  const materialize = (change: CrdtChange): ChangeSet => {
    const changes: DocumentChange[] = [];
    for (const entity of [...change.entities].sort()) {
      ids.observe(entity);
      const state = crdt.readEntity(entity);
      if (state === undefined || !state.exists) {
        if (world.has(entity)) {
          world.removeEntity(entity);
          changes.push({ type: 'entity.deleted', entity });
        }
        continue;
      }
      if (!world.has(entity)) {
        world.addEntity(entity);
        changes.push({ type: 'entity.created', entity });
      }
      for (const component of world.components) {
        const node = state.components.get(component.id);
        const has = world.hasComponent(entity, component);
        if (node === undefined || node.kind !== component.storage) {
          if (has) {
            world.removeComponent(entity, component);
            changes.push({ type: 'component.removed', entity, component: component.id });
          }
          continue;
        }
        if (component.storage === 'struct' && node.kind === 'struct') {
          const next = sanitize(component, node.values);
          const previous = world.get(entity, component) as Record<string, unknown> | undefined;
          const changed = Object.keys(next).filter((field) => previous === undefined || !Object.is(previous[field], next[field]));
          if (!has || changed.length > 0) {
            world.writeStruct(entity, component, next);
            changes.push({ type: 'component.set', entity, component: component.id, values: next, changed });
          }
        } else if (component.storage === 'text' && node.kind === 'text') {
          if (world.text(entity, component) !== node.text || !has) {
            world.writeText(entity, component, node.text);
            changes.push({ type: 'text.changed', entity, component: component.id, text: node.text });
          }
        }
      }
    }
    const set: ChangeSet = { origin: change.origin, changes };
    if (changes.length > 0) publish(set);
    return set;
  };

  const toPatches = (set: ChangeSet): Patch[] => {
    const patches: Patch[] = [];
    const created = new Set<EntityId>();
    for (const change of set.changes) {
      switch (change.type) {
        case 'entity.created':
          created.add(change.entity);
          patches.push({ op: 'add', path: ['entities', change.entity], value: entityView(change.entity) });
          break;
        case 'entity.deleted':
          patches.push({ op: 'remove', path: ['entities', change.entity] });
          break;
        case 'component.set':
          if (!created.has(change.entity)) {
            patches.push({ op: 'add', path: ['entities', change.entity, change.component], value: { kind: 'struct', values: change.values } });
          }
          break;
        case 'component.removed':
          if (!created.has(change.entity)) patches.push({ op: 'remove', path: ['entities', change.entity, change.component] });
          break;
        case 'text.changed':
          if (!created.has(change.entity)) {
            patches.push({ op: 'add', path: ['entities', change.entity, change.component], value: { kind: 'text', text: change.text } });
          }
          break;
      }
    }
    return patches;
  };

  const publish = (set: ChangeSet): void => {
    for (const system of systems) {
      const watched = new Set((system.watches ?? system.query).map((c) => c.id));
      const relevant = set.changes.some(
        (c) => c.type === 'entity.created' || c.type === 'entity.deleted' || watched.size === 0 || watched.has(c.component),
      );
      if (relevant) system.run({ world, entities: world.query(system.query), changes: set });
    }
    for (const observer of [...observers]) observer(set);
    if (patchListeners.size > 0) {
      const patches = toPatches(set);
      if (patches.length > 0) for (const listener of [...patchListeners]) listener(patches);
    }
  };

  // -------------------------------------------------------------- transactions

  const transact = (fn: (tx: DocumentTransaction) => Result<unknown> | void): Result<ChangeSet> => {
    const ops: DocumentOp[] = [];
    const created = new Set<EntityId>();
    const destroyed = new Set<EntityId>();
    const textLength = new Map<string, number>();
    let failure: SfError | undefined;

    const fail = (error: SfError): Result<never> => {
      failure ??= error;
      return err(error);
    };
    const alive = (entity: EntityId): boolean => !destroyed.has(entity) && (created.has(entity) || world.has(entity));
    const lengthOf = (entity: EntityId, component: TextComponent): number =>
      textLength.get(`${entity}|${component.id}`) ?? world.text(entity, component)?.length ?? 0;

    const tx: DocumentTransaction = {
      createEntity(components = []) {
        for (const init of components) {
          const known = registered(init.component);
          if (!known.ok) return fail(known.error);
          if (init.component.storage === 'struct') {
            if (typeof init.value === 'string') return fail(TextRangeError({ details: { component: init.component.id } }));
            const valid = validateValues(init.component, init.value);
            if (!valid.ok) return fail(valid.error);
          } else if (typeof init.value !== 'string') return fail(TextRangeError({ details: { component: init.component.id } }));
        }
        const entity = ids.next();
        created.add(entity);
        ops.push({ type: 'entity.create', entity });
        for (const init of components) {
          if (init.component.storage === 'struct') {
            ops.push({
              type: 'component.set',
              entity,
              component: init.component.id,
              values: { ...(init.component.defaults as Record<string, unknown>), ...(init.value as Record<string, unknown>) },
            });
          } else {
            const text = init.value as string;
            ops.push({ type: 'text.init', entity, component: init.component.id });
            if (text.length > 0) ops.push({ type: 'text.insert', entity, component: init.component.id, index: 0, text });
            textLength.set(`${entity}|${init.component.id}`, text.length);
          }
        }
        return ok(entity);
      },
      set(entity, component, values) {
        const known = registered(component);
        if (!known.ok) return fail(known.error);
        if (!alive(entity)) return fail(UnknownEntityError({ details: { entity } }));
        const valid = validateValues(component, values as Record<string, unknown>);
        if (!valid.ok) return fail(valid.error);
        const adding = !created.has(entity) && !world.hasComponent(entity, component);
        ops.push({
          type: 'component.set',
          entity,
          component: component.id,
          values: adding ? { ...(component.defaults as Record<string, unknown>), ...(values as Record<string, unknown>) } : (values as Record<string, unknown>),
        });
        return ok();
      },
      remove(entity, component) {
        const known = registered(component);
        if (!known.ok) return fail(known.error);
        if (!alive(entity)) return fail(UnknownEntityError({ details: { entity } }));
        ops.push({ type: 'component.remove', entity, component: component.id });
        return ok();
      },
      destroy(entity) {
        if (!alive(entity)) return fail(UnknownEntityError({ details: { entity } }));
        destroyed.add(entity);
        ops.push({ type: 'entity.delete', entity });
        return ok();
      },
      insertText(entity, component, index, text) {
        const known = registered(component);
        if (!known.ok) return fail(known.error);
        if (component.storage !== 'text') return fail(TextRangeError({ details: { component: component.id } }));
        if (!alive(entity)) return fail(UnknownEntityError({ details: { entity } }));
        const length = lengthOf(entity, component);
        if (!Number.isInteger(index) || index < 0 || index > length) {
          return fail(TextRangeError({ details: { entity, component: component.id, index, length } }));
        }
        ops.push({ type: 'text.insert', entity, component: component.id, index, text });
        textLength.set(`${entity}|${component.id}`, length + text.length);
        return ok();
      },
      deleteText(entity, component, index, length) {
        const known = registered(component);
        if (!known.ok) return fail(known.error);
        if (component.storage !== 'text') return fail(TextRangeError({ details: { component: component.id } }));
        if (!alive(entity)) return fail(UnknownEntityError({ details: { entity } }));
        const current = lengthOf(entity, component);
        if (!Number.isInteger(index) || !Number.isInteger(length) || index < 0 || length < 0 || index + length > current) {
          return fail(TextRangeError({ details: { entity, component: component.id, index, length: current } }));
        }
        ops.push({ type: 'text.delete', entity, component: component.id, index, length });
        textLength.set(`${entity}|${component.id}`, current - length);
        return ok();
      },
    };

    const returned = fn(tx);
    if (failure !== undefined) return err(failure);
    if (returned !== undefined && !returned.ok) return err(returned.error);
    if (ops.length === 0) return ok({ origin: 'local', changes: [] });
    const span = telemetry.span('document.transact', { subsystem: SUBSYSTEM, level: 'verbose', attrs: { ops: ops.length } });
    const applied = crdt.applyLocal(ops);
    if (!applied.ok) {
      span.end('error', applied.error);
      return applied;
    }
    telemetry.record(DocumentMetrics.ops, ops.length);
    const set = materialize(applied.value);
    span.end('ok');
    return ok(set);
  };

  const single = <T>(fn: (tx: DocumentTransaction) => Result<T>): Result<T> => {
    let value: T | undefined;
    const result = transact((tx) => {
      const r = fn(tx);
      if (r.ok) value = r.value;
      return r;
    });
    return result.ok ? ok(value as T) : result;
  };

  const intentHandlers: { readonly [K in keyof DocumentIntents]: (args: DocumentIntents[K]['args']) => Result<DocumentIntents[K]['result']> } = {
    createEntity: (args) => {
      const inits: ComponentInit[] = [];
      for (const [id, value] of Object.entries(args?.components ?? {})) {
        const component = componentOf(id);
        if (!component.ok) return component;
        inits.push({ component: component.value, value });
      }
      return single((tx) => tx.createEntity(inits));
    },
    set: (args) => {
      const component = componentOf(args.component);
      if (!component.ok) return component;
      if (component.value.storage !== 'struct') return err(TextRangeError({ details: { component: args.component } }));
      const target = component.value;
      return map(single((tx) => tx.set(args.entity, target, args.values as never)));
    },
    remove: (args) => {
      const component = componentOf(args.component);
      if (!component.ok) return component;
      const target = component.value;
      return map(single((tx) => tx.remove(args.entity, target)));
    },
    destroy: (args) => map(single((tx) => tx.destroy(args.entity))),
    insertText: (args) => {
      const component = componentOf(args.component);
      if (!component.ok) return component;
      const target = component.value as TextComponent;
      return map(single((tx) => tx.insertText(args.entity, target, args.index, args.text)));
    },
    deleteText: (args) => {
      const component = componentOf(args.component);
      if (!component.ok) return component;
      const target = component.value as TextComponent;
      return map(single((tx) => tx.deleteText(args.entity, target, args.index, args.length)));
    },
  };

  const restore = (archive: DocumentArchive): Result<ChangeSet> => {
    if (!isDocumentArchive(archive)) return err(UnsupportedArchiveError());
    const applied = crdt.applyRemote(archive.update, 'restore');
    if (!applied.ok) return applied;
    for (const entity of crdt.entityIds()) ids.observe(entity);
    return ok(materialize(applied.value));
  };

  const engine: DocumentEngine = {
    clientId: crdt.clientId,
    world,
    crdt,
    has: (entity) => world.has(entity),
    get: (entity, component) => world.get(entity, component),
    text: (entity, component) => world.text(entity, component),
    query: (components, queryOptions) => world.query(components, queryOptions),
    transact,
    createEntity: (components) => single((tx) => tx.createEntity(components)),
    set: (entity, component, values) => single((tx) => tx.set(entity, component, values)),
    remove: (entity, component) => single((tx) => tx.remove(entity, component)),
    destroy: (entity) => single((tx) => tx.destroy(entity)),
    insertText: (entity, component, index, text) => single((tx) => tx.insertText(entity, component, index, text)),
    deleteText: (entity, component, index, length) => single((tx) => tx.deleteText(entity, component, index, length)),
    observe(listener) {
      observers.add(listener);
      return () => observers.delete(listener);
    },
    applyRemote(update) {
      const applied = crdt.applyRemote(update, 'remote');
      if (!applied.ok) return applied;
      telemetry.record(DocumentMetrics.remoteUpdates, 1);
      return ok(materialize(applied.value));
    },
    encodeStateVector: () => crdt.encodeStateVector(),
    encodeUpdate: (stateVector) => crdt.encodeUpdate(stateVector),
    onLocalUpdate: (listener) => crdt.onLocalUpdate(listener),
    view() {
      const entities: Record<EntityId, EntityView> = {};
      for (const entity of world.entities()) entities[entity] = entityView(entity);
      return { entities };
    },
    snapshot() {
      const update = crdt.encodeUpdate();
      if (!update.ok) return update;
      return ok({ format: 'sf-document', version: 1, clientId: crdt.clientId, update: update.value });
    },
    restore,
    addSystem(system) {
      systems.add(system);
      return () => systems.delete(system);
    },
    // ReplicableSource
    getSnapshot: () => engine.view(),
    onPatches(listener) {
      patchListeners.add(listener);
      return () => patchListeners.delete(listener);
    },
    applyIntent(action, args) {
      const handler = (intentHandlers as Record<string, ((a: unknown) => Result<unknown>) | undefined>)[action];
      if (handler === undefined) return err(UnknownIntentError({ message: `Unknown document intent "${action}".`, details: { action } }));
      return handler(args);
    },
    dispose() {
      observers.clear();
      patchListeners.clear();
      systems.clear();
      crdt.dispose();
    },
  };
  return engine;
}

function map(result: Result<void>): Result<null> {
  return result.ok ? ok(null) : result;
}

/** Create an engine and rehydrate it from an archive (unarchive / worker respawn). */
export function restoreDocumentEngine(archive: unknown, options: DocumentEngineOptions): Result<DocumentEngine> {
  if (!isDocumentArchive(archive)) return err(UnsupportedArchiveError({ details: { received: typeof archive } }));
  const engine = createDocumentEngine(options);
  const restored = engine.restore(archive);
  if (!restored.ok) {
    engine.dispose();
    return restored;
  }
  return ok(engine);
}
