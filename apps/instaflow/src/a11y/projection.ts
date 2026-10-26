/**
 * The virtualized DOM projection of the canvas (IF-7.12, IF-25.1–25.9): what assistive technology sees of a page that
 * is drawn on a GPU canvas. Editor worker side, headless: it produces `@staticflux/surface` `AccessibleNode`s (plain
 * data) that the main-thread mount (`dom.ts`) reconciles into real DOM over the canvas.
 *
 * - **Virtualized**: only elements whose ink bounds meet the visible region (the tab camera's viewport in page space,
 *   grown by `margin` of its size per side) get nodes, found through B3's rbush element index; their ancestors, the
 *   selection and the entered container are kept so the tree and the focus path stay whole. Plain groups are never
 *   taken from the index (their bounds are their children's, which the index does not keep current): a group is in
 *   view when one of its descendants is.
 * - **Reading order** is the document tree (child order), never the paint stack or screen position.
 * - **Names**: the element's `name`, else its text (B2, through the `text` port, first line, at most
 *   `NAME_MAX_CHARS`), else its role description. **Roles** come from `roles.ts` tables.
 * - **Repeats (B7)**: derived instances never get nodes. A live repeat group says how many instances it has; a selected
 *   instance focuses its source node, described as "instance k of n".
 * - **Focus path**: the focused node is the last selected element (mapped to its source) or the entered container; it
 *   alone is in the tab order (`tabIndex` 0), every other selectable element is `-1` (roving tabindex).
 *
 * `projectCanvas(input)` is the pure function; `createCanvasProjector` keeps it current from the stage's invalidations
 * and the tab's view state (camera, viewport, selection, entered container), coalescing bursts into one flush per
 * scheduled turn (machine `instaflow/a11y-projection`, LIFECYCLES §26).
 */
import { createMachine, defineMachine, err, ok, type Result, type Scope, watch } from '@staticflux/core';
import type { Box } from '@staticflux/document/spatial-index';
import type { NodeId } from '@staticflux/document/v2';
import type { AccessibleNode } from '@staticflux/surface';
import { P } from '../elements/components.js';
import { elementBounds, isElement } from '../elements/layout.js';
import { resolveElement } from '../elements/resolve.js';
import { instanceCount } from '../repeat/params.js';
import type { RepeatStage } from '../repeat/stage.js';
import { canvasSelectable, type ElementIndex, type ToolContext } from '../tools/hit-test.js';
import { toScreen, type ViewState } from '../tools/view-state.js';
import { ProjectionRootError, ProjectorDisposedError } from './errors.js';
import { a11yMessages, NAME_MAX_CHARS } from './messages.js';
import { type A11yRole, a11yRoleOf } from './roles.js';

/** What the projection needs from B7's repeat view (omit outside a repeat-aware stage). */
export type InstanceSource = Pick<RepeatStage, 'resolveInstance' | 'params' | 'sourceChildren'>;

/** Plain text of a text element (B2: `readTextBlock(part, node).value.text`); undefined for other kinds. */
export type TextSource = (node: NodeId) => string | undefined;

export interface ProjectionInput {
  /** B3's tool context (the stage may be B7's repeat view). */
  readonly ctx: ToolContext;
  /** B3's element index of the page (the broad phase of the visible query). */
  readonly index: ElementIndex;
  readonly view: Pick<ViewState, 'root' | 'camera' | 'viewport' | 'selection' | 'context'>;
  readonly text?: TextSource;
  readonly instances?: InstanceSource;
  /** Region kept around the viewport per side, as a fraction of its width / height (default `PROJECTION_MARGIN`). */
  readonly margin?: number;
}

export const PROJECTION_MARGIN = 0.5;

export interface CanvasSnapshot {
  /** The page node (the root's label source). */
  readonly root: NodeId;
  /** Root label ("Canvas: <page name>"). */
  readonly label: string;
  /** Top-level nodes in reading order (children nested). */
  readonly nodes: readonly AccessibleNode[];
  /** Every projected id in reading order (depth first). */
  readonly ids: readonly NodeId[];
  /** The node that holds focus (last selected element, or the entered container); undefined: the canvas itself. */
  readonly focus: NodeId | undefined;
  /** The page-space region that was projected. */
  readonly region: Box;
}

/** A spoken description of one element (the announcer and `describe-canvas` share it). */
export interface ElementDescription {
  readonly id: NodeId;
  readonly name: string;
  readonly role: A11yRole;
  /** Extra facts, in order: repeat count, instance position, locks. */
  readonly extra: readonly string[];
}

const stringValue = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

/** The editable node a view node stands for (a derived instance → its source; anything else → itself). */
export function sourceOf(instances: InstanceSource | undefined, node: NodeId): NodeId {
  const ref = instances?.resolveInstance(node);
  return ref?.derived === true ? ref.source : node;
}

/** "instance k of n" of a view node inside a live repeat (innermost level); undefined outside any repeat. */
export function instanceOf(instances: InstanceSource | undefined, node: NodeId): { readonly k: number; readonly n: number } | undefined {
  const ref = instances?.resolveInstance(node);
  const step = ref?.path.at(-1);
  const params = step === undefined ? undefined : instances?.params(step.repeat);
  return step === undefined || params === undefined ? undefined : { k: step.index + 1, n: instanceCount(params) };
}

/** The node the DOM focus follows (IF-25.10): last selected (as its source), else the entered container, else none. */
export function focusTargetOf(view: Pick<ViewState, 'root' | 'selection' | 'context'>, instances?: InstanceSource): NodeId | undefined {
  const last = view.selection.at(-1);
  if (last !== undefined) return sourceOf(instances, last);
  return view.context === view.root ? undefined : sourceOf(instances, view.context);
}

/** Name, role and facts of one element (`viewNode` may be a derived instance: its position is described). */
export function describeElement(input: Pick<ProjectionInput, 'ctx' | 'text' | 'instances'>, viewNode: NodeId): ElementDescription | undefined {
  const { ctx, instances } = input;
  const id = sourceOf(instances, viewNode);
  const composed = ctx.stage.read(id);
  if (composed === undefined) return undefined;
  const params = instances?.params(id);
  const role = a11yRoleOf(composed.kind, stringValue(ctx.stage.value(id, P.shape)), stringValue(ctx.stage.value(id, 'role')), params?.kind);
  const text = input.text?.(id);
  const firstLine = stringValue(text?.split('\n')[0])?.slice(0, NAME_MAX_CHARS);
  const name = stringValue(ctx.stage.value(id, 'name')) ?? firstLine ?? a11yMessages.unnamed(role.roleDescription);
  const instance = instanceOf(instances, viewNode);
  const lock = ctx.stage.lockOf(id);
  const extra = [
    ...(params === undefined ? [] : [a11yMessages.repeatCount(instanceCount(params))]),
    ...(instance === undefined ? [] : [a11yMessages.instance(instance.k, instance.n)]),
    ...(lock.position && lock.content ? [a11yMessages.locked] : lock.position ? [a11yMessages.positionLocked] : []),
  ];
  return { id, name, role, extra };
}

/** The page-space region a camera shows, grown by `margin` of the viewport per side. */
export function visibleRegion(view: Pick<ViewState, 'camera' | 'viewport'>, margin = PROJECTION_MARGIN): Box {
  const { camera, viewport } = view;
  const mx = viewport.width * margin;
  const my = viewport.height * margin;
  return {
    minX: (-mx - camera.tx) / camera.zoom,
    minY: (-my - camera.ty) / camera.zoom,
    maxX: (viewport.width + mx - camera.tx) / camera.zoom,
    maxY: (viewport.height + my - camera.ty) / camera.zoom,
  };
}

/** Project the page once (see the module header). */
export function projectCanvas(input: ProjectionInput): Result<CanvasSnapshot> {
  const { ctx, index, view, instances } = input;
  const stage = ctx.stage;
  const page = stage.read(view.root);
  if (page === undefined) return err(ProjectionRootError({ details: { root: view.root } }));
  const region = visibleRegion(view, input.margin);
  const focus = focusTargetOf(view, instances);
  const keep = new Set<NodeId>();
  const parentOf = (node: NodeId): NodeId | null => {
    const parent = stage.read(node)?.parent ?? null;
    return parent === null ? null : sourceOf(instances, parent);
  };
  const add = (viewNode: NodeId): void => {
    for (let at: NodeId | null = sourceOf(instances, viewNode); at !== null && at !== view.root && !keep.has(at); at = parentOf(at)) {
      if (stage.read(at) === undefined) return;
      keep.add(at);
    }
  };
  index.refresh();
  for (const hit of index.index.search(region)) if (hasOwnBounds(ctx, hit)) add(hit);
  for (const selected of view.selection) add(selected);
  if (view.context !== view.root) add(view.context);

  const childrenOf = (node: NodeId): readonly NodeId[] => (instances === undefined ? stage.children(node) : instances.sourceChildren(node));
  const ids: NodeId[] = [];
  const project = (node: NodeId): AccessibleNode | undefined => {
    const description = describeElement(input, node === focus ? (view.selection.at(-1) ?? node) : node);
    if (description === undefined) return undefined;
    ids.push(node);
    const bounds = elementBounds(ctx, node);
    const children = walk(node);
    const text = input.text?.(node);
    const selectable = canvasSelectable(stage, node);
    const { role } = description;
    return {
      id: node,
      role: role.role,
      roleDescription: role.roleDescription,
      ...(role.level === undefined ? {} : { level: role.level }),
      label: description.name,
      ...(description.extra.length === 0 ? {} : { description: description.extra.join(', ') }),
      ...(bounds.ok ? { bounds: screenBounds(view, bounds.value.ink) } : {}),
      focusable: selectable,
      ...(selectable ? { tabIndex: node === focus ? 0 : -1 } : {}),
      ...(text === undefined ? {} : { text }),
      ...(children.length === 0 ? {} : { children }),
    };
  };
  const walk = (node: NodeId): AccessibleNode[] => {
    const out: AccessibleNode[] = [];
    for (const child of childrenOf(node)) {
      const composed = stage.read(child);
      if (!keep.has(child) || !isElement(composed?.kind) || composed?.values[P.hidden] === true) continue; // B12: hidden elements are not announced
      const projected = project(child);
      if (projected !== undefined) out.push(projected);
    }
    return out;
  };
  const nodes = walk(view.root);
  const pageName = stringValue(stage.value(view.root, 'name')) ?? view.root;
  return ok({ root: view.root, label: a11yMessages.canvas(pageName), nodes, ids, focus: focus !== undefined && ids.includes(focus) ? focus : undefined, region });
}

/** False for plain groups (their bounds are their children's union); true for every element with its own geometry. */
export function hasOwnBounds(ctx: Pick<ToolContext, 'stage' | 'kit'>, node: NodeId): boolean {
  const el = resolveElement(ctx.stage, node, ctx.kit);
  return el !== undefined && el.geometry.kind !== 'group';
}

function screenBounds(view: Pick<ViewState, 'camera'>, box: Box): NonNullable<AccessibleNode['bounds']> {
  const [x0, y0] = toScreen(view.camera, box.minX, box.minY);
  const [x1, y1] = toScreen(view.camera, box.maxX, box.maxY);
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

// ---------------------------------------------------------------- the live projector

export const CanvasProjectionLifecycle = /* @__PURE__ */ defineMachine({
  id: 'instaflow/a11y-projection',
  initial: 'dirty',
  states: ['clean', 'dirty', 'disposed'],
  transitions: {
    clean: { invalidate: 'dirty', dispose: 'disposed' },
    dirty: { flush: 'clean', dispose: 'disposed' },
  },
});
export type CanvasProjectionState = (typeof CanvasProjectionLifecycle.states)[number];

export interface CanvasProjectorOptions extends ProjectionInput {
  readonly view: ViewState;
  /** Runs `flush` later, once per burst (default a microtask; the main mount may pass `requestAnimationFrame`). */
  readonly schedule?: (flush: () => void) => void;
  /** Disposed with the tab scope (rule 5). */
  readonly scope?: Pick<Scope, 'defer'>;
}

export interface CanvasProjector {
  /** `clean` (snapshot current), `dirty` (a flush is scheduled) or `disposed`. Reactive. */
  readonly state: CanvasProjectionState;
  /** The latest snapshot (flushes first when dirty). */
  snapshot(): Result<CanvasSnapshot>;
  /** Project now; listeners hear the result. */
  flush(): Result<CanvasSnapshot>;
  onChange(listener: (snapshot: CanvasSnapshot) => void): () => void;
  readonly stats: { readonly flushes: number; readonly invalidations: number };
  dispose(): void;
}

/** Keep the projection of one tab current (see the module header). */
export function createCanvasProjector(options: CanvasProjectorOptions): CanvasProjector {
  const machine = createMachine(CanvasProjectionLifecycle);
  const schedule = options.schedule ?? ((fn: () => void): void => queueMicrotask(fn));
  const listeners = new Set<(snapshot: CanvasSnapshot) => void>();
  const stats = { flushes: 0, invalidations: 0 };
  let last: Result<CanvasSnapshot> | undefined;
  const disposed = (): Result<CanvasSnapshot> => err(ProjectorDisposedError());
  const flush = (): Result<CanvasSnapshot> => {
    if (machine.is('disposed')) return disposed();
    if (machine.is('dirty')) machine.send('flush');
    stats.flushes += 1;
    last = projectCanvas(options);
    if (last.ok) for (const listener of [...listeners]) listener(last.value);
    return last;
  };
  const invalidate = (): void => {
    stats.invalidations += 1;
    if (!machine.is('clean')) return;
    machine.send('invalidate');
    schedule(() => {
      if (machine.is('dirty')) flush();
    });
  };
  const stopStage = options.ctx.stage.onInvalidate(invalidate);
  const view = options.view;
  const stopView = watch(() => [view.camera, view.viewport, view.selection, view.context], invalidate);
  const projector: CanvasProjector = {
    get state() {
      return machine.state;
    },
    snapshot: () => (machine.is('disposed') ? disposed() : machine.is('clean') && last !== undefined ? last : flush()),
    flush,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stats,
    dispose() {
      if (machine.is('disposed')) return;
      machine.send('dispose');
      stopStage();
      stopView();
      listeners.clear();
    },
  };
  options.scope?.defer(() => projector.dispose());
  return projector;
}
