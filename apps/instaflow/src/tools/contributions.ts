/**
 * B3's contributions to the editor spec (D16, B0's `apps/instaflow/src/spec`). Nothing here builds a screen.
 *
 * - **Tools** `instaflow/select` (V) and `instaflow/hand` (H): the real Select and Hand tools behind B0's placeholder
 *   ids (same ids, so specs, saved specs and pins keep working). Their behaviour is `createToolController` and
 *   `createToolCommands`; the keyboard path is `TOOL_KEYMAP`.
 * - **Capabilities** `instaflow/move-by`, `instaflow/resize-by`, `instaflow/rotate-by` (numbers in, one change set =
 *   one undo step out; exposed to agents, gated per subject, locks apply) and `instaflow/rotate-90-cw` /
 *   `instaflow/rotate-90-ccw` (selection only) with **HUD actions** running them.
 * - B10a: `instaflow/flip-horizontal`, `instaflow/flip-vertical`, `instaflow/skew-by` and `instaflow/set-transform`
 *   (the numeric bar's X, Y, W, H, angle and skew, applied in that order as one change set); they and `rotate-by`
 *   take an optional `pivot` (a page point; default the frame centre). HUD actions: Flip horizontal / vertical and
 *   Free transform (enters transform mode in the editor through `TOOL_HUD_COMMANDS`, not a capability: a session is
 *   view state).
 * - Align, centre in container and distribute are B1's capabilities (`instaflow/align-*`, `instaflow/distribute-*`);
 *   tools reuse them and do not redefine them.
 *
 * Lit-free: the editor worker imports this file (B9); the numeric transform bar's panel is `transform-bar.ts`.
 */
import { capabilityDeclarationUnit, capabilityImplementationUnit, defineCapability, implementCapability, type RunContext, s } from '@staticflux/capabilities';
import { AbortedError, err, ok, type Result } from '@staticflux/core';
import type { NodeId } from '@staticflux/document/v2';
import type { Actor } from '@staticflux/stage';
import { commitEdit } from '../elements/actions.js';
import { defineHudAction, defineTool, hudActionContribution, type HudActionContribution, toolContribution, type ToolContribution } from '../spec/contributions.js';
import { StudioIds } from '../spec/studio-ids.js';
import { NothingToTransformError } from './errors.js';
import { type FlipAxis, flipValues, NUMERIC_FIELDS, type NumericField, numericValues, pivotFraction, SKEW_LIMIT, skewByValues } from './free-transform.js';
import type { ToolOutcome, ToolSession } from './gesture.js';
import type { ToolCommands } from './keyboard.js';
import { createPreview } from './transform-mode.js';
import { captureTransform, moveValues, type Point, resizeByValues, rotateValues, type SpatialValues, type TransformStart, valuesToOps } from './transform.js';

export const selectTool: ToolContribution = defineTool({
  id: StudioIds.tool.select,
  label: 'Select',
  glyph: '↖',
  shortcut: 'V',
  description: 'Select, move, resize and rotate; drag on empty canvas for a marquee. Arrow keys nudge, Tab cycles.',
});

export const handTool: ToolContribution = defineTool({
  id: StudioIds.tool.hand,
  label: 'Hand',
  glyph: '✋',
  shortcut: 'H',
  description: 'Pan the canvas; arrow keys pan, Mod+= and Mod+- zoom.',
});

export const toolContributions: readonly ToolContribution[] = Object.freeze([selectTool, handTool]);

const nodes = s.array(s.string({ minLength: 1 }), { minItems: 1, maxItems: 10_000 });
const output = s.object({ ops: s.number({ integer: true, min: 0, description: 'Ops written in the one change set' }) });
/** B10a: the reference point on the page (default the centre of the nodes' frame). */
const pivot = s.optional(s.object({ x: s.number({ description: 'Page x' }), y: s.number({ description: 'Page y' }) }, { description: 'Pivot (reference point) on the page; default the centre of the frame' }));

export const moveByCapability = defineCapability({
  id: 'instaflow/move-by',
  title: 'Move by',
  description: 'Move elements by a page-space offset (one undo step; position-locked elements stay put).',
  input: s.object({ nodes, dx: s.number({ description: 'Page units, right is positive' }), dy: s.number({ description: 'Page units, down is positive' }) }),
  output,
  requiresConfirmation: false,
  destructive: false,
  exposeToAgents: true,
});

export const resizeByCapability = defineCapability({
  id: 'instaflow/resize-by',
  title: 'Resize by',
  description: 'Grow or shrink elements by a width and height delta in their own units, top-left corner fixed (one undo step).',
  input: s.object({ nodes, dw: s.number({ description: 'Width delta' }), dh: s.number({ description: 'Height delta' }) }),
  output,
  requiresConfirmation: false,
  destructive: false,
  exposeToAgents: true,
});

export const rotateByCapability = defineCapability({
  id: 'instaflow/rotate-by',
  title: 'Rotate by',
  description: 'Rotate elements clockwise by degrees about the pivot (default the centre of their selection frame; one undo step).',
  input: s.object({ nodes, degrees: s.number({ min: -3600, max: 3600, description: 'Degrees, clockwise' }), pivot }),
  output,
  requiresConfirmation: false,
  destructive: false,
  exposeToAgents: true,
});

export const rotate90CwCapability = defineCapability({
  id: 'instaflow/rotate-90-cw',
  title: 'Rotate 90° clockwise',
  description: 'Rotate the selection 90° clockwise about its centre.',
  input: s.object({ nodes }),
  output,
  requiresConfirmation: false,
  destructive: false,
  exposeToAgents: true,
});

export const rotate90CcwCapability = defineCapability({
  id: 'instaflow/rotate-90-ccw',
  title: 'Rotate 90° counter-clockwise',
  description: 'Rotate the selection 90° counter-clockwise about its centre.',
  input: s.object({ nodes }),
  output,
  requiresConfirmation: false,
  destructive: false,
  exposeToAgents: true,
});

export const flipHorizontalCapability = defineCapability({
  id: 'instaflow/flip-horizontal',
  title: 'Flip horizontal',
  description: 'Mirror elements left to right over the pivot (one element along its own axes; one undo step; twice restores).',
  input: s.object({ nodes, pivot }),
  output,
  requiresConfirmation: false,
  destructive: false,
  exposeToAgents: true,
});

export const flipVerticalCapability = defineCapability({
  id: 'instaflow/flip-vertical',
  title: 'Flip vertical',
  description: 'Mirror elements top to bottom over the pivot (one element along its own axes; one undo step; twice restores).',
  input: s.object({ nodes, pivot }),
  output,
  requiresConfirmation: false,
  destructive: false,
  exposeToAgents: true,
});

const skewAngle = (description: string) => s.number({ min: -SKEW_LIMIT, max: SKEW_LIMIT, description });

export const skewByCapability = defineCapability({
  id: 'instaflow/skew-by',
  title: 'Skew by',
  description: 'Skew elements about the pivot: x leans the vertical edges, y the horizontal ones (degrees within ±80; one element along its own axes; one undo step).',
  input: s.object({ nodes, x: skewAngle('Horizontal skew in degrees (vertical edges lean right for positive values)'), y: skewAngle('Vertical skew in degrees (horizontal edges lean down for positive values)'), pivot }),
  output,
  requiresConfirmation: false,
  destructive: false,
  exposeToAgents: true,
});

const optionalNumber = (description: string) => s.optional(s.number({ description }));

export const setTransformCapability = defineCapability({
  id: 'instaflow/set-transform',
  title: 'Set transform',
  description:
    'Set X, Y, W, H, angle and skew like the numeric transform bar (one element: its box in its parent; several: their frame on the page). Given fields apply in that order as one undo step; linked keeps W and H in proportion.',
  input: s.object({
    nodes,
    x: optionalNumber('X'),
    y: optionalNumber('Y'),
    w: optionalNumber('Width (at least 1)'),
    h: optionalNumber('Height (at least 1)'),
    rotation: optionalNumber('Angle in degrees, clockwise'),
    skew: optionalNumber('Horizontal skew in degrees (within ±80)'),
    linked: s.optional(s.boolean({ description: 'Keep W and H in proportion' })),
    pivot,
  }),
  output,
  requiresConfirmation: false,
  destructive: false,
  exposeToAgents: true,
});

export const toolCapabilities = Object.freeze([
  moveByCapability,
  resizeByCapability,
  rotateByCapability,
  rotate90CwCapability,
  rotate90CcwCapability,
  flipHorizontalCapability,
  flipVerticalCapability,
  skewByCapability,
  setTransformCapability,
]);

/** What the implementations need: the open page's tool session and the run's actor. */
export interface ToolEditEnv {
  session(): ToolSession | undefined;
  actorFor(run: RunContext): Result<Actor>;
}

/** Run a transform on explicit nodes as one change set (capabilities, HUD and tests). */
export function runTransform(
  session: ToolSession,
  actor: Actor,
  label: string,
  targets: readonly NodeId[],
  values: (start: TransformStart) => SpatialValues[],
  signal?: AbortSignal,
): Result<{ readonly ops: number }> {
  if (signal?.aborted === true) return err(AbortedError());
  const start = captureTransform(session.ctx, targets);
  if (!start.ok) return start;
  const ops = valuesToOps(start.value, values(start.value));
  if (ops.length === 0) return ok({ ops: 0 });
  const committed = commitEdit(session.target, actor, label, ok(ops));
  return committed.ok ? ok({ ops: ops.length }) : committed;
}

/**
 * Run several transform steps on explicit nodes as **one** change set (B10a, `set-transform`): each step sees the
 * previous ones (previewed in the session layer, cleared before the commit); an active transform session's own
 * previews are shown again afterwards.
 */
export function runTransformSteps(
  session: ToolSession,
  actor: Actor,
  label: string,
  targets: readonly NodeId[],
  steps: readonly ((start: TransformStart) => Result<readonly SpatialValues[]>)[],
  signal?: AbortSignal,
): Result<{ readonly ops: number }> {
  if (signal?.aborted === true) return err(AbortedError());
  const first = captureTransform(session.ctx, targets);
  if (!first.ok) return first;
  const preview = createPreview(session.session);
  const merged = new Map<NodeId, SpatialValues>();
  let start = first.value;
  try {
    for (const step of steps) {
      const values = step(start);
      if (!values.ok) return values;
      preview.show(values.value);
      for (const v of values.value) merged.set(v.node, { ...merged.get(v.node), ...v });
      const next = captureTransform(session.ctx, targets);
      if (!next.ok) return next;
      start = next.value;
    }
  } finally {
    preview.clear();
    session.mode?.restore();
  }
  const ops = valuesToOps(first.value, [...merged.values()]);
  if (ops.length === 0) return ok({ ops: 0 });
  const committed = commitEdit(session.target, actor, label, ok(ops));
  return committed.ok ? ok({ ops: ops.length }) : committed;
}

/** One capability run: the open page, the run's actor, one change set. */
function runFor(env: ToolEditEnv, run: RunContext, label: string, targets: readonly NodeId[], values: (start: TransformStart) => SpatialValues[]): Result<{ readonly ops: number }> {
  const session = env.session();
  if (session === undefined) return err(NothingToTransformError({ message: 'No page is open.' }));
  const actor = env.actorFor(run);
  return actor.ok ? runTransform(session, actor.value, label, targets, values, run.signal) : actor;
}

type PagePoint = { readonly x: number; readonly y: number } | undefined;
/** A page pivot as frame fractions of a start (undefined: the centre). */
const fractionOf = (start: TransformStart, p: PagePoint): Point | undefined => (p === undefined ? undefined : pivotFraction(start.frame, [p.x, p.y]));
const pageOf = (start: TransformStart, p: PagePoint): Point => (p === undefined ? start.frame.center : [p.x, p.y]);

const flipWith =
  (env: ToolEditEnv, axis: FlipAxis, label: string) =>
  (i: { readonly nodes: readonly string[]; readonly pivot?: PagePoint }, run: RunContext): Result<{ readonly ops: number }> =>
    runFor(env, run, label, i.nodes, (start) => flipValues(start, axis, fractionOf(start, i.pivot)));

export function toolCapabilityImplementations(env: ToolEditEnv) {
  return [
    implementCapability(moveByCapability, (i, run) => runFor(env, run, 'Move', i.nodes, (start) => moveValues(start, i.dx, i.dy))),
    implementCapability(resizeByCapability, (i, run) => runFor(env, run, 'Resize', i.nodes, (start) => resizeByValues(start, i.dw, i.dh))),
    implementCapability(rotateByCapability, (i, run) => runFor(env, run, 'Rotate', i.nodes, (start) => rotateValues(start, i.degrees, pageOf(start, i.pivot)))),
    implementCapability(rotate90CwCapability, (i, run) => runFor(env, run, 'Rotate', i.nodes, (start) => rotateValues(start, 90))),
    implementCapability(rotate90CcwCapability, (i, run) => runFor(env, run, 'Rotate', i.nodes, (start) => rotateValues(start, -90))),
    implementCapability(flipHorizontalCapability, flipWith(env, 'horizontal', 'Flip horizontal')),
    implementCapability(flipVerticalCapability, flipWith(env, 'vertical', 'Flip vertical')),
    implementCapability(skewByCapability, (i, run) => runFor(env, run, 'Skew', i.nodes, (start) => skewByValues(start, i.x, i.y, fractionOf(start, i.pivot)))),
    implementCapability(setTransformCapability, (i, run) => {
      const session = env.session();
      if (session === undefined) return err(NothingToTransformError({ message: 'No page is open.' }));
      const actor = env.actorFor(run);
      if (!actor.ok) return actor;
      const given = NUMERIC_FIELDS.filter((f): f is NumericField => i[f] !== undefined);
      // The pivot is a page point: each step reads it in the frame the previous steps left.
      const steps = given.map((f) => (start: TransformStart) => numericValues(start, { field: f, value: i[f] as number, linked: i.linked === true }, fractionOf(start, i.pivot)));
      return runTransformSteps(session, actor.value, 'Transform', i.nodes, steps, run.signal);
    }),
  ];
}

/** The HUD action that enters transform mode (B10a; an editor command, not a capability: a session is view state). */
export const FREE_TRANSFORM_HUD = 'instaflow/free-transform-hud';

/** Editor-side HUD commands of the tools, by HUD action id. */
export const TOOL_HUD_COMMANDS: Readonly<Record<string, (commands: ToolCommands) => Result<ToolOutcome>>> = Object.freeze({
  [FREE_TRANSFORM_HUD]: (commands: ToolCommands) => commands.transform(),
});

/** HUD actions (B0) for the selection-only transforms; Canvas lens. */
export const toolHudActions: readonly HudActionContribution[] = Object.freeze([
  defineHudAction({ id: rotate90CwCapability.id, label: 'Rotate 90°', description: rotate90CwCapability.description, tone: 'more', capability: rotate90CwCapability.id, lenses: [StudioIds.lens.canvas], scopes: ['selection', 'page'] }),
  defineHudAction({ id: rotate90CcwCapability.id, label: 'Rotate −90°', description: rotate90CcwCapability.description, tone: 'more', capability: rotate90CcwCapability.id, lenses: [StudioIds.lens.canvas], scopes: ['selection', 'page'] }),
  defineHudAction({ id: flipHorizontalCapability.id, label: 'Flip horizontal', description: flipHorizontalCapability.description, tone: 'more', capability: flipHorizontalCapability.id, shortcut: 'Shift+H', lenses: [StudioIds.lens.canvas], scopes: ['selection'] }),
  defineHudAction({ id: flipVerticalCapability.id, label: 'Flip vertical', description: flipVerticalCapability.description, tone: 'more', capability: flipVerticalCapability.id, shortcut: 'Shift+V', lenses: [StudioIds.lens.canvas], scopes: ['selection'] }),
  defineHudAction({ id: FREE_TRANSFORM_HUD, label: 'Free transform', description: 'All handles and the pivot; Enter applies everything as one undo step, Escape cancels.', tone: 'more', shortcut: 'Mod+T', lenses: [StudioIds.lens.canvas], scopes: ['selection'] }),
]);

/** Every B3 contribution: tools, capability declarations and implementations, HUD actions. */
export function toolContributionUnits(env: ToolEditEnv) {
  return [
    ...toolContributions.map((t) => toolContribution(t)),
    ...toolCapabilities.map((c) => capabilityDeclarationUnit(c)),
    ...toolCapabilityImplementations(env).map((impl) => capabilityImplementationUnit(impl)),
    ...toolHudActions.map((a) => hudActionContribution(a)),
  ];
}
