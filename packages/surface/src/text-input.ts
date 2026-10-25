/**
 * `TextInput` port (SF-Δ27, R11.54–R11.57): text entry for editors that draw their own text (canvas, WebGPU),
 * without a contenteditable. Two implementations behind one port:
 *
 * - **EditContext** (`createEditContextTextInput`, Chromium): the host element gets an `EditContext`; the IME
 *   candidate window is positioned from the character bounds the editor pushes (`updateCharacterBounds`).
 * - **Hidden textarea** (`createHiddenTextareaTextInput`, Firefox and anything without EditContext): an invisible
 *   textarea follows the selection bounds so the IME anchors there; `beforeinput` and composition events become
 *   the same intents.
 *
 * Which one an app gets is a **variant binding** on a platform fact (`textInputBindings({ editContext })`), never a
 * browser branch in feature code. The editor owns the text: it applies `TextIntent`s to its model (a CRDT, usually
 * in a worker) and pushes the result back with `setState`, plus geometry (`setControlBounds`, `setSelectionBounds`,
 * `setCharacterBounds`) in client CSS px. All offsets are **UTF-16 code units** (what both platform APIs use).
 *
 * Deletes may arrive collapsed (`delete` with `range[0] === range[1]`, a hidden-textarea Backspace): the editor
 * expands them to a grapheme, word or line boundary with its own layout (it knows clusters; the port does not).
 */
import { err, ok, type Result, token, unit, type UnitDefinition, variant } from '@staticflux/core';
import { TextInputUnavailableError } from './errors.js';

export type TextRange = readonly [start: number, end: number];

export interface TextInputState {
  readonly text: string;
  readonly selection: TextRange;
}

/** Keys the editor handles itself (neither platform API inserts or moves for these). */
export const TEXT_KEYS = ['Enter', 'Tab', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'SelectAll'] as const;
export type TextKey = (typeof TEXT_KEYS)[number];

export const DELETE_UNITS = ['selection', 'grapheme', 'word', 'line'] as const;
export type DeleteUnit = (typeof DELETE_UNITS)[number];

export const UNDERLINE_STYLES = ['none', 'solid', 'dotted', 'dashed', 'wavy'] as const;
export type UnderlineStyle = (typeof UNDERLINE_STYLES)[number];

export interface CompositionFormat {
  readonly range: TextRange;
  readonly underline: UnderlineStyle;
  readonly thick: boolean;
}

/** What the user did, in model terms. */
export type TextIntent =
  /** Replace `range` with `text` (typing, paste, autocorrect). */
  | { readonly kind: 'insert'; readonly text: string; readonly range: TextRange }
  /** Delete `range`; collapsed = expand by `unit` in `direction` (the editor's layout decides the boundary). */
  | { readonly kind: 'delete'; readonly range: TextRange; readonly direction: 'backward' | 'forward'; readonly unit: DeleteUnit }
  | { readonly kind: 'compose-start'; readonly range: TextRange }
  /** The composition now spans `range` and reads `text`; `selection` is the caret inside it. */
  | { readonly kind: 'compose-update'; readonly text: string; readonly range: TextRange; readonly selection: TextRange }
  /** Composition finished with `text` replacing `range` (the composition's last range). */
  | { readonly kind: 'compose-commit'; readonly text: string; readonly range: TextRange }
  | { readonly kind: 'compose-cancel'; readonly range: TextRange }
  /** The platform moved the selection (IME, accessibility tools). */
  | { readonly kind: 'selection'; readonly selection: TextRange }
  | { readonly kind: 'key'; readonly key: TextKey; readonly shift: boolean; readonly mod: boolean; readonly alt: boolean }
  /** Composition styling from the IME (underlines). */
  | { readonly kind: 'format'; readonly formats: readonly CompositionFormat[] };

export interface ClientRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const TEXT_INPUT_KINDS = ['edit-context', 'hidden-textarea'] as const;
export type TextInputKind = (typeof TEXT_INPUT_KINDS)[number];

export interface TextInput {
  readonly kind: TextInputKind;
  /** Focus the input (the host or the textarea). */
  focus(): void;
  blur(): void;
  readonly focused: boolean;
  /** True between compose-start and compose-commit/cancel. */
  readonly composing: boolean;
  /** The editor's model after applying intents (do not push during a composition except to commit). */
  setState(state: TextInputState): void;
  readonly state: TextInputState;
  /** Bounds of the editable area (client px). */
  setControlBounds(rect: ClientRect): void;
  /** Bounds of the selection / caret (client px): the IME anchors here. */
  setSelectionBounds(rect: ClientRect): void;
  /** One rect per UTF-16 code unit from `start` (client px), e.g. answering a bounds request. */
  setCharacterBounds(start: number, rects: readonly ClientRect[]): void;
  onIntent(listener: (intent: TextIntent) => void): () => void;
  /** The platform asks for character bounds of `range` (EditContext `characterboundsupdate`). */
  onBoundsRequest(listener: (range: TextRange) => void): () => void;
  dispose(): void;
}

export interface TextInputOptions {
  /** The element that shows the text (a canvas or its container). Must be focusable for EditContext. */
  readonly host: HTMLElement;
  /** Accessible name of the input (the textarea or the host). */
  readonly label?: string;
  /** Injected for tests; defaults to the host's document / global `EditContext`. */
  readonly document?: Document;
}

/** Creates `TextInput`s; the bound implementation is chosen by `textInputBindings`. */
export interface TextInputFactory {
  readonly kind: TextInputKind;
  create(options: TextInputOptions): Result<TextInput>;
}

// ------------------------------------------------------------------ shared helpers

type Listeners<T> = Set<(value: T) => void>;

function emitter<T>(): { readonly set: Listeners<T>; add(l: (v: T) => void): () => void; emit(v: T): void } {
  const set: Listeners<T> = new Set();
  return {
    set,
    add: (l) => {
      set.add(l);
      return () => set.delete(l);
    },
    emit: (v) => {
      for (const l of [...set]) l(v);
    },
  };
}

const ordered = (a: number, b: number): TextRange => (a <= b ? [a, b] : [b, a]);

const KEY_OF: Readonly<Record<string, TextKey>> = {
  Enter: 'Enter',
  Tab: 'Tab',
  Escape: 'Escape',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
};

/** Map a keydown to a key intent (or undefined to let the platform handle it). */
export function keyIntent(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing'>): TextIntent | undefined {
  if (event.isComposing) return undefined;
  const mod = event.ctrlKey || event.metaKey;
  const key = mod && (event.key === 'a' || event.key === 'A') ? 'SelectAll' : KEY_OF[event.key];
  if (key === undefined) return undefined;
  return { kind: 'key', key, shift: event.shiftKey, mod, alt: event.altKey };
}

const DELETE_OF: Readonly<Record<string, { direction: 'backward' | 'forward'; unit: DeleteUnit }>> = {
  deleteContentBackward: { direction: 'backward', unit: 'grapheme' },
  deleteContentForward: { direction: 'forward', unit: 'grapheme' },
  deleteWordBackward: { direction: 'backward', unit: 'word' },
  deleteWordForward: { direction: 'forward', unit: 'word' },
  deleteSoftLineBackward: { direction: 'backward', unit: 'line' },
  deleteSoftLineForward: { direction: 'forward', unit: 'line' },
  deleteHardLineBackward: { direction: 'backward', unit: 'line' },
  deleteHardLineForward: { direction: 'forward', unit: 'line' },
  deleteByCut: { direction: 'backward', unit: 'selection' },
  deleteContent: { direction: 'backward', unit: 'selection' },
};

/**
 * Apply an intent to plain text (the reference model of the contract suite; also usable for single-line fields).
 * `boundary(text, at, direction, unit)` expands collapsed deletes (default: one code point).
 */
export function applyTextIntent(
  state: TextInputState,
  intent: TextIntent,
  boundary: (text: string, at: number, direction: 'backward' | 'forward', unit: DeleteUnit) => number = codePointBoundary,
): TextInputState {
  const splice = (range: TextRange, text: string): TextInputState => {
    const [a, b] = ordered(range[0], range[1]);
    const next = state.text.slice(0, a) + text + state.text.slice(b);
    return { text: next, selection: [a + text.length, a + text.length] };
  };
  switch (intent.kind) {
    case 'insert':
    case 'compose-commit':
      return splice(intent.range, intent.text);
    case 'compose-update': {
      const next = splice(intent.range, intent.text);
      return { text: next.text, selection: intent.selection };
    }
    case 'delete': {
      const [a, b] = ordered(intent.range[0], intent.range[1]);
      if (a !== b || intent.unit === 'selection') return splice([a, b], '');
      const edge = boundary(state.text, a, intent.direction, intent.unit);
      return splice(ordered(a, edge), '');
    }
    case 'selection':
      return { text: state.text, selection: intent.selection };
    case 'compose-cancel':
      return splice(intent.range, '');
    case 'compose-start':
    case 'key':
    case 'format':
      return state;
  }
}

/** One code point before/after `at` (surrogate pairs kept whole). */
export function codePointBoundary(text: string, at: number, direction: 'backward' | 'forward'): number {
  if (direction === 'backward') {
    if (at <= 0) return 0;
    const low = text.charCodeAt(at - 1);
    return at >= 2 && low >= 0xdc00 && low <= 0xdfff ? at - 2 : at - 1;
  }
  if (at >= text.length) return text.length;
  const high = text.charCodeAt(at);
  return high >= 0xd800 && high <= 0xdbff && at + 1 < text.length ? at + 2 : at + 1;
}

// ------------------------------------------------------------------ EditContext

/** The parts of `EditContext` this port uses (a fake implements them in tests). */
export interface EditContextLike extends EventTarget {
  readonly text: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  updateText(start: number, end: number, text: string): void;
  updateSelection(start: number, end: number): void;
  updateControlBounds(rect: DOMRectReadOnly): void;
  updateSelectionBounds(rect: DOMRectReadOnly): void;
  updateCharacterBounds(start: number, rects: readonly DOMRectReadOnly[]): void;
}

export type EditContextConstructor = new (init?: { text?: string; selectionStart?: number; selectionEnd?: number }) => EditContextLike;

interface TextUpdateEventLike extends Event {
  readonly updateRangeStart: number;
  readonly updateRangeEnd: number;
  readonly text: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

interface TextFormatLike {
  readonly rangeStart: number;
  readonly rangeEnd: number;
  readonly underlineStyle: string;
  readonly underlineThickness: string;
}

const underline = (style: string): UnderlineStyle => {
  const s = style.toLowerCase();
  return (UNDERLINE_STYLES as readonly string[]).includes(s) ? (s as UnderlineStyle) : 'solid';
};

function domRect(document: Document | undefined, r: ClientRect): DOMRectReadOnly {
  const Ctor = (document?.defaultView as (Window & { DOMRect?: typeof DOMRect }) | null | undefined)?.DOMRect ?? globalThis.DOMRect;
  return Ctor === undefined ? ({ x: r.x, y: r.y, width: r.width, height: r.height, left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height } as DOMRectReadOnly) : new Ctor(r.x, r.y, r.width, r.height);
}

export interface EditContextTextInputOptions extends TextInputOptions {
  /** Defaults to the global `EditContext`. */
  readonly EditContext?: EditContextConstructor;
}

/** The EditContext implementation (Chromium). */
export function createEditContextTextInput(options: EditContextTextInputOptions): Result<TextInput> {
  const Ctor = options.EditContext ?? (globalThis as { EditContext?: EditContextConstructor }).EditContext;
  if (Ctor === undefined) return err(TextInputUnavailableError({ message: 'EditContext is not available here.', details: { kind: 'edit-context' } }));
  const { host } = options;
  const document = options.document ?? host.ownerDocument;
  const ec = new Ctor({ text: '', selectionStart: 0, selectionEnd: 0 });
  (host as HTMLElement & { editContext?: unknown }).editContext = ec;
  if (!host.hasAttribute('tabindex')) host.tabIndex = 0;
  if (options.label !== undefined) host.setAttribute('aria-label', options.label);
  const intents = emitter<TextIntent>();
  const requests = emitter<TextRange>();
  let state: TextInputState = { text: '', selection: [0, 0] };
  let composition: TextRange | undefined;
  let lastComposed = '';
  let focused = false;

  const onTextUpdate = (e: Event): void => {
    const u = e as TextUpdateEventLike;
    const range: TextRange = [u.updateRangeStart, u.updateRangeEnd];
    if (composition !== undefined) {
      composition = [u.updateRangeStart, u.updateRangeStart + u.text.length];
      lastComposed = u.text;
      intents.emit({ kind: 'compose-update', text: u.text, range, selection: [u.selectionStart, u.selectionEnd] });
    } else if (u.text === '' && range[0] !== range[1]) {
      // A caret that sat at the start of the removed range means a forward delete.
      const forward = state.selection[0] === range[0] && state.selection[1] === range[0];
      intents.emit({ kind: 'delete', range, direction: forward ? 'forward' : 'backward', unit: 'selection' });
    } else {
      intents.emit({ kind: 'insert', text: u.text, range });
    }
    state = { text: ec.text, selection: [ec.selectionStart, ec.selectionEnd] };
  };
  const onCompositionStart = (): void => {
    composition = [ec.selectionStart, ec.selectionEnd];
    lastComposed = '';
    intents.emit({ kind: 'compose-start', range: composition });
  };
  const onCompositionEnd = (e: Event): void => {
    const range = composition ?? [ec.selectionStart, ec.selectionStart];
    const data = (e as CompositionEvent).data ?? lastComposed;
    composition = undefined;
    // The composed text is already in the EditContext buffer: the commit replaces the composition range.
    intents.emit(data === '' ? { kind: 'compose-cancel', range } : { kind: 'compose-commit', text: data, range: [range[0], range[0] + lastComposed.length] });
  };
  const onFormat = (e: Event): void => {
    const formats = ((e as Event & { getTextFormats?: () => readonly TextFormatLike[] }).getTextFormats?.() ?? []).map(
      (f): CompositionFormat => ({ range: [f.rangeStart, f.rangeEnd], underline: underline(f.underlineStyle), thick: f.underlineThickness.toLowerCase() === 'thick' }),
    );
    intents.emit({ kind: 'format', formats });
  };
  const onBounds = (e: Event): void => {
    const b = e as Event & { rangeStart: number; rangeEnd: number };
    requests.emit([b.rangeStart, b.rangeEnd]);
  };
  const onKey = (e: KeyboardEvent): void => {
    const intent = keyIntent(e);
    if (intent === undefined) return;
    e.preventDefault();
    intents.emit(intent);
  };
  const onFocus = (): void => {
    focused = true;
  };
  const onBlur = (): void => {
    focused = false;
  };
  ec.addEventListener('textupdate', onTextUpdate);
  ec.addEventListener('compositionstart', onCompositionStart);
  ec.addEventListener('compositionend', onCompositionEnd);
  ec.addEventListener('textformatupdate', onFormat);
  ec.addEventListener('characterboundsupdate', onBounds);
  host.addEventListener('keydown', onKey);
  host.addEventListener('focus', onFocus);
  host.addEventListener('blur', onBlur);

  return ok({
    kind: 'edit-context',
    focus: () => host.focus(),
    blur: () => host.blur(),
    get focused() {
      return focused;
    },
    get composing() {
      return composition !== undefined;
    },
    get state() {
      return state;
    },
    setState(next) {
      ec.updateText(0, ec.text.length, next.text);
      ec.updateSelection(next.selection[0], next.selection[1]);
      state = next;
    },
    setControlBounds: (r) => ec.updateControlBounds(domRect(document, r)),
    setSelectionBounds: (r) => ec.updateSelectionBounds(domRect(document, r)),
    setCharacterBounds: (start, rects) => ec.updateCharacterBounds(start, rects.map((r) => domRect(document, r))),
    onIntent: intents.add,
    onBoundsRequest: requests.add,
    dispose() {
      ec.removeEventListener('textupdate', onTextUpdate);
      ec.removeEventListener('compositionstart', onCompositionStart);
      ec.removeEventListener('compositionend', onCompositionEnd);
      ec.removeEventListener('textformatupdate', onFormat);
      ec.removeEventListener('characterboundsupdate', onBounds);
      host.removeEventListener('keydown', onKey);
      host.removeEventListener('focus', onFocus);
      host.removeEventListener('blur', onBlur);
      (host as HTMLElement & { editContext?: unknown }).editContext = null;
      intents.set.clear();
      requests.set.clear();
    },
  });
}

// ------------------------------------------------------------------ hidden textarea

/** The hidden-textarea implementation (Firefox; any browser without EditContext). */
export function createHiddenTextareaTextInput(options: TextInputOptions): Result<TextInput> {
  const { host } = options;
  const document = options.document ?? host.ownerDocument;
  if (document === undefined || document === null) return err(TextInputUnavailableError({ message: 'The hidden-textarea input needs a document.', details: { kind: 'hidden-textarea' } }));
  const area = document.createElement('textarea');
  area.setAttribute('autocomplete', 'off');
  area.setAttribute('autocapitalize', 'off');
  area.setAttribute('spellcheck', 'false');
  area.setAttribute('data-sf-text-input', 'hidden-textarea');
  if (options.label !== undefined) area.setAttribute('aria-label', options.label);
  // Invisible but laid out: the IME positions its candidate window at the textarea caret, which follows
  // the selection bounds (setSelectionBounds). No opacity:0 on the parent, no display:none (IMEs ignore those).
  Object.assign(area.style, {
    position: 'fixed',
    left: '0px',
    top: '0px',
    width: '1px',
    height: '1em',
    padding: '0',
    border: '0',
    margin: '0',
    outline: 'none',
    resize: 'none',
    overflow: 'hidden',
    whiteSpace: 'pre',
    opacity: '0',
    color: 'transparent',
    background: 'transparent',
    caretColor: 'transparent',
    zIndex: '-1',
  });
  host.appendChild(area);
  const intents = emitter<TextIntent>();
  const requests = emitter<TextRange>();
  let state: TextInputState = { text: '', selection: [0, 0] };
  let composition: TextRange | undefined;
  let composed = '';
  let focused = false;

  const sync = (): void => {
    if (area.value !== state.text) area.value = state.text;
    area.setSelectionRange(state.selection[0], state.selection[1]);
  };
  const selection = (): TextRange => ordered(area.selectionStart ?? 0, area.selectionEnd ?? 0);

  const onBeforeInput = (e: Event): void => {
    const input = e as InputEvent;
    const type = input.inputType;
    if (type === 'insertCompositionText') return; // the composition events carry it
    const range = composition ?? selection();
    if (type === 'insertText' || type === 'insertReplacementText' || type === 'insertFromPaste' || type === 'insertFromDrop') {
      e.preventDefault();
      const text = input.data ?? input.dataTransfer?.getData('text/plain') ?? '';
      intents.emit({ kind: 'insert', text, range });
      return;
    }
    if (type === 'insertLineBreak' || type === 'insertParagraph') {
      e.preventDefault();
      intents.emit({ kind: 'key', key: 'Enter', shift: type === 'insertLineBreak', mod: false, alt: false });
      return;
    }
    const del = DELETE_OF[type];
    if (del !== undefined) {
      e.preventDefault();
      intents.emit({ kind: 'delete', range, direction: del.direction, unit: range[0] === range[1] ? del.unit : 'selection' });
      return;
    }
    // History and formatting shortcuts belong to the editor, never to the hidden textarea.
    e.preventDefault();
  };
  const onCompositionStart = (): void => {
    composition = selection();
    composed = '';
    intents.emit({ kind: 'compose-start', range: composition });
  };
  const onCompositionUpdate = (e: Event): void => {
    const data = (e as CompositionEvent).data ?? '';
    const start = composition?.[0] ?? selection()[0];
    const range: TextRange = [start, start + composed.length];
    composed = data;
    composition = [start, start + data.length];
    intents.emit({ kind: 'compose-update', text: data, range, selection: [start + data.length, start + data.length] });
    requests.emit(composition);
  };
  const onCompositionEnd = (e: Event): void => {
    const data = (e as CompositionEvent).data ?? composed;
    const start = composition?.[0] ?? selection()[0];
    const range: TextRange = [start, start + composed.length];
    composition = undefined;
    composed = '';
    intents.emit(data === '' ? { kind: 'compose-cancel', range } : { kind: 'compose-commit', text: data, range });
  };
  const onKey = (e: KeyboardEvent): void => {
    const intent = keyIntent(e);
    if (intent === undefined || composition !== undefined) return;
    e.preventDefault();
    intents.emit(intent);
  };
  const onFocus = (): void => {
    focused = true;
  };
  const onBlur = (): void => {
    focused = false;
  };
  area.addEventListener('beforeinput', onBeforeInput);
  area.addEventListener('compositionstart', onCompositionStart);
  area.addEventListener('compositionupdate', onCompositionUpdate);
  area.addEventListener('compositionend', onCompositionEnd);
  area.addEventListener('keydown', onKey);
  area.addEventListener('focus', onFocus);
  area.addEventListener('blur', onBlur);

  return ok({
    kind: 'hidden-textarea',
    focus: () => area.focus(),
    blur: () => area.blur(),
    get focused() {
      return focused;
    },
    get composing() {
      return composition !== undefined;
    },
    get state() {
      return state;
    },
    setState(next) {
      state = next;
      if (composition === undefined) sync();
    },
    setControlBounds: () => undefined,
    setSelectionBounds(r) {
      area.style.left = `${r.x}px`;
      area.style.top = `${r.y}px`;
      area.style.height = `${Math.max(1, r.height)}px`;
      area.style.fontSize = `${Math.max(1, r.height * 0.8)}px`;
      area.style.lineHeight = `${Math.max(1, r.height)}px`;
    },
    setCharacterBounds(start, rects) {
      // No platform API: anchor the textarea at the first composed character so the candidate window follows.
      const first = rects[0];
      if (first !== undefined && composition !== undefined && start === composition[0]) this.setSelectionBounds(first);
    },
    onIntent: intents.add,
    onBoundsRequest: requests.add,
    dispose() {
      area.removeEventListener('beforeinput', onBeforeInput);
      area.removeEventListener('compositionstart', onCompositionStart);
      area.removeEventListener('compositionupdate', onCompositionUpdate);
      area.removeEventListener('compositionend', onCompositionEnd);
      area.removeEventListener('keydown', onKey);
      area.removeEventListener('focus', onFocus);
      area.removeEventListener('blur', onBlur);
      area.remove();
      intents.set.clear();
      requests.set.clear();
    },
  });
}

// ------------------------------------------------------------------ factories and variant binding

export const editContextTextInputFactory: TextInputFactory = Object.freeze({ kind: 'edit-context', create: (o: TextInputOptions) => createEditContextTextInput(o) });
export const hiddenTextareaTextInputFactory: TextInputFactory = Object.freeze({ kind: 'hidden-textarea', create: (o: TextInputOptions) => createHiddenTextareaTextInput(o) });

export const TextInputFactoryToken = /* @__PURE__ */ token('surface/text-input-factory').type<TextInputFactory>();

/* @__NO_SIDE_EFFECTS__ */
export function hiddenTextareaTextInputUnit(): UnitDefinition<TextInputFactory, Record<never, never>, 'surface/text-input-factory'> {
  return unit<TextInputFactory, Record<never, never>, 'surface/text-input-factory'>({ id: 'surface/text-input-hidden-textarea', provides: TextInputFactoryToken, scope: 'app', create: () => hiddenTextareaTextInputFactory, description: 'TextInput over a hidden textarea.' });
}

/* @__NO_SIDE_EFFECTS__ */
export function editContextTextInputUnit(): UnitDefinition<TextInputFactory, Record<never, never>, 'surface/text-input-factory'> {
  return unit<TextInputFactory, Record<never, never>, 'surface/text-input-factory'>({ id: 'surface/text-input-edit-context', provides: TextInputFactoryToken, scope: 'app', create: () => editContextTextInputFactory, description: 'TextInput over EditContext.' });
}

export interface TextInputBindingOptions {
  /** The platform fact (`PlatformFacts.apis.editContext`); read once when the factory is first resolved. */
  readonly editContext: () => boolean;
}

/**
 * Registrations for `TextInputFactoryToken`: the hidden textarea by default, re-bound to EditContext when the
 * platform has it. Feature code injects the token and never sees the condition.
 */
export function textInputBindings(options: TextInputBindingOptions): readonly (ReturnType<typeof hiddenTextareaTextInputUnit> | ReturnType<typeof variant>)[] {
  return [hiddenTextareaTextInputUnit(), variant({ of: TextInputFactoryToken, unit: editContextTextInputUnit(), when: options.editContext, source: 'platform/edit-context' })];
}
