/**
 * Style classes and local overrides (IF-4.6, IF-20.6): elements inherit a brand-kit class through `style.inherit`
 * (the stage's inherit arc). A local value on the element is an **override**: the stage's provenance shows it beating
 * the class opinion, and resetting it (writing `null`) brings the class value back. Final paths of a class cannot be
 * overridden (the stage rejects the write, SF-STAGE-003).
 */
import type { JsonValue, NodeId, PartOp, PropertyPath } from '@staticflux/document/v2';
import type { AssetRef, Opinion, Stage } from '@staticflux/stage';
import { P } from './components.js';

export interface ClassRef {
  readonly kit?: AssetRef;
  readonly class: string;
}

/** Ops that make `nodes` inherit `cls` (or stop inheriting with `null`). */
export function applyClassOps(nodes: readonly NodeId[], cls: ClassRef | null): PartOp[] {
  const value: JsonValue = cls === null ? null : { ...(cls.kit === undefined ? {} : { kit: cls.kit as unknown as JsonValue }), class: cls.class };
  return nodes.map((node) => ({ op: 'set', node, path: P.inherit, value }));
}

export interface StyleOverride {
  readonly path: PropertyPath;
  /** The element's own value. */
  readonly local: JsonValue | undefined;
  /** The class value it hides. */
  readonly inherited: JsonValue | undefined;
  readonly from: Opinion;
}

/** Paths where the element's local value overrides its class (from stage provenance). */
export function overridesOf(stage: Pick<Stage, 'read' | 'explain'>, node: NodeId): StyleOverride[] {
  const composed = stage.read(node);
  if (composed === undefined) return [];
  const out: StyleOverride[] = [];
  for (const [path, winner] of Object.entries(composed.provenance)) {
    if (winner.arc !== 'local' || path === P.inherit) continue;
    const explained = stage.explain(node, path);
    const inherited = explained.overridden.find((o) => o.arc === 'inherit');
    if (inherited !== undefined) out.push({ path, local: winner.value, inherited: inherited.value, from: inherited });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Ops that drop local overrides so the class values show again (all overrides when `paths` is omitted). */
export function resetOverrideOps(stage: Pick<Stage, 'read' | 'explain'>, node: NodeId, paths?: readonly PropertyPath[]): PartOp[] {
  const chosen = paths ?? overridesOf(stage, node).map((o) => o.path);
  return chosen.map((path) => ({ op: 'set', node, path, value: null }));
}

/** Where a value comes from, for the inspector hint ("from class Headline", "@primary"). */
export function styleSource(stage: Pick<Stage, 'explain'>, node: NodeId, path: PropertyPath): { readonly arc: Opinion['arc'] | 'default'; readonly token?: string; readonly node?: string } {
  const winner = stage.explain(node, path).winner;
  if (winner === undefined) return { arc: 'default' };
  const token = winner.token?.path.slice(`${P.tokens}.`.length);
  return { arc: winner.arc, ...(token === undefined ? {} : { token }), node: winner.node };
}

/** Ops that bake the composed values of `paths` locally and stop inheriting ("detach from class"). */
export function detachClassOps(stage: Pick<Stage, 'read'>, node: NodeId, paths: readonly PropertyPath[]): PartOp[] {
  const composed = stage.read(node);
  if (composed === undefined) return [];
  const ops: PartOp[] = [];
  for (const path of paths) {
    const winner = composed.provenance[path];
    if (winner === undefined || winner.arc === 'local') continue;
    // Keep the token reference, not its colour, so the element still follows the brand kit.
    const value = winner.token !== undefined ? `@${winner.token.path.slice(`${P.tokens}.`.length)}` : winner.value;
    ops.push({ op: 'set', node, path, value });
  }
  ops.push({ op: 'set', node, path: P.inherit, value: null });
  return ops;
}
