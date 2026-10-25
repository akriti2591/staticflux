/**
 * The per-tab tool session on Studio's live canvas (B8; IF-27.5–27.13): everything one tab needs to draw, select,
 * snap, type and be read by assistive technology, wired over one open page.
 *
 * - **B3**: the tab's view state, the element index over B7's repeat view, the `ToolSession`, the pointer
 *   controller (select, marquee, handles, smart guides and snapping, hand), the keyboard commands and shortcuts
 *   (`CanvasToolsShortcutScope`, active while the canvas surface has focus and no text is being edited), and the
 *   **overlay** (`toolOverlayBatch`, non-printing) drawn on its own raster above the content, with the distance
 *   labels as kit tags (`guideLabelTemplate`).
 * - **Creation tools** (`creation.ts`): Shape, Frame and Text; pointer events go to the controller that handles
 *   the active tool (a lookup, never a mode branch).
 * - **B2**: the text layer on the canvas pipeline's IR section, and one editing session at a time
 *   (`text-editing.ts`); double click on a text element edits it.
 * - **B6**: `createCanvasA11y` over the same index, view and repeat view: the virtualized DOM projection, the focus
 *   path and polite announcements follow the canvas.
 * - **A7 / B1 / B7**: the canvas pipeline (`canvas-pipeline.ts`) publishes on stage invalidations and view changes.
 *
 * Undo / redo (`Mod+Z`, `Mod+Shift+Z`) and Delete are canvas shortcuts too (one undo step each). Everything is
 * disposed with the tab scope (rule 5).
 */
import { type Announcer, defineShortcut, type ShortcutRegistry, type Timers } from '@staticflux/a11y';
import { err, ok, type Result, type Scope, type SfError, watch } from '@staticflux/core';
import { createRenderProjector } from '@staticflux/document/render-projection';
import type { NodeId, PartOp } from '@staticflux/document/v2';
import type { Actor } from '@staticflux/stage';
import type { TextInput } from '@staticflux/surface/text-input';
import { render as renderLit } from 'lit';
import { type CanvasA11y, createCanvasA11y } from '../a11y/canvas-a11y.js';
import { partTextSource } from '../a11y/text-source.js';
import { commitEdit, duplicate } from '../elements/actions.js';
import { createElementRenderSource, ElementProjection } from '../elements/projection.js';
import type { ToolId } from '../spec/contributions.js';
import { STRUCTURE_PATHS } from '../lenses/structure.js';
import type { RenderPacing } from '../sequencing/pacing.js';
import { colorToRgba } from '../elements/values.js';
import { cleanPopTheme } from '../theme/clean-pop.js';
import { TEXT_KIND } from '../text/model.js';
import { createToolController, refreshOverlay, type ToolController, type ToolOutcome, type ToolPointer, type ToolSession } from '../tools/gesture.js';
import { createElementIndex, hitTest } from '../tools/hit-test.js';
import { bindToolShortcuts, CanvasToolsShortcutScope, createToolCommands, type ToolCommands } from '../tools/keyboard.js';
import { createSceneWriter } from '../render/scene-ir.js';
import { toolOverlayBatch } from '../tools/overlay.js';
import { guideLabelTemplate } from '../tools/overlay-labels.js';
import { createViewState, fitCamera, type TabId, type ViewState } from '../tools/view-state.js';
import { type CanvasPipeline, createElementSceneSide, type SceneIrSource, startCanvasPipeline } from './canvas-pipeline.js';
import type { ImageUploads } from './images.js';
import { type CreateOutcome, createCreationController, type CreationController } from './creation.js';
import type { StudioDocument } from './document.js';
import { type CanvasRaster, createElementRenderPort } from './element-port.js';
import { NoOpenPageError } from './errors.js';
import { startTextEditing, type TextEditing } from './text-editing.js';
import { createTextLayer, type StudioFonts, type TextLayer } from './text-layer.js';

export interface CanvasTabOptions {
  readonly tab: TabId;
  readonly document: StudioDocument;
  readonly page: NodeId;
  readonly fonts: StudioFonts;
  /** The canvas surface element (pointer target; the accessibility layer and the text host live inside it). */
  readonly surface: HTMLElement;
  /** Content raster (the page) and the overlay raster above it (B3's non-printing overlay). */
  readonly raster: CanvasRaster;
  readonly overlay: CanvasRaster;
  /** Where the distance labels go (positioned over the canvas). */
  readonly labels?: HTMLElement;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly actor: () => Actor;
  /** Studio's picked tool (reactive). */
  readonly tool: () => ToolId | undefined;
  /** Hand the toolbar back (after a creation tool placed its element). */
  readonly selectTool?: (tool: ToolId) => void;
  readonly shortcuts?: ShortcutRegistry;
  /** The bound `TextInputFactory` (text editing is off without it). */
  readonly textInput?: (host: HTMLElement, label: string) => Result<TextInput>;
  readonly announcer: Pick<Announcer, 'announce'>;
  readonly timers: Timers;
  /** Coalesces publishes and projection flushes (default microtask; `requestAnimationFrame` in a browser). */
  readonly schedule?: (fn: () => void) => void;
  readonly pacing?: RenderPacing;
  /** Image uploads (library Place): their asset section and the encoder's image lookup. */
  readonly images?: Pick<ImageUploads, 'changes' | 'images'>;
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
  readonly a11y: CanvasA11y;
  readonly pipeline: CanvasPipeline;
  readonly text: TextLayer;
  /** The text being edited (reactive only through `onChange`). */
  readonly editing: TextEditing | undefined;
  /** Pointer input in surface pixels (the DOM wiring and tests call it). */
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
}

const Undo = /* @__PURE__ */ defineShortcut({ id: 'instaflow/undo', keys: ['Mod+Z'], scope: CanvasToolsShortcutScope, description: 'Undo' });
const Redo = /* @__PURE__ */ defineShortcut({ id: 'instaflow/redo', keys: ['Mod+Shift+Z'], scope: CanvasToolsShortcutScope, description: 'Redo' });
const Delete = /* @__PURE__ */ defineShortcut({ id: 'instaflow/delete', keys: ['Delete', 'Backspace'], scope: CanvasToolsShortcutScope, description: 'Delete the selection' });
const Duplicate = /* @__PURE__ */ defineShortcut({ id: 'instaflow/duplicate', keys: ['Mod+D'], scope: CanvasToolsShortcutScope, description: 'Duplicate the selection' });

/** Where a duplicate lands, relative to its source (page units). */
export const DUPLICATE_OFFSET: readonly [number, number] = [24, 24];

const microtask = (fn: () => void): void => queueMicrotask(fn);

/** Overlay scene ids (above B1's even element ids and the text layer's odd ids). */
export const OVERLAY_FIRST_ID = 0x4000_0001;

/** The page edge colour (Clean Pop `border`). */
const PAGE_EDGE = /* @__PURE__ */ colorToRgba(String(cleanPopTheme.values.color['border'])) ?? [0, 0, 0, 40];

const chain = (first: Result<void>, next: () => Result<void>): Result<void> => (first.ok ? next() : first);

/** Open the tool session of one tab on one page (see the module header). */
export async function openCanvasTab(options: CanvasTabOptions): Promise<Result<CanvasTab>> {
  const { document, page, scope } = options;
  const part = document.part(page);
  if (part === undefined) return err(NoOpenPageError({ details: { page } }));
  const schedule = options.schedule ?? microtask;
  const ctx = { stage: document.view, geometry: document.geometry, kit: document.kit };
  const index = createElementIndex(ctx, page, scope);
  const view = createViewState({ tab: options.tab, root: page, viewport: options.viewport, tool: options.tool() ?? 'instaflow/select' });
  const tools: ToolSession = { ctx, target: document.target(page), session: document.session, index, view, actor: options.actor };
  const controller = createToolController(tools);
  const commands = createToolCommands(tools);
  let editing: TextEditing | undefined;

  // Canvas pipeline: B1's source over the repeat view, B2's text on the IR section.
  const source = createElementRenderSource({ stage: document.view, geometry: document.geometry, kit: document.kit, root: page, orderOf: (id) => part.node(id)?.order });
  scope.defer(() => source.dispose());
  const projector = createRenderProjector(ElementProjection, source);
  const text = createTextLayer({ document, page, fonts: options.fonts, scope });
  const side = createElementSceneSide();
  const port = createElementRenderPort({ side, raster: options.raster, ...(options.images === undefined ? {} : { images: options.images.images }) });
  const images = options.images;
  const ir: SceneIrSource = {
    changes(full) {
      const uploads = images?.changes(full);
      const glyphs = text.changes(full);
      return uploads === undefined && glyphs === undefined ? undefined : { ...uploads, ...glyphs };
    },
  };
  const pipeline = await startCanvasPipeline({ source, projector, ir, side, port, view: () => ({ camera: view.camera, selection: view.selection }), signal: scope.signal, ...(options.pacing === undefined ? {} : { pacing: options.pacing }) });
  if (!pipeline.ok) return pipeline;
  scope.defer(() => pipeline.value.stop());
  let queued = false;
  const publish = (): void => {
    if (queued) return;
    queued = true;
    schedule(() => {
      queued = false;
      pipeline.value.publish();
    });
  };
  scope.defer(document.view.onInvalidate(publish));
  watch(() => [view.camera, view.selection] as const, publish, { scope });
  // The selection frame follows selections made outside B3's controller (creation tools, HUD actions, panels,
  // accessibility focus, undo) and document changes (an inspector edit moves the frame); not during a gesture.
  const reframe = (): void => {
    if (controller.state === 'idle' && creation.state === 'idle') refreshOverlay(tools);
  };
  watch(() => view.selection, () => schedule(reframe), { scope });
  scope.defer(document.view.onInvalidate(() => schedule(reframe)));

  function pageSize(): { readonly w: number; readonly h: number } {
    const size = part?.prop(page, STRUCTURE_PATHS.pageSize) as { width?: number; height?: number } | undefined;
    return { w: typeof size?.width === 'number' ? size.width : 1080, h: typeof size?.height === 'number' ? size.height : 1350 };
  }

  // Overlay (B3): redrawn when the overlay or the camera changes, into the overlay raster's scene (the content
  // raster in the browser: the canvas is opaque) under ids of its own; labels as kit tags.
  let overlayIds: number[] = [];
  let labelled = false;
  const drawOverlay = (): void => {
    const removed = createSceneWriter();
    for (const id of overlayIds) removed.remove(id);
    overlayIds = [];
    // The page edge (the page itself is the raster background), then B3's overlay.
    const size = pageSize();
    const edge = createSceneWriter().upsert({
      id: OVERLAY_FIRST_ID - 2,
      transform: [1, 0, 0, 1, 0, 0],
      geometry: { kind: 'rect', w: size.w, h: size.h },
      stroke: { width: 1 / view.camera.zoom, paint: { kind: 'solid', color: PAGE_EDGE } },
    });
    overlayIds.push(OVERLAY_FIRST_ID - 2);
    const batch = toolOverlayBatch(view.overlay, view.camera.zoom, { clear: false, firstId: OVERLAY_FIRST_ID, ids: overlayIds });
    const applied = chain(removed.ops === 0 ? ok() : options.overlay.apply(removed.finish()), () => chain(options.overlay.apply(edge.finish()), () => options.overlay.apply(batch)));
    if (!applied.ok) return options.onProblem?.(applied.error);
    options.overlay.setCamera(view.camera);
    const presented = options.overlay.present();
    if (!presented.ok) options.onProblem?.(presented.error);
    // Distance labels as kit tags (rendered only while there are labels, or to clear the last ones).
    const labels = view.overlay.labels;
    if (options.labels !== undefined && (labels.length > 0 || labelled)) renderLit(guideLabelTemplate(labels, view.camera), options.labels);
    labelled = labels.length > 0;
  };
  watch(() => [view.overlay, view.camera] as const, () => schedule(drawOverlay), { scope, fireImmediately: true });
  scope.defer(() => options.overlay.dispose());

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

  // B6: the accessibility layer over the same pieces.
  const a11y = createCanvasA11y({
    ctx,
    index,
    view,
    instances: document.view,
    text: partTextSource(part),
    host: options.surface,
    document: options.surface.ownerDocument,
    announcer: options.announcer,
    timers: options.timers,
    gesture: controller,
    schedule,
    scope,
  });
  if (!a11y.ok) return a11y;

  const editText = (node: NodeId): Result<void> => {
    if (options.textInput === undefined) return ok();
    editing?.stop();
    const started = startTextEditing({
      document,
      page,
      node,
      layer: text,
      fonts: options.fonts,
      input: options.textInput,
      surface: options.surface,
      camera: () => view.camera,
      actor: options.actor,
      onExit: (reason) => {
        editing = undefined;
        a11y.value.mount.layer.element(node)?.removeAttribute('aria-hidden');
        publish();
        if (reason !== 'stopped') options.surface.focus();
      },
      ...(options.onProblem === undefined ? {} : { onProblem: options.onProblem }),
      scope,
    });
    if (!started.ok) return started;
    editing = started.value;
    view.select([node]);
    // B6: while editing, the TextInput host is the element's `textbox`; its projected node steps aside.
    a11y.value.mount.layer.element(node)?.setAttribute('aria-hidden', 'true');
    return ok();
  };

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
    for (const [def, run] of [
      [Undo, () => void step('undo').then(report)],
      [Redo, () => void step('redo').then(report)],
      [Delete, () => report(deleteSelection())],
      [Duplicate, () => report(duplicateSelection())],
    ] as const) {
      const registered = registry.register(def, run, { scope });
      if (!registered.ok) return registered;
    }
    // Canvas shortcuts are live while the surface (or a node of its accessibility layer) has focus, never while
    // text is being edited: the text host owns its keys then.
    let deactivate: (() => void) | undefined;
    const sync = (): void => {
      const active = options.surface.ownerDocument.activeElement;
      const inside = active !== null && options.surface.contains(active) && active !== editing?.host;
      if (inside && deactivate === undefined) deactivate = registry.activate(CanvasToolsShortcutScope, scope);
      if (!inside && deactivate !== undefined) {
        deactivate();
        deactivate = undefined;
      }
    };
    const listening = { signal: scope.signal };
    options.surface.addEventListener('focusin', () => schedule(sync), listening);
    options.surface.addEventListener('focusout', () => schedule(sync), listening);
  }

  const routes = (): { pointer(e: ToolPointer): Result<ToolOutcome | CreateOutcome> } => (creation.handles(view.tool as ToolId) || creation.state !== 'idle' ? creation : controller);

  const fit = (): void => {
    const { w, h } = pageSize();
    void view.setCamera(fitCamera({ minX: 0, minY: 0, maxX: w, maxY: h }, view.viewport));
  };
  fit();

  const tab: CanvasTab = {
    tab: options.tab,
    page,
    view,
    tools,
    controller,
    creation,
    commands,
    a11y: a11y.value,
    pipeline: pipeline.value,
    text,
    get editing() {
      return editing;
    },
    pointer(event) {
      if (event.phase === 'down' && editing !== undefined) editing.stop();
      if (event.phase === 'down' && (event.clicks ?? 1) >= 2) {
        const hit = hitTest(ctx, index, ...pagePoint(view, event), { tolerance: 3 / view.camera.zoom, context: view.context });
        const node = hit.ok ? hit.value?.target : undefined;
        if (node !== undefined && isText(node) && !creation.handles(view.tool as ToolId)) {
          const started = editText(node);
          return started.ok ? ok({ kind: 'selection', selection: view.selection }) : started;
        }
      }
      return routes().pointer(event);
    },
    wheel: (event) => controller.wheel(event),
    editText,
    stopEditing: () => editing?.stop(),
    deleteSelection,
    duplicateSelection,
    undo: () => step('undo'),
    redo: () => step('redo'),
    fit,
  };
  return ok(tab);
}

const pagePoint = (view: ViewState, e: { readonly x: number; readonly y: number }): [number, number] => [(e.x - view.camera.tx) / view.camera.zoom, (e.y - view.camera.ty) / view.camera.zoom];
