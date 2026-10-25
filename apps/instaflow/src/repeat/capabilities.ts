/**
 * B7's repeat operations as capabilities (validated, gated per subject, attributed, one change set = one undo step):
 * declarations, selection facts and the implementations over the editor's repeat context. Lit-free, so the editor
 * worker imports it (B9); `contributions.ts` re-exports it with the HUD actions and the panel.
 */
import { defineCapability, implementCapability, type RunContext, s } from '@staticflux/capabilities';
import { AbortedError, err, ok, type Result } from '@staticflux/core';
import type { NodeId, PartOp } from '@staticflux/document/v2';
import type { Actor } from '@staticflux/stage';
import type { EditTarget } from '../elements/actions.js';
import { isElement } from '../elements/layout.js';
import { commitRepeatEdit, expandRepeat, makeRepeat, newRepeatParams, releaseRepeat, type RepeatContext, setRepeat } from './actions.js';
import { BRICK_AXES, MIRROR_AXES, REPEAT_KINDS, type RepeatKind } from './components.js';
import { RepeatNotApplicableError } from './errors.js';
import { REPEAT_LIMITS, type RepeatPatch } from './params.js';

/** Facts about a selection (HUD enablement and tests). */
export interface RepeatSelectionFacts {
  readonly count: number;
  readonly elements: number;
  readonly sameParent: boolean;
  /** Live repeats in the document (not derived copies). */
  readonly repeats: number;
  readonly derived: number;
}

export function repeatSelectionFacts(ctx: Pick<RepeatContext, 'stage'>, nodes: readonly NodeId[]): RepeatSelectionFacts {
  const composed = nodes.map((n) => ctx.stage.read(n));
  const derived = nodes.filter((n) => ctx.stage.isDerived(n)).length;
  return {
    count: nodes.length,
    elements: composed.filter((c) => c !== undefined && isElement(c.kind)).length,
    sameParent: new Set(composed.map((c) => c?.parent ?? null)).size <= 1,
    repeats: nodes.filter((n) => !ctx.stage.isDerived(n) && ctx.stage.params(n) !== undefined).length,
    derived,
  };
}

export interface RepeatActionInput {
  readonly nodes: readonly string[];
  readonly params?: RepeatPatch;
}

interface RepeatActionSpec {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly destructive?: boolean;
  readonly tone: 'direct' | 'more';
  readonly applies: (f: RepeatSelectionFacts) => boolean;
  readonly run: (ctx: RepeatContext, input: RepeatActionInput) => Result<PartOp[]>;
}

const need = (what: string): Result<never> => err(RepeatNotApplicableError({ details: { needs: what } }));
const each = (ctx: RepeatContext, nodes: readonly NodeId[], one: (ctx: RepeatContext, node: NodeId) => Result<PartOp[]>): Result<PartOp[]> => {
  const ops: PartOp[] = [];
  for (const node of nodes) {
    const r = one(ctx, node);
    if (!r.ok) return r;
    ops.push(...r.value);
  }
  return ok(ops);
};

const MAKE: Readonly<Record<RepeatKind, readonly [title: string, description: string]>> = {
  radial: ['Radial repeat', 'Repeat the selection around a circle (count, radius, start angle, sweep, rotate copies); live and editable.'],
  grid: ['Grid repeat', 'Repeat the selection in rows and columns (gaps, row and column offsets, brick shift); live and editable.'],
  mirror: ['Mirror repeat', 'Mirror the selection across an axis (vertical, horizontal or any angle, with an offset); live and editable.'],
};

/** The repeat operations (one capability and one HUD action each). */
export const REPEAT_ACTIONS: readonly RepeatActionSpec[] = [
  ...REPEAT_KINDS.map(
    (kind): RepeatActionSpec => ({
      name: `repeat-${kind}`,
      title: MAKE[kind][0],
      description: MAKE[kind][1],
      tone: 'direct',
      applies: (f) => f.elements >= 1 && f.sameParent && f.derived === 0,
      run: (ctx, i) => makeRepeat(ctx, i.nodes, newRepeatParams(kind, i.params)),
    }),
  ),
  {
    name: 'repeat-edit',
    title: 'Edit repeat',
    description: 'Change the parameters of the selected repeats (`params`; a `kind` switches the generator).',
    tone: 'more',
    applies: (f) => f.repeats >= 1 && f.repeats === f.count,
    run: (ctx, i) => (i.params === undefined ? need('params') : each(ctx, i.nodes, (c, node) => setRepeat(c, node, i.params as RepeatPatch))),
  },
  {
    name: 'repeat-expand',
    title: 'Expand repeat',
    description: 'Turn every instance into real elements in one undo step (match keys stay deterministic).',
    destructive: true,
    tone: 'more',
    applies: (f) => f.repeats >= 1 && f.repeats === f.count,
    run: (ctx, i) =>
      each(ctx, i.nodes, (c, node) => {
        const r = expandRepeat(c, node);
        return r.ok ? ok(r.value.ops) : r;
      }),
  },
  { name: 'repeat-release', title: 'Release repeat', description: 'Stop repeating; the source stays as a group, unchanged.', tone: 'more', applies: (f) => f.repeats >= 1 && f.repeats === f.count, run: (ctx, i) => each(ctx, i.nodes, releaseRepeat) },
];

const paramsInput = s.object({
  kind: s.optional(s.enum(REPEAT_KINDS)),
  count: s.optional(s.number({ integer: true, min: REPEAT_LIMITS.count.min, max: REPEAT_LIMITS.count.max, description: 'Radial: instances, the source included' })),
  radius: s.optional(s.number({ min: 0, description: 'Radial: circle radius (px)' })),
  startAngle: s.optional(s.number({ description: 'Radial: where the source sits, degrees clockwise from 12 o’clock' })),
  sweep: s.optional(s.number({ min: 0, max: REPEAT_LIMITS.sweep.max, description: 'Radial: arc in degrees (360 = full circle)' })),
  rotate: s.optional(s.boolean({ description: 'Radial: turn copies with the circle' })),
  rows: s.optional(s.number({ integer: true, min: REPEAT_LIMITS.rows.min, max: REPEAT_LIMITS.rows.max })),
  columns: s.optional(s.number({ integer: true, min: REPEAT_LIMITS.columns.min, max: REPEAT_LIMITS.columns.max })),
  gapX: s.optional(s.number({ description: 'Grid: horizontal gap between cells (px)' })),
  gapY: s.optional(s.number({ description: 'Grid: vertical gap between cells (px)' })),
  rowOffset: s.optional(s.number({ description: 'Grid: x shift per row (px)' })),
  columnOffset: s.optional(s.number({ description: 'Grid: y shift per column (px)' })),
  brick: s.optional(s.enum(BRICK_AXES)),
  brickShift: s.optional(s.number({ min: REPEAT_LIMITS.brickShift.min, max: REPEAT_LIMITS.brickShift.max, description: 'Grid: odd row / column shift in cells' })),
  axis: s.optional(s.enum(MIRROR_AXES)),
  angle: s.optional(s.number({ description: 'Mirror: axis angle in degrees (axis "angle")' })),
  offset: s.optional(s.number({ description: 'Mirror: axis distance beyond the source edge (px)' })),
});
const actionInput = s.object({ nodes: s.array(s.string({ minLength: 1 }), { minItems: 1, maxItems: 10_000 }), params: s.optional(paramsInput) });
const actionOutput = s.object({ ops: s.number({ integer: true, min: 0, description: 'Ops written in the one change set' }) });

export const repeatActionId = (name: string): `instaflow/${string}` => `instaflow/${name}`;

/** Capability declarations, one per repeat operation. */
export const repeatCapabilities = REPEAT_ACTIONS.map((a) =>
  defineCapability({
    id: repeatActionId(a.name),
    title: a.title,
    description: a.description,
    input: actionInput,
    output: actionOutput,
    requiresConfirmation: false,
    destructive: a.destructive === true,
    exposeToAgents: true,
  }),
);

/** What the implementations need from the editor (the open page's repeat context and undo service). */
export interface RepeatEditEnv {
  context(): RepeatContext | undefined;
  target(): EditTarget | undefined;
  actorFor(run: RunContext): Result<Actor>;
}

/** Run one repeat operation as one change set (keyboard paths and tests use it without the registry). */
export function runRepeatAction(env: RepeatEditEnv, name: string, input: RepeatActionInput, actor: Actor, signal?: AbortSignal): Result<{ readonly ops: number }> {
  if (signal?.aborted === true) return err(AbortedError({ cause: signal.reason }));
  const action = REPEAT_ACTIONS.find((a) => a.name === name);
  const ctx = env.context();
  const target = env.target();
  if (action === undefined || ctx === undefined || target === undefined) return need('an open page');
  if (!action.applies(repeatSelectionFacts(ctx, input.nodes))) return need(action.title.toLowerCase());
  const ops = action.run(ctx, input);
  const committed = commitRepeatEdit(target, actor, action.title, ops, (node) => ctx.stage.params(node));
  if (!committed.ok) return committed;
  return ok({ ops: ops.ok ? ops.value.length : 0 });
}

export function repeatCapabilityImplementations(env: RepeatEditEnv) {
  return REPEAT_ACTIONS.map((action, i) =>
    implementCapability(repeatCapabilities[i] as (typeof repeatCapabilities)[number], (input, run) => {
      const actor = env.actorFor(run);
      return actor.ok ? runRepeatAction(env, action.name, input as RepeatActionInput, actor.value, run.signal) : actor;
    }),
  );
}
