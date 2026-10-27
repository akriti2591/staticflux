/**
 * Studio's canvas port on main (B8; B9 IF-33.7–33.13): what `<if-studio>` starts on its canvas surface. Main keeps
 * only page-side adapters; the editor and render modules run in their workers (`../workers/`).
 *
 * - **Canvas**: a `<canvas>` in the surface, handed to the render module as an `OffscreenCanvas` (transferred once).
 * - **Input**: A5's input forwarder writes pointer, wheel and key samples into the editor's input ring. Events from
 *   the text host are not forwarded (the TextInput owns them); keys reach the ring only from inside the surface.
 *   Pointer capture and focus on press stay here (DOM).
 * - **Shortcuts**: the canvas shortcuts are registered in Studio's registry with handlers that do nothing here (the
 *   editor runs them from the ring): the browser default is prevented, the help lists them, and the canvas scope is
 *   active while the surface (not the text host) has focus — exactly B8's behaviour.
 * - **B6**: `mountCanvasA11y` applies the editor's snapshots; focusing a node selects it in the editor.
 * - **B2**: the text host bridge (EditContext / textarea on a host div) over the TextInput port.
 * - **B3**: the distance labels as kit tags from the editor's labels.
 * - Size, device pixel ratio and visibility changes go to both modules.
 */
import type { ShortcutRegistry } from '@staticflux/a11y';
import { createScope, err, ok, type Result, type Scope, type SfError } from '@staticflux/core';
import type { NodeId } from '@staticflux/document/v2';
import { createInputForwarder, type InputTarget } from '@staticflux/surface';
import { inputRingSink } from '@staticflux/surface/input-ring';
import type { TextInput } from '@staticflux/surface/text-input';
import { fromWireError } from '@staticflux/worker';
import { render as renderLit } from 'lit';
import { type CanvasA11yMount, type FocusRingOptions, mountCanvasA11y } from '../a11y/dom.js';
import type { CanvasPort, CanvasSession } from '../studio/canvas.js';
import { CanvasToolsShortcutScope } from '../tools/keyboard.js';
import { guideLabelTemplate } from '../tools/overlay-labels.js';
import type { StudioWorkers } from '../workers/boot.js';
import { CanvasTransferError } from '../workers/errors.js';
import { createTextHostBridge, type TextHostBridge } from '../workers/text-port.js';
import { canvasShortcutDefs } from './canvas-shortcuts.js';
import { NoOpenPageError } from './errors.js';

/**
 * Focus an element because of a pointer press (#41). Script focus in `pointerdown` runs before the browser records the
 * press as the focus cause, so Chromium's heuristic shows the keyboard focus ring there (and every programmatic move
 * after it inherits that ring); `focusVisible: false` says it is pointer focus, as a native click would be.
 */
export function focusFromPointer(el: HTMLElement): void {
  const options: FocusRingOptions = { preventScroll: true, focusVisible: false };
  el.focus(options);
}

/** What hands the canvas to the render module (default: `transferControlToOffscreen`; tests pass a stand-in). */
export type CanvasHandoffFactory = (canvas: HTMLCanvasElement) => Result<{ readonly canvas: unknown; readonly transfer: readonly Transferable[] }>;

export const offscreenHandoff: CanvasHandoffFactory = (canvas) => {
  const transfer = (canvas as HTMLCanvasElement & { transferControlToOffscreen?: () => OffscreenCanvas }).transferControlToOffscreen;
  if (typeof transfer !== 'function') return err(CanvasTransferError());
  try {
    const offscreen = transfer.call(canvas);
    return ok({ canvas: offscreen, transfer: [offscreen] });
  } catch (cause) {
    return err(CanvasTransferError({ cause }));
  }
};

export interface StudioCanvasOptions {
  readonly workers: StudioWorkers;
  /** The page shown first. */
  readonly page: () => NodeId;
  /** Create the platform TextInput on a host (text editing is off without it). */
  readonly textInput?: (host: HTMLElement, label: string) => Result<TextInput>;
  /** Studio's shortcut registry (the canvas shortcuts are registered there for the canvas' lifetime). */
  readonly shortcuts?: ShortcutRegistry;
  readonly handoff?: CanvasHandoffFactory;
  readonly onProblem?: (error: SfError) => void;
  /** Viewport when the surface has no layout yet (tests, hidden tabs). */
  readonly fallbackSize?: { readonly width: number; readonly height: number };
  readonly env?: { readonly now: () => number; readonly timeOrigin: number };
}

export interface StudioCanvas extends CanvasPort {
  /** The page the editor shows (after `start`). */
  readonly page: NodeId | undefined;
  readonly a11y: CanvasA11yMount | undefined;
  readonly text: TextHostBridge | undefined;
  showPage(page: NodeId): Promise<Result<void>>;
}

const fromTextHost = (e: Event): boolean => (e.target as Element | null)?.closest?.('[data-if-text-host]') != null;

/** The surface as an input target that skips events from the text host. */
function filteredTarget(surface: HTMLElement): InputTarget {
  return {
    addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
      if (listener === null) return;
      const call = typeof listener === 'function' ? listener : (e: Event) => listener.handleEvent(e);
      surface.addEventListener(type, (e) => (fromTextHost(e) ? undefined : call(e)), options);
    },
    removeEventListener: () => undefined, // the forwarder removes its listeners with its abort signal
    dispatchEvent: (event: Event) => surface.dispatchEvent(event),
    getBoundingClientRect: () => surface.getBoundingClientRect(),
  };
}

export function studioCanvas(options: StudioCanvasOptions): StudioCanvas {
  const { workers } = options;
  let page: NodeId | undefined;
  let size = options.fallbackSize ?? { width: 960, height: 640 };
  let a11y: CanvasA11yMount | undefined;
  let text: TextHostBridge | undefined;
  let started = false;
  const problem = (r: Result<unknown>): void => {
    if (!r.ok) options.onProblem?.(r.error);
  };
  const showPage = async (next: NodeId): Promise<Result<void>> => {
    if (!started) return err(NoOpenPageError({ message: 'The canvas has not started.' }));
    const opened = await workers.editor.request('open', { page: next, viewport: size });
    if (opened.ok) page = next;
    return opened;
  };

  return {
    get page() {
      return page;
    },
    get a11y() {
      return a11y;
    },
    get text() {
      return text;
    },
    showPage,
    async start(surfaceTarget, signal): Promise<Result<CanvasSession>> {
      const surface = surfaceTarget as unknown as HTMLElement;
      const doc = surface.ownerDocument;
      const scope: Scope = createScope('instaflow/studio-canvas');
      const listening = { signal: scope.signal };
      const canvas = doc.createElement('canvas');
      canvas.dataset['ifCanvas'] = 'content';
      canvas.setAttribute('aria-hidden', 'true');
      Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block' });
      const labels = doc.createElement('div');
      labels.dataset['ifGuideLabels'] = '';
      labels.setAttribute('aria-hidden', 'true');
      Object.assign(labels.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden' });
      surface.append(canvas, labels);
      scope.defer(() => {
        canvas.remove();
        labels.remove();
      });
      const measured = surface.getBoundingClientRect();
      if (measured.width > 0 && measured.height > 0) size = { width: measured.width, height: measured.height };
      const dpr = (): number => doc.defaultView?.devicePixelRatio ?? 1;
      const fail = async (r: Result<never>): Promise<Result<never>> => {
        await scope.dispose();
        return r;
      };

      // B6: the DOM projection of the editor's snapshots.
      const mounted = mountCanvasA11y({ host: surface, document: doc, onFocusNode: (id) => void workers.editor.request('select', { nodes: [id] }).then(problem) });
      if (!mounted.ok) return fail(mounted);
      a11y = mounted.value;
      scope.defer(() => {
        mounted.value.dispose();
        a11y = undefined;
      });
      scope.defer(workers.editor.on('a11y', (snapshot) => problem(mounted.value.apply(snapshot))));

      // B2: the text host over the TextInput port.
      if (options.textInput !== undefined) {
        const bridge = createTextHostBridge({
          surface,
          create: options.textInput,
          send: (event) => void workers.editor.request('text', event).then(problem),
          // B6: while editing, the host is the element's `textbox`; its projected node steps aside.
          onOpen: (node) => mounted.value.layer.element(node)?.setAttribute('aria-hidden', 'true'),
          onClose: (node) => mounted.value.layer.element(node)?.removeAttribute('aria-hidden'),
          ...(options.onProblem === undefined ? {} : { onProblem: options.onProblem }),
        });
        text = bridge;
        scope.defer(workers.editor.on('text', (command) => bridge.receive(command)));
        scope.defer(() => {
          bridge.dispose();
          text = undefined;
        });
      }

      // B3: distance labels as kit tags.
      let labelled = false;
      scope.defer(
        workers.editor.on('labels', ({ labels: list, camera }) => {
          if (list.length > 0 || labelled) renderLit(guideLabelTemplate(list, camera), labels);
          labelled = list.length > 0;
        }),
      );
      scope.defer(workers.editor.on('problem', ({ error }) => options.onProblem?.(fromWireError(error))));

      // The canvas goes to the render module (once), then the editor opens the first page.
      const handed = (options.handoff ?? offscreenHandoff)(canvas);
      if (!handed.ok) return fail(handed);
      const attached = await workers.render.request('canvas', { canvas: handed.value.canvas, width: size.width, height: size.height, dpr: dpr() }, { transfer: handed.value.transfer, signal });
      if (!attached.ok) return fail(attached);
      started = true;
      // Measure again: the layout may have settled while the render module started (Wasm, GPU device).
      const settled = surface.getBoundingClientRect();
      if (settled.width > 0 && settled.height > 0) size = { width: settled.width, height: settled.height };
      const first = await showPage(options.page());
      if (!first.ok) {
        started = false;
        return fail(first);
      }

      // Input → the editor's ring (A5).
      // Keys typed into the text host belong to it (WRK-2); its pointer events go to the editor like any other, which
      // places the caret and selects in the text (FIX-TEXT-FIRST-KEY item 2: they used to be dropped here).
      const keys = filteredTarget(surface);
      const forwarder = createInputForwarder({ target: surface as unknown as InputTarget, keyboardTarget: keys, env: options.env ?? { now: () => performance.now(), timeOrigin: performance.timeOrigin }, sinks: [inputRingSink(workers.input)], captureWheel: true });
      scope.defer(() => forwarder.dispose());
      // No native text selection or drag-and-drop on the surface (the accessibility layer holds text): the browser would
      // cancel the pointer (pointercancel) to start its own drag and end the gesture.
      const surfaceStyle = { userSelect: surface.style.userSelect, touchAction: surface.style.touchAction };
      Object.assign(surface.style, { userSelect: 'none', touchAction: 'none' });
      scope.defer(() => Object.assign(surface.style, surfaceStyle));
      surface.addEventListener('dragstart', (e) => e.preventDefault(), listening);
      surface.addEventListener(
        'pointerdown',
        (e) => {
          if (e.button !== 0) return;
          surface.setPointerCapture?.(e.pointerId); // a drag-select may leave the text host
          // The host keeps the focus while editing. Pointer focus: no keyboard focus ring (#41).
          if (!fromTextHost(e)) focusFromPointer(surface);
        },
        listening,
      );

      // Canvas shortcuts: registered here (default prevented, help lists them), run in the editor.
      const registry = options.shortcuts;
      if (registry !== undefined) {
        for (const def of canvasShortcutDefs()) {
          const registered = registry.register(def, () => undefined, { scope });
          if (!registered.ok) return fail(registered);
        }
        let deactivate: (() => void) | undefined;
        const sync = (): void => {
          // The focused element through shadow roots (the surface lives in `<if-studio>`'s shadow root, so the
          // document's active element is the host): B11b found the canvas scope never activated, so key commands that
          // also run from the chrome ran twice (once here, once in the editor from the ring).
          let active: Element | null = doc.activeElement;
          while (active?.shadowRoot?.activeElement != null) active = active.shadowRoot.activeElement;
          const inside = active !== null && surface.contains(active) && active !== text?.host;
          if (inside && deactivate === undefined) deactivate = registry.activate(CanvasToolsShortcutScope, scope);
          if (!inside && deactivate !== undefined) {
            deactivate();
            deactivate = undefined;
          }
        };
        surface.addEventListener('focusin', () => queueMicrotask(sync), listening);
        surface.addEventListener('focusout', () => queueMicrotask(sync), listening);
        sync();
      }

      // Size, pixel ratio and visibility go to both modules.
      const Observer = (doc.defaultView as (Window & { ResizeObserver?: typeof ResizeObserver }) | null)?.ResizeObserver;
      if (Observer !== undefined) {
        const observer = new Observer(() => {
          const r = surface.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return;
          size = { width: r.width, height: r.height };
          void workers.everyWorker((client) => client.request('resize', { width: r.width, height: r.height, dpr: dpr() })).then(problem);
        });
        observer.observe(surface);
        scope.defer(() => observer.disconnect());
      }
      doc.addEventListener('visibilitychange', () => void workers.render.request('visible', { visible: doc.visibilityState === 'visible' }).then(problem), listening);

      let stopped = false;
      const stop = async (): Promise<void> => {
        if (stopped) return;
        stopped = true;
        started = false;
        page = undefined;
        await scope.dispose();
      };
      signal.addEventListener('abort', () => void stop(), { once: true });
      return ok({
        get forwarded() {
          return forwarder.forwarded;
        },
        stop,
      });
    },
  };
}
