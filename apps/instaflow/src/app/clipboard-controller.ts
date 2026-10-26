/**
 * Studio's clipboard on main (B11b, STUDIO-UX-SPEC §8.1). The editor builds and applies payloads (`clipboard.ts`); this
 * controller moves them:
 *
 * - **Keys** use the browser's own `copy` / `cut` / `paste` events (so the system clipboard works without a permission
 *   prompt). Copy writes the payload into `text/html` (and names or text into `text/plain`) and keeps it in memory too.
 * - **Paste** reads, in order: Studio's payload in `text/html` → image files (imported into the library, then placed) →
 *   plain text from another app (a text element) → the in-memory copy (a browser that blocked the system clipboard).
 *   `Mod+Shift+V` pastes in place.
 * - **Menus** (no clipboard event) write with the async Clipboard API when it is there, and read the in-memory copy.
 *
 * Events inside text fields, contenteditable regions and text editing are left to them. Client gating, not security.
 */
import { box, type Derived, type Result, type Scope, type SfError } from '@staticflux/core';
import type { NodeId } from '@staticflux/document/v2';
import { defineShortcut } from '@staticflux/a11y';
import { StudioShortcutScope } from '../studio/studio.js';
import { type ClipboardPayload, payloadFromHtml, payloadToHtml } from './clipboard.js';

/**
 * The clipboard keys as registry entries (the cheat sheet lists them). Their handlers decline (`false`), so the
 * browser's default runs and fires the copy / cut / paste events this controller handles.
 */
export const ClipboardShortcuts = Object.freeze({
  cut: defineShortcut({ id: 'instaflow/cut-key', keys: ['Mod+X'], scope: StudioShortcutScope, description: 'Cut', allowInInputs: false, preventDefault: false }),
  copy: defineShortcut({ id: 'instaflow/copy-key', keys: ['Mod+C'], scope: StudioShortcutScope, description: 'Copy', allowInInputs: false, preventDefault: false }),
  paste: defineShortcut({ id: 'instaflow/paste-key', keys: ['Mod+V'], scope: StudioShortcutScope, description: 'Paste', allowInInputs: false, preventDefault: false }),
  pasteInPlace: defineShortcut({ id: 'instaflow/paste-in-place-key', keys: ['Mod+Shift+V'], scope: StudioShortcutScope, description: 'Paste in place', allowInInputs: false, preventDefault: false }),
});

/** The editor requests the controller runs (the worker protocol's `copy`, `paste`, `pasteText`). */
export interface ClipboardEditor {
  copy(nodes: readonly NodeId[], cut: boolean): Promise<Result<ClipboardPayload>>;
  paste(payload: ClipboardPayload, inPlace: boolean): Promise<Result<void>>;
  pasteText(text: string): Promise<Result<void>>;
}

/** The async Clipboard API subset (menus write with it). */
export interface SystemClipboard {
  write?(items: readonly ClipboardItem[]): Promise<void>;
  writeText?(text: string): Promise<void>;
}

export interface ClipboardControllerOptions {
  readonly editor: ClipboardEditor;
  readonly selection: () => readonly NodeId[];
  /** Is a text element being edited (its own input owns the clipboard then)? */
  readonly editing: () => boolean;
  /** Import image files into the library and place them (paste of a screenshot). */
  readonly placeFiles: (files: readonly File[]) => Promise<void>;
  /** The text of the selected text elements (Copy as text). */
  readonly selectedText: () => Promise<string>;
  readonly problem: (error: SfError) => void;
  /** A user-facing note (clipboard blocked). */
  readonly warn: (message: string) => void;
  readonly system?: SystemClipboard;
}

export interface ClipboardController {
  /** The last copy (memory fallback; the context menu offers Paste while there is one). */
  readonly held: Derived<ClipboardPayload | undefined>;
  /** Menu commands. */
  copy(cut: boolean): Promise<void>;
  paste(inPlace: boolean): Promise<void>;
  copyAsText(): Promise<void>;
  /** The clipboard events (exported for tests; `attach` listens on a document). */
  onCopy(e: ClipboardEvent, cut: boolean): void;
  onPaste(e: ClipboardEvent): void;
  /** Listen on `target` (the document) while `scope` lives; `within` says whether an event is Studio's. */
  attach(target: EventTarget, within: (e: Event) => boolean, scope: Scope): void;
}

export const clipboardMessages = Object.freeze({
  blocked: 'Clipboard blocked by the browser · Allow in site settings',
  nothing: 'Nothing to paste',
});

/** Does the event come from a text field or editable region (which handles the clipboard itself)? */
export function fromEditable(e: Event): boolean {
  const first = e.composedPath()[0];
  if (typeof HTMLElement === 'undefined' || !(first instanceof HTMLElement)) return false;
  return first instanceof HTMLInputElement || first instanceof HTMLTextAreaElement || first.isContentEditable;
}

export function createClipboardController(options: ClipboardControllerOptions): ClipboardController {
  const held = box<ClipboardPayload | undefined>(undefined);
  let inPlaceKey = false;

  const report = (r: Result<unknown>): boolean => {
    if (!r.ok && r.error.kind !== 'aborted') options.problem(r.error);
    return r.ok;
  };

  const build = async (cut: boolean): Promise<ClipboardPayload | undefined> => {
    const nodes = options.selection();
    if (nodes.length === 0) return undefined;
    const made = await options.editor.copy(nodes, cut);
    if (!report(made) || !made.ok) return undefined;
    held.set(made.value);
    return made.value;
  };

  const writeSystem = async (payload: ClipboardPayload): Promise<void> => {
    const sys = options.system;
    try {
      if (sys?.write !== undefined && typeof ClipboardItem !== 'undefined') {
        const html = new Blob([payloadToHtml(payload)], { type: 'text/html' });
        const text = new Blob([payload.text], { type: 'text/plain' });
        await sys.write([new ClipboardItem({ 'text/html': html, 'text/plain': text })]);
      } else if (sys?.writeText !== undefined) await sys.writeText(payload.text);
    } catch {
      // The memory copy still pastes inside Studio; only other apps miss it.
      options.warn(clipboardMessages.blocked);
    }
  };

  const pastePayload = async (payload: ClipboardPayload, inPlace: boolean): Promise<void> => {
    report(await options.editor.paste(payload, inPlace));
  };

  const controller: ClipboardController = {
    held,
    async copy(cut) {
      const payload = await build(cut);
      if (payload !== undefined) await writeSystem(payload);
    },
    async paste(inPlace) {
      const payload = held.get();
      if (payload === undefined) options.warn(clipboardMessages.nothing);
      else await pastePayload(payload, inPlace);
    },
    async copyAsText() {
      const text = await options.selectedText();
      if (text === '') return;
      try {
        if (options.system?.writeText === undefined) throw new Error('no clipboard');
        await options.system.writeText(text);
      } catch {
        options.warn(clipboardMessages.blocked);
      }
    },
    onCopy(e, cut) {
      if (options.editing() || fromEditable(e) || options.selection().length === 0) return;
      e.preventDefault();
      // The event's data must be set now; the editor answers later, so the payload goes through the async API (still
      // inside the key's user activation) and memory.
      void build(cut).then((payload) => (payload === undefined ? undefined : writeSystem(payload)));
    },
    onPaste(e) {
      if (options.editing() || fromEditable(e)) return;
      e.preventDefault();
      const inPlace = inPlaceKey;
      inPlaceKey = false;
      const data = e.clipboardData;
      const html = data?.getData('text/html') ?? '';
      const ours = html === '' ? undefined : payloadFromHtml(html);
      if (ours !== undefined) {
        held.set(ours);
        void pastePayload(ours, inPlace);
        return;
      }
      const files = [...(data?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (files.length > 0) {
        void options.placeFiles(files);
        return;
      }
      const text = data?.getData('text/plain') ?? '';
      const memory = held.get();
      // Our own copy whose system write failed (or put only the names there): the memory copy is the real one.
      if (memory !== undefined && (text === '' || text === memory.text)) {
        void pastePayload(memory, inPlace);
        return;
      }
      if (text.trim() !== '') {
        void options.editor.pasteText(text).then(report);
        return;
      }
      options.warn(clipboardMessages.nothing);
    },
    attach(target, within, scope) {
      const onKey = (e: Event): void => {
        const k = e as KeyboardEvent;
        // Mod+Shift+V: the paste event that follows is "Paste in place".
        inPlaceKey = (k.key === 'v' || k.key === 'V') && k.shiftKey && (k.metaKey || k.ctrlKey);
      };
      const onCopy = (e: Event): void => (within(e) ? controller.onCopy(e as ClipboardEvent, false) : undefined);
      const onCut = (e: Event): void => (within(e) ? controller.onCopy(e as ClipboardEvent, true) : undefined);
      const onPaste = (e: Event): void => (within(e) ? controller.onPaste(e as ClipboardEvent) : undefined);
      target.addEventListener('keydown', onKey, true);
      target.addEventListener('copy', onCopy);
      target.addEventListener('cut', onCut);
      target.addEventListener('paste', onPaste);
      scope.defer(() => {
        target.removeEventListener('keydown', onKey, true);
        target.removeEventListener('copy', onCopy);
        target.removeEventListener('cut', onCut);
        target.removeEventListener('paste', onPaste);
      });
    },
  };
  return controller;
}
