/**
 * Test-only fixtures for the Studio integration (never imported by app code): an in-memory workspace, a new Studio
 * document opened over the real authoring Wasm (geometry and text, loaded from `engine/dist` in Node; suites skip
 * when it is not built), and Studio's fonts from `test/fonts`.
 */
import { createScope, type Scope } from '@staticflux/core';
import type { Timers } from '@staticflux/a11y';
import type { Actor } from '@staticflux/stage';
import { createEditContextTextInput, type ClientRect, type EditContextConstructor, type TextInput, type TextInputState, type TextIntent, type TextRange } from '@staticflux/surface/text-input';
import { FakeEditContext } from '@staticflux/testkit';
import { Window } from 'happy-dom';
import { authoringBuilt as geometryBuilt, loadGeometry } from '../elements/testing/fixtures.js';
import { placeTextOps } from '../text/commands.js';
import { readTextBlock } from '../text/rich-text.js';
import { authoringBuilt as textBuilt, loadAuthoringInNode, testFont } from '../text/test-helpers.js';
import { createRemoteTextHost, createTextHostBridge, type TextHostBridge, type TextHostCommand, type TextHostEvent } from '../workers/text-port.js';
import { createStudioDocument, openStudioDocument, openStudioWorkspace, type StudioDocument, type StudioWorkspace } from './document.js';
import { createStudioFonts } from './fonts.js';
import { startTextEditing, type TextEditing } from './text-editing.js';
import { createTextLayer, type StudioFonts } from './text-layer.js';

export const authoringBuilt = geometryBuilt && textBuilt;
export const person: Actor = { kind: 'human', id: 'g-ada', displayName: 'Ada', via: 'direct' };

export const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};

export interface StudioFixture {
  readonly workspace: StudioWorkspace;
  readonly document: StudioDocument;
  readonly fonts: StudioFonts;
  readonly scope: Scope;
  readonly signal: AbortSignal;
}

let assets = 0;

/** A new Studio document with `pages` pages (1080 × 1350) and Noto Sans as the default face. */
export async function createStudioFixture(options: { readonly pages?: number } = {}): Promise<StudioFixture> {
  const scope = createScope('studio-test');
  const signal = scope.signal;
  const workspace = unwrap(await openStudioWorkspace({ signal }));
  const doc = unwrap(await createStudioDocument(workspace, { asset: `as_test${(assets += 1)}`, title: 'Flyer', pages: options.pages ?? 1, signal }));
  const geometry = await loadGeometry();
  const document = unwrap(await openStudioDocument({ workspace, doc, geometry, signal, scope }));
  const fonts = unwrap(createStudioFonts({ wasm: await loadAuthoringInNode('base'), fonts: [testFont('NotoSans-Latin.wght.ttf'), testFont('NotoSansArabic.wght.ttf')] }));
  return { workspace, document, fonts, scope, signal };
}

/** A scripted `TextInput` (no DOM events): tests emit intents and read the bounds the session pushed. */
export interface ScriptedTextInput extends TextInput {
  emit(intent: TextIntent): void;
  readonly controlBounds: ClientRect[];
  readonly disposed: boolean;
}

export function scriptedTextInput(): ScriptedTextInput {
  const intents = new Set<(i: TextIntent) => void>();
  const requests = new Set<(r: TextRange) => void>();
  const controlBounds: ClientRect[] = [];
  let state: TextInputState = { text: '', selection: [0, 0] };
  let composing = false;
  let focused = false;
  let disposed = false;
  return {
    kind: 'hidden-textarea',
    focus: () => void (focused = true),
    blur: () => void (focused = false),
    get focused() {
      return focused;
    },
    get composing() {
      return composing;
    },
    get state() {
      return state;
    },
    get disposed() {
      return disposed;
    },
    controlBounds,
    setState: (next) => void (state = next),
    setControlBounds: (r) => void controlBounds.push(r),
    setSelectionBounds: () => undefined,
    setCharacterBounds: () => undefined,
    onIntent(l) {
      intents.add(l);
      return () => intents.delete(l);
    },
    onBoundsRequest(l) {
      requests.add(l);
      return () => requests.delete(l);
    },
    emit(intent) {
      if (intent.kind === 'compose-start') composing = true;
      if (intent.kind === 'compose-commit' || intent.kind === 'compose-cancel') composing = false;
      for (const l of [...intents]) l(intent);
    },
    dispose: () => void (disposed = true),
  };
}

/** A separate happy-dom window lent to `globalThis` (B1's fixtures need the node environment; see B6's tests). */
export function lendDom(): { readonly window: Window; readonly document: Document; restore(): void } {
  const window = new Window();
  const lent = ['HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement'] as const;
  for (const name of lent) Object.assign(globalThis, { [name]: window[name] });
  return {
    window,
    document: window.document as unknown as Document,
    restore: () => {
      for (const name of lent) Reflect.deleteProperty(globalThis, name);
    },
  };
}

/** Manual timers (announcements are debounced). */
export function manualTimers(): Timers & { flush(): void } {
  const due = new Map<number, () => void>();
  let id = 0;
  return {
    set: (fn) => (due.set((id += 1), fn), id),
    clear: (h) => due.delete(h as number),
    flush: () => {
      for (const [k, fn] of [...due]) {
        due.delete(k);
        fn();
      }
    },
  };
}

/** The TextInput port rig (FIX-TEXT-FIRST-KEY, B12b P1): see `textPortRig`. */
export interface TextPortRig {
  readonly fixture: StudioFixture;
  readonly editing: TextEditing;
  readonly bridge: TextHostBridge;
  /** Commands from the editor not yet applied on main (postMessage order). */
  readonly toMain: TextHostCommand[];
  /** Main applies the editor's next command; returns it. */
  mainStep(): TextHostCommand | undefined;
  /** The editor handles every event main sent so far. */
  editorStep(): void;
  /** Deliver both ways until nothing is in flight. */
  settle(): void;
  /** The EditContext on main. */
  platform(): FakeEditContext;
  /** A key on the text host (main's EditContext turns it into a key intent). */
  key(key: string, modifiers?: { readonly shift?: boolean; readonly mod?: boolean }): void;
  /** The element's committed text. */
  text(): string;
  dispose(): Promise<void>;
}

/**
 * A new text element `t` on `p1`, its editing session in the editor module and an EditContext (fake) on main, joined by
 * B9's TextInput port with **both message queues under the test's control** (states can be held back). Settled once.
 */
export async function textPortRig(): Promise<TextPortRig> {
  const f = await createStudioFixture();
  const dom = lendDom();
  const surface = dom.document.createElement('div');
  dom.document.body.append(surface);
  unwrap(f.document.commitOps('p1', person, 'Add text', unwrap(placeTextOps({ node: 't', parent: 'p1', x: 100, y: 50 }))));
  const layer = createTextLayer({ document: f.document, page: 'p1', fonts: f.fonts, scope: f.scope });
  const toMain: TextHostCommand[] = [];
  const toEditor: TextHostEvent[] = [];
  let ec: FakeEditContext | undefined;
  const Ctor = function (init?: { text?: string; selectionStart?: number; selectionEnd?: number }): FakeEditContext {
    ec = new FakeEditContext(init);
    return ec;
  } as unknown as EditContextConstructor;
  const bridge = createTextHostBridge({ surface, create: (host, label) => createEditContextTextInput({ host, document: dom.document, EditContext: Ctor, label }), send: (e) => toEditor.push(e) });
  const remote = createRemoteTextHost((c) => toMain.push(c), 'edit-context');
  const editing = unwrap(startTextEditing({ document: f.document, page: 'p1', node: 't', layer, fonts: f.fonts, host: remote, camera: () => ({ tx: 0, ty: 0, zoom: 1 }), actor: () => person, onExit: () => undefined, scope: f.scope }));
  const mainStep = (): TextHostCommand | undefined => {
    const c = toMain.shift();
    if (c !== undefined) bridge.receive(c);
    return c;
  };
  const editorStep = (): void => {
    for (const e of toEditor.splice(0)) remote.receive(e);
  };
  const settle = (): void => {
    while (toMain.length > 0 || toEditor.length > 0) {
      while (mainStep() !== undefined);
      editorStep();
    }
  };
  settle(); // open, the first state, place, focus
  const platform = (): FakeEditContext => {
    if (ec === undefined) throw new Error('no EditContext');
    return ec;
  };
  const key = (name: string, modifiers: { readonly shift?: boolean; readonly mod?: boolean } = {}): void => {
    const e = new dom.window.Event('keydown', { bubbles: true, cancelable: true }) as unknown as Event;
    const fields = { key: name, shiftKey: modifiers.shift === true, ctrlKey: modifiers.mod === true, metaKey: false, altKey: false, isComposing: false };
    for (const [k, v] of Object.entries(fields)) Object.defineProperty(e, k, { value: v });
    bridge.host?.dispatchEvent(e);
  };
  return {
    fixture: f,
    editing,
    bridge,
    toMain,
    mainStep,
    editorStep,
    settle,
    platform,
    key,
    text: () => unwrap(readTextBlock(f.document.part('p1')!, 't')).text,
    dispose: async () => {
      editing.stop();
      dom.restore();
      await f.scope.dispose();
    },
  };
}
