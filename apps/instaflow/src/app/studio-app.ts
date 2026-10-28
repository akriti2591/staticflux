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
 * - **B11c**: this device's settings (density both ways with the spec, `Mod+.`, the root's appearance attributes),
 *   Settings and Export as routable dialogs (`/d/settings`, `/d/export`: pushed in-app, Back closes, Escape on a
 *   deep-linked one replaces), the link a URL points at applied on a cold boot (`lens`, `page`, `dock`, `el`,
 *   `inspect`, the dialog last; intents stripped), "Copy link to this" (design, page, selection, dialog), first-use
 *   hints (two per session, suppressed on deep links) and the shortcut snapshot Home's Settings lists.
 */
import { type Announcer, createAnnouncer, createShortcutRegistry, defineShortcut, type ShortcutRegistry, type Timers } from '@staticflux/a11y';
import { alwaysActivePort, allowAllDecidePort, type AnyCapability, type CapabilityRegistry, createCapabilityRegistry, failClosedConfirmPort, implementCapability, unmeteredPort } from '@staticflux/capabilities';
import { box, createInjector, createScope, err, type Injector, ok, type Result, type Scope, type SfError, unit, watch } from '@staticflux/core';
import type { NodeId } from '@staticflux/document/v2';
import { createGate, definePolicy, definePolicySet } from '@staticflux/gate';
import type { Actor } from '@staticflux/stage';
import type { TextInputFactory } from '@staticflux/surface/text-input';
import { allowAllDecideUnit, defineUiElements, gateResource, provideScope, visibilityObserverUnit } from '@staticflux/ui';
import { defineDialogSurface } from '@staticflux/kit/surface-defs';
import { defineShortcutSheet } from '@staticflux/kit/shortcut-sheet';
import { defineHint } from '@staticflux/kit/hint';
import { defineSurfaces } from '@staticflux/kit/surfaces';
import { ownerOf, RoutableDialogBridgeToken, routableDialogBridgeUnit, routableSurface, SeenStoreToken, strictSurfaceManagerUnit, SurfaceManagerToken, type SurfaceManager } from '@staticflux/messaging';
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
import { type LibraryEntry, readLibraryEntries } from '../library/library-doc.js';
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
import type { IfLayersPanelElement, LayersModel, LayersPort } from '../studio/layers-panel.js';
import { type IfInspectorElement, type InspectorModel, type InspectorPort } from '../studio/inspector.js';
import { type CameraAction, type CopyLinkTarget, defineStudio, EMPTY_CHROME, type IfStudioElement, type StudioChromeModel, type StudioChromePort } from '../studio/studio-element.js';
import type { HudAction } from '../studio/hud.js';
import type { LayerRow } from './scene-summary.js';
import { createToasts, type Toasts } from './feedback.js';
import { bindTextKeys, TextEditingShortcutScope } from './text-keys.js';
import { FindCapability, type FindMatch, type FindResult, ReplaceCapability, type ReplaceResult } from './find-replace.js';
import { homeViewHref, keepForeignParams, readStudioIntent, STUDIO_DIALOGS, type StudioDialog, type StudioDockTab, type StudioLink, studioLinkHref, withoutIntents } from '../home/routes.js';
import { createDeviceSettings, DENSITY_LINES, type DeviceSettings, nextDensity } from '../settings/device-settings.js';
import { defineSettings, diagnosticsText, SETTINGS_SECTIONS, type SettingsSection, type SettingsStorage } from '../settings/settings-element.js';
import { HINT_STORAGE_PREFIXES, resetHintsOnDevice, writeShortcutsSnapshot } from '../settings/shortcuts-snapshot.js';
import { createHintSession, type HintSession, localSeenStore, STUDIO_HINTS } from '../studio/hints.js';
import { CopyStyleCapability, DeleteCapability, LockCapability, STUDIO_KEY_COMMANDS, UndoCapability } from './studio-commands.js';
import { ClipboardShortcuts, createClipboardController } from './clipboard-controller.js';
import { shortcutSheet, type ShortcutGroupName, shortcutsSheetSurface } from '../studio/shortcuts-sheet.js';
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
import type { ImageFillTarget, InspectedElement, StudioDocumentRef, StudioInspection, StudioMetrics, ViewProjection } from '../workers/protocol.js';
import type { ImageSource } from '../studio/inspector-paint.js';
import { fromWire } from '../workers/wire.js';
import type { StudioWorkspace } from './document.js';
import { NoOpenPageError } from './errors.js';
import { ImageTooLargeError, MAX_IMAGE_BYTES, NotAnImageError } from '../studio/errors.js';
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
  /** B11c: this device's settings (default: `localStorage`). */
  readonly settings?: DeviceSettings;
  /** B11c: where the URL points within the design (NAVIGATION §6), applied once the canvas shows. */
  readonly link?: StudioLink;
  /** B11c: the browser history routable dialogs and links use (default: the window's). */
  readonly history?: StudioHistory;
  /** B11c: per-device storage for hints and the shortcut snapshot (default `localStorage`; null: this tab only). */
  readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'> | null;
  /** B11c: storage facts for Settings › Storage (default `navigator.storage`). */
  readonly storageFacts?: SettingsStorage;
  readonly scope: Scope;
}

/** The history Studio's routable dialogs and links write (NAVIGATION §3). */
export interface StudioHistory {
  /** `pathname + search` now. */
  current(): string;
  /** The origin links are copied with. */
  origin(): string;
  push(href: string): void;
  replace(href: string): void;
  back(): void;
  /** Back / forward (`popstate`); returns the unsubscribe. */
  onPop(listener: () => void): () => void;
}

/** The window's history (no-ops without one, e.g. in workers or tests without a DOM). */
export function browserStudioHistory(): StudioHistory {
  const g = globalThis as { history?: History; location?: Location; addEventListener?: Window['addEventListener']; removeEventListener?: Window['removeEventListener'] };
  return {
    current: () => (g.location === undefined ? '/' : `${g.location.pathname}${g.location.search}`),
    origin: () => g.location?.origin ?? '',
    push: (href) => g.history?.pushState(null, '', href),
    replace: (href) => g.history?.replaceState(null, '', href),
    back: () => g.history?.back(),
    onPop(listener) {
      g.addEventListener?.('popstate', listener);
      return () => g.removeEventListener?.('popstate', listener);
    },
  };
}

/** Whether page-space `frame` shows in the viewport at `camera` (pure). */
export function onScreen(frame: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }, camera: { readonly tx: number; readonly ty: number; readonly zoom: number }, viewport: { readonly width: number; readonly height: number }): boolean {
  const x = frame.x * camera.zoom + camera.tx;
  const y = frame.y * camera.zoom + camera.ty;
  return x >= 0 && y >= 0 && x + frame.w * camera.zoom <= viewport.width && y + frame.h * camera.zoom <= viewport.height;
}

/** The dock tab a link names → the panel it shows. */
const DOCK_PANELS: Readonly<Record<StudioDockTab, string>> = Object.freeze({
  layers: StudioIds.panel.layers,
  pages: StudioIds.panel.pages,
  assets: StudioIds.panel.assets,
  milestones: StudioIds.panel.milestones,
});

/** NAVIGATION §4's fallback toasts. */
export const linkMessages = Object.freeze({
  page: 'That page is no longer in this design',
  elements: 'That element is no longer in this design',
  someElements: (missing: number, of: number) => `${missing} of ${of} linked elements are no longer in this design`,
  selected: (n: number) => (n === 1 ? '1 element selected' : `${n} elements selected`),
  copied: 'Link copied',
  blocked: 'Clipboard blocked by the browser · Allow in site settings',
  copyLink: 'Copy link',
  settings: 'Settings',
});

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
  /** B11c: this device's settings. */
  readonly settings: DeviceSettings;
  /** B11c: first-use hints this session. */
  readonly hints: HintSession;
  /** B11c: open a routable dialog in-app (pushes `/d/<key>`; Back closes it). */
  openDialog(key: StudioDialog, section?: SettingsSection): Promise<Result<unknown>>;
  /** B11c: the href "Copy link to this" copies for a target (path and query, no origin). */
  linkTo(target: CopyLinkTarget): string;
  /** B11c: apply a link (NAVIGATION §6); `mount` applies the one the app was opened with. */
  applyLink(link: StudioLink): Promise<void>;
  /** B11c: resolves once the link the app was opened with is applied (cold boot). */
  readonly linked: Promise<void>;
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
    editor: {
      document: options.document,
      person,
      isMac: options.isMac ?? false,
      ...(options.textInput === undefined ? {} : { textInput: options.textInput.kind }),
      // #43: the design's images resolve to their blobs when a page opens (trashed ones too: a design still shows them).
      images: readLibraryEntries(workspace.library.part).filter((e) => e.kind === 'image' && e.content !== undefined),
    },
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
  const inspectorBinding: { bind: (element: Element) => () => void; element?: IfInspectorElement } = { bind: () => () => undefined };
  const layersBinding: { bind: (element: Element) => () => void } = { bind: () => () => undefined };
  const BINDERS: Readonly<Record<string, (element: Element) => () => void>> = {
    [EXPORT_PANEL_ID]: (element) => bindExportPanel(element as IfExportPanelElement, exportPort),
    [StudioIds.panel.transform]: (element) => bindTransformBar(element as IfTransformBarElement, transformBar),
    [APPEARANCE_PANEL_ID]: (element) => bindPaintInspector(element as IfPaintInspectorElement, appearance),
    [REPEAT_PANEL_ID]: (element) => bindRepeatInspector(element as IfRepeatInspectorElement, repeat),
    // B11b: bound once the chrome below exists (the binder runs when the panel renders, after startup).
    [StudioIds.panel.inspector]: (element) => inspectorBinding.bind(element),
    [StudioIds.panel.layers]: (element) => layersBinding.bind(element),
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
  // B11b: a deleted page toasts with Undo (the editor's undo service restores its stub; the part kept its content).
  const story = storyFromMirror(storyView, problem, { deleted: () => toasts.undoable({ message: 'Page deleted', undo: () => run(UndoCapability.id, {}, []) }) });
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
  // ---------------------------------------------------------------- B11c: settings, history, routable dialogs
  const settings = options.settings ?? createDeviceSettings();
  const history = options.history ?? browserStudioHistory();
  const storage = options.storage === null ? undefined : (options.storage ?? (globalThis as { localStorage?: Storage }).localStorage);
  const seen = localSeenStore(storage);
  const asset = options.document.asset as string;
  /** The URL now, read as a Studio link (the view params a dialog's href keeps). */
  const linkNow = (): StudioLink => {
    const read = readStudioIntent(history.current());
    return read.kind === 'open' ? read.link ?? {} : {};
  };
  const hrefOf = (link: StudioLink): string => {
    const built = studioLinkHref(asset, link);
    return keepForeignParams(built.ok ? built.value : history.current(), history.current());
  };
  /** The design's href with the dialog's key (and section) on top of today's view params. */
  const dialogHref = (key: StudioDialog | undefined, section?: SettingsSection): string => {
    const { dialog: _d, section: _s, ...view } = withoutIntents(linkNow());
    return hrefOf({ ...view, ...(key === undefined ? {} : { dialog: key }), ...(key === 'settings' && section !== undefined && section !== 'general' ? { section } : {}) });
  };
  let settingsSection: SettingsSection = 'general';
  const writeClipboard = (href: string): void => {
    const clip = globalThis.navigator?.clipboard;
    const blockedToast = (): void => void toasts.show({ message: linkMessages.blocked, tone: 'warning' });
    if (clip === undefined) return blockedToast();
    void clip.writeText(`${history.origin()}${href}`).then(() => void toasts.show({ message: linkMessages.copied, dedupe: 'link-copied', durationMs: 1500 }), blockedToast);
  };
  const copyLinkButton = (key: StudioDialog) =>
    html`<sf-button slot="header-actions" class="copy-dialog-link" size="sm" variant="ghost" @click=${() => writeClipboard(dialogHref(key, key === 'settings' ? settingsSection : undefined))}>${linkMessages.copyLink}</sf-button>`;
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
    routable: { key: 'export' },
    body: () => html`${copyLinkButton('export')}<if-export-panel ${ref(bindExportOnce)}></if-export-panel>`,
  });
  // B11c: Settings over Studio (STUDIO §2.4): the same `<if-settings>` Home shows as a page.
  const sheetGroups = () => shortcutSheet(shortcuts.list(), { lenses: lensIds, commands: commandGroups });
  const settingsDialog = defineDialogSurface<{ readonly section: SettingsSection }>({
    id: 'instaflow/settings-dialog',
    scope: 'app',
    title: () => linkMessages.settings,
    size: 'settings',
    routable: {
      key: 'settings',
      params: (raw) => ok({ section: (SETTINGS_SECTIONS as readonly string[]).includes(raw['section'] ?? '') ? (raw['section'] as SettingsSection) : 'general' }),
    },
    body: (context) => {
      settingsSection = settingsSection === 'general' ? context.props.section : settingsSection;
      return html`${copyLinkButton('settings')}<if-settings
          section=${context.props.section}
          .settings=${settings}
          .storage=${options.storageFacts ?? (globalThis.navigator as { storage?: SettingsStorage } | undefined)?.storage}
          .shortcuts=${sheetGroups()}
          .diagnostics=${() => diagnosticsText({ surface: 'Studio', density: settings.current.density, extra: { Pages: String(scene.read('pages')), Workers: String(workers.workers.length) } })}
          @if-section=${(e: CustomEvent<{ section: SettingsSection }>) => {
            settingsSection = e.detail.section;
            if (dialogs.current === 'settings') history.replace(dialogHref('settings', settingsSection));
          }}
          @if-reset-hints=${() => {
            resetHintsOnDevice(storage, HINT_STORAGE_PREFIXES);
            void hints.reset();
          }}
          @if-open-trash=${() => {
            const trash = homeViewHref({ kind: 'trash' });
            void leave(trash.ok ? trash.value : '/');
          }}
        ></if-settings>`;
    },
  });
  const injector = createInjector({
    units: [
      // B11b: messaging under the strict overlay policy (toasts, the Export dialog), OVERLAYS-FEEDBACK §1. B11c: the
      // seen store is this device's (`instaflow/ui/hints`), and Export and Settings are routable dialogs.
      visibilityObserverUnit,
      allowAllDecideUnit,
      unit({ id: 'instaflow/studio-seen-store', provides: SeenStoreToken, scope: 'app', create: () => seen }),
      strictSurfaceManagerUnit,
      routableDialogBridgeUnit,
      routableSurface(exportDialog),
      routableSurface(settingsDialog),
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
  const bridged = await injector.get(RoutableDialogBridgeToken);
  if (!bridged.ok) return bridged;
  const dialogs = bridged.value;
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

  // B11c: a link's page is the page the canvas opens on (NAVIGATION §6 step 2: before the first content frame).
  const linkedPage = options.link?.page;
  const startPage = (): NodeId => (linkedPage !== undefined && pages.includes(linkedPage as NodeId) ? (linkedPage as NodeId) : firstPage());
  const canvas = studioCanvas({
    workers,
    page: startPage,
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
      // B11b: pages join and leave at runtime: the arrangement (the mirrored story) lists the pages there are now.
      if (current !== undefined && current !== canvas.page && (lens.arrangement()?.frames.some((f) => f.page === current) ?? pages.includes(current))) void canvas.showPage(current).then((r) => (r.ok ? undefined : problem(r.error)));
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
  const styleCopied = box(false);
  const feedback = (capability: string, nodes: readonly NodeId[]): void => {
    if (capability === CopyStyleCapability.id) styleCopied.set(true);
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
  // B11b slice 4: the clipboard (STUDIO §8.1): keys use the browser's events, menus the async API and memory.
  const blocked = (message: string): void => {
    toasts.show({ message, tone: 'warning', dedupe: 'clipboard' });
  };
  const clip = createClipboardController({
    editor: {
      copy: (nodes, cut) => editor.request('copy', { nodes: [...nodes], cut }),
      paste: (payload, inPlace) => editor.request('paste', { payload, inPlace }),
      pasteText: (text) => editor.request('pasteText', { text }),
    },
    selection,
    editing: () => view()?.editing !== undefined,
    async placeFiles(files) {
      const imported = await library.panel.importFiles(files);
      if (!imported.ok) return void toasts.error(imported.error);
      for (const failed of imported.value.failed) toasts.error(failed.error);
      for (const entry of [...imported.value.imported, ...imported.value.deduplicated]) {
        const placed = await editor.request('place', { entry });
        if (!placed.ok) toasts.error(placed.error);
      }
    },
    async selectedText() {
      const copied = await editor.request('copy', { nodes: [...selection()], cut: false });
      return copied.ok ? copied.value.text : '';
    },
    problem: (e) => toasts.error(e),
    warn: blocked,
    ...(globalThis.navigator?.clipboard === undefined ? {} : { system: globalThis.navigator.clipboard }),
  });
  // The cheat sheet (STUDIO §2.3.1): a snapshot of the registry when it opens.
  const commandGroups = new Map<string, ShortcutGroupName>(STUDIO_KEY_COMMANDS.map((k) => [k.def.id as string, k.group === 'Style' ? 'Edit' : k.group] as const));
  const lensIds = new Set<string>(registries.value.lenses.map((l) => l.id as string));
  const sheetDialog = shortcutsSheetSurface(() => shortcutSheet(shortcuts.list(), { lenses: lensIds, commands: commandGroups }));
  let sheet: { dismiss(): void; readonly state: string } | undefined;
  const pageAction = async (action: 'add' | 'duplicate' | 'delete' | 'size', arg?: string): Promise<void> => {
    const current = lens.current();
    const pagesEditor = story.pages;
    if (action === 'size') {
      const [w, h] = (arg ?? '').split('x').map(Number);
      if (w !== undefined && h !== undefined && Number.isFinite(w) && Number.isFinite(h)) sceneCall(scene.call('resizePage', w, h));
      return;
    }
    if (pagesEditor === undefined) return;
    if (action === 'add') {
      const added = await pagesEditor.addPage(current);
      if (added.ok) void lens.goTo(added.value);
      else toasts.error(added.error);
    } else if (current !== undefined && action === 'duplicate') {
      const copy = await pagesEditor.duplicatePage(current);
      if (copy.ok) void lens.goTo(copy.value);
      else toasts.error(copy.error);
    } else if (current !== undefined && action === 'delete') {
      const frames = lens.arrangement()?.frames ?? [];
      const at = frames.findIndex((f) => f.page === current);
      const next = frames[at + 1] ?? frames[at - 1];
      if (next !== undefined && frames.length > 1) await lens.goTo(next.page);
      const gone = await pagesEditor.deletePage(current);
      if (!gone.ok) toasts.error(gone.error);
    }
  };
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
    setImageFit: (fit) => sceneCall(scene.call('setImageFit', fit)),
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
    copyLink: (target) => writeClipboard(linkTo(target ?? 'design')),
    openSettings: (section) => void openDialog('settings', section),
    // B11c slice 3 (STUDIO §9.1): the find bar over `instaflow/find` / `instaflow/replace`.
    async find(query) {
      const found = await capabilities.invoke(FindCapability, query, { subject: 'user', signal, origin: { channel: 'ui/find' } });
      if (found.ok) return found.value as FindResult;
      toasts.error(found.error);
      return undefined;
    },
    async replace(query, replacement, o) {
      const font = o.font !== undefined && 'font' in o.font ? { font: o.font.font, ...(o.font.family === undefined ? {} : { family: o.font.family }) } : undefined;
      const input = { ...query, replacement, ...(font === undefined ? {} : { font }), ...(o.only === undefined ? {} : { only: [...o.only] }) };
      const done = await capabilities.invoke(ReplaceCapability, input, { subject: 'user', signal, origin: { channel: 'ui/find' } });
      if (!done.ok) {
        toasts.error(done.error);
        return undefined;
      }
      const r = done.value as ReplaceResult;
      const what = `${r.label} · ${r.replaced === 1 ? '1 match' : `${r.replaced} matches`}${r.skipped > 0 ? ` · ${r.skipped} locked, skipped` : ''}`;
      if (r.replaced > 0) toasts.undoable({ message: what, undo: () => run(UndoCapability.id, {}, []) });
      else if (r.skipped > 0) toasts.show({ message: `${r.skipped} locked, skipped`, tone: 'warning' });
      say(what);
      return r;
    },
    reveal: (match) => void revealMatch(match),
    cycleDensity() {
      const next = nextDensity(studio.density);
      void studio.setDensity(next, signal);
      toasts.show({ message: `${DENSITY_LINES[next].name} · ${DENSITY_LINES[next].line}`, dedupe: 'density', durationMs: 1500 });
    },
    navigate: (href) => void leave(href),
    selectPage(rename) {
      void editor.request('select', { nodes: [] }).then(async (r) => {
        if (!r.ok) return problem(r.error);
        const el = inspectorBinding.element;
        if (el === undefined) return;
        if (rename) await el.focusPageName();
        else await el.reveal('page');
      });
    },
    async contextAt(point) {
      const r = await editor.request('contextAt', point === undefined ? {} : { x: point.x, y: point.y });
      if (r.ok) return r.value;
      problem(r.error);
      return undefined;
    },
    clipboard(action) {
      if (action === 'cut' || action === 'copy') void clip.copy(action === 'cut');
      else if (action === 'copy-as-text') void clip.copyAsText();
      else void clip.paste(action === 'paste-in-place');
    },
    selectAll() {
      const nodes = scene.read('layers').filter((l) => !l.locked && !l.hidden).map((l) => l.id);
      void editor.request('select', { nodes }).then((r) => (r.ok ? undefined : problem(r.error)));
    },
    editText: () => void editor.request('editText', {}).then((r) => (r.ok ? undefined : toasts.error(r.error))),
    textPreset: (name) => void typography.applyPreset(name as never),
    fitToBox: () => void typography.fitToBox(),
    replaceImage() {
      void library.panel.pickAndImport().then(async (picked) => {
        if (!picked.ok) {
          if (picked.error.kind !== 'aborted') toasts.error(picked.error);
          return;
        }
        const entry = picked.value.imported[0] ?? picked.value.deduplicated[0];
        if (entry === undefined) return;
        const done = await editor.request('replaceImage', { entry });
        if (!done.ok) toasts.error(done.error);
      });
    },
    pageAction: (action, arg) => void pageAction(action, arg),
    placeImage: () => void placeImage(),
    dropFiles: (files, at) => void dropFiles(files, at),
    saveHint: () => toasts.show({ message: 'Instaflow saves as you work', dedupe: 'save-hint', action: { label: 'Create milestone', run: () => void createMilestone() } }),
    openShortcuts() {
      writeShortcutsSnapshot(storage, sheetGroups());
      if (sheet !== undefined && sheet.state !== 'dismissed') {
        sheet.dismiss();
        sheet = undefined;
        return;
      }
      sheet = manager.request(sheetDialog, { owner: ownerOf(injector) });
    },
  };
  /** A find match: its page shown, it selected (the page itself for a background), the camera on it when off-screen. */
  async function revealMatch(m: FindMatch): Promise<void> {
    if (view()?.page !== m.page) {
      await lens.goTo(m.page as NodeId);
      await until(() => view()?.page === m.page);
    }
    if (m.where === 'background') {
      chrome.selectPage(false);
      return;
    }
    const picked = await editor.request('select', { nodes: [m.node as NodeId] });
    if (!picked.ok) return problem(picked.error);
    await until(() => selection()[0] === m.node && scene.read('frame') !== undefined);
    const frame = scene.read('frame');
    const v = view();
    if (frame !== undefined && v !== undefined && !onScreen(frame, v.camera, v.viewport)) chrome.camera('fit-selection');
  }
  /** "Copy link to this" (NAVIGATION §5): the design, the open page (Pages lens) or the selection on its page. */
  function linkTo(target: CopyLinkTarget): string {
    const page = canvas.page ?? view()?.page;
    const LINKS: Readonly<Record<CopyLinkTarget, () => StudioLink>> = {
      design: () => ({}),
      page: () => (page === undefined ? {} : { lens: 'pages', page }),
      selection: () => ({ ...(page === undefined ? {} : { page }), ...(selection().length === 0 ? {} : { el: selection().slice(0, 20) }) }),
    };
    const built = studioLinkHref(asset, LINKS[target]());
    return built.ok ? built.value : history.current();
  }
  // ---------------------------------------------------------------- B11c: images from files (HOME-FILES §3.1)
  /** Import picked or dropped files into the library; refusals toast with their fix (never a blank screen). */
  const imported = (summary: { readonly imported: readonly LibraryEntry[]; readonly deduplicated: readonly LibraryEntry[]; readonly failed: readonly { readonly error: SfError }[] }): readonly LibraryEntry[] => {
    for (const failed of summary.failed) toasts.error(failed.error);
    return [...summary.imported, ...summary.deduplicated].filter((e) => e.kind === 'image');
  };
  /** The files Studio takes as images (HOME-FILES §3.1): others are refused, each with one toast and its fix. */
  const screenImages = <F extends { readonly name: string; readonly type: string; readonly size: number }>(files: readonly F[]): F[] =>
    files.filter((f) => {
      if (!f.type.startsWith('image/')) toasts.error(NotAnImageError({ details: { name: f.name, type: f.type } }));
      else if (f.size > MAX_IMAGE_BYTES) toasts.error(ImageTooLargeError({ details: { name: f.name, size: f.size } }));
      else return true;
      return false;
    });
  const pickImages = async (): Promise<readonly LibraryEntry[]> => {
    const picked = await (options.library?.pickFiles ?? ((s: AbortSignal) => browserPickFiles(s)))(signal);
    if (!picked.ok) {
      if (picked.error.kind !== 'aborted') toasts.error(picked.error);
      return [];
    }
    const files = screenImages(picked.value);
    if (files.length === 0) return [];
    const result = await library.panel.importFiles(files);
    if (!result.ok) {
      toasts.error(result.error);
      return [];
    }
    return imported(result.value);
  };
  /** `Place image…`: the picked images at the viewport centre (or in the selected frame), the last one selected. */
  const placeImage = async (): Promise<void> => {
    for (const entry of await pickImages()) {
      const placed = await editor.request('place', { entry });
      if (!placed.ok) toasts.error(placed.error);
      else say(`Placed ${entry.title}`);
    }
  };
  /** An image on fills: a workspace image or an upload; the editor makes it one undo step. */
  const imageFill = async (target: ImageFillTarget, source: ImageSource): Promise<void> => {
    const entries = 'asset' in source ? library.library.entries().filter((e) => e.asset === source.asset) : (await pickImages()).slice(0, 1);
    const entry = entries[0];
    if (entry === undefined) return;
    const done = await editor.request('imageFill', { entry, target });
    if (!done.ok) toasts.error(done.error);
    else say(target.to === 'page' ? `Background: ${entry.title}` : `Image fill: ${entry.title}`);
  };
  /** Files dropped on the canvas: the first fills the shape under the point (or lands there); the rest are placed. */
  const dropFiles = async (files: readonly File[], at: { readonly x: number; readonly y: number }): Promise<void> => {
    const images = screenImages(files);
    if (images.length === 0) return;
    const result = await library.panel.importFiles(images);
    if (!result.ok) return void toasts.error(result.error);
    const entries = imported(result.value);
    const [first, ...rest] = entries;
    if (first === undefined) return;
    const done = await editor.request('imageFill', { entry: first, target: { to: 'point', x: at.x, y: at.y } });
    if (!done.ok) toasts.error(done.error);
    else say('filled' in done.value ? `Image fill: ${first.title}` : `Placed ${first.title}`);
    for (const entry of rest) {
      const placed = await editor.request('place', { entry });
      if (!placed.ok) toasts.error(placed.error);
    }
  };
  // B11b: the inspector (STUDIO §5): the chrome port plus the editor's appearance, transform, repeat and typography.
  const inspectorPort: InspectorPort = {
    ...chrome,
    appearance: (edit) => appearance.apply(edit),
    pageAppearance: (edit) => sceneCall(scene.call('applyPage', edit)),
    transform: (edit) => transformBar.apply(edit),
    transformSession: (action) => transformBar.session(action),
    repeat: (edit) => repeat.apply(edit),
    text: typography,
    renamePage: (name) => sceneCall(scene.call('renamePage', name)),
    resizePage: (width, height) => sceneCall(scene.call('resizePage', width, height)),
    imageFill: (to, source, index) => void imageFill(index === undefined ? { to } : { to, index }, source),
    backgroundToAllPages: () => sceneCall(scene.call('backgroundToAllPages')),
    setPivot: (fraction) => sceneCall(transformView.call('pivot', fraction)),
  };
  const appearanceView = hub.view(AppearanceMirror);
  const transformView = hub.view(TransformMirror);
  const repeatView = hub.view(RepeatMirror);
  const inspectorModel = (): InspectorModel => {
    const s = scene.read('selection');
    const asset = s.asset;
    return {
      selection: s,
      page: scene.read('page'),
      title: titleBox.get(),
      pages: scene.read('pages'),
      appearance: appearanceView.read('model'),
      pageFill: scene.read('pageFill'),
      transform: transformView.read('model'),
      pivot: transformView.read('pivot'),
      typography: typographyView.read('summary'),
      fonts: typographyView.read('fonts'),
      repeat: repeatView.read('model'),
      colors: scene.read('colors'),
      imageName: asset === undefined ? undefined : library.library.entries().find((e) => e.asset === asset)?.title,
      images: library.library
        .entries()
        .filter((e) => e.kind === 'image' && e.trashedAt === undefined && e.content !== undefined)
        .map((e) => {
          const thumb = library.panel.thumbnail(e.asset);
          return { asset: e.asset as string, title: e.title, ...(thumb === undefined ? {} : { thumb }) };
        }),
    };
  };
  inspectorBinding.bind = (element) => {
    const el = element as IfInspectorElement;
    inspectorBinding.element = el;
    el.port = inspectorPort;
    const stop = createScope('instaflow/inspector-binding');
    watch(inspectorModel, (model) => (el.model = model), { scope: stop, fireImmediately: true });
    return () => void stop.dispose();
  };

  // B11b: Layers (STUDIO §3.1) over the scene mirror; its edits are capabilities and mirror actions.
  const layersPort: LayersPort = {
    select: (nodes) => void editor.request('select', { nodes: [...nodes] }).then((r) => (r.ok ? undefined : problem(r.error))),
    selectPage: () => chrome.selectPage(false),
    rename: (node, name) => run('instaflow/rename', { name }, [node]),
    move: (nodes, parent, before) => sceneCall(scene.call('move', nodes, parent, before)),
    hide: (nodes, hidden) => run('instaflow/hide', { hidden }, nodes),
    lock: (nodes, locked) => run(LockCapability.id, { locked }, nodes),
    remove: (nodes) => run(DeleteCapability.id, {}, nodes),
    hover: (node) => void editor.request('hover', { node: node ?? null }),
    pickTool: (tool) => void studio.selectTool(tool === 'shape' ? StudioIds.tool.shape : StudioIds.tool.text),
  };
  const layersModel = (): LayersModel => ({ page: scene.read('page'), layers: scene.read('layers'), selection: selection(), hover: view()?.hover });
  layersBinding.bind = (element) => {
    const el = element as IfLayersPanelElement;
    el.port = layersPort;
    const stop = createScope('instaflow/layers-binding');
    watch(layersModel, (model) => (el.model = model), { scope: stop, fireImmediately: true });
    return () => void stop.dispose();
  };

  // B11c: routable dialogs (NAVIGATION §3): opened in-app they push `/d/<key>` (Back closes; `×` / Escape go back);
  // opened from a link Escape replaces the path with the design's. Back / forward open or close them to match the URL.
  const openDialog = async (key: StudioDialog, section?: SettingsSection, source: 'in-app' | 'deep-link' = 'in-app'): Promise<Result<unknown>> => {
    if (key === 'export' && exportsService === undefined) {
      toasts.show({ message: 'Export is not available here.', tone: 'warning' });
      return ok(undefined);
    }
    if (key === 'settings') settingsSection = section ?? 'general';
    if (source === 'in-app' && dialogs.current !== key) history.push(dialogHref(key, section));
    if (source === 'in-app' && dialogs.current === key && key === 'settings') history.replace(dialogHref(key, section));
    const opened = await dialogs.openDialog(key, key === 'settings' ? { section: section ?? 'general' } : {}, { source });
    if (!opened.ok) toasts.error(opened.error);
    return opened;
  };
  scope.defer(
    dialogs.onDismissIntent((intent) => {
      if (intent.kind === 'back') history.back();
      else history.replace(dialogHref(undefined));
    }),
  );
  scope.defer(
    history.onPop(() => {
      const link = linkNow();
      if (link.dialog === undefined) {
        if (dialogs.current !== undefined) dialogs.closeDialog();
        return;
      }
      if (dialogs.current !== link.dialog) void dialogs.openDialog(link.dialog, link.dialog === 'settings' ? { section: link.section ?? 'general' } : {}, { source: 'in-app' });
    }),
  );
  const openExport = (): void => void openDialog('export');
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
      clipboard: { canPaste: clip.held.get() !== undefined, styleCopied: styleCopied.get() },
      pages: scene.read('pages'),
      undo: scene.read('undo'),
    };
  };

  // ---------------------------------------------------------------- B11c: hints, density, the link
  // Hints are view-level surfaces (the kit's hint def): their owner is a view scope under the app's.
  const hintScope = createScope('instaflow/studio-hints');
  scope.defer(() => hintScope.dispose());
  const hints = createHintSession({ manager, owner: { scope: hintScope, level: 'view' }, seen, enabled: () => settings.current.hints });
  const TOOL_HINTS = new Map<string, (typeof STUDIO_HINTS)[keyof typeof STUDIO_HINTS]>([
    [StudioIds.tool.frame, STUDIO_HINTS.frame],
    [StudioIds.tool.shape, STUDIO_HINTS.shape],
    [StudioIds.tool.text, STUDIO_HINTS.text],
    [StudioIds.tool.hand, STUDIO_HINTS.hand],
  ]);
  let hinted: ToolId | undefined;
  watch(
    () => studio.activeTool,
    (tool) => {
      // The previous tool was used (or left): its hint goes. The newly picked one offers its sentence once.
      const before = hinted === undefined ? undefined : TOOL_HINTS.get(hinted);
      if (before !== undefined && hinted !== tool) hints.used(before);
      hinted = tool;
      const hint = tool === undefined ? undefined : TOOL_HINTS.get(tool);
      if (hint !== undefined && element !== undefined) hints.offer(hint);
    },
    { scope },
  );
  watch(
    () => [scene.read('layers').length > 0, selection().length > 1] as const,
    ([some, many]) => {
      if (element === undefined) return;
      if (some) hints.offer(STUDIO_HINTS.layers);
      if (many) hints.offer(STUDIO_HINTS.multiSelection);
    },
    { scope },
  );
  // Density: this device's setting and the mounted spec stay one value (View menu, Settings, `Mod+.`, other tabs).
  watch(
    () => studio.density,
    (d) => (settings.current.density === d ? undefined : settings.set({ density: d })),
    { scope },
  );
  watch(
    () => settings.current.density,
    (d) => (studio.density === d ? undefined : void studio.setDensity(d, signal)),
    { scope },
  );
  /** NAVIGATION §6: lens, dock, the selection intent, the inspector intent, the dialog last; intents stripped after. */
  const applyLink = async (link: StudioLink): Promise<void> => {
    if (link.el !== undefined || link.page !== undefined || link.dialog !== undefined) hints.suppress();
    if (link.lens === 'pages') await studio.switchLens(StudioIds.lens.pages, signal);
    if (link.dock !== undefined) await element?.showPanel(DOCK_PANELS[link.dock]);
    await until(() => view()?.page !== undefined);
    if (link.page !== undefined && !pages.includes(link.page as NodeId)) toasts.show({ message: linkMessages.page, dedupe: 'link-page' });
    if (link.el !== undefined) {
      const found = await editor.request('inspect', { nodes: [...link.el] as NodeId[] });
      const known = found.ok ? found.value.elements.map((e) => e.id).filter((id) => link.el?.includes(id)) : [];
      const missing = link.el.length - known.length;
      if (known.length > 0) {
        const selected = await editor.request('select', { nodes: known });
        if (selected.ok) {
          chrome.camera('fit-selection');
          say(linkMessages.selected(known.length));
        } else problem(selected.error);
      } else chrome.camera('fit-page');
      if (missing > 0) toasts.show({ message: known.length === 0 ? linkMessages.elements : linkMessages.someElements(missing, link.el.length), dedupe: 'link-elements' });
    } else if (link.page !== undefined) chrome.camera('fit-page');
    if (link.inspect !== undefined && element !== undefined) {
      await until(() => inspectorBinding.element !== undefined);
      await element?.updateComplete;
      await inspectorBinding.element?.reveal(link.inspect);
    }
    // Strip the intents (and a dialog key this build does not have) so a reload does not repeat them.
    if (link.el !== undefined || link.inspect !== undefined || link.unknownDialog !== undefined || (link.page !== undefined && !pages.includes(link.page as NodeId))) {
      const { page: _page, ...rest } = withoutIntents(link);
      history.replace(hrefOf(link.page !== undefined && pages.includes(link.page as NodeId) ? { ...rest, page: link.page } : rest));
    }
    if (link.unknownDialog !== undefined) console.info(`[studio] dropped unknown dialog "${link.unknownDialog}" (${STUDIO_DIALOGS.join(', ')} exist)`);
    if (link.dialog !== undefined) await openDialog(link.dialog, link.section, 'deep-link');
  };
  /** Resolves once `test()` holds (reactive), or after `ms` whatever happens (a link or a match never hangs Studio). */
  function until(test: () => boolean, ms = 5000): Promise<void> {
    return new Promise((resolve) => {
      if (test()) return resolve();
      const stop = createScope('instaflow/until');
      scope.defer(() => stop.dispose());
      const late = setTimeout(() => {
        void stop.dispose();
        resolve();
      }, ms);
      stop.defer(() => clearTimeout(late));
      watch(
        test,
        (held) => {
          if (!held) return;
          void stop.dispose();
          resolve();
        },
        { scope: stop },
      );
    });
  }
  let linkedDone: () => void = () => undefined;
  const linked = new Promise<void>((resolve) => (linkedDone = resolve));

  const app: StudioApp = {
    settings,
    hints,
    openDialog: (key, section) => openDialog(key, section),
    linkTo,
    applyLink,
    linked,
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
      defineShortcutSheet();
      defineSettings();
      defineHint();
      const provided = provideScope(container, { injector, name: 'instaflow/studio' });
      scope.defer(() => provided.dispose());
      const doc = container.ownerDocument;
      settings.apply(doc.documentElement, scope);
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
          @if-announce=${(e: CustomEvent<{ message: string }>) => say(e.detail.message)}
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
        const registered = shortcuts.register(def, () => run(command.capability, command.extra?.(selection().length) ?? {}, command.empty === true ? [] : selection()), { scope, when: () => command.empty === true || selection().length > 0 });
        if (!registered.ok) problem(registered.error);
      }
      // The clipboard keys (cheat sheet rows; the browser's events do the work) and the clipboard events in Studio.
      for (const def of Object.values(ClipboardShortcuts)) {
        const registered = shortcuts.register(def, () => false, { scope });
        if (!registered.ok) problem(registered.error);
      }
      clip.attach(doc, (e) => e.composedPath().includes(mounted), scope);
      // B11c audit: the text formatting keys the inspector and the pill show (⌘B ⌘I ⌘U ⌘⇧X ⌘. ⌘, ⌘⇧L/E/R/J), while editing.
      const editingText = (): boolean => view()?.editing !== undefined;
      const textSelected = (): boolean => scene.read('selection').kind === 'text';
      const textKeys = bindTextKeys({ registry: shortcuts, text: typography, summary: () => typographyView.read('summary'), editing: editingText, textSelected, problem: say, scope });
      if (textKeys !== undefined && !textKeys.ok) problem(textKeys.error);
      let textScope: (() => void) | undefined;
      watch(
        () => editingText() || textSelected(),
        (on) => {
          if (on && textScope === undefined) textScope = shortcuts.activate(TextEditingShortcutScope, scope);
          if (!on) {
            textScope?.();
            textScope = undefined;
          }
        },
        { scope, fireImmediately: true },
      );
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
      writeShortcutsSnapshot(storage, sheetGroups());
      void applyLink(options.link ?? {}).then(() => linkedDone(), (error: unknown) => {
        console.warn('[studio] the link could not be applied', error);
        linkedDone();
      });
      return mounted;
    },
  };
  const openedSpec = await studio.open(signal);
  if (!openedSpec.ok) return openedSpec;
  if (settings.current.density !== studio.density) {
    const dense = await studio.setDensity(settings.current.density, signal);
    if (!dense.ok) problem(dense.error);
  }
  return ok(app);
}
