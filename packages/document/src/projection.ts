/**
 * Projections (R11.8): main-thread UI, an OffscreenCanvas renderer, an
 * outline panel… all are projections of the document. A projection receives
 * a full view on reset and change sets afterwards — either directly from an
 * engine in the same thread, or from a worker replica (patches are turned
 * back into change sets).
 */
import { box, type Box } from '@staticflux/core';
import type { DeepReadonly, Patch, Replica } from '@staticflux/worker';
import type { ComponentId, EntityId } from './ecs.js';
import type { ChangeSet, ComponentNode, DocumentChange, DocumentEngine, DocumentView, EntityView } from './engine.js';

export interface Projection {
  /** Replace everything (first sync, resnapshot after respawn). */
  reset(view: DocumentView): void;
  apply(changes: ChangeSet): void;
}

/** Project an in-thread engine. Returns unsubscribe. */
export function bindProjection(engine: DocumentEngine, projection: Projection): () => void {
  projection.reset(engine.view());
  return engine.observe((changes) => projection.apply(changes));
}

function nodeChange(entity: EntityId, component: ComponentId, node: ComponentNode): DocumentChange {
  return node.kind === 'text'
    ? { type: 'text.changed', entity, component, text: node.text }
    : { type: 'component.set', entity, component, values: node.values, changed: Object.keys(node.values) };
}

/** Convert replicated view patches back into document changes. */
export function patchesToChanges(patches: readonly Patch[]): DocumentChange[] {
  const changes: DocumentChange[] = [];
  for (const patch of patches) {
    const [root, entity, component] = patch.path as readonly [string?, string?, string?];
    if (root !== 'entities' || typeof entity !== 'string') continue;
    if (component === undefined) {
      if (patch.op === 'remove') changes.push({ type: 'entity.deleted', entity });
      else {
        changes.push({ type: 'entity.created', entity });
        for (const [id, node] of Object.entries((patch.value ?? {}) as EntityView)) changes.push(nodeChange(entity, id as ComponentId, node));
      }
      continue;
    }
    if (patch.op === 'remove') changes.push({ type: 'component.removed', entity, component: component as ComponentId });
    else changes.push(nodeChange(entity, component as ComponentId, patch.value as ComponentNode));
  }
  return changes;
}

/** Project a (worker-owned) document replica on the main thread. Returns unsubscribe. */
export function projectReplica(replica: Replica<DocumentView>, projection: Projection): () => void {
  if (replica.state !== undefined) projection.reset(replica.state as DocumentView);
  return replica.subscribe((event) => {
    if (event.type === 'snapshot') projection.reset(event.state as DeepReadonly<DocumentView> as DocumentView);
    else projection.apply({ origin: 'remote', changes: patchesToChanges(event.patches) });
  });
}

export interface ViewProjection extends Projection {
  /** Reactive: bumps on every reset/apply. */
  readonly revision: number;
  entities(): readonly EntityId[];
  entity(id: EntityId): EntityView | undefined;
  text(id: EntityId, component: ComponentId): string | undefined;
  values(id: EntityId, component: ComponentId): Readonly<Record<string, unknown>> | undefined;
}

/** A plain reactive projection (what UI components read). */
export function createViewProjection(): ViewProjection {
  const entities = new Map<EntityId, Map<ComponentId, ComponentNode>>();
  const revision: Box<number> = box(0);
  const bump = (): void => revision.set(revision.get() + 1);
  return {
    get revision() {
      return revision.get();
    },
    reset(view) {
      entities.clear();
      for (const [id, components] of Object.entries(view.entities)) {
        entities.set(id, new Map(Object.entries(components) as [ComponentId, ComponentNode][]));
      }
      bump();
    },
    apply(set) {
      for (const change of set.changes) {
        switch (change.type) {
          case 'entity.created':
            if (!entities.has(change.entity)) entities.set(change.entity, new Map());
            break;
          case 'entity.deleted':
            entities.delete(change.entity);
            break;
          case 'component.set':
            entities.get(change.entity)?.set(change.component, { kind: 'struct', values: change.values });
            break;
          case 'component.removed':
            entities.get(change.entity)?.delete(change.component);
            break;
          case 'text.changed':
            entities.get(change.entity)?.set(change.component, { kind: 'text', text: change.text });
            break;
        }
      }
      bump();
    },
    entities() {
      revision.get();
      return [...entities.keys()].sort();
    },
    entity(id) {
      revision.get();
      const components = entities.get(id);
      return components === undefined ? undefined : (Object.fromEntries(components) as EntityView);
    },
    text(id, component) {
      revision.get();
      const node = entities.get(id)?.get(component);
      return node?.kind === 'text' ? node.text : undefined;
    },
    values(id, component) {
      revision.get();
      const node = entities.get(id)?.get(component);
      return node?.kind === 'struct' ? node.values : undefined;
    },
  };
}
