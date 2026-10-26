/**
 * The per-tab tool session on Studio's live canvas (B8; IF-27.5–27.13; B9: in the editor module, DOM-free): everything
 * one tab needs to draw, select, snap, type and be read by assistive technology, wired over one open page.
 *
 * - **B3**: the tab's view state, the element index over B7's repeat view, the `ToolSession`, the pointer
 *   controller (select, marquee, handles, smart guides and snapping, hand), the keyboard commands and shortcuts
 *   (registered on the editor's registry: main forwards keys only while the canvas surface has focus and no text is
 *   being edited), and the **overlay** (`toolOverlayBatch`, non-printing) on the scene record's overlay section, so it
 *   is drawn in the same frame as the content it frames; distance labels go to main (`onLabels`) as data.
 * - **Creation tools** (`creation.ts`): Shape, Frame and Text; pointer events go to the controller that handles
 *   the active tool (a lookup, never a mode branch).
 * - **B2**: the text layer on the record's IR section, and one editing session at a time (`text-editing.ts`, over
 *   the `TextHostPort`); double click on a text element edits it.
 * - **B6**: the editor side of the accessibility layer (`createCanvasA11yEditor`): snapshots go to main
 *   (`onSnapshot`), where the DOM projection is mounted; polite announcements go to the announcer port.
 * - **A7 / B1 / B7**: the tab attaches its sources to the editor's canvas publisher and publishes on stage
 *   invalidations and view changes.
 *
 * Undo / redo (`Mod+Z`, `Mod+Shift+Z`), Delete and Duplicate are canvas shortcuts too (one undo step each). Everything
 * is disposed with the tab scope (rule 5).
 */
import type { Announcer, ShortcutRegistry, Timers } from '@staticflux/a11y';
import { err, ok, type Result, type Scope, type SfError, watch } from '@staticflux/core';
import { createRenderProjector } from '@staticflux/document/render-projection';
import type { NodeId, PartOp } from '@staticflux/document/v2';
import type { Actor } from '@staticflux/stage';
import { type CanvasA11yEditor, createCanvasA11yEditor } from '../a11y/editor-side.js';
import type { CanvasSnapshot } from '../a11y/projection.js';
import { partTextSource } from '../a11y/text-source.js';
import { commitEdit, duplicate } from '../elements/actions.js';
import { createElementRenderSource, ElementProjection } from '../elements/projection.js';
import { colorToRgba } from '../elements/values.js';
import { STRUCTURE_PATHS } from '../lenses/structure.js';
import { createSceneWriter } from '../render/scene-ir.js';
import type { ToolId } from '../spec/contributions.js';
import { TEXT_KIND } from '../text/model.js';
import { cleanPopTheme } from '../theme/clean-pop.js';
import { createToolController, refreshOverlay, type ToolController, type ToolOutcome, type ToolPointer, type ToolSession } from '../tools/gesture.js';
import { createElementIndex, hitTest } from '../tools/hit-test.js';
import { bindToolShortcuts, createToolCommands, type ToolCommands, TransformModeShortcutScope } from '../tools/keyboard.js';
import { textEditBatch, toolOverlayBatch } from '../tools/overlay.js';
import { createTransformMode } from '../tools/transform-mode.js';
import type { GuideLabel } from '../tools/snapping.js';
import { type Camera, createViewState, fitCamera, type TabId, type ViewState } from '../tools/view-state.js';
import type { CanvasPublisher, SceneIrChanges, SceneIrSource } from './canvas-pipeline.js';
import { DeleteShortcut, DuplicateShortcut, RedoShortcut, UndoShortcut } from './canvas-shortcuts.js';
import { type CreateOutcome, createCreationController, type CreationController } from './creation.js';
import type { StudioDocument } from './document.js';
import { NoOpenPageError } from './errors.js';
import type { ImageUploads } from './images.js';
import { startTextEditing, type TextEditing, type TextExitReason, type TextHostPort } from './text-editing.js';
import { createTextLayer, type StudioFonts, type TextLayer } from './text-layer.js';

export interface CanvasTabOptions {
  readonly tab: TabId;
  readonly document: StudioDocument;
  readonly page: NodeId;
  readonly fonts: StudioFonts;
  /** The editor's canvas publisher (the tab attaches its page's sources while it lives). */
  readonly publisher: CanvasPublisher;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly actor: () => Actor;
  /** Studio's picked tool (reactive). */
  readonly tool: () => ToolId | undefined;
  /** Hand the toolbar back (after a creation tool placed its element). */
  readonly selectTool?: (tool: ToolId) => void;
  /** The editor's shortcut registry (the canvas scope is active there whenever keys arrive). */
  readonly shortcuts?: ShortcutRegistry;
  /** Apple key conventions while editing text (B12 T-3: Option word, Command line). Default false. */
  readonly isMac?: boolean;
  /** Where the text host lives (text editing is off without it). */
  readonly textHost?: TextHostPort;
  readonly announcer: Pick<Announcer, 'announce'>;
  readonly timers: Timers;
  /** Coalesces publishes (default microtask). */
  readonly schedule?: (fn: () => void) => void;
  /** Coalesces accessibility projections (default `schedule`; `requestAnimationFrame` where there is one). */
  readonly a11ySchedule?: (fn: () => void) => void;
  /** Image uploads (library Place): their asset section and the encoder's image lookup. */
  readonly images?: Pick<ImageUploads, 'changes' | 'images'>;
  /** Distance labels changed (main shows them as kit tags). */
  readonly onLabels?: (labels: readonly GuideLabel[], camera: Camera) => void;
  /** A new accessibility snapshot (main mounts it). */
  readonly onSnapshot?: (snapshot: CanvasSnapshot) => void;
  /** Text editing started (`node`) or ended (`undefined`). */
  readonly onEditing?: (node: NodeId | undefined, reason?: TextExitReason) => void;
  readonly onProblem?: (error: SfError) => void;
  readonly scope: Scope;
}

export interface CanvasTab {
  readonly tab: TabId;
  readonly page: NodeId;
  readonly view: ViewState;
  readonly tools: ToolSession;
  readonly controller: ToolController;
  readonly creation: CreationController;
  readonly commands: ToolCommands;
  readonly a11y: CanvasA11yEditor;
  readonly text: TextLayer;
  /** The text being edited (reactive only through `onEditing`). */
  readonly editing: TextEditing | undefined;
  /** Pointer input in surface pixels (the input ring drain and tests call it). */
  pointer(event: ToolPointer): Result<ToolOutcome | CreateOutcome>;
  wheel(event: { readonly x: number; readonly y: number; readonly dx: number; readonly dy: number; readonly mod?: boolean }): Result<void>;
  /** Start editing a text element. */
  editText(node: NodeId): Result<void>;
  stopEditing(): void;
  /** Delete the selection (one undo step). */
  deleteSelection(): Result<void>;
  /** Duplicate the selection (B1 `duplicate`: match keys, rich text kept), select the copies (one undo step). */
  duplicateSelection(): Result<void>;
  undo(): Promise<Result<void>>;
  redo(): Promise<Result<void>>;
  /** Fit the page in the viewport. */
  fit(): void;
  /** Publish now (cheap when nothing changed). */
  publish(): void;
}

/** Where a duplicate lands, relative to its source (page units). */
export const DUPLICATE_OFFSET: readonly [number, number] = [24, 24];

const microtask = (fn: () => void): void => queueMicrotask(fn);

/** Overlay scene ids (above B1's even element ids and the text layer's odd ids). */
export const OVERLAY_FIRST_ID = 0x4000_0001;
/** The page edge's scene id (below the tool overlay's). */
export const PAGE_EDGE_ID = OVERLAY_FIRST_ID - 2;

/** The page edge colour (Clean Pop `border`). */
const PAGE_EDGE = /* @__PURE__ */ colorToRgba(String(cleanPopTheme.values.color['border'])) ?? [0, 0, 0, 40];

/** Open the tool session of one tab on one page (see the module header). */
export async function openCanvasTab(options: CanvasTabOptions): Promise<Result<CanvasTab>> {
  const { document, page, scope } = options;
  const part = document.part(page);
  if (part === undefined) return err(NoOpenPageError({ details: { page } }));
  const schedule = options.schedule ?? microtask;
  const ctx = { stage: document.view, geometry: document.geometry, kit: document.kit };
  const index = createElementIndex(ctx, page, scope);
  const view = createViewState({ tab: options.tab, root: page, viewport: options.viewport, tool: options.tool() ?? 'instaflow/select' });
  const base = { ctx, target: document.target(page), session: document.session, index, view, actor: options.actor };
  // B10a: the tab's transform session (Mod+T); it cancels with the tab scope (page switch).
  const tools: ToolSession = { ...base, mode: createTransformMode(base, scope) };
  const mode = tools.mode as NonNullable<ToolSession['mode']>;
  const controller = createToolController(tools);
  const commands = createToolCommands(tools);
  let editing: TextEditing | undefined;

  function pageSize(): { readonly w: number; readonly h: number } {
    const size = part?.prop(page, STRUCTURE_PATHS.pageSize) as { width?: number; height?: number } | undefined;
    return { w: typeof size?.width === 'number' ? size.width : 1080, h: typeof size?.height === 'number' ? size.height : 1350 };
  }

  // Overlay (B3): the page edge (the page itself is the raster background) and B3's overlay, as the overlay section of
  // the next record whenever the overlay or the zoom changes (stroke widths stay constant on screen).
  // The page edge is re-sent only when it changes (page size, or zoom for its constant on-screen width): its bounds are
  // the whole page, so re-sending it with every overlay change (each pointer move of a drag) made every tile of the
  // page stale on every move (FIX-DRAG-STUTTER).
  let overlayIds: number[] = [];
  let overlayDirty = true;
  let edge = '';
  const overlay: SceneIrSource = {
    changes(full) {
      if (!full && !overlayDirty) return undefined;
      overlayDirty = false;
      const prelude = createSceneWriter();
      if (!full) for (const id of overlayIds) prelude.remove(id); // a snapshot starts with CLEAR
      overlayIds = [];
      const size = pageSize();
      const nextEdge = `${size.w}:${size.h}:${view.camera.zoom}`;
      if (full || nextEdge !== edge) {
        edge = nextEdge;
        prelude.upsert({
          id: PAGE_EDGE_ID,
          transform: [1, 0, 0, 1, 0, 0],
          geometry: { kind: 'rect', w: size.w, h: size.h },
          stroke: { width: 1 / view.camera.zoom, paint: { kind: 'solid', color: PAGE_EDGE } },
        });
      }
      const tools = toolOverlayBatch(view.overlay, view.camera.zoom, { clear: false, firstId: OVERLAY_FIRST_ID, ids: overlayIds });
      // The caret and selection of the text being edited (TEXT-FONTS §3.2), after the tool overlay's ids.
      const edit = editing?.overlay(view.camera.zoom);
      const batches = [prelude.finish(), tools];
      if (edit !== undefined) batches.push(textEditBatch(edit, { clear: false, firstId: OVERLAY_FIRST_ID + 2 * (overlayIds.length + 1), ids: overlayIds }));
      return { overlay: batches };
    },
  };

  // Canvas pipeline: B1's source over the repeat view, B2's text on the IR section, uploads and the overlay.
  const source = createElementRenderSource({ stage: document.view, geometry: document.geometry, kit: document.kit, root: page, orderOf: (id) => part.node(id)?.order, pageFill: true }); // B12: the page's fill stack
  scope.defer(() => source.dispose());
  const projector = createRenderProjector(ElementProjection, source);
  const text = createTextLayer({ document, page, fonts: options.fonts, scope });
  const images = options.images;
  const ir: SceneIrSource = {
    changes(full) {
      const parts = [images?.changes(full), text.changes(full), overlay.changes(full)].filter((c): c is SceneIrChanges => c !== undefined);
      return parts.length === 0 ? undefined : (Object.assign({}, ...parts) as SceneIrChanges);
    },
  };
  let queued = false;
  const publish = (): void => {
    if (queued) return;
    queued = true;
    schedule(() => {
      queued = false;
      if (!scope.signal.aborted) options.publisher.step();
    });
  };
  const dirtyOverlay = (): void => {
    overlayDirty = true;
    publish();
  };
  scope.defer(document.view.onInvalidate(dirtyOverlay)); // content (and the page size) changed
  watch(() => [view.camera, view.selection] as const, publish, { scope });
  watch(() => [view.overlay, view.camera.zoom] as const, dirtyOverlay, { scope });

  // Distance labels: data for main (kit tags there), sent while there are labels and once to clear the last ones.
  let labelled = false;
  watch(
    () => [view.overlay.labels, view.camera] as const,
    ([labels, camera]) => {
      if (labels.length > 0 || labelled) options.onLabels?.(labels, camera);
      labelled = labels.length > 0;
    },
    { scope },
  );

  // Studio's toolbar drives the tab's tool.
  watch(
    () => options.tool(),
    (tool) => {
      if (tool !== undefined) view.setTool(tool);
    },
    { scope },
  );

  const creation = createCreationController({
    view,
    target: tools.target,
    actor: options.actor,
    newId: () => document.newId(),
    parent: () => view.context,
    onText: (node) => void tab.editText(node),
    onDone: () => options.selectTool?.('instaflow/select'),
  });

  // The selection frame follows selections made outside B3's controller (creation tools, HUD actions, panels,
  // accessibility focus, undo) and document changes (an inspector edit moves the frame); not during a gesture.
  const reframe = (): void => {
    if (controller.state === 'idle' && creation.state === 'idle') refreshOverlay(tools);
  };
  watch(() => view.selection, () => schedule(reframe), { scope });
  // Entering or leaving transform mode shows or hides the pivot and the thick frame.
  watch(() => mode.state, () => schedule(reframe), { scope });
  scope.defer(document.view.onInvalidate(() => schedule(reframe)));

  // B6: the editor side of the accessibility layer over the same pieces; snapshots go to main.
  const a11y = createCanvasA11yEditor({
    ctx,
    index,
    view,
    instances: document.view,
    text: partTextSource(part),
    announcer: options.announcer,
    timers: options.timers,
    gesture: controller,
    schedule: options.a11ySchedule ?? schedule,
    scope,
  });
  if (!a11y.ok) return a11y;
  const snapshots = options.onSnapshot;
  if (snapshots !== undefined) {
    scope.defer(a11y.value.projector.onChange(snapshots));
    const first = a11y.value.projector.snapshot();
    if (first.ok) snapshots(first.value);
  }

  const editText = (node: NodeId): Result<void> => {
    const host = options.textHost;
    if (host === undefined) return ok();
    editing?.stop();
    const started = startTextEditing({
      document,
      page,
      node,
      layer: text,
      fonts: options.fonts,
      host,
      camera: () => view.camera,
      actor: options.actor,
      isMac: options.isMac === true,
      onExit: (reason) => {
        editing = undefined;
        options.onEditing?.(undefined, reason);
        dirtyOverlay(); // the caret goes
      },
      ...(options.onProblem === undefined ? {} : { onProblem: options.onProblem }),
      scope,
    });
    if (!started.ok) return started;
    editing = started.value;
    // The caret and selection are drawn in the overlay: redraw it whenever the session's state changes.
    scope.defer(started.value.session.onChange(dirtyOverlay));
    dirtyOverlay();
    view.select([node]);
    options.onEditing?.(node);
    return ok();
  };
  // The host follows the text box when the camera moves.
  watch(() => view.camera, () => editing?.place(), { scope });

  const isText = (node: NodeId | undefined): boolean => node !== undefined && document.view.read(node)?.kind === TEXT_KIND;

  const deleteSelection = (): Result<void> => {
    const nodes = view.selection.filter((n) => document.view.read(n) !== undefined && !document.view.isDerived(n));
    if (nodes.length === 0) return ok();
    const ops: PartOp[] = nodes.map((node) => ({ op: 'delete', node }));
    const done = document.commitOps(page, options.actor(), nodes.length === 1 ? 'Delete' : `Delete ${nodes.length} elements`, ops);
    if (done.ok) view.clear();
    return done;
  };
  const duplicateSelection = (): Result<void> => {
    const nodes = view.selection.filter((n) => document.view.read(n) !== undefined && !document.view.isDerived(n));
    if (nodes.length === 0) return ok();
    const copied = duplicate(document.context(), nodes, DUPLICATE_OFFSET);
    if (!copied.ok) return copied;
    const done = commitEdit(tools.target, options.actor(), 'Duplicate', ok(copied.value.ops));
    if (done.ok) view.select(nodes.flatMap((n) => copied.value.copies.get(n) ?? []));
    return done;
  };
  const step = async (run: 'undo' | 'redo'): Promise<Result<void>> => {
    // Undo during a transform session cancels the session (nothing of it was written yet).
    if (mode.state === 'active') {
      const cancelled = mode.cancel();
      return cancelled.ok ? ok() : cancelled;
    }
    const outcome = await document.undo[run](options.actor(), scope.signal);
    return outcome.ok ? ok() : outcome;
  };

  if (options.shortcuts !== undefined) {
    const registry = options.shortcuts;
    const report = (r: Result<unknown>): void => {
      if (!r.ok) options.onProblem?.(r.error);
    };
    const bound = bindToolShortcuts(registry, commands, scope, report);
    if (!bound.ok) return bound;
    // While a transform session is active its scope (Enter applies, Escape cancels) shadows the canvas scope.
    let deactivate: (() => void) | undefined;
    watch(
      () => mode.state,
      (state) => {
        deactivate?.();
        deactivate = state === 'active' ? registry.activate(TransformModeShortcutScope, scope) : undefined;
      },
      { scope },
    );
    for (const [def, run] of [
      [UndoShortcut, () => void step('undo').then(report)],
      [RedoShortcut, () => void step('redo').then(report)],
      [DeleteShortcut, () => report(deleteSelection())],
      [DuplicateShortcut, () => report(duplicateSelection())],
    ] as const) {
      const registered = registry.register(def, run, { scope });
      if (!registered.ok) return registered;
    }
  }

  const routes = (): { pointer(e: ToolPointer): Result<ToolOutcome | CreateOutcome> } => (creation.handles(view.tool as ToolId) || creation.state !== 'idle' ? creation : controller);

  const fit = (): void => {
    const { w, h } = pageSize();
    void view.setCamera(fitCamera({ minX: 0, minY: 0, maxX: w, maxY: h }, view.viewport));
  };
  fit();
  // Attach last: the first snapshot carries the fitted camera and the first overlay.
  scope.defer(options.publisher.attach({ source, projector, ir, view: () => ({ camera: view.camera, selection: view.selection }) }));

  const tab: CanvasTab = {
    tab: options.tab,
    page,
    view,
    tools,
    controller,
    creation,
    commands,
    a11y: a11y.value,
    text,
    get editing() {
      return editing;
    },
    pointer(event) {
      // FIX-TEXT-FIRST-KEY item 2: while editing, presses in the text box place the caret and drags select (TEXT-FONTS
      // §3.2); a press anywhere else ends editing and goes on to the tools as before.
      const [px, py] = pagePoint(view, event);
      const textPointer = { phase: event.phase, x: px, y: py, ...(event.shift === undefined ? {} : { shift: event.shift }), ...(event.clicks === undefined ? {} : { clicks: event.clicks }) };
      if (editing !== undefined && editing.pointer(textPointer)) return ok({ kind: 'none' });
      if (event.phase === 'down' && editing !== undefined) editing.stop();
      if (event.phase === 'down' && (event.clicks ?? 1) >= 2) {
        const hit = hitTest(ctx, index, px, py, { tolerance: 3 / view.camera.zoom, context: view.context });
        const node = hit.ok ? hit.value?.target : undefined;
        if (node !== undefined && isText(node) && !creation.handles(view.tool as ToolId)) {
          const started = editText(node);
          // Edit mode with the caret at the click (TEXT-FONTS §3.1); a drag from here selects.
          if (started.ok) editing?.pointer({ ...textPointer, clicks: 1 });
          return started.ok ? ok({ kind: 'selection', selection: view.selection }) : started;
        }
      }
      const route = routes();
      // A release whose press went elsewhere (double click into text, focus moving into the canvas) is not an error.
      if (event.phase === 'up' && controller.state === 'idle' && creation.state === 'idle') return ok({ kind: 'none' });
      return route.pointer(event);
    },
    wheel: (event) => controller.wheel(event),
    editText,
    stopEditing: () => editing?.stop(),
    deleteSelection,
    duplicateSelection,
    undo: () => step('undo'),
    redo: () => step('redo'),
    fit,
    publish,
  };
  return ok(tab);
}

const pagePoint = (view: ViewState, e: { readonly x: number; readonly y: number }): [number, number] => [(e.x - view.camera.tx) / view.camera.zoom, (e.y - view.camera.ty) / view.camera.zoom];
