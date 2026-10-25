/**
 * Test-only fixtures for the Studio integration (never imported by app code): an in-memory workspace, a new Studio
 * document opened over the real authoring Wasm (geometry and text, loaded from `engine/dist` in Node; suites skip
 * when it is not built), and Studio's fonts from `test/fonts`.
 */
import { createScope, type Scope } from '@staticflux/core';
import type { Timers } from '@staticflux/a11y';
import type { Actor } from '@staticflux/stage';
import type { ClientRect, TextInput, TextInputState, TextIntent, TextRange } from '@staticflux/surface/text-input';
import { Window } from 'happy-dom';
import { authoringBuilt as geometryBuilt, loadGeometry } from '../elements/testing/fixtures.js';
import { authoringBuilt as textBuilt, loadAuthoringInNode, testFont } from '../text/test-helpers.js';
import { createStudioDocument, openStudioDocument, openStudioWorkspace, type StudioDocument, type StudioWorkspace } from './document.js';
import { createStudioFonts } from './fonts.js';
import type { StudioFonts } from './text-layer.js';

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
