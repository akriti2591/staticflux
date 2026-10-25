/**
 * `TextInput` contract suite (SF-Δ27, R16.31; port R11.56–R11.59; Instaflow IF-7.7). Runs the same user scripts — typing,
 * selection replace, Backspace/Delete (surrogate pairs), paste, Enter and Select All, a Japanese composition with
 * commit, a cancelled composition, an RTL insert — against any implementation through a **driver** that plays the
 * platform side (a fake EditContext, or events on the hidden textarea). An editor loop applies every intent with
 * `applyTextIntent` and pushes the state back, exactly as a real editor would; the suite checks the resulting text,
 * the intent sequence, the composing flag, where the IME anchor ends up (selection and character bounds) and
 * that `dispose` stops everything.
 *
 * @example
 * runTextInputContract('hidden textarea', hiddenTextareaContractSubject(), { describe, it });
 * runTextInputContract('EditContext (fake)', editContextContractSubject(), { describe, it });
 */
import {
  applyTextIntent,
  type ClientRect,
  createEditContextTextInput,
  createHiddenTextareaTextInput,
  type EditContextLike,
  type TextInput,
  type TextInputState,
  type TextIntent,
  type TextRange,
} from '@staticflux/surface/text-input';
import { assertEqual, assertTrue, type ContractRunner, okValue } from './contract-runner.js';

/** Plays the platform: what a user and an OS IME do to the input. */
export interface TextInputDriver {
  /** Type characters one by one (no IME). */
  type(text: string): void;
  backspace(): void;
  forwardDelete(): void;
  paste(text: string): void;
  /** Press a key the editor handles (`Enter`, `ArrowLeft`, `a` with mod for Select All). */
  key(key: string, modifiers?: { readonly mod?: boolean; readonly shift?: boolean }): void;
  /** An IME composition: intermediate strings, then `commit` (empty string = cancel). */
  compose(steps: readonly string[], commit: string): void;
  /** Where the platform anchors the IME now (client px), or undefined. */
  anchor(): ClientRect | undefined;
  /** The platform asks for bounds of `range` (EditContext only; the textarea has no such request). */
  requestBounds?(range: TextRange): void;
}

export interface TextInputHarness {
  readonly input: TextInput;
  readonly driver: TextInputDriver;
  dispose(): void;
}

export interface TextInputContractSubject {
  create(): TextInputHarness;
}

export interface TextInputContractCase {
  readonly name: string;
  run(subject: TextInputContractSubject): Promise<void>;
}

/** The editor side: applies intents and pushes state back; answers bounds requests with a 10 px grid. */
function editor(input: TextInput): { readonly intents: TextIntent[]; state(): TextInputState; stop(): void } {
  let state: TextInputState = { text: '', selection: [0, 0] };
  const intents: TextIntent[] = [];
  const offIntent = input.onIntent((intent) => {
    intents.push(intent);
    if (intent.kind === 'key' && intent.key === 'SelectAll') state = { text: state.text, selection: [0, state.text.length] };
    else state = applyTextIntent(state, intent);
    if (!input.composing) input.setState(state);
    const caret = state.selection[1];
    input.setSelectionBounds({ x: 100 + caret * 10, y: 50, width: 1, height: 20 });
  });
  const offBounds = input.onBoundsRequest((range) => {
    const rects: ClientRect[] = [];
    for (let i = range[0]; i < range[1]; i++) rects.push({ x: 100 + i * 10, y: 50, width: 10, height: 20 });
    input.setCharacterBounds(range[0], rects);
  });
  return {
    intents,
    state: () => state,
    stop: () => {
      offIntent();
      offBounds();
    },
  };
}

function withEditor(subject: TextInputContractSubject, body: (h: TextInputHarness, e: ReturnType<typeof editor>) => void): void {
  const h = subject.create();
  const e = editor(h.input);
  try {
    body(h, e);
  } finally {
    e.stop();
    h.dispose();
  }
}

const kinds = (intents: readonly TextIntent[]): string[] => intents.map((i) => i.kind);

export const textInputContractCases: readonly TextInputContractCase[] = [
  {
    name: 'typing inserts at the caret and the state round-trips',
    async run(subject) {
      withEditor(subject, (h, e) => {
        h.driver.type('héllo');
        assertEqual(e.state().text, 'héllo', 'typed text');
        assertEqual(h.input.state, { text: 'héllo', selection: [5, 5] }, 'state pushed back');
        assertTrue(e.intents.every((i) => i.kind === 'insert'), `only inserts: ${kinds(e.intents).join(',')}`);
      });
    },
  },
  {
    name: 'typing over a selection replaces it',
    async run(subject) {
      withEditor(subject, (h, e) => {
        h.driver.type('abcdef');
        h.input.setState({ text: 'abcdef', selection: [1, 4] });
        e.intents.length = 0;
        h.driver.type('X');
        const insert = e.intents.find((i) => i.kind === 'insert');
        assertEqual(insert, { kind: 'insert', text: 'X', range: [1, 4] }, 'replaces the selection');
      });
    },
  },
  {
    name: 'Backspace and Delete remove whole code points (surrogate pairs)',
    async run(subject) {
      withEditor(subject, (h, e) => {
        h.driver.type('a😀b');
        h.driver.backspace();
        assertEqual(e.state().text, 'a😀', 'Backspace removes b');
        h.driver.backspace();
        assertEqual(e.state().text, 'a', 'Backspace removes the whole emoji');
        h.input.setState({ text: 'a', selection: [0, 0] });
        h.driver.forwardDelete();
        assertTrue(e.intents.filter((i) => i.kind === 'delete').length === 3, 'three delete intents');
        const last = e.intents.at(-1);
        assertTrue(last?.kind === 'delete' && last.direction === 'forward', 'Delete is forward');
      });
    },
  },
  {
    name: 'paste inserts the clipboard text',
    async run(subject) {
      withEditor(subject, (h, e) => {
        h.driver.type('ab');
        h.driver.paste('XYZ');
        assertEqual(e.state().text, 'abXYZ', 'pasted');
      });
    },
  },
  {
    name: 'Enter and Select All are key intents for the editor, never text',
    async run(subject) {
      withEditor(subject, (h, e) => {
        h.driver.type('ab');
        h.driver.key('Enter');
        h.driver.key('Enter', { shift: true });
        h.driver.key('a', { mod: true });
        h.driver.key('ArrowLeft', { shift: true });
        const keys = e.intents.filter((i): i is Extract<TextIntent, { kind: 'key' }> => i.kind === 'key');
        assertEqual(
          keys.map((k) => [k.key, k.shift, k.mod]),
          [
            ['Enter', false, false],
            ['Enter', true, false],
            ['SelectAll', false, true],
            ['ArrowLeft', true, false],
          ],
          'key intents',
        );
        assertEqual(e.state().text, 'ab', 'no newline inserted by the input itself');
      });
    },
  },
  {
    name: 'a Japanese composition streams updates and commits once',
    async run(subject) {
      withEditor(subject, (h, e) => {
        h.driver.type('A');
        e.intents.length = 0;
        let composingSeen = false;
        const off = h.input.onIntent((i) => {
          if (i.kind === 'compose-update') composingSeen ||= h.input.composing;
        });
        h.driver.compose(['n', 'に', 'にほ', 'にほん', 'にほんご'], '日本語');
        off();
        assertTrue(composingSeen, 'composing during updates');
        assertTrue(!h.input.composing, 'not composing after the commit');
        const k = kinds(e.intents);
        assertEqual(k[0], 'compose-start', 'starts');
        assertEqual(k.at(-1), 'compose-commit', 'ends with one commit');
        assertEqual(k.filter((x) => x === 'compose-commit').length, 1, 'one commit');
        assertEqual(e.state().text, 'A日本語', 'committed text replaces the composition');
        const start = e.intents[0] as Extract<TextIntent, { kind: 'compose-start' }>;
        assertEqual(start.range, [1, 1], 'composition starts at the caret');
      });
    },
  },
  {
    name: 'a cancelled composition leaves no text',
    async run(subject) {
      withEditor(subject, (h, e) => {
        h.driver.type('x');
        h.driver.compose(['ㅎ', '하', '한'], '');
        assertEqual(e.state().text, 'x', 'nothing left');
        assertTrue(kinds(e.intents).includes('compose-cancel'), 'cancel intent');
      });
    },
  },
  {
    name: 'RTL text is just text (UTF-16 offsets)',
    async run(subject) {
      withEditor(subject, (h, e) => {
        h.driver.type('مرحبا');
        assertEqual(e.state(), { text: 'مرحبا', selection: [5, 5] }, 'five code units');
      });
    },
  },
  {
    name: 'the IME anchors at the caret (selection bounds) and composition character bounds',
    async run(subject) {
      withEditor(subject, (h) => {
        h.driver.type('abc');
        const anchor = h.driver.anchor();
        assertTrue(anchor !== undefined, 'the platform has an anchor');
        assertEqual([anchor?.x, anchor?.y], [130, 50], 'anchor at the caret after "abc"');
        h.driver.compose(['か'], 'か');
        h.driver.requestBounds?.([3, 4]);
        const after = h.driver.anchor();
        assertTrue(after !== undefined && after.x >= 130, `anchor follows the composition: ${JSON.stringify(after)}`);
      });
    },
  },
  {
    name: 'dispose stops intents',
    async run(subject) {
      const h = subject.create();
      const seen: TextIntent[] = [];
      h.input.onIntent((i) => seen.push(i));
      h.dispose();
      try {
        h.driver.type('z');
      } catch {
        // a disposed platform side may refuse input; either way no intent arrives
      }
      assertEqual(seen, [], 'no intents after dispose');
    },
  },
];

export function runTextInputContract(name: string, subject: TextInputContractSubject, runner: ContractRunner, options: { readonly skip?: readonly string[] } = {}): void {
  runner.describe(`TextInput contract: ${name}`, () => {
    for (const c of textInputContractCases) {
      if (options.skip?.includes(c.name)) continue;
      runner.it(c.name, () => c.run(subject));
    }
  });
}

// ------------------------------------------------------------------ fakes and drivers

function makeEvent(type: string, fields: Record<string, unknown>, cancelable = false): Event {
  const e = new Event(type, { cancelable, bubbles: true });
  for (const [k, v] of Object.entries(fields)) Object.defineProperty(e, k, { value: v, enumerable: true });
  return e;
}

const prevPoint = (text: string, at: number): number => {
  const low = text.charCodeAt(at - 1);
  return at >= 2 && low >= 0xdc00 && low <= 0xdfff ? at - 2 : Math.max(0, at - 1);
};
const nextPoint = (text: string, at: number): number => {
  const high = text.charCodeAt(at);
  return high >= 0xd800 && high <= 0xdbff ? Math.min(text.length, at + 2) : Math.min(text.length, at + 1);
};

/**
 * A fake `EditContext` that behaves like Chromium's: it owns a text buffer, applies typing and IME input itself and
 * reports it with `textupdate`, composition and `characterboundsupdate` events; bounds calls are recorded.
 */
export class FakeEditContext extends EventTarget implements EditContextLike {
  text: string;
  selectionStart: number;
  selectionEnd: number;
  controlBounds: DOMRectReadOnly | undefined;
  selectionBounds: DOMRectReadOnly | undefined;
  characterBounds: { start: number; rects: readonly DOMRectReadOnly[] } | undefined;
  private composition: [number, number] | undefined;

  constructor(init: { text?: string; selectionStart?: number; selectionEnd?: number } = {}) {
    super();
    this.text = init.text ?? '';
    this.selectionStart = init.selectionStart ?? 0;
    this.selectionEnd = init.selectionEnd ?? 0;
  }

  updateText(start: number, end: number, text: string): void {
    this.text = this.text.slice(0, start) + text + this.text.slice(end);
  }
  updateSelection(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  updateControlBounds(rect: DOMRectReadOnly): void {
    this.controlBounds = rect;
  }
  updateSelectionBounds(rect: DOMRectReadOnly): void {
    this.selectionBounds = rect;
  }
  updateCharacterBounds(start: number, rects: readonly DOMRectReadOnly[]): void {
    this.characterBounds = { start, rects };
  }

  /** Platform side: replace [start, end) with `text` and announce it. */
  input(start: number, end: number, text: string): void {
    this.updateText(start, end, text);
    const caret = start + text.length;
    this.updateSelection(caret, caret);
    this.dispatchEvent(makeEvent('textupdate', { updateRangeStart: start, updateRangeEnd: end, text, selectionStart: caret, selectionEnd: caret }));
  }

  type(text: string): void {
    for (const ch of text) this.input(Math.min(this.selectionStart, this.selectionEnd), Math.max(this.selectionStart, this.selectionEnd), ch);
  }

  deleteBackward(): void {
    const [a, b] = [Math.min(this.selectionStart, this.selectionEnd), Math.max(this.selectionStart, this.selectionEnd)];
    this.input(a === b ? prevPoint(this.text, a) : a, b, '');
  }

  deleteForward(): void {
    const [a, b] = [Math.min(this.selectionStart, this.selectionEnd), Math.max(this.selectionStart, this.selectionEnd)];
    const end = a === b ? nextPoint(this.text, b) : b;
    this.updateText(a, end, '');
    this.updateSelection(a, a);
    this.dispatchEvent(makeEvent('textupdate', { updateRangeStart: a, updateRangeEnd: end, text: '', selectionStart: a, selectionEnd: a }));
  }

  compose(steps: readonly string[], commit: string): void {
    const start = Math.min(this.selectionStart, this.selectionEnd);
    this.composition = [start, Math.max(this.selectionStart, this.selectionEnd)];
    this.dispatchEvent(makeEvent('compositionstart', { data: '' }));
    for (const step of steps) {
      this.input(this.composition[0], this.composition[1], step);
      this.composition = [start, start + step.length];
      this.dispatchEvent(makeEvent('textformatupdate', { getTextFormats: () => [{ rangeStart: start, rangeEnd: start + step.length, underlineStyle: 'Solid', underlineThickness: 'Thin' }] }));
      this.dispatchEvent(makeEvent('characterboundsupdate', { rangeStart: start, rangeEnd: start + step.length }));
    }
    if (commit !== steps.at(-1)) this.input(this.composition[0], this.composition[1], commit);
    this.composition = undefined;
    this.dispatchEvent(makeEvent('compositionend', { data: commit }));
  }

  requestBounds(range: TextRange): void {
    this.dispatchEvent(makeEvent('characterboundsupdate', { rangeStart: range[0], rangeEnd: range[1] }));
  }
}

function keydown(target: EventTarget, key: string, modifiers: { readonly mod?: boolean; readonly shift?: boolean } = {}): void {
  target.dispatchEvent(makeEvent('keydown', { key, shiftKey: modifiers.shift === true, ctrlKey: modifiers.mod === true, metaKey: false, altKey: false, isComposing: false }, true));
}

/** The EditContext implementation over `FakeEditContext` (needs a DOM: happy-dom or a browser). */
export function editContextContractSubject(doc: Document = globalThis.document): TextInputContractSubject {
  return {
    create() {
      const host = doc.createElement('div');
      doc.body.appendChild(host);
      let fake: FakeEditContext | undefined;
      class Ctor extends FakeEditContext {
        constructor(init?: { text?: string; selectionStart?: number; selectionEnd?: number }) {
          super(init);
          fake = this;
        }
      }
      const input = okValue(createEditContextTextInput({ host, document: doc, EditContext: Ctor, label: 'Text' }), 'create EditContext input');
      const ec = fake as FakeEditContext;
      const driver: TextInputDriver = {
        type: (text) => ec.type(text),
        backspace: () => ec.deleteBackward(),
        forwardDelete: () => ec.deleteForward(),
        paste: (text) => ec.type(text),
        key: (key, m) => keydown(host, key, m),
        compose: (steps, commit) => ec.compose(steps, commit),
        anchor: () => {
          const c = ec.characterBounds?.rects[0];
          const r = c ?? ec.selectionBounds;
          return r === undefined ? undefined : { x: r.x, y: r.y, width: r.width, height: r.height };
        },
        requestBounds: (range) => ec.requestBounds(range),
      };
      return {
        input,
        driver,
        dispose: () => {
          input.dispose();
          host.remove();
        },
      };
    },
  };
}

/** The hidden-textarea implementation, driven with `beforeinput`, composition and key events (Firefox-like). */
export function hiddenTextareaContractSubject(doc: Document = globalThis.document): TextInputContractSubject {
  return {
    create() {
      const host = doc.createElement('div');
      doc.body.appendChild(host);
      const input = okValue(createHiddenTextareaTextInput({ host, document: doc, label: 'Text' }), 'create textarea input');
      const area = host.querySelector('textarea') as HTMLTextAreaElement;
      const before = (inputType: string, data: string | null): void => {
        const e = makeEvent('beforeinput', { inputType, data, dataTransfer: null }, true);
        area.dispatchEvent(e);
        if (!e.defaultPrevented && inputType !== 'insertCompositionText') throw new Error(`beforeinput ${inputType} was not handled`);
      };
      const driver: TextInputDriver = {
        type: (text) => {
          if (!host.contains(area)) throw new Error('textarea removed');
          for (const ch of text) before('insertText', ch);
        },
        backspace: () => before('deleteContentBackward', null),
        forwardDelete: () => before('deleteContentForward', null),
        paste: (text) => before('insertFromPaste', text),
        key: (key, m) => {
          keydown(area, key, m);
        },
        compose: (steps, commit) => {
          area.dispatchEvent(makeEvent('compositionstart', { data: '' }));
          for (const step of steps) {
            before('insertCompositionText', step);
            area.dispatchEvent(makeEvent('compositionupdate', { data: step }));
          }
          area.dispatchEvent(makeEvent('compositionend', { data: commit }));
        },
        anchor: () => {
          const x = Number.parseFloat(area.style.left);
          const y = Number.parseFloat(area.style.top);
          return Number.isNaN(x) || Number.isNaN(y) ? undefined : { x, y, width: 1, height: Number.parseFloat(area.style.height) };
        },
      };
      return {
        input,
        driver,
        dispose: () => {
          input.dispose();
          host.remove();
        },
      };
    },
  };
}
