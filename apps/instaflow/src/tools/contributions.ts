/**
 * B3's contributions to the editor spec (D16, B0's `apps/instaflow/src/spec`). Nothing here builds a screen.
 *
 * - **Tools** `instaflow/select` (V) and `instaflow/hand` (H): the real Select and Hand tools behind B0's placeholder
 *   ids (same ids, so specs, saved specs and pins keep working). Their behaviour is `createToolController` and
 *   `createToolCommands`; the keyboard path is `TOOL_KEYMAP`.
 * - **Capabilities** `instaflow/move-by`, `instaflow/resize-by`, `instaflow/rotate-by` (numbers in, one change set =
 *   one undo step out; exposed to agents, gated per subject, locks apply) and `instaflow/rotate-90-cw` /
 *   `instaflow/rotate-90-ccw` (selection only) with **HUD actions** running them.
 * - Align, centre in container and distribute are B1's capabilities (`instaflow/align-*`, `instaflow/distribute-*`);
 *   tools reuse them and do not redefine them.
 */
import { capabilityDeclarationUnit, capabilityImplementationUnit, defineCapability, implementCapability, type RunContext, s } from '@staticflux/capabilities';
import { AbortedError, err, ok, type Result } from '@staticflux/core';
import type { NodeId } from '@staticflux/document/v2';
import type { Actor } from '@staticflux/stage';
import { commitEdit } from '../elements/actions.js';
import { defineHudAction, defineTool, hudActionContribution, type HudActionContribution, toolContribution, type ToolContribution } from '../spec/contributions.js';
import { StudioIds } from '../spec/studio-contributions.js';
import { NothingToTransformError } from './errors.js';
import type { ToolSession } from './gesture.js';
import { captureTransform, moveValues, resizeByValues, rotateValues, type SpatialValues, type TransformStart, valuesToOps } from './transform.js';

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
  description: 'Rotate elements clockwise by degrees about the centre of their selection frame (one undo step).',
  input: s.object({ nodes, degrees: s.number({ min: -3600, max: 3600, description: 'Degrees, clockwise' }) }),
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

export const toolCapabilities = Object.freeze([moveByCapability, resizeByCapability, rotateByCapability, rotate90CwCapability, rotate90CcwCapability]);

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

/** One capability run: the open page, the run's actor, one change set. */
function runFor(env: ToolEditEnv, run: RunContext, label: string, targets: readonly NodeId[], values: (start: TransformStart) => SpatialValues[]): Result<{ readonly ops: number }> {
  const session = env.session();
  if (session === undefined) return err(NothingToTransformError({ message: 'No page is open.' }));
  const actor = env.actorFor(run);
  return actor.ok ? runTransform(session, actor.value, label, targets, values, run.signal) : actor;
}

export function toolCapabilityImplementations(env: ToolEditEnv) {
  return [
    implementCapability(moveByCapability, (i, run) => runFor(env, run, 'Move', i.nodes, (start) => moveValues(start, i.dx, i.dy))),
    implementCapability(resizeByCapability, (i, run) => runFor(env, run, 'Resize', i.nodes, (start) => resizeByValues(start, i.dw, i.dh))),
    implementCapability(rotateByCapability, (i, run) => runFor(env, run, 'Rotate', i.nodes, (start) => rotateValues(start, i.degrees))),
    implementCapability(rotate90CwCapability, (i, run) => runFor(env, run, 'Rotate', i.nodes, (start) => rotateValues(start, 90))),
    implementCapability(rotate90CcwCapability, (i, run) => runFor(env, run, 'Rotate', i.nodes, (start) => rotateValues(start, -90))),
  ];
}

/** HUD actions (B0) for the selection-only transforms; Canvas lens. */
export const toolHudActions: readonly HudActionContribution[] = Object.freeze([
  defineHudAction({ id: rotate90CwCapability.id, label: 'Rotate 90°', description: rotate90CwCapability.description, tone: 'more', capability: rotate90CwCapability.id, lenses: [StudioIds.lens.canvas], scopes: ['selection', 'page'] }),
  defineHudAction({ id: rotate90CcwCapability.id, label: 'Rotate −90°', description: rotate90CcwCapability.description, tone: 'more', capability: rotate90CcwCapability.id, lenses: [StudioIds.lens.canvas], scopes: ['selection', 'page'] }),
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
