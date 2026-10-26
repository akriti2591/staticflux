/**
 * The Studio app (B8; IF-27.14–27.24; B9 IF-33.1–33.16): the composition root on the main thread. Wire, don't
 * rebuild: everything here is glue. The editor and render modules run in their workers (D15, `../workers/`); main
 * keeps the page-side adapters, the chrome and the store side.
 *
 * - **Workers** (`bootStudioWorkers`): one by default, two by the boot setting; the editor opens (or creates) the
 *   document over the store port.
 * - **Store side** (the store-worker stand-in until C0): the workspace's store, blobs and library document, served to
 *   the editor; B4's library services and Assets panel model run here.
 * - **Vocabulary** (`registries.ts`): B0's placeholders replaced by the real contributions; panels that take their
 *   model from the host are bound when they render (B1's Fill / stroke / effects, B7's Repeat).
 * - **Panel models** over the editor's mirrors (`panel-mirrors.ts`): B2 typography, B5 Latest and milestones, B4 story;
 *   B4's lens controller runs here over the mirrored structure (it only picks the page the canvas shows).
 * - **Capabilities** (one pipeline for HUD, shortcuts and agents): validated and gated in the registry here, run by the
 *   editor (forwarding implementations for exactly the ids the editor reported).
 * - **Canvas** (`studio-canvas.ts`): the canvas handed to the render module, input into the ring, B6's DOM, the text
 *   host.
 * - **Glue**: Studio's scope follows the canvas selection (the view projection); HUD clicks run their capability on the
 *   selection; the Milestone button; zoom buttons and readout; the library's Place; results and problems are
 *   announced politely.
 */
import { type Announcer, createAnnouncer, createShortcutRegistry, defineShortcut, type ShortcutRegistry, type Timers } from '@staticflux/a11y';
import { alwaysActivePort, allowAllDecidePort, type AnyCapability, type CapabilityRegistry, createCapabilityRegistry, failClosedConfirmPort, implementCapability, unmeteredPort } from '@staticflux/capabilities';
import { box, createInjector, err, type Injector, ok, type Result, type Scope, type SfError, unit, watch } from '@staticflux/core';
import type { NodeId } from '@staticflux/document/v2';
import { createGate, definePolicy, definePolicySet } from '@staticflux/gate';
import type { Actor } from '@staticflux/stage';
import type { TextInputFactory } from '@staticflux/surface/text-input';
import { allowAllDecideUnit, defineUiElements, gateResource, provideScope, visibilityObserverUnit } from '@staticflux/ui';
import { defineDialogSurface } from '@staticflux/kit/surface-defs';
import { defineSurfaces } from '@staticflux/kit/surfaces';
import { ownerOf, SurfaceManagerToken, type SurfaceManager } from '@staticflux/messaging';
import { fromWireError, type Spawner } from '@staticflux/worker';
import { html, render } from 'lit';
import { ref } from 'lit/directives/ref.js';
import { APPEARANCE_PANEL_ID } from '../elements/contributions.js';
import { ExportCapability, ExportShortcut, implementExport } from '../export/capability.js';
import { DEFAULT_EXPORT_OPTIONS, type ExportFile, type ExportOptions } from '../export/formats.js';
import { bindExportPanel, defineExportPanel, EXPORT_PANEL_ID, type IfExportPanelElement } from '../export/panel.js';
import { browserDownload, createExportService, type ExportService } from '../export/service.js';
import { bindPaintInspector, definePaintInspector, type IfPaintInspectorElement } from '../elements/panel.js';
import { canvasLensFeature } from '../lenses/canvas-lens.js';
import { createLensController, type LensController } from '../lenses/controller.js';
import { createLensFeatureRegistry } from '../lenses/lens-features.js';
import { pagesLensFeature } from '../lenses/pages-lens.js';
import { LensControllerToken, StoryWriterToken } from '../lenses/tokens.js';
import type { Library } from '../library/library.js';
import type { LibraryEntry } from '../library/library-doc.js';
import { browserObjectUrls, browserPickFiles, type LibraryHost } from '../library/panel-model.js';
import type { ImageDecoder, ImageEncoder, ThumbnailRenderer } from '../library/renditions.js';
import { browserImageDecoder, pngImageEncoder, scaleThumbnailRenderer } from '../library/thumbnails.js';
import { LibraryPanelModelToken } from '../library/tokens.js';
import { createLibraryServices } from '../library/units.js';
import { REPEAT_PANEL_ID } from '../repeat/contributions.js';
import { bindRepeatInspector, defineRepeatInspector, type IfRepeatInspectorElement } from '../repeat/panel.js';
import { editDocumentCapability, proposeSpecCapability } from '../spec/capabilities.js';
import { StudioIds } from '../spec/studio-ids.js';
import type { ActionId, PanelContribution, ToolId } from '../spec/contributions.js';
import { gateSpecDecide } from '../spec/gate.js';
import type { EditorRegistries } from '../spec/registries.js';
import type { ScopeRef } from '../spec/schema.js';
import { createStudio, type Studio, StudioShortcutScope } from '../studio/studio.js';
import { type CameraAction, defineStudio, EMPTY_CHROME, type IfStudioElement, type StudioChromeModel, type StudioChromePort } from '../studio/studio-element.js';
import type { HudAction } from '../studio/hud.js';
import type { LayerRow } from './scene-summary.js';
import { createToasts, INSTAFLOW_SURFACE_UNITS, type Toasts } from './feedback.js';
import { DeleteCapability, STUDIO_KEY_COMMANDS, UndoCapability } from './studio-commands.js';
import { ELEMENT_ACTIONS, elementActionId } from '../elements/capabilities.js';
import { TEXT_HUD_COMMANDS } from '../text/commands.js';
import { TOOL_HUD_COMMANDS } from '../tools/contributions.js';
import { bindTransformBar, defineTransformBar, type IfTransformBarElement } from '../tools/transform-bar.js';
import { type TypographyService, TypographyServiceToken } from '../text/typography.js';
import { defineTypographyPanel } from '../text/typography-panel.js';
import type { Camera } from '../tools/view-state.js';
import { CreateMilestoneCapability } from '../versioning/command.js';
import type { MilestoneId } from '../versioning/records.js';
import { SaveAsTemplateCapability } from '../workspace/templates.js';
import { TemplateSourceError } from '../home/errors.js';
import { defineSaveStatus } from '../versioning/save-status.js';
import { LatestServiceToken, MilestonesPanelModelToken } from '../versioning/tokens.js';
import { type BootStudioWorkersOptions, bootStudioWorkers, type StudioWorkers } from '../workers/boot.js';
import { createMirrorHub, type MirrorHub } from '../workers/mirror.js';
import { AppearanceMirror, LatestMirror, MilestonesMirror, RepeatMirror, SceneMirror, StoryMirror, TransformMirror, TypographyMirror } from '../workers/mirrors.js';
import type { InspectedElement, StudioDocumentRef, StudioInspection, StudioMetrics, ViewProjection } from '../workers/protocol.js';
import { fromWire } from '../workers/wire.js';
import type { StudioWorkspace } from './document.js';
import { NoOpenPageError } from './errors.js';
import { appearanceSource, latestFromMirror, milestonesFromMirror, repeatSource, storyFromMirror, structureFromMirror, transformSource, typographyFromMirror } from './panel-mirrors.js';
import { studioAppRegistries } from './registries.js';
import { type CanvasHandoffFactory, type StudioCanvas, studioCanvas } from './studio-canvas.js';

export interface StudioAppOptions {
  /** The store side: store, blobs and the library document (main, until the store worker, C0). */
  readonly workspace: Pick<StudioWorkspace, 'store' | 'blobs' | 'library'>;
  /** The document the editor opens (created when the store has none and `create` is given). */
  readonly document: StudioDocumentRef;
  /** The person (guest identity, D3). */
  readonly person: Actor;
  /** How the workers boot: the topology setting, the spawner, isolation, the Wasm and fonts to load. */
  readonly workers: Omit<BootStudioWorkersOptions, 'editor' | 'store' | 'signal'>;
  readonly textInput?: TextInputFactory;
  /** Library media (browser defaults). */
  readonly library?: { readonly decoder?: ImageDecoder; readonly renderer?: ThumbnailRenderer; readonly encoder?: ImageEncoder; readonly pickFiles?: LibraryHost['pickFiles'] };
  /** How the canvas reaches the render module (default an `OffscreenCanvas` transfer; tests pass a stand-in). */
  readonly handoff?: CanvasHandoffFactory;
  readonly timers?: Timers;
  readonly isMac?: boolean;
  /** Where the top bar's Home link goes (C0; default `/`). */
  readonly homeHref?: string;
  /** Leave Studio for `href` once Latest is flushed (C0: the Home link). Default: `location.assign`. */
  readonly leave?: (href: string) => Promise<void> | void;
  /**
   * C1: the export worker (spawned per export) and where files go (default: the browser's download). Without it the
   * Export panel says exports are unavailable here.
   */
  readonly exporter?: { readonly spawn: () => Spawner; readonly deliver?: (files: readonly ExportFile[], signal: AbortSignal) => Promise<Result<void>> };
  /** "Save as template" (C0): make a template from a milestone of the open design. Without it the action says so. */
  readonly templates?: { save(request: { readonly milestone: MilestoneId; readonly title: string }, signal: AbortSignal): Promise<Result<{ readonly asset: string }>> };
  readonly scope: Scope;
}

/** The open tab as main sees it (the editor's view projection). */
export interface StudioTabView {
  readonly page: NodeId;
  readonly view: { readonly selection: readonly NodeId[]; readonly tool: string; readonly camera: Camera; readonly viewport: { readonly width: number; readonly height: number }; readonly context: NodeId | undefined };
  readonly editing: { readonly node: NodeId } | undefined;
}

export interface StudioApp {
  readonly studio: Studio;
  readonly registries: EditorRegistries;
  readonly capabilities: CapabilityRegistry;
  readonly canvas: StudioCanvas;
  readonly injector: Injector;
  readonly shortcuts: ShortcutRegistry;
  readonly lens: LensController;
  readonly typography: TypographyService;
  readonly workers: StudioWorkers;
  /** The workspace library (store side; C0 lists designs and templates in it). */
  readonly library: Library;
  /** Save Latest, then leave for `href` (what the Home link does). */
  leave(href: string): Promise<void>;
  /** Wait until every edit so far is durable in the workspace store (Latest flushed). */
  flush(): Promise<Result<void>>;
  /** "Save as template" (C0): one capability run; the title defaults to the design's. */
  saveAsTemplate(title?: string): Promise<Result<unknown>>;
  /** C1: the export service (undefined without an exporter). */
  readonly exports: ExportService | undefined;
  /** C1: export through the `instaflow/export` capability (what the Export panel's button does). */
  exportDesign(options: ExportOptions): Promise<Result<unknown>>;
  /** The mirrors the panels read (tests, devtools). */
  readonly mirrors: MirrorHub;
  /** The editor's view projection (reactive; undefined until the editor posts). */
  readonly view: ViewProjection | undefined;
  /** The open canvas tab (after the canvas started). */
  readonly tab: StudioTabView | undefined;
  /** Render `<if-studio>` into `container` (inside the UI scope). */
  mount(container: HTMLElement): IfStudioElement;
  /** Run a HUD action on the selection (what a HUD click does). */
  runHudAction(action: ActionId): Promise<Result<unknown>>;
  createMilestone(name?: string): Promise<Result<unknown>>;
  place(entry: LibraryEntry, signal: AbortSignal): Promise<Result<void>>;
  /** Read the editor's state (tests, the smoke check, devtools). */
  inspect(nodes?: readonly NodeId[]): Promise<Result<StudioInspection>>;
  /** One element as the editor sees it (undefined: not on the page). */
  element(node: NodeId): Promise<InspectedElement | undefined>;
  /** Frame metrics (A7) and editor counters of every worker. */
  metrics(): Promise<Result<StudioMetrics>>;
  /** Messages spoken in the polite live region (the last few; tests and the smoke check read them). */
  readonly spoken: readonly string[];
  /** B11b: the toasts port (feedback for non-local actions, OVERLAYS-FEEDBACK §3.5). */
  readonly toasts: Toasts;
  /** B11b: toast messages shown so far (the last few; tests and the smoke check read them). */
  readonly toasted: readonly string[];
  /** B11b: what the chrome runs (the HUD pill, the top bar, menus): also the smoke checks' handle. */
  readonly chrome: StudioChromePort;
  /** B11b: what the chrome shows (the selection summary, layers, page; tests and the smoke check read it). */
  readonly scene: StudioChromeModel & { readonly layers: readonly LayerRow[] };
}

/** HUD action → capability input from the selection (data; the default is `{ nodes }`). */
const HUD_INPUTS: Readonly<Record<string, (nodes: readonly NodeId[]) => unknown>> = Object.freeze({
  'instaflow/describe-canvas': (nodes: readonly NodeId[]) => ({ what: nodes.length > 0 ? 'selection' : 'visible' }),
});

/** Capability outputs the HUD speaks (`text`), else a short confirmation. */
const spokenResult = (label: string, value: unknown): string => (typeof (value as { text?: unknown })?.text === 'string' ? (value as { text: string }).text : `${label} done`);

let invocations = 0;

/** Open Studio over a document (see the module header). */
export async function createStudioApp(options: StudioAppOptions): Promise<Result<StudioApp>> {
  const { scope, workspace, person } = options;
  const signal = scope.signal;
  const spoken: string[] = [];
  let announcer: Pick<Announcer, 'announce'> = { announce: () => undefined };
  const say = (message: string): void => {
    spoken.push(message);
    if (spoken.length > 20) spoken.shift();
    announcer.announce(message);
  };
  const problem = (error: SfError): void => say(error.message);
  const timers: Timers = options.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  const actor = (): Actor => person;

  // ---------------------------------------------------------------- workers
  const booted = await bootStudioWorkers({
    ...options.workers,
    editor: { document: options.document, person, isMac: options.isMac ?? false, ...(options.textInput === undefined ? {} : { textInput: options.textInput.kind }) },
    store: { store: workspace.store, blobs: workspace.blobs },
    signal,
  });
  if (!booted.ok) return booted;
  const workers = booted.value;
  scope.defer(() => workers.stop());
  const editor = workers.editor;
  const hub = createMirrorHub((call) => editor.request('call', call));
  scope.defer(editor.on('mirror', (update) => hub.apply(update)));
  const viewBox = box<ViewProjection | undefined>(undefined);
  scope.defer(editor.on('view', (projection) => viewBox.set(projection)));
  scope.defer(editor.on('announce', ({ message }) => say(message)));
  scope.defer(editor.on('problem', ({ error }) => problem(fromWireError(error))));
  const synced = await editor.request('sync', undefined); // the editor posted before these listeners existed
  if (!synced.ok) return synced;
  const view = (): ViewProjection | undefined => viewBox.get();
  const selection = (): readonly NodeId[] => view()?.selection ?? [];
  const pages = workers.started.pages;
  const firstPage = (): NodeId => pages[0] ?? 'p1';

  // ---------------------------------------------------------------- panel sources
  const appearance = appearanceSource(hub.view(AppearanceMirror), problem);
  const repeat = repeatSource(hub.view(RepeatMirror), problem);
  const transformBar = transformSource(hub.view(TransformMirror), problem);
  // C1: the export service exists once the library does (below); the panel reads it through this port.
  let exportsService: ExportService | undefined;
  let lastExport: ExportOptions | undefined;
  const exportPort = {
    status: () => exportsService?.status ?? { kind: 'failed' as const, options: { format: 'png' as const, scale: 2 as const, transparent: false, scope: 'page' as const }, message: 'Export is not available here.', code: 'IF-EXP-007' },
    subscribe: (listener: () => void) => exportsService?.onChange(listener) ?? (() => undefined),
    run: (o: ExportOptions) => void app.exportDesign(o),
    cancel: () => exportsService?.cancel(),
  };
  const BINDERS: Readonly<Record<string, (element: Element) => () => void>> = {
    [EXPORT_PANEL_ID]: (element) => bindExportPanel(element as IfExportPanelElement, exportPort),
    [StudioIds.panel.transform]: (element) => bindTransformBar(element as IfTransformBarElement, transformBar),
    [APPEARANCE_PANEL_ID]: (element) => bindPaintInspector(element as IfPaintInspectorElement, appearance),
    [REPEAT_PANEL_ID]: (element) => bindRepeatInspector(element as IfRepeatInspectorElement, repeat),
  };
  /** Panels whose element takes its model from the host: rendered inside a wrapper whose first child gets bound. */
  const bindPanel = (panel: PanelContribution): PanelContribution => {
    const binder = BINDERS[panel.id];
    if (binder === undefined) return panel;
    let unbind: (() => void) | undefined;
    const bound = ref((element) => {
      unbind?.();
      unbind = undefined;
      // The wrapper's content renders after its element part: bind once it is there.
      if (element !== undefined)
        queueMicrotask(() => {
          const target = element.firstElementChild;
          if (target !== null && unbind === undefined) unbind = binder(target);
        });
    });
    return { ...panel, render: (context) => html`<div ${bound}>${panel.render(context)}</div>` };
  };
  const registries = studioAppRegistries(bindPanel);
  if (!registries.ok) return registries;

  // ---------------------------------------------------------------- services for the panels
  const typography = typographyFromMirror(hub.view(TypographyMirror), problem);
  const features = createLensFeatureRegistry([pagesLensFeature, canvasLensFeature]);
  if (!features.ok) return features;
  const studioBox = box<Studio | undefined>(undefined);
  const storyView = hub.view(StoryMirror);
  const lens = createLensController({
    features: features.value,
    lens: () => studioBox.get()?.lens?.id,
    structure: structureFromMirror(storyView),
    viewport: () => view()?.viewport ?? { width: 960, height: 640 },
    camera: { show: () => undefined },
  });
  scope.defer(() => lens.dispose());
  const story = storyFromMirror(storyView, problem);
  let assetCount = 0;
  const library = createLibraryServices(
    {
      document: workspace.library,
      blobs: workspace.blobs,
      actor,
      newAssetId: () => `as_${Date.now().toString(36)}${(assetCount += 1)}` as never,
      host: { pickFiles: options.library?.pickFiles ?? ((s) => browserPickFiles(s)), place: (entry, s) => app.place(entry, s) },
      decoder: options.library?.decoder ?? browserImageDecoder(),
      renderer: options.library?.renderer ?? scaleThumbnailRenderer(),
      encoder: options.library?.encoder ?? pngImageEncoder(),
      urls: browserObjectUrls,
    },
    scope,
  );
  const assets = options.workers.assets;
  if (options.exporter !== undefined && assets !== undefined) {
    const exporter = options.exporter;
    exportsService = createExportService({
      spawn: exporter.spawn,
      assets,
      store: { store: workspace.store, blobs: workspace.blobs },
      target: async (s) => {
        const t = await editor.request('exportTarget', undefined, { signal: s });
        return t.ok ? ok(t.value) : t;
      },
      title: () => options.document.title,
      images: () => library.library.entries().filter((e) => e.kind === 'image' && e.content !== undefined && e.trashedAt === undefined),
      deliver: exporter.deliver ?? ((files) => browserDownload(files)),
    });
    scope.defer(() => exportsService?.dispose());
  }
  const milestonesPanel = milestonesFromMirror(hub.view(MilestonesMirror));
  const latest = latestFromMirror(hub.view(LatestMirror));
  const injector = createInjector({
    units: [
      // B11b: messaging under the strict overlay policy (toasts, the Export dialog), OVERLAYS-FEEDBACK §1.
      visibilityObserverUnit,
      allowAllDecideUnit,
      ...INSTAFLOW_SURFACE_UNITS,
      unit({ id: 'instaflow/studio-typography', provides: TypographyServiceToken, scope: 'app', create: () => typography }),
      unit({ id: 'instaflow/studio-lens-controller', provides: LensControllerToken, scope: 'app', create: () => lens }),
      unit({ id: 'instaflow/studio-story-writer', provides: StoryWriterToken, scope: 'app', create: () => story }),
      unit({ id: 'instaflow/studio-library-panel', provides: LibraryPanelModelToken, scope: 'app', create: () => library.panel }),
      unit({ id: 'instaflow/studio-milestones-panel', provides: MilestonesPanelModelToken, scope: 'app', create: () => milestonesPanel }),
      unit({ id: 'instaflow/studio-latest', provides: LatestServiceToken, scope: 'app', create: () => latest }),
    ],
    idle: (cb) => setTimeout(cb, 0),
  });
  scope.defer(() => injector.dispose());
  const managed = await injector.get(SurfaceManagerToken);
  if (!managed.ok) return managed;
  const manager: SurfaceManager = managed.value;
  const toasted: string[] = [];
  const baseToasts = createToasts(manager, ownerOf(injector));
  const record = (message: string): void => {
    toasted.push(message);
    if (toasted.length > 20) toasted.shift();
  };
  const toasts: Toasts = {
    show: (r) => {
      record(r.message);
      return baseToasts.show(r);
    },
    undoable: (r) => {
      record(r.message);
      return baseToasts.undoable(r);
    },
    error: (e, run, copy) => {
      record(e.message);
      return baseToasts.error(e, run, copy);
    },
    undoNewest: () => baseToasts.undoNewest(),
  };

  // ---------------------------------------------------------------- capabilities (run in the editor)
  const served = new Set(workers.started.capabilities);
  const declarations = registries.value.vocabulary.list('capability').flatMap((c) => {
    const cap = registries.value.capability(c.id);
    return cap === undefined ? [] : [cap];
  });
  const forward = (cap: AnyCapability) =>
    implementCapability(cap, async (input, run) => {
      const out = await editor.request('invoke', { capability: cap.id, input, subject: run.subject, ...(run.origin === undefined ? {} : { origin: run.origin }), invocationId: `${run.invocationId}:${(invocations += 1)}` }, { signal: run.signal });
      return out.ok ? ok(fromWire(out.value)) : out;
    });
  // C0: "Save as template" runs on main (it needs the store side): a milestone through the editor, then the template.
  const templates = options.templates;
  const saveTemplate =
    templates === undefined
      ? []
      : [
          implementCapability(SaveAsTemplateCapability, async (input, run) => {
            const title = input.title?.trim() || options.document.title;
            const made = await capabilities.invoke(CreateMilestoneCapability, { name: `Template · ${title}` }, { subject: run.subject, signal: run.signal, ...(run.origin === undefined ? {} : { origin: run.origin }) });
            if (!made.ok) return made;
            const milestone = (made.value as { id?: string }).id as MilestoneId | undefined;
            if (milestone === undefined) return err(TemplateSourceError({ details: { template: null, milestone: null } }));
            const saved = await templates.save({ milestone, title }, run.signal);
            return saved.ok ? ok({ template: saved.value.asset, milestone, title }) : saved;
          }),
        ];
  const capabilities = createCapabilityRegistry({
    decide: allowAllDecidePort,
    confirm: failClosedConfirmPort,
    meter: unmeteredPort,
    activation: alwaysActivePort,
    declarations: [...declarations, ...(templates === undefined ? [] : [SaveAsTemplateCapability])],
    implementations: [...declarations.filter((cap) => served.has(cap.id)).map(forward), ...saveTemplate, ...(exportsService === undefined ? [] : [implementExport(exportsService)])],
  });
  scope.defer(() => capabilities.dispose());

  // ---------------------------------------------------------------- Studio
  const gate = createGate({
    sources: [],
    policySets: [
      definePolicySet('instaflow/studio-policies', [
        definePolicy({ id: 'instaflow/agent-propose', subjects: ['agent'], resource: gateResource('capability', proposeSpecCapability.id) }),
        definePolicy({ id: 'instaflow/agent-edit', subjects: ['agent'], resource: gateResource('capability', editDocumentCapability.id) }),
      ]),
    ],
  });
  const studio = createStudio({ registries: registries.value, decideFor: (s) => gateSpecDecide(gate, s) });
  studioBox.set(studio);
  scope.defer(() => studio.dispose());
  const shortcuts = createShortcutRegistry({ isMac: options.isMac ?? false });

  const canvas = studioCanvas({
    workers,
    page: firstPage,
    ...(options.textInput === undefined ? {} : { textInput: (host: HTMLElement, label: string) => (options.textInput as TextInputFactory).create({ host, label }) }),
    shortcuts,
    ...(options.handoff === undefined ? {} : { handoff: options.handoff }),
    onProblem: problem,
  });
  // The toolbar drives the editor's tool; a creation tool hands the toolbar back.
  watch(
    () => studio.activeTool,
    (tool) => {
      if (tool !== undefined) void editor.request('tool', { tool }).then((r) => (r.ok ? undefined : problem(r.error)));
    },
    { scope, fireImmediately: true },
  );
  scope.defer(editor.on('tool', ({ tool }) => void studio.selectTool(tool as ToolId)));

  // Scope follows the selection (serialized; the latest selection wins).
  let scoping = false;
  let wanted: ScopeRef | undefined;
  const applyScope = async (): Promise<void> => {
    if (scoping) return;
    scoping = true;
    try {
      while (wanted !== undefined) {
        const next = wanted;
        wanted = undefined;
        const r = await studio.setScope(next, signal);
        if (!r.ok) problem(r.error);
      }
    } finally {
      scoping = false;
    }
  };
  // Compared with the scope Studio has, not the last one asked for: a lens switch during a scope change cannot leave a
  // stale selection scope behind.
  const scopeOf = (nodes: readonly NodeId[]): ScopeRef => (nodes.length === 0 ? { kind: 'asset' } : { kind: 'selection', nodes: [...nodes] });
  const keyOf = (s: ScopeRef | undefined): string => JSON.stringify(s?.kind === 'selection' ? s.nodes : []);
  watch(
    () => [keyOf(scopeOf(selection().slice(0, 1024))), keyOf(studio.spec?.scope)] as const,
    ([want, have]) => {
      if (want === have || (wanted !== undefined && keyOf(wanted) === want)) return;
      wanted = scopeOf(selection().slice(0, 1024));
      void applyScope();
    },
    { scope },
  );
  // The Pages panel (lens controller) chooses the page the canvas shows; the controller starts on the page shown.
  watch(
    () => [view()?.page, lens.arrangement()] as const,
    ([shown, arrangement]) => {
      if (shown !== undefined && arrangement !== undefined && lens.current() === undefined) void lens.goTo(shown);
    },
    { scope },
  );
  watch(
    () => lens.current(),
    (current) => {
      if (current !== undefined && current !== canvas.page && pages.includes(current)) void canvas.showPage(current).then((r) => (r.ok ? undefined : problem(r.error)));
    },
    { scope },
  );

  const runHudAction = async (action: ActionId): Promise<Result<unknown>> => {
    const hud = registries.value.hud(action);
    if (hud === undefined) return ok(undefined);
    // Editor commands behind HUD actions (B2's text commands, B10a's Free transform): no capability, run in the editor.
    if (TEXT_HUD_COMMANDS[action] !== undefined || TOOL_HUD_COMMANDS[action] !== undefined) {
      const done = await editor.request('hud', { action });
      if (!done.ok) problem(done.error);
      return done;
    }
    if (hud.capability === undefined) {
      say(`${hud.label} arrives in a later milestone.`);
      return ok(undefined);
    }
    const nodes = selection();
    const input = (HUD_INPUTS[hud.capability] ?? ((n: readonly NodeId[]) => ({ nodes: n })))(nodes);
    const result = await capabilities.invoke(hud.capability, input, { subject: 'user', signal, origin: { channel: 'ui/hud' } });
    if (result.ok) say(spokenResult(hud.label, result.value));
    else problem(result.error);
    return result;
  };
  let milestones = 0;
  const createMilestone = async (name?: string): Promise<Result<unknown>> => {
    const result = await capabilities.invoke(CreateMilestoneCapability, { name: name ?? `Milestone ${(milestones += 1)}` }, { subject: 'user', signal, origin: { channel: 'ui/hud' } });
    if (result.ok) {
      const made = (result.value as { name?: string }).name ?? '';
      say(`Milestone created: ${made}`);
      toasts.show({ message: `Milestone '${made}' created`, action: { label: 'View', run: () => void element?.showPanel(StudioIds.panel.milestones) } });
      void milestonesPanel.refresh();
    } else problem(result.error);
    return result;
  };

  const saveAsTemplate = async (title?: string): Promise<Result<unknown>> => {
    if (templates === undefined) {
      say('Templates are not available here.');
      return ok(undefined);
    }
    const result = await capabilities.invoke(SaveAsTemplateCapability, title === undefined ? {} : { title }, { subject: 'user', signal, origin: { channel: 'ui/top-bar' } });
    if (result.ok) {
      const saved = (result.value as { title: string }).title;
      say(`Template saved: ${saved}`);
      toasts.show({ message: `Saved as template '${saved}'`, action: { label: 'Open Home', run: () => void leave(options.homeHref ?? '/') } });
    } else problem(result.error);
    return result;
  };
  // C1: the Export panel's button, `Mod+Shift+E` and agents run the same capability.
  const exportDesign = async (o: ExportOptions): Promise<Result<unknown>> => {
    lastExport = o;
    const result = await capabilities.invoke(ExportCapability, o, { subject: 'user', signal, origin: { channel: 'ui/panel' } });
    if (result.ok) {
      const files = (result.value as { files: readonly { name: string }[] }).files;
      const what = files.length === 1 ? (files[0]?.name ?? '') : `${files.length} files`;
      say(`Exported ${what}`);
      toasts.show({ message: `Exported ${what}`, tone: 'success' });
    } else if (result.error.kind !== 'aborted') problem(result.error);
    return result;
  };
  const leave = async (href: string): Promise<void> => {
    const flushed = await latest.flush(signal);
    if (!flushed.ok) problem(flushed.error);
    await (options.leave ?? ((h: string) => globalThis.location.assign(h)))(href);
  };

  const tabView = (): StudioTabView | undefined => {
    const v = view();
    if (v?.page === undefined || canvas.page === undefined) return undefined;
    return { page: v.page, view: { selection: v.selection, tool: v.tool, camera: v.camera, viewport: v.viewport, context: v.context }, editing: v.editing === undefined ? undefined : { node: v.editing } };
  };

  // ---------------------------------------------------------------- B11b: the chrome (top bar, pill, menus)
  let element: IfStudioElement | undefined;
  const scene = hub.view(SceneMirror);
  const typographyView = hub.view(TypographyMirror);
  const titleBox = box(options.document.title);
  const keyOfCapability = new Map<string, string>(STUDIO_KEY_COMMANDS.map((k) => [k.capability as string, k.def.keys[0] as string] as const));
  const elementKeys = new Map(ELEMENT_ACTIONS.flatMap((a) => (a.shortcut === undefined ? [] : [[elementActionId(a.name), a.shortcut] as const])));
  const globalActions: readonly string[] = STUDIO_KEY_COMMANDS.filter((k) => k.empty === true).map((k) => k.capability as string);
  const actionTable: ReadonlyMap<string, HudAction> = new Map(
    declarations.map((cap) => {
      const shortcut = keyOfCapability.get(cap.id) ?? elementKeys.get(cap.id as `instaflow/${string}`) ?? registries.value.hud(cap.id)?.shortcut;
      return [cap.id as string, { id: cap.id as string, title: cap.title, ...(shortcut === undefined ? {} : { shortcut }) }] as const;
    }),
  );
  /** Feedback a capability run gives beyond the canvas (FOUNDATIONS §5.3: a delete of ≥ 5 elements toasts with Undo). */
  const feedback = (capability: string, nodes: readonly NodeId[]): void => {
    if (capability === DeleteCapability.id && nodes.length >= 5) toasts.undoable({ message: `Deleted ${nodes.length} elements`, undo: () => run(UndoCapability.id, {}, []) });
  };
  const run = (capability: string, extra: Readonly<Record<string, unknown>> = {}, nodes: readonly NodeId[] = selection()): void => {
    const input = nodes.length === 0 ? { ...extra } : { nodes: [...nodes], ...extra };
    void capabilities.invoke(capability, input, { subject: 'user', signal, origin: { channel: 'ui/hud' } }).then((r) => {
      if (r.ok) feedback(capability, nodes);
      else if (r.error.kind !== 'aborted') toasts.error(r.error);
    });
  };
  scope.defer(editor.on('ran', (ran) => (ran.ok ? feedback(ran.capability, ran.nodes) : undefined)));
  const sceneCall = (r: Promise<Result<unknown>>): void => void r.then((x) => (x.ok ? undefined : toasts.error(x.error)));
  const chrome: StudioChromePort = {
    invoke: (capability, extra, nodes) => run(capability, extra ?? {}, nodes ?? selection()),
    setPaint: (stack, paint, label) => sceneCall(scene.call('setPaint', stack, paint, label)),
    setProp: (path, value, label) => sceneCall(scene.call('setProp', path, value as never, label)),
    setFont: (font) => void typography.setFont(font),
    setSize: (size) => void typography.setSize(size),
    setTextColor: (color) => void typography.setColor(color),
    toggleText: (key) => void typography.toggle(key),
    setTextAlign: (align) => void typography.setAlign(align),
    setRepeat: (patch) => repeat.apply({ op: 'set', patch: patch as never }),
    command: (id) => void runHudAction(id as ActionId),
    renameTitle(title) {
      const asset = options.document.asset as never;
      const renamed = library.library.rename(asset, title);
      if (!renamed.ok) {
        toasts.error(renamed.error);
        return;
      }
      titleBox.set(title.trim());
      if (typeof document !== 'undefined') document.title = `${title.trim()} · Instaflow`;
    },
    camera: (action: CameraAction) => void editor.request('camera', { action }).then((r) => (r.ok ? undefined : problem(r.error))),
    openExport: () => openExport(),
    createMilestone: (name) => void createMilestone(name === '' ? undefined : name),
    saveAsTemplate: () => void saveAsTemplate(titleBox.get()),
    copyLink() {
      const href = globalThis.location?.href ?? '';
      const clip = globalThis.navigator?.clipboard;
      if (clip === undefined) {
        toasts.show({ message: 'Clipboard blocked by the browser · Allow in site settings', tone: 'warning' });
        return;
      }
      void clip.writeText(href).then(
        () => toasts.show({ message: 'Link copied', dedupe: 'link-copied' }),
        () => toasts.show({ message: 'Clipboard blocked by the browser · Allow in site settings', tone: 'warning' }),
      );
    },
    navigate: (href) => void leave(href),
  };
  // The Export dialog (OVERLAYS-FEEDBACK §2.3): C1's panel in a form dialog over Studio, bound once per element (the
  // dialog re-renders its body; binding again on every render ran each export as many times).
  let exportBound: { readonly element: Element; readonly unbind: () => void } | undefined;
  const bindExportOnce = (el: Element | undefined): void => {
    if (el === exportBound?.element) return;
    exportBound?.unbind();
    exportBound = el === undefined ? undefined : { element: el, unbind: bindExportPanel(el as IfExportPanelElement, exportPort) };
  };
  const exportDialog = defineDialogSurface<void>({
    id: 'instaflow/export-dialog',
    scope: 'app',
    title: () => 'Export',
    size: 'form',
    body: () => html`<if-export-panel ${ref(bindExportOnce)}></if-export-panel>`,
  });
  const openExport = (): void => {
    manager.request(exportDialog, { owner: ownerOf(injector) });
  };
  const chromeModel = (): StudioChromeModel => {
    const v = view();
    return {
      ...EMPTY_CHROME,
      title: titleBox.get(),
      page: scene.read('page'),
      selection: scene.read('selection'),
      frame: scene.read('frame'),
      camera: v?.camera ?? { tx: 0, ty: 0, zoom: 1 },
      gesture: v?.gesture ?? 'idle',
      editing: v?.editing !== undefined,
      typography: typographyView.read('summary'),
      fonts: typographyView.read('fonts'),
      colors: scene.read('colors'),
      actions: actionTable,
      globalActions,
      exportAvailable: exportsService !== undefined,
      templatesAvailable: templates !== undefined,
    };
  };

  const app: StudioApp = {
    toasts,
    get toasted() {
      return toasted;
    },
    chrome,
    get scene() {
      return { ...chromeModel(), layers: scene.read('layers') };
    },
    studio,
    registries: registries.value,
    capabilities,
    canvas,
    injector,
    shortcuts,
    lens,
    typography,
    workers,
    library: library.library,
    leave,
    flush: () => latest.flush(signal),
    saveAsTemplate,
    get exports() {
      return exportsService;
    },
    exportDesign,
    mirrors: hub,
    get view() {
      return view();
    },
    get tab() {
      return tabView();
    },
    spoken,
    runHudAction,
    createMilestone,
    async place(entry, s) {
      if (canvas.page === undefined) return err(NoOpenPageError());
      return editor.request('place', { entry }, { signal: s });
    },
    inspect: (nodes) => editor.request('inspect', nodes === undefined ? {} : { nodes }),
    async element(node) {
      const r = await editor.request('inspect', { nodes: [node] });
      return r.ok ? r.value.elements[0] : undefined;
    },
    async metrics() {
      const merged: { render?: NonNullable<StudioMetrics['render']>; editor?: NonNullable<StudioMetrics['editor']> } = {};
      const done = await workers.everyWorker(async (client) => {
        const m = await client.request('metrics', undefined);
        if (!m.ok) return m;
        if (m.value.render !== undefined) merged.render = m.value.render;
        if (m.value.editor !== undefined) merged.editor = m.value.editor;
        return ok();
      });
      return done.ok ? ok(merged) : done;
    },
    mount(container) {
      defineUiElements();
      defineStudio();
      definePaintInspector();
      defineRepeatInspector();
      defineTransformBar();
      defineTypographyPanel();
      defineSaveStatus();
      defineSurfaces();
      defineExportPanel();
      const provided = provideScope(container, { injector, name: 'instaflow/studio' });
      scope.defer(() => provided.dispose());
      const doc = container.ownerDocument;
      const live = createAnnouncer({ document: doc, timers });
      announcer = live;
      render(
        html`<if-studio
          .studio=${studio}
          .canvas=${canvas}
          .shortcuts=${shortcuts}
          .status=${html`<if-save-status></if-save-status>`}
          .model=${chromeModel()}
          .port=${chrome}
          asset-title=${options.document.title}
          home-href=${options.homeHref ?? '/'}
          project-title="Instaflow"
          @if-navigate=${(e: CustomEvent<{ href: string }>) => {
            e.preventDefault();
            void leave(e.detail.href);
          }}
        ></if-studio>
        <sf-surface-layer></sf-surface-layer>`,
        container,
      );
      const mounted = container.querySelector('if-studio') as IfStudioElement;
      element = mounted;
      // The chrome model follows the mirrors and the view (one assignment per change; Lit diffs the rest).
      watch(chromeModel, (model) => (mounted.model = model), { scope });
      // Key commands with the focus on the chrome (STUDIO §12: Delete works when focus is not on the canvas and not in a
      // text field); on the canvas its own scope wins and the editor runs them.
      for (const command of STUDIO_KEY_COMMANDS) {
        const def = defineShortcut({ id: `${command.def.id}-chrome`, keys: command.def.keys, scope: StudioShortcutScope, description: command.def.description, allowInInputs: false });
        const registered = shortcuts.register(def, () => run(command.capability, {}, command.empty === true ? [] : selection()), { scope, when: () => command.empty === true || selection().length > 0 });
        if (!registered.ok) problem(registered.error);
      }
      if (exportsService !== undefined) {
        const registered = shortcuts.register(
          ExportShortcut,
          () => {
            openExport();
            return true;
          },
          { scope },
        );
        if (!registered.ok) problem(registered.error);
      }
      watch(
        () => view()?.camera.zoom,
        (zoom) => {
          if (zoom !== undefined) mounted.zoom = zoom;
        },
        { scope, fireImmediately: true },
      );
      scope.defer(() => render(html``, container));
      return mounted;
    },
  };
  const openedSpec = await studio.open(signal);
  if (!openedSpec.ok) return openedSpec;
  return ok(app);
}
