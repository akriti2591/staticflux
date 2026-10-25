/**
 * Typing on the canvas (B8 glue over B2's text session; IF-27.11–27.13): one editing session at a time per tab.
 *
 * - The **text host** is a focusable element placed over the text box inside the canvas surface; B2's `TextInput`
 *   (EditContext on Chrome, hidden textarea otherwise: the variant binding's choice) owns it, so the IME anchors at
 *   the caret. While editing, the host is the **`textbox`** assistive technology sees (B6: the projection defers to
 *   the TextInput host; `role="textbox"`, `aria-multiline`, named after the element).
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
import { type StudioFonts, type TextLayer, textBoxOps } from './text-layer.js';

export interface TextEditingOptions {
  readonly document: StudioDocument;
  readonly page: NodeId;
  readonly node: NodeId;
  readonly layer: TextLayer;
  readonly fonts: StudioFonts;
  /** Create the TextInput on `host` (the bound `TextInputFactory`). */
  readonly input: (host: HTMLElement, label: string) => Result<TextInput>;
  /** The canvas surface (the text host goes inside it). */
  readonly surface: HTMLElement;
  readonly camera: () => Camera;
  readonly actor: () => Actor;
  readonly onExit: (reason: 'escape' | 'tab' | 'stopped') => void;
  readonly onProblem?: (error: SfError) => void;
  readonly scope: Pick<Scope, 'defer'>;
}

export interface TextEditing {
  readonly node: NodeId;
  readonly session: TextSession;
  readonly host: HTMLElement;
  readonly input: TextInput;
  stop(): void;
}

/** Block px → client px for the node (page transform, camera, surface offset). */
export function textToClient(document: StudioDocument, node: NodeId, camera: Camera, surface: Pick<HTMLElement, 'getBoundingClientRect'>): (r: Rect) => ClientRect {
  return (r) => {
    const [a, b, c, d, e, f] = pageTransform(document.context(), node);
    const box = surface.getBoundingClientRect();
    const px = (x: number, y: number): readonly [number, number] => [box.left + (a * x + c * y + e) * camera.zoom + camera.tx, box.top + (b * x + d * y + f) * camera.zoom + camera.ty];
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
  const owner = options.surface.ownerDocument;
  const host = owner.createElement('div');
  const name = document.view.value(node, 'name');
  const label = typeof name === 'string' && name.length > 0 ? name : 'Text';
  host.dataset['ifTextHost'] = node;
  host.setAttribute('role', 'textbox');
  host.setAttribute('aria-multiline', 'true');
  host.setAttribute('aria-label', label);
  host.style.position = 'absolute';
  host.style.outline = 'none';
  options.surface.append(host);
  const input = options.input(host, label);
  if (!input.ok) {
    host.remove();
    return input;
  }
  const toClient = (r: Rect): ClientRect => textToClient(document, node, options.camera(), options.surface)(r);
  const placeHost = (): void => {
    const laid = layer.layout(node);
    if (!laid.ok) return;
    const box = options.surface.getBoundingClientRect();
    const r = toClient({ x0: 0, y0: 0, x1: Math.max(4, laid.value.width), y1: Math.max(4, laid.value.height) });
    host.style.left = `${r.x - box.left}px`;
    host.style.top = `${r.y - box.top}px`;
    host.style.width = `${r.width}px`;
    host.style.height = `${r.height}px`;
  };
  let stopped = false;
  let session: TextSession | undefined;
  const stop = (reason: 'escape' | 'tab' | 'stopped' = 'stopped'): void => {
    if (stopped) return;
    stopped = true;
    stopInvalidate();
    session?.dispose();
    input.value.dispose();
    host.remove();
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
    toClient,
    target: {
      read: () => readTextBlock(part, node),
      commit(ops, label): Result<void> {
        const changeSet = newTransactionId();
        const committed = document.commitOps(page, options.actor(), label, ops, { changeSet });
        if (!committed.ok) return committed;
        const laid = layer.layout(node);
        if (!laid.ok) return ok();
        const sized = document.commitOps(page, options.actor(), label, textBoxOps(document, node, laid.value), { changeSet });
        placeHost();
        return sized;
      },
    },
    onExit: (reason) => stop(reason),
    ...(options.onProblem === undefined ? {} : { onProblem: options.onProblem }),
  });
  if (!created.ok) {
    input.value.dispose();
    host.remove();
    return created;
  }
  session = created.value;
  const stopInvalidate = document.view.onInvalidate((nodes) => {
    if (!stopped && nodes.includes(node)) {
      if (document.view.read(node) === undefined) stop();
      else session?.refresh();
    }
  });
  placeHost();
  input.value.focus();
  const editing: TextEditing = { node, session, host, input: input.value, stop: () => stop() };
  options.scope.defer(() => stop());
  return ok(editing);
}
