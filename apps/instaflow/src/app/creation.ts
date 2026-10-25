/**
 * Creation tools on the canvas (B8; IF-27.8–27.10): Shape (`R`), Frame (`F`) and Text (`T`) — the toolbar tools B0
 * placed and B3 left to "tools that bring their own controllers" (B3's `TOOL_BEHAVIOURS` covers Select and Hand).
 *
 * - **Drag** draws the box (page space; Shift keeps it square, Alt draws from the centre). The preview is B3's
 *   overlay marquee (never the document); release commits **one create** through B1's `commitEdit` (one undo step,
 *   value checks, locks), selects the new element and hands the tool back (`onDone`, Figma-like).
 * - **Click** without a drag creates the tool's default size at the pointer.
 * - Text creates a B2 text element (`placeTextOps`, auto width on click, auto height with the dragged width) and
 *   asks the host to start editing it (`onText`).
 *
 * What each tool creates is a row of `CREATION_TOOLS` (rule 4: no branch on the tool). Machine
 * `instaflow/create-gesture` (LIFECYCLES §29): idle → pressed → drawing → idle (release | cancel).
 */
import { createMachine, defineMachine, err, ok, type Result } from '@staticflux/core';
import type { Box } from '@staticflux/document/spatial-index';
import type { JsonValue, NodeId, PartOp } from '@staticflux/document/v2';
import type { Actor } from '@staticflux/stage';
import { commitEdit, type EditTarget } from '../elements/actions.js';
import { P } from '../elements/components.js';
import { StudioIds } from '../spec/studio-ids.js';
import type { ToolId } from '../spec/contributions.js';
import { placeTextOps } from '../text/commands.js';
import { EMPTY_OVERLAY } from '../tools/overlay.js';
import { POINTER, type ToolPointer } from '../tools/gesture.js';
import { toPage, type ViewState } from '../tools/view-state.js';
import { GestureStateError } from '../tools/errors.js';

export interface CreateRequest {
  readonly node: NodeId;
  readonly parent: NodeId;
  /** Page-space box (w/h ≥ 1). */
  readonly box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  /** True when the person dragged (false: a click at the default size). */
  readonly dragged: boolean;
}

export interface CreationTool {
  /** Undo label. */
  readonly label: string;
  /** Size of a click-created element. */
  readonly size: { readonly w: number; readonly h: number };
  readonly ops: (request: CreateRequest) => Result<PartOp[]>;
  /** After the commit: `text` asks the host to start editing the new element. */
  readonly then: 'select' | 'text';
}

const FILL = [{ paint: '@primary' }] as unknown as JsonValue;

const element = (kind: string, props: Record<string, JsonValue>) => (r: CreateRequest): Result<PartOp[]> =>
  ok([{ op: 'create', node: r.node, kind, parent: r.parent, props: { name: '', [P.x]: r.box.x, [P.y]: r.box.y, [P.w]: r.box.w, [P.h]: r.box.h, ...props } }]);

/** Tool id → what it creates (data). */
export const CREATION_TOOLS: Readonly<Record<ToolId, CreationTool>> = Object.freeze({
  [StudioIds.tool.shape]: { label: 'Draw rectangle', size: { w: 100, h: 100 }, ops: element('shape', { [P.fills]: FILL }), then: 'select' },
  [StudioIds.tool.frame]: { label: 'Draw frame', size: { w: 400, h: 300 }, ops: element('frame', { [P.fills]: [{ paint: '#ffffff' }] as unknown as JsonValue }), then: 'select' },
  [StudioIds.tool.text]: {
    label: 'Add text',
    size: { w: 0, h: 0 },
    ops: (r) => placeTextOps({ node: r.node, parent: r.parent, x: r.box.x, y: r.box.y, ...(r.dragged ? { width: r.box.w } : {}) }),
    then: 'text',
  },
});

export const CreateGestureLifecycle = /* @__PURE__ */ defineMachine({
  id: 'instaflow/create-gesture',
  initial: 'idle',
  states: ['idle', 'pressed', 'drawing'],
  transitions: {
    idle: { press: 'pressed' },
    pressed: { draw: 'drawing', release: 'idle', cancel: 'idle' },
    drawing: { release: 'idle', cancel: 'idle' },
  },
});
export type CreateGestureState = (typeof CreateGestureLifecycle.states)[number];

export interface CreationSession {
  readonly view: ViewState;
  readonly target: EditTarget;
  readonly actor: () => Actor;
  readonly newId: () => NodeId;
  /** Where new elements go (the entered container or the page). */
  readonly parent: () => NodeId;
  /** A text element was created: start editing it. */
  readonly onText?: (node: NodeId) => void;
  /** The element is placed: hand the toolbar back to Select. */
  readonly onDone?: () => void;
}

export type CreateOutcome = { readonly kind: 'none' } | { readonly kind: 'created'; readonly node: NodeId; readonly label: string } | { readonly kind: 'cancelled' };

export interface CreationController {
  readonly state: CreateGestureState;
  /** Whether `tool` creates elements (the canvas routes its pointer events here). */
  handles(tool: ToolId): boolean;
  pointer(event: ToolPointer): Result<CreateOutcome>;
  cancel(): CreateOutcome;
}

/** The box from the press to `page` (Shift: square, Alt: from the centre). */
export function dragBox(from: readonly [number, number], to: readonly [number, number], mods: { readonly shift?: boolean; readonly alt?: boolean } = {}): Box {
  let dx = to[0] - from[0];
  let dy = to[1] - from[1];
  if (mods.shift === true) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * side;
    dy = Math.sign(dy || 1) * side;
  }
  const [cx, cy] = from;
  const x0 = mods.alt === true ? cx - Math.abs(dx) : Math.min(cx, cx + dx);
  const y0 = mods.alt === true ? cy - Math.abs(dy) : Math.min(cy, cy + dy);
  const x1 = mods.alt === true ? cx + Math.abs(dx) : Math.max(cx, cx + dx);
  const y1 = mods.alt === true ? cy + Math.abs(dy) : Math.max(cy, cy + dy);
  return { minX: x0, minY: y0, maxX: x1, maxY: y1 };
}

const NONE: CreateOutcome = Object.freeze({ kind: 'none' });

/** The creation controller of one tab (see the module header). */
export function createCreationController(s: CreationSession): CreationController {
  const machine = createMachine(CreateGestureLifecycle);
  let press: { readonly sx: number; readonly sy: number; readonly page: readonly [number, number]; readonly tool: CreationTool } | undefined;
  let last: Box | undefined;

  const reset = (): void => {
    press = undefined;
    last = undefined;
    s.view.setOverlay(EMPTY_OVERLAY);
  };

  const commit = (tool: CreationTool, box: Box, dragged: boolean): Result<CreateOutcome> => {
    const node = s.newId();
    const w = dragged ? Math.max(1, box.maxX - box.minX) : tool.size.w;
    const h = dragged ? Math.max(1, box.maxY - box.minY) : tool.size.h;
    const ops = tool.ops({ node, parent: s.parent(), box: { x: box.minX, y: box.minY, w, h }, dragged });
    const committed = commitEdit(s.target, s.actor(), tool.label, ops);
    if (!committed.ok) return committed;
    s.view.select([node]);
    s.onDone?.();
    if (tool.then === 'text') s.onText?.(node);
    return ok({ kind: 'created', node, label: tool.label });
  };

  const handlers: Readonly<Record<ToolPointer['phase'], (e: ToolPointer) => Result<CreateOutcome>>> = {
    down(e) {
      const tool = CREATION_TOOLS[s.view.tool as ToolId];
      if (tool === undefined) return ok(NONE);
      if (!machine.is('idle')) return err(GestureStateError({ message: `Pointer down during "${machine.state}".`, details: { state: machine.state } }));
      press = { sx: e.x, sy: e.y, page: toPage(s.view.camera, e.x, e.y), tool };
      machine.send('press');
      return ok(NONE);
    },
    move(e) {
      if (press === undefined) return ok(NONE);
      if (machine.is('pressed')) {
        if (Math.hypot(e.x - press.sx, e.y - press.sy) < POINTER.dragSlop) return ok(NONE);
        machine.send('draw');
      }
      last = dragBox(press.page, toPage(s.view.camera, e.x, e.y), { shift: e.shift === true, alt: e.alt === true });
      s.view.setOverlay({ ...EMPTY_OVERLAY, marquee: last });
      return ok(NONE);
    },
    up(e) {
      if (press === undefined) return ok(NONE);
      const { tool, page } = press;
      if (machine.is('drawing')) last = dragBox(page, toPage(s.view.camera, e.x, e.y), { shift: e.shift === true, alt: e.alt === true });
      const dragged = machine.is('drawing') && last !== undefined;
      const box = dragged && last !== undefined ? last : { minX: page[0], minY: page[1], maxX: page[0], maxY: page[1] };
      machine.send('release');
      reset();
      return commit(tool, box, dragged);
    },
    cancel: () => ok(cancel()),
  };

  const cancel = (): CreateOutcome => {
    if (machine.is('idle')) return NONE;
    machine.send('cancel');
    reset();
    return { kind: 'cancelled' };
  };

  return {
    get state() {
      return machine.state;
    },
    handles: (tool) => CREATION_TOOLS[tool] !== undefined,
    pointer: (event) => handlers[event.phase](event),
    cancel,
  };
}
