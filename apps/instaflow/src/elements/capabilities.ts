/**
 * B1's element actions as capabilities (validated, gated per subject, attributed, one change set = one undo step):
 * declarations, selection facts and the implementations over the editor's element context. Lit-free, so the editor
 * worker imports it (B9); `contributions.ts` re-exports it with the HUD actions and the panel.
 */
import type { Actor } from '@staticflux/stage';
import { defineCapability, implementCapability, type RunContext, s } from '@staticflux/capabilities';
import { err, ok, type Result } from '@staticflux/core';
import type { NodeId, PartOp } from '@staticflux/document/v2';
import {
  type ActionContext,
  align,
  type AlignEdge,
  type AlignTarget,
  applyToken,
  booleanGroup,
  centerInContainer,
  commitEdit,
  cropImage,
  imageFillIndex,
  distribute,
  type EditTarget,
  flatten,
  frameSelection,
  group,
  outlineStroke,
  releaseBoolean,
  releaseMask,
  rename,
  reorder,
  type ReorderDirection,
  setHidden,
  setMask,
  showAll,
  TOKEN_TARGETS,
  type TokenTarget,
  tidyUp,
  ungroup,
  useAsMask,
  type ImageCropEdit,
} from './actions.js';
import type { ImageRotation } from './values.js';
import { ActionNotApplicableError } from './errors.js';
import { isElement } from './layout.js';
import { resolveElement } from './resolve.js';

/** Facts about a selection (for HUD enablement and tests). */
export interface SelectionFacts {
  readonly count: number;
  readonly elements: number;
  readonly sameParent: boolean;
  readonly booleans: number;
  readonly masks: number;
  readonly withStroke: number;
  /** Elements Flatten bakes: shapes, vectors, booleans and (#69) groups, repeats and masks. */
  readonly flattenable: number;
  /** Groups and frames (B12: ungroup / unframe). */
  readonly containers: number;
  /** Elements with an image fill (B12: crop). */
  readonly images: number;
}

export function selectionFacts(ctx: Pick<ActionContext, 'stage' | 'kit'>, nodes: readonly NodeId[]): SelectionFacts {
  const images = nodes.filter((n) => imageFillIndex(ctx, n) !== undefined).length;
  const resolved = nodes.map((n) => resolveElement(ctx.stage, n, ctx.kit));
  const elements = resolved.filter((r) => r !== undefined && isElement(r.kind));
  return {
    count: nodes.length,
    elements: elements.length,
    sameParent: new Set(resolved.map((r) => r?.parent ?? null)).size <= 1,
    booleans: elements.filter((e) => e?.geometry.kind === 'boolean').length,
    masks: elements.filter((e) => e?.mask !== undefined).length,
    withStroke: elements.filter((e) => (e?.strokes.length ?? 0) > 0).length,
    flattenable: elements.length,
    containers: elements.filter((e) => e?.kind === 'group' || e?.kind === 'frame').length,
    images,
  };
}

export interface ElementActionInput {
  readonly nodes: readonly string[];
  readonly target?: 'selection' | 'container' | 'page';
  readonly key?: string;
  readonly tokenTarget?: TokenTarget;
  readonly token?: string;
  /** `rename`: the new name. */
  readonly name?: string;
  /** `hide`: true hides, false shows, omitted toggles. */
  readonly hidden?: boolean;
  /** `frame-selection`: space around the content (design px, default 0). */
  readonly padding?: number;
  /** `image-crop` (B12 A-3): offset 0…1 of the free space, scale × the fit, rotation in degrees; omitted fields stay. */
  readonly crop?: { readonly x?: number; readonly y?: number; readonly scale?: number; readonly rotation?: number };
}

interface ActionSpec {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly shortcut?: string;
  readonly destructive?: boolean;
  /** HUD placement: `direct` (on the bar) or `more` (in ⋯ More). */
  readonly tone: 'direct' | 'more';
  readonly applies: (f: SelectionFacts) => boolean;
  readonly run: (ctx: ActionContext, input: ElementActionInput) => Result<PartOp[]>;
  /** What to select after the action (B12 structure actions: the new container, the released children). */
  readonly select?: (ops: readonly PartOp[], input: ElementActionInput) => readonly NodeId[];
}

/** The containers an action created (group, frame selection). */
const createdContainers = (ops: readonly PartOp[]): NodeId[] => ops.flatMap((op) => (op.op === 'create' && (op.kind === 'group' || op.kind === 'frame') ? [op.node] : []));
/** The nodes ungroup moved out (in paint order). */
const releasedChildren = (ops: readonly PartOp[]): NodeId[] => ops.flatMap((op) => (op.op === 'move' ? [op.node] : []));

const REORDER: readonly (readonly [ReorderDirection, string, string, string])[] = [
  ['forward', 'bring-forward', 'Bring forward', 'Mod+]'],
  ['backward', 'send-backward', 'Send backward', 'Mod+['],
  ['front', 'bring-to-front', 'Bring to front', 'Mod+Alt+]'],
  ['back', 'send-to-back', 'Send to back', 'Mod+Alt+['],
];

const need = (what: string): Result<never> => err(ActionNotApplicableError({ details: { needs: what } }));
const each = (ctx: ActionContext, nodes: readonly NodeId[], one: (ctx: ActionContext, node: NodeId) => Result<PartOp[]>): Result<PartOp[]> => {
  const ops: PartOp[] = [];
  for (const node of nodes) {
    const r = one(ctx, node);
    if (!r.ok) return r;
    ops.push(...r.value);
  }
  return ok(ops);
};
const targetOf = (input: ElementActionInput): AlignTarget => (input.key !== undefined ? { kind: 'key', node: input.key } : { kind: input.target ?? 'selection' });

const ALIGN: readonly (readonly [AlignEdge, string, string])[] = [
  ['left', 'Align left', 'Alt+A'],
  ['center-x', 'Align horizontal centres', 'Alt+H'],
  ['right', 'Align right', 'Alt+D'],
  ['top', 'Align top', 'Alt+W'],
  ['center-y', 'Align vertical centres', 'Alt+V'],
  ['bottom', 'Align bottom', 'Alt+S'],
];

/** The element actions (one capability and one HUD action each). */
export const ELEMENT_ACTIONS: readonly ActionSpec[] = [
  ...ALIGN.map(
    ([edge, title, shortcut]): ActionSpec => ({
      name: `align-${edge}`,
      title,
      description: `${title} to the selection bounds, the parent frame or page (target), or a key object (key); exact geometry.`,
      shortcut,
      tone: 'direct',
      applies: (f) => f.elements >= 1,
      run: (ctx, i) => align(ctx, i.nodes, edge, targetOf(i)),
    }),
  ),
  { name: 'center-in-container', title: 'Centre in container', description: 'Centre each element in its parent frame or page, both axes.', shortcut: 'Alt+C', tone: 'direct', applies: (f) => f.elements >= 1, run: (ctx, i) => centerInContainer(ctx, i.nodes) },
  { name: 'distribute-h-spacing', title: 'Distribute horizontal spacing', description: 'Equal horizontal gaps; the first and last elements stay.', shortcut: 'Alt+Shift+H', tone: 'direct', applies: (f) => f.elements >= 3, run: (ctx, i) => distribute(ctx, i.nodes, 'x', 'spacing') },
  { name: 'distribute-v-spacing', title: 'Distribute vertical spacing', description: 'Equal vertical gaps; the first and last elements stay.', shortcut: 'Alt+Shift+V', tone: 'direct', applies: (f) => f.elements >= 3, run: (ctx, i) => distribute(ctx, i.nodes, 'y', 'spacing') },
  { name: 'distribute-h-centers', title: 'Distribute horizontal centres', description: 'Equal steps between horizontal centres.', tone: 'more', applies: (f) => f.elements >= 3, run: (ctx, i) => distribute(ctx, i.nodes, 'x', 'centers') },
  { name: 'distribute-v-centers', title: 'Distribute vertical centres', description: 'Equal steps between vertical centres.', tone: 'more', applies: (f) => f.elements >= 3, run: (ctx, i) => distribute(ctx, i.nodes, 'y', 'centers') },
  { name: 'tidy-up', title: 'Tidy up', description: 'Snap a rough grid of elements into even rows and columns.', shortcut: 'Ctrl+Alt+T', tone: 'direct', applies: (f) => f.elements >= 2, run: (ctx, i) => tidyUp(ctx, i.nodes) },
  ...(['union', 'subtract', 'intersect', 'exclude'] as const).map(
    (op): ActionSpec => ({
      name: `boolean-${op}`,
      title: { union: 'Union', subtract: 'Subtract', intersect: 'Intersect', exclude: 'Exclude' }[op],
      description: `A live ${op} of the selected shapes (they stay editable inside the boolean group).`,
      tone: 'direct',
      applies: (f) => f.elements >= 2 && f.sameParent,
      run: (ctx, i) => booleanGroup(ctx, i.nodes, op),
    }),
  ),
  { name: 'boolean-release', title: 'Release boolean', description: 'Put the operands back; nothing else changes.', tone: 'more', applies: (f) => f.booleans >= 1, run: (ctx, i) => each(ctx, i.nodes, releaseBoolean) },
  { name: 'flatten', title: 'Flatten', description: 'Bake a shape, a boolean, a group, a repeat or a mask into one vector path (visible children only; the topmost one’s fill and stroke).', shortcut: 'Ctrl+E', destructive: true, tone: 'more', applies: (f) => f.flattenable >= 1, run: (ctx, i) => each(ctx, i.nodes, flatten) },
  { name: 'outline-stroke', title: 'Outline stroke', description: 'Turn strokes into filled vector paths.', shortcut: 'Ctrl+Alt+O', destructive: true, tone: 'more', applies: (f) => f.withStroke >= 1, run: (ctx, i) => each(ctx, i.nodes, outlineStroke) },
  ...(['clip', 'alpha', 'luminance'] as const).map(
    (mode): ActionSpec => ({
      name: `mask-${mode}`,
      title: { clip: 'Use as mask', alpha: 'Use as alpha mask', luminance: 'Use as luminance mask' }[mode],
      description: `The bottom selected element masks the others (${mode}); everything stays editable.`,
      ...(mode === 'clip' ? { shortcut: 'Ctrl+Alt+M' } : {}),
      tone: mode === 'clip' ? 'direct' : 'more',
      applies: (f) => (f.elements >= 2 && f.sameParent) || f.masks === 1,
      run: (ctx, i) => (i.nodes.length === 1 && i.nodes[0] !== undefined ? setMask(ctx, i.nodes[0], mode) : useAsMask(ctx, i.nodes, mode)),
    }),
  ),
  {
    name: 'mask-invert',
    title: 'Invert mask',
    description: 'Flip what the mask shows and hides.',
    tone: 'more',
    applies: (f) => f.masks >= 1,
    run: (ctx, i) =>
      each(ctx, i.nodes, (c, node) => {
        const el = resolveElement(c.stage, node, c.kit);
        return el?.mask === undefined ? need('a mask') : setMask(c, node, el.mask.mode, !el.mask.invert);
      }),
  },
  { name: 'mask-release', title: 'Release mask', description: 'Stop masking; the masked elements are unchanged.', tone: 'more', applies: (f) => f.masks >= 1, run: (ctx, i) => each(ctx, i.nodes, releaseMask) },
  {
    name: 'apply-token',
    title: 'Apply brand token',
    description: 'Apply a brand token (@name) to the top fill or stroke, the radii or the effects preset.',
    tone: 'more',
    applies: (f) => f.elements >= 1,
    run: (ctx, i) => (i.tokenTarget === undefined || i.token === undefined ? need('tokenTarget and token') : applyToken(ctx, i.nodes, i.tokenTarget, i.token)),
  },
  // B12: structure (APPEARANCE §4.1, §4.9). Each is one change set; `select` names what to select afterwards.
  { name: 'group', title: 'Group', description: 'Wrap the selected siblings in a group at the top-most one’s place; nothing moves on the page.', shortcut: 'Mod+G', tone: 'more', applies: (f) => f.elements >= 1 && f.sameParent, run: (ctx, i) => group(ctx, i.nodes), select: createdContainers },
  {
    name: 'ungroup',
    title: 'Ungroup',
    description: 'Put a group’s or frame’s children back in its place (position and paint order kept); releases booleans and masks inside.',
    shortcut: 'Mod+Shift+G',
    tone: 'more',
    applies: (f) => f.containers >= 1,
    run: (ctx, i) => ungroup(ctx, i.nodes),
    select: releasedChildren,
  },
  {
    name: 'frame-selection',
    title: 'Frame selection',
    description: 'Wrap the selected siblings in a clipping frame sized to them (padding optional, no fill); nothing moves on the page.',
    shortcut: 'Mod+Alt+G',
    tone: 'more',
    applies: (f) => f.elements >= 1 && f.sameParent,
    run: (ctx, i) => frameSelection(ctx, i.nodes, i.padding ?? 0),
    select: createdContainers,
  },
  ...REORDER.map(
    ([direction, name, title, shortcut]): ActionSpec => ({
      name,
      title,
      description: `${title} within the parent; the selected keep their order among themselves.`,
      shortcut,
      tone: 'more',
      applies: (f) => f.elements >= 1,
      run: (ctx, i) => reorder(ctx, i.nodes, direction),
    }),
  ),
  { name: 'rename', title: 'Rename', description: 'Give one element a name (trimmed; empty is refused).', shortcut: 'Mod+Shift+R', tone: 'more', applies: (f) => f.elements === 1, run: (ctx, i) => (i.name === undefined || i.nodes[0] === undefined ? need('name') : rename(ctx, i.nodes[0], i.name)) },
  { name: 'hide', title: 'Hide / show', description: 'Hide the elements (not drawn, exported, hit or announced) or show them again; `hidden` omitted toggles.', shortcut: 'Mod+Shift+H', tone: 'more', applies: (f) => f.elements >= 1, run: (ctx, i) => setHidden(ctx, i.nodes, i.hidden) },
  {
    name: 'image-crop',
    title: 'Crop image',
    description: 'Move, scale or turn the picture inside an image fill (offset x, y 0…1 of the overflow; scale × the fit; rotation 0/90/180/270); the element stays.',
    tone: 'more',
    applies: (f) => f.images >= 1,
    run: (ctx, i) => (i.crop === undefined ? need('crop') : cropImage(ctx, i.nodes, cropEdit(i.crop))),
  },
  { name: 'image-crop-reset', title: 'Reset crop', description: 'Show the whole picture at its plain fit again.', tone: 'more', applies: (f) => f.images >= 1, run: (ctx, i) => cropImage(ctx, i.nodes, null) },
  { name: 'show-all', title: 'Show all', description: 'Show every hidden element on the page (nodes: the page or a container).', tone: 'more', applies: (f) => f.count >= 1, run: (ctx, i) => (i.nodes[0] === undefined ? need('a page') : showAll(ctx, i.nodes[0])) },
];

/** The capability's crop input as an edit (the paint check validates the ranges). */
function cropEdit(c: NonNullable<ElementActionInput['crop']>): ImageCropEdit {
  return {
    ...(c.x === undefined && c.y === undefined ? {} : { offset: [c.x ?? 0.5, c.y ?? 0.5] as const }),
    ...(c.scale === undefined ? {} : { scale: c.scale }),
    ...(c.rotation === undefined ? {} : { rotation: c.rotation as ImageRotation }),
  };
}

const actionInput = s.object({
  nodes: s.array(s.string({ minLength: 1 }), { minItems: 1, maxItems: 10_000 }),
  target: s.optional(s.enum(['selection', 'container', 'page'] as const)),
  key: s.optional(s.string({ minLength: 1, description: 'Key object to align to' })),
  tokenTarget: s.optional(s.enum(Object.keys(TOKEN_TARGETS) as unknown as readonly [TokenTarget, ...TokenTarget[]])),
  token: s.optional(s.string({ minLength: 2, description: 'A brand token, @name' })),
  name: s.optional(s.string({ maxLength: 1000, description: 'rename: the new name (trimmed, 1–200 characters)' })),
  hidden: s.optional(s.boolean({ description: 'hide: true hides, false shows, omitted toggles' })),
  padding: s.optional(s.number({ min: 0, max: 10_000, description: 'frame-selection: space around the content in design px' })),
  crop: s.optional(
    s.object({
      x: s.optional(s.number({ min: 0, max: 1, description: 'Horizontal place in the free space (0 left, 0.5 centred, 1 right)' })),
      y: s.optional(s.number({ min: 0, max: 1, description: 'Vertical place in the free space (0 top, 0.5 centred, 1 bottom)' })),
      scale: s.optional(s.number({ min: 0.01, max: 100, description: 'Scale of the picture × its fit' })),
      rotation: s.optional(s.number({ integer: true, min: 0, max: 270, description: 'Clockwise turn of the picture: 0, 90, 180 or 270' })),
    }),
  ),
});
const actionOutput = s.object({
  ops: s.number({ integer: true, min: 0, description: 'Ops written in the one change set' }),
  select: s.optional(s.array(s.string({ minLength: 1 }), { description: 'Nodes to select afterwards (group, frame selection, ungroup)' })),
});

export const elementActionId = (name: string): `instaflow/${string}` => `instaflow/${name}`;

/** Capability declarations, one per element action. */
export const elementCapabilities = ELEMENT_ACTIONS.map((a) =>
  defineCapability({
    id: elementActionId(a.name),
    title: a.title,
    description: a.description,
    input: actionInput,
    output: actionOutput,
    requiresConfirmation: false,
    destructive: a.destructive === true,
    exposeToAgents: true,
  }),
);

/** What the implementations need from the editor (the open page's element context and undo service). */
export interface ElementEditEnv {
  context(): ActionContext | undefined;
  target(): EditTarget | undefined;
  /** The actor record of a run (the stage attribution port, `metaForRun`). */
  actorFor(run: RunContext): Result<Actor>;
}

/** Run one element action as one change set (exported for tests and keyboard paths without the registry). */
export function runElementAction(env: ElementEditEnv, name: string, input: ElementActionInput, actor: Actor): Result<{ readonly ops: number; readonly select?: readonly NodeId[] }> {
  const action = ELEMENT_ACTIONS.find((a) => a.name === name);
  const ctx = env.context();
  const target = env.target();
  if (action === undefined || ctx === undefined || target === undefined) return need('an open page');
  if (!action.applies(selectionFacts(ctx, input.nodes))) return need(action.title.toLowerCase());
  const ops = action.run(ctx, input);
  const committed = commitEdit(target, actor, action.title, ops);
  if (!committed.ok) return committed;
  const written = ops.ok ? ops.value : [];
  return ok({ ops: written.length, ...(action.select === undefined ? {} : { select: action.select(written, input) }) });
}

export function elementCapabilityImplementations(env: ElementEditEnv) {
  return ELEMENT_ACTIONS.map((action, i) =>
    implementCapability(elementCapabilities[i] as (typeof elementCapabilities)[number], (input, run) => {
      const actor = env.actorFor(run);
      return actor.ok ? runElementAction(env, action.name, input as ElementActionInput, actor.value) : actor;
    }),
  );
}
