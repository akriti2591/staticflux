/**
 * Layers of the stage's layer stack (DOCUMENT-FORMAT §3.3), strongest first:
 *
 *   session        ephemeral previews, solo/mute, the active variant selection — never persisted
 *   proposal/<id>  agent change-set previews (M2: added with `stage.addLayer`, between session and local)
 *   local          the asset's own content (the `StageDocument`)
 *
 * A layer holds direct opinions per stage node (a root-asset node id or an instance proxy id). Arcs (variant, inherit,
 * reference) are weaker than every layer's direct opinions.
 */
import type { JsonValue, PropertyPath } from '@staticflux/document/v2';

export type LayerId = 'session' | 'local' | `proposal/${string}`;
/** A root-asset node id, or an instance proxy `<instance>/<source>[/<source>…]`. */
export type StageNodeId = string;

export const SESSION_LAYER: LayerId = 'session';
export const LOCAL_LAYER: LayerId = 'local';

export interface StageLayer {
  readonly id: LayerId;
  /** Direct opinions on a stage node. */
  opinions(node: StageNodeId): Readonly<Record<PropertyPath, JsonValue>> | undefined;
  /** Nodes whose opinions changed. */
  subscribe(listener: (nodes: readonly StageNodeId[]) => void): () => void;
}

/** One `set → value` entry of a variant selection, e.g. `['format', 'story']`. */
export type VariantChoice = readonly [set: string, value: string];

export interface SessionLayer extends StageLayer {
  set(node: StageNodeId, path: PropertyPath, value: JsonValue): void;
  /** Clear one opinion, every opinion on a node, or (no args) the whole layer. */
  clear(node?: StageNodeId, path?: PropertyPath): void;
  /** Select a variant (`undefined` deselects). Earlier selections are stronger than later ones. */
  select(set: string, value: string | undefined): void;
  selection(): readonly VariantChoice[];
  onSelection(listener: (selection: readonly VariantChoice[]) => void): () => void;
}

export function createSessionLayer(initial: { readonly selection?: readonly VariantChoice[] } = {}): SessionLayer {
  const opinions = new Map<StageNodeId, Map<PropertyPath, JsonValue>>();
  let choices: VariantChoice[] = [...(initial.selection ?? [])];
  const listeners = new Set<(nodes: readonly StageNodeId[]) => void>();
  const selectionListeners = new Set<(selection: readonly VariantChoice[]) => void>();
  const emit = (nodes: readonly StageNodeId[]): void => {
    if (nodes.length > 0) for (const listener of [...listeners]) listener(nodes);
  };
  return {
    id: SESSION_LAYER,
    opinions(node) {
      const map = opinions.get(node);
      return map === undefined ? undefined : Object.fromEntries(map);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(node, path, value) {
      let map = opinions.get(node);
      if (map === undefined) opinions.set(node, (map = new Map()));
      map.set(path, value);
      emit([node]);
    },
    clear(node, path) {
      if (node === undefined) {
        const all = [...opinions.keys()];
        opinions.clear();
        emit(all);
        return;
      }
      const map = opinions.get(node);
      if (map === undefined) return;
      if (path === undefined) map.clear();
      else map.delete(path);
      if (map.size === 0) opinions.delete(node);
      emit([node]);
    },
    select(set, value) {
      choices = choices.filter(([s]) => s !== set);
      if (value !== undefined) choices.push([set, value]);
      for (const listener of [...selectionListeners]) listener(choices);
    },
    selection: () => choices,
    onSelection(listener) {
      selectionListeners.add(listener);
      return () => {
        selectionListeners.delete(listener);
      };
    },
  };
}
