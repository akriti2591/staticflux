/**
 * Typing on the canvas (B8 glue over B2's text session; IF-27.11–27.13; B9 IF-33.9–33.11): one editing session at a
 * time per tab, in the editor module.
 *
 * - The **text host** (main thread) is a focusable element placed over the text box inside the canvas surface; B2's
 *   `TextInput` (EditContext on Chrome, hidden textarea otherwise: the variant binding's choice) owns it, so the IME
 *   anchors at the caret. The editor reaches it through a `TextHostPort` (B9: the TextInput port across the worker
 *   boundary; in one realm, a direct host). While editing, the host is the **`textbox`** assistive technology sees.
 * - Every rect this module hands out is in **surface px** (`textToSurface`); the host side adds the surface's client
 *   offset, which only main knows.
 * - Every text commit and the box-size ops it implies (`textBoxOps`: auto width / auto height) share one change set,
 *   so a keystroke is one undo step and B3's hit tests always see the real text box.
 * - Remote edits and undo of the element refresh the session (stage invalidation).
 * - Escape or Tab ends editing and returns focus to the canvas; an element left empty is deleted with the same step
 *   pattern (one undo step).
 */
import { ok, type Result, type Scope, type SfError } from '@staticflux/core';
import type { NodeId } from '@staticflux/document/v2';
import { type Actor, newTransactionId } from '@staticflux/stage';
import type { ClientRect, TextInput } from '@staticflux/surface/text-input';
import { pageTransform } from '../elements/layout.js';
import { readTextBlock } from '../text/rich-text.js';
import { createTextSession, type TextSession } from '../text/text-session.js';
import type { Rect } from '../text/text-engine.js';
import type { Camera } from '../tools/view-state.js';
import type { StudioDocument } from './document.js';
import { NoOpenPageError } from './errors.js';
import { type StudioFonts, textBlockTransform, type TextLayer, textBoxOps } from './text-layer.js';
import type { TextLayout } from '../text/layout-result.js';
import { P } from '../elements/components.js';
import type { TextEditOverlay } from '../tools/overlay.js';
import type { SceneTransform } from '../render/scene-ir.js';

export type TextExitReason = 'escape' | 'tab' | 'stopped';

/** Where the text host lives (main thread). Rects are surface px. */
export interface TextHostPort {
  /** Create the host for `node` (`role="textbox"`, named `label`) and the TextInput on it. */
  open(node: NodeId, label: string): Result<TextInput>;
  /** Place the host over the text box. */
  place(rect: ClientRect): void;
  /** Remove the host; `escape` and `tab` hand focus back to the canvas surface. */
  close(reason: TextExitReason): void;
}

export interface TextEditingOptions {
  readonly document: StudioDocument;
  readonly page: NodeId;
  readonly node: NodeId;
  readonly layer: TextLayer;
  readonly fonts: StudioFonts;
  readonly host: TextHostPort;
  readonly camera: () => Camera;
  readonly actor: () => Actor;
  /** Apple caret keys (B12 T-3). */
  readonly isMac?: boolean;
  readonly onExit: (reason: TextExitReason) => void;
  readonly onProblem?: (error: SfError) => void;
  readonly scope: Pick<Scope, 'defer'>;
}

/** A pointer event in **page** px while editing (FIX-TEXT-FIRST-KEY item 2; TEXT-FONTS §3.2). */
export interface TextPointer {
  readonly phase: 'down' | 'move' | 'up' | 'cancel';
  readonly x: number;
  readonly y: number;
  readonly shift?: boolean;
  /** Click count on `down`: 1 caret, 2 word, 3 paragraph, 4 all. */
  readonly clicks?: number;
}

export interface TextEditing {
  readonly node: NodeId;
  readonly session: TextSession;
  readonly input: TextInput;
  /** Re-place the host (the camera moved). */
  place(): void;
  /**
   * Caret and selection by pointer (TEXT-FONTS §3.2): a press inside the text box places the caret at the hit
   * (Shift extends from the anchor; double click = word, triple = paragraph, quadruple = all); dragging extends by the
   * press's unit; above the first line selects to the start, below the last to the end. True when it was the text's.
   */
  pointer(event: TextPointer): boolean;
  /** The caret and selection to draw, in block px with the block's page transform; `zoom` keeps the caret ≥ 1 screen px. */
  overlay(zoom: number): TextEditOverlay | undefined;
  stop(): void;
}

type Unit = 'grapheme' | 'word' | 'paragraph' | 'all';
const UNIT_OF_CLICKS: readonly Unit[] = ['grapheme', 'grapheme', 'word', 'paragraph', 'all'];
/** Caret width in page px (TEXT-FONTS §3.2: 1.5 px, never thinner than one screen px). */
const CARET_WIDTH = 1.5;
/** Slop around the text box that still counts as a press in the text (page px at zoom 1). */
const HIT_SLOP = 4;

/** Block px → surface px for the node (page transform with the fixed box's vertical alignment, B12 T-1; camera). */
export function textToSurface(document: StudioDocument, node: NodeId, camera: Camera, laid?: Pick<TextLayout, 'height'>): (r: Rect) => ClientRect {
  return (r) => {
    const [a, b, c, d, e, f] = laid === undefined ? pageTransform(document.context(), node) : textBlockTransform(document, node, laid);
    const px = (x: number, y: number): readonly [number, number] => [(a * x + c * y + e) * camera.zoom + camera.tx, (b * x + d * y + f) * camera.zoom + camera.ty];
    const [x0, y0] = px(r.x0, r.y0);
    const [x1, y1] = px(r.x1, r.y1);
    return { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.max(1, Math.abs(x1 - x0)), height: Math.max(1, Math.abs(y1 - y0)) };
  };
}

/** Start editing `node` (see the module header). */
export function startTextEditing(options: TextEditingOptions): Result<TextEditing> {
  const { document, page, node, layer } = options;
  const part = document.part(page);
  if (part === undefined) return { ok: false, error: NoOpenPageError({ details: { page } }) };
  const name = document.view.value(node, 'name');
  const label = typeof name === 'string' && name.length > 0 ? name : 'Text';
  const input = options.host.open(node, label);
  if (!input.ok) return input;
  // The committed block's size, measured at start and after each commit only: laying the block out again at any other
  // time would replace the session's composition preview in the engine (same block id) and lose its character bounds.
  let blockSize: Pick<TextLayout, 'width' | 'height'> | undefined;
  const measure = (): void => {
    const laid = layer.layout(node);
    if (laid.ok) blockSize = { width: laid.value.width, height: laid.value.height };
  };
  const toSurface = (r: Rect): ClientRect => textToSurface(document, node, options.camera(), blockSize)(r);
  const placeHost = (): void => {
    const laid = blockSize;
    if (laid === undefined) return;
    // The host covers the editable area: the box of a fixed text (B12 T-1), else the laid-out block.
    const h = document.view.value(node, P.h);
    const fixed = document.view.value(node, 'text.box') === 'fixed' && typeof h === 'number';
    const surface = textToSurface(document, node, options.camera());
    options.host.place(fixed ? surface({ x0: 0, y0: 0, x1: Math.max(4, laid.width), y1: Math.max(4, h, laid.height) }) : toSurface({ x0: 0, y0: 0, x1: Math.max(4, laid.width), y1: Math.max(4, laid.height) }));
  };
  let stopped = false;
  let session: TextSession | undefined;
  // B12 T-2: one change set id per session step key (only the open run's key is ever reused).
  let lastStep: readonly [string, string] | undefined;
  const stepChangeSet = (step: string): string => {
    if (lastStep?.[0] !== step) lastStep = [step, newTransactionId()];
    return lastStep[1];
  };
  const stop = (reason: TextExitReason = 'stopped'): void => {
    if (stopped) return;
    stopped = true;
    stopInvalidate();
    session?.dispose();
    input.value.dispose();
    options.host.close(reason);
    // An element left empty disappears (one more undo step on the same change set as nothing else).
    const block = readTextBlock(part, node);
    if (block.ok && block.value.text.length === 0 && document.view.read(node) !== undefined) void document.commitOps(page, options.actor(), 'Remove empty text', [{ op: 'delete', node }]);
    options.onExit(reason);
  };
  const created = createTextSession({
    input: input.value,
    engine: options.fonts.engine,
    blockId: layer.blockId(node),
    layout: (model) => layer.layout(node, model),
    toClient: toSurface,
    target: {
      read: () => readTextBlock(part, node),
      commit(ops, label, step): Result<void> {
        // B12 T-2: the session's step key keeps consecutive typing in one change set (one undo step).
        const changeSet = step === undefined ? newTransactionId() : stepChangeSet(step);
        const committed = document.commitOps(page, options.actor(), label, ops, { changeSet });
        if (!committed.ok) return committed;
        const laid = layer.layout(node);
        if (!laid.ok) return ok();
        blockSize = { width: laid.value.width, height: laid.value.height };
        const sized = document.commitOps(page, options.actor(), label, textBoxOps(document, node, laid.value), { changeSet });
        placeHost();
        return sized;
      },
    },
    onExit: (reason) => stop(reason),
    isMac: options.isMac === true,
    ...(options.onProblem === undefined ? {} : { onProblem: options.onProblem }),
  });
  if (!created.ok) {
    input.value.dispose();
    options.host.close('stopped');
    return created;
  }
  session = created.value;
  const stopInvalidate = document.view.onInvalidate((nodes) => {
    if (!stopped && nodes.includes(node)) {
      if (document.view.read(node) === undefined) stop();
      else session?.refresh();
    }
  });
  measure();
  placeHost();
  input.value.focus();

  // ---- Pointer → caret and selection (FIX-TEXT-FIRST-KEY item 2). Hit tests run on the session's layout (block px).
  const live = session;
  const blockId = layer.blockId(node);
  const engine = options.fonts.engine;
  const blockTransform = (): readonly [number, number, number, number, number, number] => textBlockTransform(document, node, blockSize ?? { height: 0 });
  const toBlock = (x: number, y: number): readonly [number, number] | undefined => {
    const [a, b, c, d, e, f] = blockTransform();
    const det = a * d - b * c;
    if (det === 0) return undefined;
    return [(d * (x - e) - c * (y - f)) / det, (-b * (x - e) + a * (y - f)) / det];
  };
  /** The editable area in block px: the laid-out block, at least the fixed box's height. */
  const area = (): { readonly w: number; readonly h: number } => {
    const h = document.view.value(node, P.h);
    const fixed = document.view.value(node, 'text.box') === 'fixed' && typeof h === 'number';
    return { w: Math.max(4, blockSize?.width ?? 0), h: Math.max(4, blockSize?.height ?? 0, fixed ? h : 0) };
  };
  const offsetAt = (bx: number, by: number): number => {
    const length = live.state.model.text.length;
    if (by < 0) return 0; // above the first line: the start
    if (by > area().h) return length; // below the last line: the end
    const hit = engine.hitTest(blockId, bx, by);
    return hit.ok ? Math.max(0, Math.min(length, hit.value.offset)) : length;
  };
  const rangeOf = (offset: number, unit: Unit): readonly [number, number] => {
    const model = live.state.model;
    if (unit === 'all') return [0, model.text.length];
    if (unit === 'word') {
      const w = engine.wordAt(blockId, offset);
      return w.ok ? w.value : [offset, offset];
    }
    if (unit === 'paragraph') {
      const p = model.paragraphs.find((q) => offset >= q.start && offset <= q.end) ?? model.paragraphs.at(-1);
      return p === undefined ? [offset, offset] : [p.start, p.end];
    }
    return [offset, offset];
  };
  /** The press: the unit and the range it selected (dragging extends from it), or undefined when not pressed. */
  let press: { readonly unit: Unit; readonly from: number; readonly to: number } | undefined;
  const pointer = (event: TextPointer): boolean => {
    if (stopped) return false;
    if (event.phase === 'up' || event.phase === 'cancel') {
      const was = press !== undefined;
      press = undefined;
      return was;
    }
    const at = toBlock(event.x, event.y);
    if (event.phase === 'move') {
      if (press === undefined || at === undefined) return press !== undefined;
      const [a, b] = rangeOf(offsetAt(at[0], at[1]), press.unit);
      // Extend from the pressed range towards the pointer (the anchor stays at its far side).
      if (a < press.from) live.select(press.to, a);
      else live.select(press.from, Math.max(b, press.to));
      return true;
    }
    if (at === undefined) return false;
    const box = area();
    const slop = HIT_SLOP / Math.max(1e-6, options.camera().zoom);
    if (at[0] < -slop || at[1] < -slop || at[0] > box.w + slop || at[1] > box.h + slop) return false;
    const unit = UNIT_OF_CLICKS[Math.min(UNIT_OF_CLICKS.length - 1, Math.max(1, event.clicks ?? 1))] ?? 'grapheme';
    const offset = offsetAt(at[0], at[1]);
    if (event.shift === true && unit === 'grapheme') {
      const anchor = live.state.anchor;
      live.select(anchor, offset);
      press = { unit, from: anchor, to: anchor };
      return true;
    }
    const [a, b] = rangeOf(offset, unit);
    live.select(a, b);
    press = { unit, from: a, to: b };
    return true;
  };
  const overlay = (zoom: number): TextEditOverlay | undefined => {
    if (stopped) return undefined;
    const s = live.state;
    const transform = [...blockTransform()] as unknown as SceneTransform;
    const width = Math.max(CARET_WIDTH, 1 / Math.max(1e-6, zoom));
    const [from, to] = live.selection;
    if (s.composition === undefined && from !== to) {
      const rects = engine.selectionRects(blockId, from, to);
      return { transform, selection: rects.ok ? rects.value : [] };
    }
    const at = s.composition === undefined ? s.focus : { offset: s.composition.from + s.composition.text.length, upstream: false };
    const caret = engine.caret(blockId, at, width);
    return caret.ok ? { transform, caret: caret.value, selection: [] } : { transform, selection: [] };
  };

  const editing: TextEditing = { node, session, input: input.value, place: placeHost, pointer, overlay, stop: () => stop() };
  options.scope.defer(() => stop());
  return ok(editing);
}
