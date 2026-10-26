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

export interface TextEditing {
  readonly node: NodeId;
  readonly session: TextSession;
  readonly input: TextInput;
  /** Re-place the host (the camera moved). */
  place(): void;
  stop(): void;
}

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
  const editing: TextEditing = { node, session, input: input.value, place: placeHost, stop: () => stop() };
  options.scope.defer(() => stop());
  return ok(editing);
}
