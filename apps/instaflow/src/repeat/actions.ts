/**
 * Repeat actions (IF-26.14–26.19): pure functions from a selection to one batch of part ops, committed as **one
 * change set = one undo step** by `commitRepeatEdit` (repeat values, element values, locks and final paths checked
 * first; derived instances are refused by the view's `checkWrite`).
 *
 * - **Make** wraps sibling elements in a repeat group (radial, grid or mirror) at the bottom element's place; the
 *   elements stay where they are and become the source. On a single repeat it switches the generator instead.
 * - **Set** writes parameters (a `kind` switches the generator; the other generator's values are kept).
 * - **Release** clears the repeat: the group stays with the source only.
 * - **Expand** turns every instance into real elements: one group per instance (`Instance n`, the wrapper's exact
 *   spatial values), the source moved into the first one unchanged, deep copies (local opinions: classes, tokens,
 *   nested live repeats kept) in the others. Match keys are deterministic — instance `k` of a node keyed `key` is
 *   `key~k`, exactly what the live view shows — so Auto Animate (M4) matches live and expanded instances, and
 *   expanding the same repeat again gives the same keys. Nodes without a key get `lk_<id>` first (like duplicate).
 */
import { err, ok, type Result } from '@staticflux/core';
import type { JsonValue, NodeId, PartOp, PropertyPath } from '@staticflux/document/v2';
import type { Actor } from '@staticflux/stage';
import { type ActionContext, commitEdit, type EditTarget, localValues } from '../elements/actions.js';
import { P } from '../elements/components.js';
import { isElement } from '../elements/layout.js';
import type { RepeatKind } from './components.js';
import { DerivedInstanceError, RepeatNotApplicableError } from './errors.js';
import { clearRepeatOps, defaultParams, patchOps, type RepeatParams, type RepeatPatch, repeatOps, validateRepeatOps } from './params.js';
import { instanceKey, type RepeatLayout, type RepeatStage, wrapperProps } from './stage.js';

/** The element action context over the repeat view (`stage` is the view; the document is `stage.base`). */
export interface RepeatContext extends ActionContext {
  readonly stage: RepeatStage;
}

const KIND_LABELS: Readonly<Record<RepeatKind, string>> = { radial: 'Radial repeat', grid: 'Grid repeat', mirror: 'Mirror repeat' };

const notApplicable = (message: string, needs: string, details: Record<string, unknown> = {}): Result<never> => err(RepeatNotApplicableError({ message, details: { needs, ...details } }));

/** The layout of a live repeat in the document (IF-REP-004 for a derived copy, IF-REP-003 for anything else). */
export function liveRepeat(ctx: Pick<RepeatContext, 'stage'>, node: NodeId): Result<RepeatLayout> {
  if (ctx.stage.isDerived(node)) return err(DerivedInstanceError({ message: `"${node}" is a repeat instance; edit its source.`, details: { node, source: ctx.stage.resolveInstance(node)?.source } }));
  const layout = ctx.stage.params(node) === undefined ? undefined : ctx.stage.layout(node);
  return layout === undefined ? notApplicable(`"${node}" is not a repeat.`, 'a repeat group', { node }) : ok(layout);
}

/** Wrap sibling `nodes` in a new repeat group, or switch a single repeat to `params`' generator. */
export function makeRepeat(ctx: RepeatContext, nodes: readonly NodeId[], params: RepeatParams): Result<PartOp[]> {
  if (nodes.length === 0) return notApplicable('Select the elements to repeat.', 'an element');
  const derived = nodes.find((n) => ctx.stage.isDerived(n));
  if (derived !== undefined) return err(DerivedInstanceError({ message: `"${derived}" is a repeat instance; repeat its source.`, details: { node: derived } }));
  const only = nodes.length === 1 ? (nodes[0] as NodeId) : undefined;
  if (only !== undefined && ctx.stage.params(only) !== undefined) return ok(repeatOps(only, params));
  const composed = nodes.map((n) => ctx.stage.read(n));
  if (composed.some((c) => c === undefined || !isElement(c.kind))) return notApplicable('Only elements can be repeated.', 'elements');
  const parents = new Set(composed.map((c) => c?.parent ?? null));
  if (parents.size !== 1) return notApplicable('The elements must share one parent.', 'siblings');
  const parent = [...parents][0] as NodeId | null;
  const set = new Set(nodes);
  const ordered = ctx.stage.children(parent).filter((c) => set.has(c));
  const bottom = ordered[0] as NodeId;
  const group = ctx.newId();
  const props: Record<PropertyPath, JsonValue> = { name: KIND_LABELS[params.kind], [P.matchKey]: `lk_${group}` };
  for (const op of repeatOps(group, params)) if (op.op === 'set') props[op.path] = op.value as JsonValue;
  const ops: PartOp[] = [{ op: 'create', node: group, kind: 'group', parent, position: { before: bottom }, props }];
  ordered.forEach((node, index) => ops.push({ op: 'move', node, parent: group, position: { index } }));
  return ok(ops);
}

/** Write parameters of a live repeat (a `kind` switches the generator). */
export function setRepeat(ctx: RepeatContext, node: NodeId, patch: RepeatPatch): Result<PartOp[]> {
  const live = liveRepeat(ctx, node);
  if (!live.ok) return live;
  const ops = patchOps(node, patch);
  return ops.length === 0 ? notApplicable('Nothing changes.', 'a parameter') : ok(ops);
}

/** Release a repeat: the group keeps only the source (nothing else changes). */
export function releaseRepeat(ctx: RepeatContext, node: NodeId): Result<PartOp[]> {
  const live = liveRepeat(ctx, node);
  return live.ok ? ok(clearRepeatOps(node)) : live;
}

/** Expand a repeat into real elements (see the module header); one change set. */
export function expandRepeat(ctx: RepeatContext, node: NodeId): Result<{ readonly ops: PartOp[]; readonly instances: readonly NodeId[] }> {
  const live = liveRepeat(ctx, node);
  if (!live.ok) return live;
  const view = ctx.stage;
  const ops: PartOp[] = [];
  const keyOf = (id: NodeId): string => {
    const key = localValues(view, id)[P.matchKey];
    if (typeof key === 'string') return key;
    ops.push({ op: 'set', node: id, path: P.matchKey, value: `lk_${id}` });
    return `lk_${id}`;
  };
  const repeatKey = keyOf(node);
  ops.push(...clearRepeatOps(node));
  const sameAsset = (child: NodeId, parent: NodeId): boolean => view.read(child)?.source.asset === view.read(parent)?.source.asset;
  // Keys of the whole source subtree (instance 0 keeps them; copies derive from them).
  const keys = new Map<NodeId, string>();
  const collect = (id: NodeId): void => {
    keys.set(id, keyOf(id));
    for (const child of view.sourceChildren(id)) if (sameAsset(child, id)) collect(child);
  };
  const sources = view.sourceChildren(node).filter((c) => sameAsset(c, node));
  for (const source of sources) collect(source);
  const instances = live.value.placements.map(() => ctx.newId());
  live.value.placements.forEach((placement, k) => {
    ops.push({ op: 'create', node: instances[k] as NodeId, kind: 'group', parent: node, position: { index: k }, props: wrapperProps(placement, k, repeatKey) });
  });
  sources.forEach((source, index) => ops.push({ op: 'move', node: source, parent: instances[0] as NodeId, position: { index } }));
  const copy = (source: NodeId, parent: NodeId, index: number, k: number): void => {
    const composed = view.read(source);
    if (composed === undefined) return;
    const id = ctx.newId();
    const props = localValues(view, source);
    props[P.matchKey] = instanceKey(keys.get(source) ?? `lk_${source}`, k);
    ops.push({ op: 'create', node: id, kind: composed.kind, parent, position: { index }, props });
    view
      .sourceChildren(source)
      .filter((c) => sameAsset(c, source))
      .forEach((child, i) => copy(child, id, i, k));
  };
  for (let k = 1; k < instances.length; k++) sources.forEach((source, index) => copy(source, instances[k] as NodeId, index, k));
  return ok({ ops, instances });
}

/** Parameters for a new repeat of `kind`: the defaults with `patch` on top (validated when committed, IF-REP-001). */
export function newRepeatParams(kind: RepeatKind, patch: RepeatPatch = {}): RepeatParams {
  const given = Object.fromEntries(Object.entries(patch).filter(([name, v]) => v !== undefined && name !== 'kind'));
  return { ...defaultParams(kind), ...given, kind } as RepeatParams;
}

/** Commit one repeat action as one change set (repeat values first, then B1's checks and the undo service). */
export function commitRepeatEdit(target: EditTarget, actor: Actor, label: string, ops: Result<readonly PartOp[]>, current: (node: NodeId) => RepeatParams | undefined = () => undefined): Result<void> {
  if (!ops.ok) return ops;
  const valid = validateRepeatOps(ops.value, current);
  if (!valid.ok) return valid;
  return commitEdit(target, actor, label, ops);
}
