/**
 * Text editing session (B2; IF-7.7, IF-21.21–21.25): connects a `TextInput` (SF-Δ27) to one text element.
 *
 * - Intents become rich-text ops committed through the caller (`commit`, i.e. the repo / a gesture): typing,
 *   deletes (collapsed deletes expand by grapheme, word or line with the **layout**, so conjuncts, ligatures and
 *   emoji are removed whole), paragraph splits, IME commits.
 * - **IME compositions are previews**: the composed text is spliced into a local copy of the model (underlined) and
 *   laid out, never written to the document until `compose-commit` — collaborators see only committed text.
 * - After every change the session lays out, pushes text + selection to the input, and positions the IME:
 *   selection bounds at the caret, character bounds of the composition (answers EditContext bounds requests).
 * - Caret movement (arrows, Home/End, word jumps, up/down with a sticky column, Select All) uses the layout's
 *   visual order (bidi aware).
 *
 * No browser checks here: which `TextInput` implementation runs is the variant binding's business.
 */
import { ok, type Result, type SfError } from '@staticflux/core';
import type { PartOp } from '@staticflux/document/v2';
import type { ClientRect, TextInput, TextIntent, TextKey } from '@staticflux/surface/text-input';
import type { TextLayout } from './layout-result.js';
import type { CharStyle } from './model.js';
import { deleteTextOps, insertTextOps, previewReplace, replaceTextOps, splitParagraphOps, type TextBlockModel } from './rich-text.js';
import type { CaretMotionName, CaretPosition, Rect, TextLayoutEngine } from './text-engine.js';

export interface TextSessionTarget {
  /** The element's current model (after local and remote changes). */
  read(): Result<TextBlockModel>;
  /** Commit ops as one undo step with a readable label. */
  commit(ops: readonly PartOp[], label: string): Result<void>;
}

export interface TextSessionOptions {
  readonly input: TextInput;
  readonly target: TextSessionTarget;
  readonly engine: TextLayoutEngine;
  /** Layout block id of the element in `engine`. */
  readonly blockId: number;
  /** Resolve styles and lay the model out (as `engine.layout(blockId, …)`). */
  readonly layout: (model: TextBlockModel) => Result<TextLayout>;
  /** Block px → client px (canvas position, zoom, device). */
  readonly toClient: (rect: Rect) => ClientRect;
  /** Escape or Tab: leave text editing (the tool decides). */
  readonly onExit?: (reason: 'escape' | 'tab') => void;
  /** Problems (rejected ops, layout failures) for a toast or the log. */
  readonly onProblem?: (error: SfError) => void;
}

export interface TextSessionState {
  readonly model: TextBlockModel;
  readonly layout: TextLayout | undefined;
  /** `anchor` stays, `focus` moves (block offsets). */
  readonly anchor: number;
  readonly focus: CaretPosition;
  readonly composition: { readonly from: number; readonly to: number; readonly text: string } | undefined;
}

export interface TextSession {
  readonly state: TextSessionState;
  /** Selected block range (ordered). */
  readonly selection: readonly [number, number];
  /** Place the caret / selection (pointer clicks; the tool hit-tests with `engine.hitTest`). */
  select(anchor: number, focus: number): void;
  /** The document changed (remote edit, undo): re-read, keep the selection in range, lay out again. */
  refresh(): void;
  /** Style typed next (Bold on a collapsed selection); cleared when the caret moves. */
  setTypingStyle(style: CharStyle | undefined): void;
  onChange(listener: (state: TextSessionState) => void): () => void;
  dispose(): void;
}

const LABELS = { type: 'Type', delete: 'Delete text', paste: 'Paste', ime: 'Type', paragraph: 'New paragraph' } as const;

export function createTextSession(options: TextSessionOptions): Result<TextSession> {
  const { input, engine, blockId } = options;
  const first = options.target.read();
  if (!first.ok) return first;
  let model = first.value;
  let layout: TextLayout | undefined;
  /**
   * Size of the committed block (no composition preview). The control bounds are the editable area, so they come
   * from this, never from the preview: a composition (its underline, wrapping, fallback fonts with other line
   * metrics) must not move or grow them (owner's IME check, finding 2).
   */
  let block: { readonly width: number; readonly height: number } | undefined;
  let anchor = model.text.length;
  let focus: CaretPosition = { offset: model.text.length, upstream: true };
  let composition: TextSessionState['composition'];
  let typingStyle: CharStyle | undefined;
  let stickyX: number | undefined;
  const listeners = new Set<(s: TextSessionState) => void>();

  const problem = (e: SfError): void => options.onProblem?.(e);
  const state = (): TextSessionState => ({ model, layout, anchor, focus, composition });
  const ordered = (): [number, number] => [Math.min(anchor, focus.offset), Math.max(anchor, focus.offset)];
  const clamp = (x: number): number => Math.max(0, Math.min(model.text.length, x));

  const relayout = (): void => {
    const shown = composition === undefined ? model : previewReplace(model, composition.from, composition.to, composition.text, { underline: true });
    const r = options.layout(shown);
    if (!r.ok) {
      problem(r.error);
      return;
    }
    layout = r.value;
    if (composition === undefined) block = { width: r.value.width, height: r.value.height };
  };

  const caretRect = (): Rect | undefined => {
    const r = engine.caret(blockId, composition === undefined ? focus : { offset: composition.from + composition.text.length, upstream: false });
    return r.ok ? r.value : undefined;
  };

  const sync = (): void => {
    if (!input.composing) input.setState({ text: model.text, selection: [anchor, focus.offset] });
    const c = caretRect();
    if (c !== undefined) input.setSelectionBounds(options.toClient(c));
    const control = block ?? layout;
    if (control !== undefined) input.setControlBounds(options.toClient({ x0: 0, y0: 0, x1: control.width, y1: control.height }));
    for (const l of [...listeners]) l(state());
  };

  const reread = (): boolean => {
    const r = options.target.read();
    if (!r.ok) {
      problem(r.error);
      return false;
    }
    model = r.value;
    return true;
  };

  const commit = (ops: Result<PartOp[]>, label: string, caret: number): void => {
    if (!ops.ok) {
      problem(ops.error);
      return;
    }
    if (ops.value.length > 0) {
      const done = options.target.commit(ops.value, label);
      if (!done.ok) {
        problem(done.error);
        return;
      }
    }
    if (!reread()) return;
    anchor = clamp(caret);
    focus = { offset: anchor, upstream: false };
    relayout();
    sync();
  };

  const boundary = (at: number, direction: 'backward' | 'forward', unit: 'grapheme' | 'word' | 'line'): number => {
    const motion: CaretMotionName = unit === 'grapheme' ? (direction === 'backward' ? 'prevGrapheme' : 'nextGrapheme') : unit === 'word' ? (direction === 'backward' ? 'wordLeft' : 'wordRight') : direction === 'backward' ? 'lineStart' : 'lineEnd';
    const r = engine.move(blockId, { offset: at, upstream: direction === 'backward' }, motion);
    return r.ok ? r.value.offset : at;
  };

  const moveFocus = (to: CaretPosition, extend: boolean, keepColumn = false): void => {
    if (!keepColumn) stickyX = undefined;
    focus = { offset: clamp(to.offset), upstream: to.upstream };
    if (!extend) anchor = focus.offset;
    typingStyle = undefined;
    sync();
  };

  const KEYS: Readonly<Partial<Record<TextKey, (shift: boolean, mod: boolean, alt: boolean) => void>>> = {
    Enter: () => {
      const [a, b] = ordered();
      commit(a === b ? splitParagraphOps(model, a) : replaceTextOps(model, a, b, '\n'), LABELS.paragraph, a + 1);
    },
    Escape: () => options.onExit?.('escape'),
    Tab: () => options.onExit?.('tab'),
    SelectAll: () => {
      anchor = 0;
      moveFocus({ offset: model.text.length, upstream: true }, true);
    },
    ArrowLeft: (shift, mod, alt) => step(mod || alt ? 'wordLeft' : 'left', shift),
    ArrowRight: (shift, mod, alt) => step(mod || alt ? 'wordRight' : 'right', shift),
    Home: (shift, mod) => step(mod ? 'textStart' : 'lineStart', shift),
    End: (shift, mod) => step(mod ? 'textEnd' : 'lineEnd', shift),
    ArrowUp: (shift) => vertical('up', shift),
    ArrowDown: (shift) => vertical('down', shift),
    PageUp: (shift) => step('textStart', shift),
    PageDown: (shift) => step('textEnd', shift),
  };

  function step(motion: CaretMotionName, extend: boolean): void {
    const [a, b] = ordered();
    // A plain arrow on a selection collapses it to the side it points to.
    if (!extend && a !== b && (motion === 'left' || motion === 'right')) return moveFocus({ offset: motion === 'left' ? a : b, upstream: motion === 'right' }, false);
    const r = engine.move(blockId, focus, motion);
    if (!r.ok) return problem(r.error);
    moveFocus(r.value, extend);
  }

  function vertical(motion: 'up' | 'down', extend: boolean): void {
    if (stickyX === undefined) stickyX = caretRect()?.x0;
    const r = engine.move(blockId, focus, motion, stickyX);
    if (!r.ok) return problem(r.error);
    moveFocus(r.value, extend, true);
  }

  const onIntent = (intent: TextIntent): void => {
    switch (intent.kind) {
      case 'insert': {
        const from = clamp(Math.min(intent.range[0], intent.range[1]));
        const to = clamp(Math.max(intent.range[0], intent.range[1]));
        commit(replaceTextOps(model, from, to, intent.text, typingStyle), intent.text.length > 1 ? LABELS.paste : LABELS.type, from + intent.text.length);
        return;
      }
      case 'delete': {
        let [from, to] = [clamp(Math.min(...intent.range)), clamp(Math.max(...intent.range))];
        if (from === to && intent.unit !== 'selection') {
          const edge = boundary(from, intent.direction, intent.unit);
          [from, to] = [Math.min(from, edge), Math.max(from, edge)];
        }
        commit(deleteTextOps(model, from, to), LABELS.delete, from);
        return;
      }
      case 'compose-start': {
        const [a, b] = [clamp(Math.min(...intent.range)), clamp(Math.max(...intent.range))];
        composition = { from: a, to: b, text: '' };
        relayout();
        sync();
        return;
      }
      case 'compose-update': {
        const from = composition?.from ?? clamp(Math.min(...intent.range));
        const to = composition?.to ?? from;
        composition = { from, to, text: intent.text };
        relayout();
        sync();
        pushCompositionBounds();
        return;
      }
      case 'compose-commit': {
        const c = composition ?? { from: clamp(intent.range[0]), to: clamp(intent.range[0]), text: '' };
        composition = undefined;
        commit(c.from === c.to ? insertTextOps(model, c.from, intent.text, typingStyle) : replaceTextOps(model, c.from, c.to, intent.text, typingStyle), LABELS.ime, c.from + intent.text.length);
        return;
      }
      case 'compose-cancel':
        composition = undefined;
        relayout();
        sync();
        return;
      case 'selection':
        anchor = clamp(intent.selection[0]);
        moveFocus({ offset: intent.selection[1], upstream: false }, true);
        return;
      case 'key':
        KEYS[intent.key]?.(intent.shift, intent.mod, intent.alt);
        return;
      case 'format':
        // Underline styles from the IME: the preview always underlines the whole composition (M1).
        return;
    }
  };

  function pushCompositionBounds(): void {
    if (composition === undefined) return;
    const r = engine.charBounds(blockId, composition.from, composition.from + composition.text.length);
    if (r.ok && r.value.length > 0) input.setCharacterBounds(composition.from, r.value.map(options.toClient));
  }

  const onBounds = (range: readonly [number, number]): void => {
    const r = engine.charBounds(blockId, range[0], range[1]);
    if (r.ok) input.setCharacterBounds(range[0], r.value.map(options.toClient));
  };

  const offIntent = input.onIntent(onIntent);
  const offBounds = input.onBoundsRequest(onBounds);
  relayout();
  sync();

  return ok({
    get state() {
      return state();
    },
    get selection() {
      return ordered();
    },
    select(a, b) {
      anchor = clamp(a);
      moveFocus({ offset: b, upstream: false }, true);
    },
    refresh() {
      if (!reread()) return;
      anchor = clamp(anchor);
      focus = { offset: clamp(focus.offset), upstream: focus.upstream };
      relayout();
      sync();
    },
    setTypingStyle(style) {
      typingStyle = style;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      offIntent();
      offBounds();
      listeners.clear();
    },
  });
}

