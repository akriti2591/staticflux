/**
 * Keyboard paths for every tool (IF-24.20–24.23; D17: everything works by hand without a pointer):
 *
 * | Keys | Command |
 * |---|---|
 * | Arrow keys / Shift+Arrow | nudge the selection 1 / 10 units (hand tool: pan 1 / 10 screen steps) |
 * | Mod+Alt+Arrow (Shift: ×10) | resize the selection (right / down grow, left / up shrink) |
 * | Alt+] / Alt+[ (Mod+Alt: 1°) | rotate the selection by ±15° |
 * | Tab / Shift+Tab | select the next / previous element in the entered container (paint order) |
 * | Mod+Shift+ArrowRight / ArrowLeft | add the next / previous element to the selection (keyboard marquee) |
 * | Mod+A | select every element of the entered container |
 * | Enter / Shift+Enter | enter the selection (select its children) / select the parent |
 * | Escape | clear the selection (and leave the entered container) |
 * | Mod+= / Mod+- / Shift+0 / Shift+1 / Shift+2 | zoom in / out / 100 % / fit everything / fit the selection |
 *
 * Each nudge, resize or rotate is one change set (one undo step) through B1's `commitEdit`; position-locked elements
 * stay put (IF-TOOL-002 when nothing can move). The arrow keys' meaning per tool is data (`ARROW_ACTIONS`).
 */
import { defineShortcut, defineShortcutScope, type KeyCombo, type ShortcutRegistry } from '@staticflux/a11y';
import { ok, type Result, type Scope } from '@staticflux/core';
import type { NodeId } from '@staticflux/document/v2';
import { commitEdit } from '../elements/actions.js';
import { isElement } from '../elements/layout.js';
import { pruneSelection, refreshOverlay, type ToolBehaviour, TOOL_BEHAVIOURS, type ToolOutcome, type ToolSession } from './gesture.js';
import { canvasSelectable, elementsInPaintOrder, selectionBounds } from './hit-test.js';
import { captureTransform, moveValues, resizeByValues, rotateValues, ROTATE_STEP, valuesToOps } from './transform.js';
import { fitCamera, stepZoom } from './view-state.js';

/** Studio's shortcut scope (`StudioShortcutScope`, same id): the canvas scope is its child, so canvas keys win while the canvas has focus. */
const StudioScope = /* @__PURE__ */ defineShortcutScope('instaflow/studio');
export const CanvasToolsShortcutScope = /* @__PURE__ */ defineShortcutScope('instaflow/canvas-tools', { parent: StudioScope });

export const NUDGE = Object.freeze({ step: 1, large: 10 });
/** Hand-tool keyboard pan step in screen pixels. */
export const PAN_STEP = 40;

export type Direction = 'left' | 'right' | 'up' | 'down';
const VECTORS: Readonly<Record<Direction, readonly [number, number]>> = Object.freeze({ left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] });

/** What the arrow keys do per tool behaviour (data, rule 4). */
export const ARROW_ACTIONS: Readonly<Record<ToolBehaviour, 'nudge' | 'pan'>> = Object.freeze({ select: 'nudge', hand: 'pan' });

export interface ToolCommands {
  arrow(direction: Direction, large: boolean): Result<ToolOutcome>;
  nudge(dx: number, dy: number): Result<ToolOutcome>;
  pan(dx: number, dy: number): Result<ToolOutcome>;
  resizeBy(dw: number, dh: number): Result<ToolOutcome>;
  rotateBy(degrees: number): Result<ToolOutcome>;
  selectSibling(step: 1 | -1, extend: boolean): Result<ToolOutcome>;
  selectAll(): Result<ToolOutcome>;
  enter(): Result<ToolOutcome>;
  selectParent(): Result<ToolOutcome>;
  escape(): Result<ToolOutcome>;
  zoomStep(direction: 1 | -1): Result<ToolOutcome>;
  zoomTo(zoom: number): Result<ToolOutcome>;
  fitAll(): Result<ToolOutcome>;
  fitSelection(): Result<ToolOutcome>;
}

const NONE: ToolOutcome = Object.freeze({ kind: 'none' });

/** The keyboard commands of one tab (see the module header). */
export function createToolCommands(s: ToolSession): ToolCommands {
  const selected = (): ToolOutcome => {
    refreshOverlay(s);
    return { kind: 'selection', selection: s.view.selection };
  };
  const commit = (label: string, values: (start: Parameters<typeof valuesToOps>[0]) => Parameters<typeof valuesToOps>[1]): Result<ToolOutcome> => {
    pruneSelection(s);
    const start = captureTransform(s.ctx, s.view.selection);
    if (!start.ok) return start;
    const ops = valuesToOps(start.value, values(start.value));
    if (ops.length === 0) return ok(NONE);
    const committed = commitEdit(s.target, s.actor(), label, ok(ops));
    refreshOverlay(s);
    return committed.ok ? ok({ kind: 'committed', label, ops: ops.length }) : committed;
  };
  const siblings = (): NodeId[] => s.ctx.stage.children(s.view.context).filter((n) => isElement(s.ctx.stage.read(n)?.kind) && canvasSelectable(s.ctx.stage, n));
  const fit = (box: Parameters<typeof fitCamera>[0] | undefined): Result<ToolOutcome> => {
    if (box === undefined) return ok(NONE);
    const set = s.view.setCamera(fitCamera(box, s.view.viewport));
    if (!set.ok) return set;
    refreshOverlay(s);
    return ok(NONE);
  };
  const commands: ToolCommands = {
    arrow(direction, large) {
      const [x, y] = VECTORS[direction];
      const behaviour = TOOL_BEHAVIOURS[s.view.tool] ?? 'select';
      const step = large ? NUDGE.large : NUDGE.step;
      return ARROW_ACTIONS[behaviour] === 'pan' ? commands.pan(-x * PAN_STEP * step, -y * PAN_STEP * step) : commands.nudge(x * step, y * step);
    },
    nudge: (dx, dy) => commit('Nudge', (start) => moveValues(start, dx, dy)),
    pan(dx, dy) {
      const r = s.view.panBy(dx, dy);
      return r.ok ? ok(NONE) : r;
    },
    resizeBy: (dw, dh) => commit('Resize', (start) => resizeByValues(start, dw, dh)),
    rotateBy: (degrees) => commit('Rotate', (start) => rotateValues(start, degrees)),
    selectSibling(step, extend) {
      const list = siblings();
      if (list.length === 0) return ok(NONE);
      const current = s.view.selection;
      const anchor = current.length === 0 ? -1 : list.indexOf(current[current.length - 1] as NodeId);
      const next = list[(anchor + step + list.length) % list.length] as NodeId;
      s.view.select(extend ? [...current, next] : [next]);
      return ok(selected());
    },
    selectAll() {
      s.view.select(siblings());
      return ok(selected());
    },
    enter() {
      const first = s.view.selection[0];
      const children = first === undefined ? [] : s.ctx.stage.children(first).filter((n) => isElement(s.ctx.stage.read(n)?.kind));
      if (first === undefined || children.length === 0) return ok(NONE);
      s.view.setContext(first);
      s.view.select([children[0] as NodeId]);
      return ok(selected());
    },
    selectParent() {
      const first = s.view.selection[0];
      const parent = first === undefined ? undefined : (s.ctx.stage.read(first)?.parent ?? undefined);
      if (parent === undefined || parent === s.view.root || !isElement(s.ctx.stage.read(parent)?.kind)) return ok(NONE);
      s.view.setContext(s.ctx.stage.read(parent)?.parent ?? s.view.root);
      s.view.select([parent]);
      return ok(selected());
    },
    escape() {
      s.view.clear();
      s.view.setContext(s.view.root);
      return ok(selected());
    },
    zoomStep(direction) {
      return commands.zoomTo(stepZoom(s.view.camera.zoom, direction));
    },
    zoomTo(zoom) {
      const r = s.view.zoomBy(zoom / s.view.camera.zoom);
      if (!r.ok) return r;
      refreshOverlay(s);
      return ok(NONE);
    },
    fitAll() {
      const all = elementsInPaintOrder(s.ctx.stage, s.view.root).filter((n) => s.ctx.stage.read(n)?.parent === s.view.root);
      const b = selectionBounds(s.ctx, all);
      return b.ok ? fit(b.value) : b;
    },
    fitSelection() {
      const b = selectionBounds(s.ctx, s.view.selection);
      return b.ok ? fit(b.value) : b;
    },
  };
  return commands;
}

export interface ToolKeyBinding {
  readonly id: `instaflow/${string}`;
  readonly keys: readonly KeyCombo[];
  readonly description: string;
  readonly run: (commands: ToolCommands) => Result<ToolOutcome>;
}

const arrows = (large: boolean): ToolKeyBinding[] =>
  (['left', 'right', 'up', 'down'] as const).map((d) => ({
    id: `instaflow/arrow-${d}${large ? '-large' : ''}`,
    keys: [`${large ? 'Shift+' : ''}Arrow${d[0]?.toUpperCase()}${d.slice(1)}` as KeyCombo],
    description: `${large ? 'Nudge 10' : 'Nudge 1'} ${d} (hand tool: pan)`,
    run: (c) => c.arrow(d, large),
  }));

const resizes = (large: boolean): ToolKeyBinding[] =>
  (
    [
      ['right', 1, 0],
      ['left', -1, 0],
      ['down', 0, 1],
      ['up', 0, -1],
    ] as const
  ).map(([d, w, h]) => ({
    id: `instaflow/resize-${d}${large ? '-large' : ''}`,
    keys: [`Mod+Alt+${large ? 'Shift+' : ''}Arrow${d[0]?.toUpperCase()}${d.slice(1)}` as KeyCombo],
    description: `${w + h > 0 ? 'Grow' : 'Shrink'} the selection ${large ? 10 : 1} (${w !== 0 ? 'width' : 'height'})`,
    run: (c) => c.resizeBy(w * (large ? NUDGE.large : NUDGE.step), h * (large ? NUDGE.large : NUDGE.step)),
  }));

/** Every tool shortcut (data; `bindToolShortcuts` registers them). */
export const TOOL_KEYMAP: readonly ToolKeyBinding[] = Object.freeze([
  ...arrows(false),
  ...arrows(true),
  ...resizes(false),
  ...resizes(true),
  { id: 'instaflow/rotate-cw', keys: ['Alt+]'], description: `Rotate ${ROTATE_STEP}° clockwise`, run: (c) => c.rotateBy(ROTATE_STEP) },
  { id: 'instaflow/rotate-ccw', keys: ['Alt+['], description: `Rotate ${ROTATE_STEP}° counter-clockwise`, run: (c) => c.rotateBy(-ROTATE_STEP) },
  { id: 'instaflow/rotate-cw-fine', keys: ['Mod+Alt+]'], description: 'Rotate 1° clockwise', run: (c) => c.rotateBy(1) },
  { id: 'instaflow/rotate-ccw-fine', keys: ['Mod+Alt+['], description: 'Rotate 1° counter-clockwise', run: (c) => c.rotateBy(-1) },
  { id: 'instaflow/select-next', keys: ['Tab'], description: 'Select the next element', run: (c) => c.selectSibling(1, false) },
  { id: 'instaflow/select-previous', keys: ['Shift+Tab'], description: 'Select the previous element', run: (c) => c.selectSibling(-1, false) },
  { id: 'instaflow/extend-next', keys: ['Mod+Shift+ArrowRight'], description: 'Add the next element to the selection', run: (c) => c.selectSibling(1, true) },
  { id: 'instaflow/extend-previous', keys: ['Mod+Shift+ArrowLeft'], description: 'Add the previous element to the selection', run: (c) => c.selectSibling(-1, true) },
  { id: 'instaflow/select-all', keys: ['Mod+A'], description: 'Select all', run: (c) => c.selectAll() },
  { id: 'instaflow/select-children', keys: ['Enter'], description: 'Select inside (children)', run: (c) => c.enter() },
  { id: 'instaflow/select-parent', keys: ['Shift+Enter'], description: 'Select the parent', run: (c) => c.selectParent() },
  { id: 'instaflow/deselect', keys: ['Escape'], description: 'Clear the selection', run: (c) => c.escape() },
  { id: 'instaflow/zoom-in', keys: ['Mod+='], description: 'Zoom in', run: (c) => c.zoomStep(1) },
  { id: 'instaflow/zoom-out', keys: ['Mod+-'], description: 'Zoom out', run: (c) => c.zoomStep(-1) },
  { id: 'instaflow/zoom-100', keys: ['Shift+0'], description: 'Zoom to 100 %', run: (c) => c.zoomTo(1) },
  { id: 'instaflow/zoom-fit', keys: ['Shift+1'], description: 'Zoom to fit everything', run: (c) => c.fitAll() },
  { id: 'instaflow/zoom-selection', keys: ['Shift+2'], description: 'Zoom to the selection', run: (c) => c.fitSelection() },
]);

/** Register the tool shortcuts for the lifetime of `scope` (the canvas activates `CanvasToolsShortcutScope` while focused). */
export function bindToolShortcuts(registry: ShortcutRegistry, commands: ToolCommands, scope: Scope, onOutcome: (r: Result<ToolOutcome>) => void = () => undefined): Result<void> {
  for (const binding of TOOL_KEYMAP) {
    const def = defineShortcut({ id: binding.id, keys: binding.keys, scope: CanvasToolsShortcutScope, description: binding.description, allowInInputs: false });
    const registered = registry.register(def, () => onOutcome(binding.run(commands)), { scope });
    if (!registered.ok) return registered;
  }
  return ok();
}
