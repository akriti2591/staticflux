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
import { deleteTextOps, insertTextOps, listIndentOps, previewReplace, replaceTextOps, splitParagraphOps, type TextBlockModel } from './rich-text.js';
import type { CaretMotionName, CaretPosition, Rect, TextLayoutEngine } from './text-engine.js';

export interface TextSessionTarget {
  /** The element's current model (after local and remote changes). */
  read(): Result<TextBlockModel>;
  /**
   * Commit ops as one undo step with a readable label. `step` (B12, T-2): commits that pass the same step key are
   * **one** undo step (typing coalescing, TEXT §3.6); omitted: a step of its own.
   */
  commit(ops: readonly PartOp[], label: string, step?: string): Result<void>;
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
  /** Apple key conventions for caret motions (T-3): Option moves by word, Command to the line or text edges. Default false. */
  readonly isMac?: boolean;
  /** Milliseconds clock for undo coalescing (default `Date.now`; tests pass a fake). */
  readonly now?: () => number;
  /**
   * Indent (+1) or outdent (-1) the list paragraphs touching `[from, to]` (T-8): the ops of one step, or
   * `undefined` when the caret is not in a list (Tab then does nothing: TEXT Q1, it never leaves editing). Default `listIndentOps`.
   */
  readonly indent?: (model: TextBlockModel, from: number, to: number, delta: 1 | -1) => Result<PartOp[]> | undefined;
}

/** A pause this long (ms) ends a coalesced typing or deleting step (TEXT §3.6). */
export const TYPING_PAUSE_MS = 1000;
/** Soft line break (T-6, Shift+Enter): a new line inside the same paragraph. */
export const LINE_SEPARATOR = '\u2028';

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

const LABELS = { type: 'Type', delete: 'Delete text', paste: 'Paste', ime: 'Type', paragraph: 'New paragraph', lineBreak: 'Line break', indent: 'Indent', outdent: 'Outdent' } as const;

/** The caret motion of an arrow / Home / End key on a platform (T-3, TEXT §3.3). */
export function caretMotionFor(key: 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End', mods: { readonly mod: boolean; readonly alt: boolean }, isMac: boolean): CaretMotionName {
  const left = key === 'ArrowLeft';
  if (key === 'Home' || key === 'End') return mods.mod ? (key === 'Home' ? 'textStart' : 'textEnd') : key === 'Home' ? 'lineStart' : 'lineEnd';
  // Mac: Option = word, Command = line edge. Windows / Linux: Ctrl = word (Alt+arrow is the browser's back / forward).
  if (isMac) return mods.mod ? (left ? 'lineStart' : 'lineEnd') : mods.alt ? (left ? 'wordLeft' : 'wordRight') : left ? 'left' : 'right';
  return mods.mod ? (left ? 'wordLeft' : 'wordRight') : left ? 'left' : 'right';
}

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
  const now = options.now ?? Date.now;
  /** The open coalesced step (T-2): its kind, key, when it last grew and where the caret is at its end. */
  let run: { readonly kind: 'type' | 'delete'; readonly key: string; readonly at: number; readonly end: number } | undefined;
  let runs = 0;
  /** The text as this session last committed or read it (an external change, e.g. undo, ends the run). */
  let known = model.text;
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

  /**
   * The step key for an edit of `kind` starting with a collapsed caret at `caret` (TEXT §3.6): the open run's key when
   * it is the same kind, continuous and recent; else a fresh one. Paste, Enter and styles take no key (own step).
   */
  const stepFor = (kind: 'type' | 'delete', caret: number | undefined): string => {
    if (run !== undefined && run.kind === kind && caret === run.end && now() - run.at < TYPING_PAUSE_MS) return run.key;
    return `${kind}-${blockId}-${(runs += 1)}`;
  };

  const commit = (ops: Result<PartOp[]>, label: string, caret: number, coalesce?: { readonly kind: 'type' | 'delete'; readonly key: string }): void => {
    if (!ops.ok) {
      problem(ops.error);
      return;
    }
    if (ops.value.length > 0) {
      const done = options.target.commit(ops.value, label, coalesce?.key);
      if (!done.ok) {
        run = undefined;
        problem(done.error);
        return;
      }
    }
    if (!reread()) return;
    known = model.text;
    run = coalesce === undefined ? undefined : { kind: coalesce.kind, key: coalesce.key, at: now(), end: clamp(caret) };
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
    run = undefined; // a caret move by mouse or arrow ends a coalesced step
    focus = { offset: clamp(to.offset), upstream: to.upstream };
    if (!extend) anchor = focus.offset;
    typingStyle = undefined;
    sync();
  };

  const KEYS: Readonly<Partial<Record<TextKey, (shift: boolean, mod: boolean, alt: boolean) => void>>> = {
    Enter: (shift) => {
      const [a, b] = ordered();
      // Shift+Enter: a soft line break inside the paragraph (T-6); Enter: a new paragraph.
      if (shift) return commit(replaceTextOps(model, a, b, LINE_SEPARATOR, typingStyle), LABELS.lineBreak, a + LINE_SEPARATOR.length);
      commit(a === b ? splitParagraphOps(model, a) : replaceTextOps(model, a, b, '\n'), LABELS.paragraph, a + 1);
    },
    Escape: () => options.onExit?.('escape'),
    // T-8 / TEXT Q1: Tab indents a list paragraph (Shift+Tab outdents); anywhere else it does nothing.
    Tab: (shift) => {
      const [a, b] = ordered();
      const ops = (options.indent ?? listIndentOps)(model, a, b, shift ? -1 : 1);
      if (ops === undefined) return;
      const keep = [anchor, focus] as const;
      commit(ops, shift ? LABELS.outdent : LABELS.indent, a);
      anchor = clamp(keep[0]);
      focus = { offset: clamp(keep[1].offset), upstream: keep[1].upstream };
      sync();
    },
    SelectAll: () => {
      anchor = 0;
      moveFocus({ offset: model.text.length, upstream: true }, true);
    },
    ArrowLeft: (shift, mod, alt) => step(caretMotionFor('ArrowLeft', { mod, alt }, options.isMac === true), shift),
    ArrowRight: (shift, mod, alt) => step(caretMotionFor('ArrowRight', { mod, alt }, options.isMac === true), shift),
    Home: (shift, mod, alt) => step(caretMotionFor('Home', { mod, alt }, options.isMac === true), shift),
    End: (shift, mod, alt) => step(caretMotionFor('End', { mod, alt }, options.isMac === true), shift),
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
        // One typed character (a grapheme) coalesces; a longer insert is a paste, its own step.
        const typed = [...intent.text].length === 1 && intent.text !== '\n' && intent.text !== LINE_SEPARATOR;
        const coalesce = typed ? { kind: 'type' as const, key: stepFor('type', from === to ? from : undefined) } : undefined;
        commit(replaceTextOps(model, from, to, intent.text, typingStyle), typed ? LABELS.type : LABELS.paste, from + intent.text.length, coalesce);
        return;
      }
      case 'delete': {
        let [from, to] = [clamp(Math.min(...intent.range)), clamp(Math.max(...intent.range))];
        const collapsed = from === to;
        if (collapsed && intent.unit !== 'selection') {
          const edge = boundary(from, intent.direction, intent.unit);
          [from, to] = [Math.min(from, edge), Math.max(from, edge)];
        }
        // Deletes from a collapsed caret coalesce like typing (separately from it); a selection delete is its own step.
        const coalesce = collapsed ? { kind: 'delete' as const, key: stepFor('delete', clamp(Math.min(...intent.range))) } : undefined;
        commit(deleteTextOps(model, from, to), LABELS.delete, from, coalesce);
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
        const coalesce = { kind: 'type' as const, key: stepFor('type', c.from === c.to ? c.from : undefined) };
        commit(c.from === c.to ? insertTextOps(model, c.from, intent.text, typingStyle) : replaceTextOps(model, c.from, c.to, intent.text, typingStyle), LABELS.ime, c.from + intent.text.length, coalesce);
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
        // B12 T-9: while a composition is open the IME owns the keys (candidate arrows, Enter to accept, Tab); a key
        // intent that slips through must not split, move or commit, or the control bounds and the text change under
        // the composition (owner's IME check, finding 2: one line more per key intent).
        if (composition !== undefined) return;
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
      if (model.text !== known) run = undefined; // undo or a remote edit: the next keystroke starts a new step
      known = model.text;
      anchor = clamp(anchor);
      focus = { offset: clamp(focus.offset), upstream: focus.upstream };
      relayout();
      sync();
    },
    setTypingStyle(style) {
      typingStyle = style;
      run = undefined; // a style change ends a coalesced step
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

