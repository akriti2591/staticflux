/**
 * The Studio app (B8; IF-27.14–27.24): the composition root that turns M1b's headless services and contributions
 * into the Studio a person can click through. Wire, don't rebuild: everything here is glue.
 *
 * - **Vocabulary** (`registries.ts`): B0's placeholders replaced by the real contributions; panels that take their
 *   model from the host are bound when they render (B1's Fill / stroke / effects, B7's Repeat).
 * - **Services** for the panels, in the UI scope's injector: B2 typography, B4 lens controller + story writer and
 *   library panel model, B5 Latest + milestones panel model.
 * - **Capabilities** (one pipeline for HUD, shortcuts and agents): B1 element actions, B7 repeat, B3 transforms, B6
 *   describe, B5 create milestone; the actor of a run comes from the stage attribution port.
 * - **Canvas** (`studio-canvas.ts`): one canvas tab on the page the lens controller focuses.
 * - **Glue**: Studio's scope follows the canvas selection (the selection's HUD actions and inspectors mount); HUD
 *   clicks run their capability on the selection; the Milestone button creates a milestone; zoom buttons and the
 *   zoom readout; the library's Place puts an image on the page; results and problems are announced politely.
 */
import { type Announcer, createAnnouncer, createShortcutRegistry, type ShortcutRegistry, type Timers } from '@staticflux/a11y';
import { alwaysActivePort, allowAllDecidePort, type CapabilityRegistry, createCapabilityRegistry, failClosedConfirmPort, type RunContext, unmeteredPort } from '@staticflux/capabilities';
import { box, createInjector, err, type Injector, ok, type Result, type Scope, type SfError, unit, watch } from '@staticflux/core';
import type { NodeId, OpenDocument } from '@staticflux/document/v2';
import { createGate, definePolicy, definePolicySet } from '@staticflux/gate';
import { type Actor, createAttributionPort } from '@staticflux/stage';
import type { TextInputFactory } from '@staticflux/surface/text-input';
import { defineUiElements, gateResource, provideScope } from '@staticflux/ui';
import { html, render } from 'lit';
import { ref } from 'lit/directives/ref.js';
import { a11yCapabilityImplementations } from '../a11y/contributions.js';
import { commitEdit } from '../elements/actions.js';
import { APPEARANCE_PANEL_ID, elementCapabilityImplementations } from '../elements/contributions.js';
import type { GeometryService } from '../elements/geometry.js';
import { appearanceEditOps, appearanceModel } from '../elements/inspector.js';
import { bindPaintInspector, definePaintInspector, type IfPaintInspectorElement } from '../elements/panel.js';
import { canvasLensFeature } from '../lenses/canvas-lens.js';
import type { LensController } from '../lenses/controller.js';
import { createLensFeatureRegistry } from '../lenses/lens-features.js';
import { pagesLensFeature } from '../lenses/pages-lens.js';
import { LensControllerToken, StoryWriterToken } from '../lenses/tokens.js';
import { createLensServices } from '../lenses/units.js';
import type { LibraryEntry } from '../library/library-doc.js';
import { browserObjectUrls, browserPickFiles, type LibraryHost } from '../library/panel-model.js';
import type { ImageDecoder, ImageEncoder, ThumbnailRenderer } from '../library/renditions.js';
import { browserImageDecoder, pngImageEncoder, scaleThumbnailRenderer } from '../library/thumbnails.js';
import { LibraryPanelModelToken } from '../library/tokens.js';
import { createLibraryServices } from '../library/units.js';
import { commitRepeatEdit } from '../repeat/actions.js';
import { REPEAT_PANEL_ID, repeatCapabilityImplementations } from '../repeat/contributions.js';
import { repeatEditOps, repeatModel } from '../repeat/inspector.js';
import { bindRepeatInspector, defineRepeatInspector, type IfRepeatInspectorElement } from '../repeat/panel.js';
import { editDocumentCapability, proposeSpecCapability } from '../spec/capabilities.js';
import type { ActionId, PanelContribution, ToolId } from '../spec/contributions.js';
import { gateSpecDecide } from '../spec/gate.js';
import type { EditorRegistries } from '../spec/registries.js';
import type { ScopeRef } from '../spec/schema.js';
import { createStudio, type Studio } from '../studio/studio.js';
import { defineStudio, type IfStudioElement } from '../studio/studio-element.js';
import { TEXT_HUD_COMMANDS } from '../text/contributions.js';
import { readTextBlock } from '../text/rich-text.js';
import { createTypographyService, type TypographyService, TypographyServiceToken } from '../text/typography.js';
import { defineTypographyPanel } from '../text/typography-panel.js';
import { toolCapabilityImplementations } from '../tools/contributions.js';
import { toPage } from '../tools/view-state.js';
import { CreateMilestoneCapability, implementCreateMilestone } from '../versioning/command.js';
import { defineSaveStatus } from '../versioning/save-status.js';
import { LatestServiceToken, MilestonesPanelModelToken } from '../versioning/tokens.js';
import { createVersioningServices } from '../versioning/units.js';
import type { CanvasTab } from './canvas-tab.js';
import { openStudioDocument, type StudioDocument, type StudioWorkspace } from './document.js';
import { NoOpenPageError } from './errors.js';
import { createImageUploads, placeImageOps } from './images.js';
import { studioAppRegistries } from './registries.js';
import { type RasterFactory, type StudioCanvas, studioCanvas } from './studio-canvas.js';
import { textBoxOps, type StudioFonts } from './text-layer.js';

export interface StudioAppOptions {
  readonly workspace: StudioWorkspace;
  readonly doc: OpenDocument;
  readonly title: string;
  readonly geometry: GeometryService;
  readonly fonts: StudioFonts;
  /** The person (guest identity, D3). */
  readonly person: Actor;
  readonly raster: RasterFactory;
  readonly textInput?: TextInputFactory;
  /** Library media (browser defaults). */
  readonly library?: { readonly decoder?: ImageDecoder; readonly renderer?: ThumbnailRenderer; readonly encoder?: ImageEncoder; readonly pickFiles?: LibraryHost['pickFiles'] };
  readonly timers?: Timers;
  readonly schedule?: (fn: () => void) => void;
  readonly isMac?: boolean;
  readonly scope: Scope;
}

export interface StudioApp {
  readonly studio: Studio;
  readonly registries: EditorRegistries;
  readonly document: StudioDocument;
  readonly capabilities: CapabilityRegistry;
  readonly canvas: StudioCanvas;
  readonly injector: Injector;
  readonly shortcuts: ShortcutRegistry;
  readonly lens: LensController;
  readonly typography: TypographyService;
  /** The open canvas tab (after the canvas started). */
  readonly tab: CanvasTab | undefined;
  /** Render `<if-studio>` into `container` (inside the UI scope). */
  mount(container: HTMLElement): IfStudioElement;
  /** Run a HUD action on the selection (what a HUD click does). */
  runHudAction(action: ActionId): Promise<Result<unknown>>;
  createMilestone(name?: string): Promise<Result<unknown>>;
  place(entry: LibraryEntry, signal: AbortSignal): Promise<Result<void>>;
  /** Messages spoken in the polite live region (the last few; tests and the smoke check read them). */
  readonly spoken: readonly string[];
}

/** HUD action → capability input from the selection (data; the default is `{ nodes }`). */
const HUD_INPUTS: Readonly<Record<string, (nodes: readonly NodeId[]) => unknown>> = Object.freeze({
  'instaflow/describe-canvas': (nodes: readonly NodeId[]) => ({ what: nodes.length > 0 ? 'selection' : 'visible' }),
});

/** Capability outputs the HUD speaks (`text`), else a short confirmation. */
const spokenResult = (label: string, value: unknown): string => (typeof (value as { text?: unknown })?.text === 'string' ? (value as { text: string }).text : `${label} done`);

/** Open Studio over a document (see the module header). */
export async function createStudioApp(options: StudioAppOptions): Promise<Result<StudioApp>> {
  const { scope, workspace, person } = options;
  const signal = scope.signal;
  const opened = await openStudioDocument({ workspace, doc: options.doc, geometry: options.geometry, signal, scope });
  if (!opened.ok) return opened;
  const document = opened.value;
  const tabBox = box<CanvasTab | undefined>(undefined);
  const tab = (): CanvasTab | undefined => tabBox.get();
  const actor = (): Actor => person;
  const attribution = createAttributionPort({ human: () => ({ id: person.id, displayName: person.displayName ?? person.id }) });
  const actorFor = (run: RunContext): Result<Actor> => attribution.actorFor(run);
  const spoken: string[] = [];
  let announcer: Pick<Announcer, 'announce'> = { announce: (m) => void spoken.push(m) };
  const say = (message: string): void => {
    spoken.push(message);
    if (spoken.length > 20) spoken.shift();
    announcer.announce(message);
  };
  const problem = (error: SfError): void => say(error.message);
  const timers: Timers = options.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  const schedule = options.schedule ?? ((fn: () => void) => requestAnimationFrame(() => fn()));
  const selection = (): readonly NodeId[] => tab()?.view.selection ?? [];
  const page = (): NodeId => tab()?.page ?? document.pages[0]?.id ?? 'p1';
  const watchSelection = (listener: () => void): (() => void) => {
    const stopWatch = watch(() => [tabBox.get(), tabBox.get()?.view.selection] as const, listener);
    const stopDoc = document.view.onInvalidate(listener);
    return () => {
      stopWatch();
      stopDoc();
    };
  };

  // ---------------------------------------------------------------- panel sources
  const single = (): NodeId | undefined => (selection().length === 1 ? selection()[0] : undefined);
  const appearance = {
    model: () => {
      const node = single();
      return node === undefined ? undefined : appearanceModel(document.view, node, document.kit);
    },
    subscribe: watchSelection,
    apply(edit: Parameters<typeof appearanceEditOps>[1]) {
      const model = appearance.model();
      if (model === undefined) return;
      const done = commitEdit(document.target(page()), actor(), 'Edit appearance', appearanceEditOps(model, edit));
      if (!done.ok) problem(done.error);
    },
  };
  const repeat = {
    model: () => {
      const node = single();
      return node === undefined ? undefined : repeatModel(document.context(), node);
    },
    subscribe: watchSelection,
    apply(edit: Parameters<typeof repeatEditOps>[2]) {
      const node = single();
      if (node === undefined) return;
      const ctx = document.context();
      const done = commitRepeatEdit(document.target(page()), actor(), 'Edit repeat', repeatEditOps(ctx, node, edit), (n) => ctx.stage.params(n));
      if (!done.ok) problem(done.error);
    },
  };
  const BINDERS: Readonly<Record<string, (element: Element) => () => void>> = {
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
  const typography = createTypographyService({
    current: () => {
      const node = single();
      const part = document.part(page());
      if (node === undefined || part === undefined || document.view.read(node)?.kind !== 'text') return undefined;
      const block = readTextBlock(part, node);
      if (!block.ok) return undefined;
      const editing = tab()?.editing;
      const [from, to] = editing?.node === node && editing.session.selection[0] !== editing.session.selection[1] ? editing.session.selection : [0, block.value.text.length];
      return { block: block.value, from, to };
    },
    commit: (ops, label) => {
      const node = single();
      const committed = document.commitOps(page(), actor(), label, ops);
      if (!committed.ok || node === undefined) return committed;
      const laid = tab()?.text.layout(node);
      return laid === undefined || !laid.ok ? committed : document.commitOps(page(), actor(), label, textBoxOps(document, node, laid.value));
    },
    defaults: { size: options.fonts.defaults.size },
    fonts: () => options.fonts.engine.fonts.map((f) => ({ label: f.families[0] ?? f.hash.slice(7, 15), value: { font: f.hash as `sha256:${string}`, ...(f.families[0] === undefined ? {} : { family: f.families[0] }) } })),
    watch: watchSelection,
  });
  const features = createLensFeatureRegistry([pagesLensFeature, canvasLensFeature]);
  if (!features.ok) return features;
  const studioBox = box<Studio | undefined>(undefined);
  const lens = createLensServices(
    { doc: options.doc, root: document.root, lens: () => studioBox.get()?.lens?.id, viewport: () => tab()?.view.viewport ?? { width: 960, height: 640 }, camera: { show: () => undefined }, actor },
    features.value,
    scope,
  );
  const uploads = createImageUploads({ blobs: workspace.blobs, decoder: options.library?.decoder ?? browserImageDecoder() });
  let assets = 0;
  const library = createLibraryServices(
    {
      document: workspace.library,
      blobs: workspace.blobs,
      actor,
      newAssetId: () => `as_${Date.now().toString(36)}${(assets += 1)}` as never,
      host: { pickFiles: options.library?.pickFiles ?? ((s) => browserPickFiles(s)), place: (entry, s) => app.place(entry, s) },
      decoder: options.library?.decoder ?? browserImageDecoder(),
      renderer: options.library?.renderer ?? scaleThumbnailRenderer(),
      encoder: options.library?.encoder ?? pngImageEncoder(),
      urls: browserObjectUrls,
    },
    scope,
  );
  const versioning = createVersioningServices(
    {
      doc: options.doc,
      store: workspace.store,
      engine: workspace.engine,
      host: { showReadOnly: () => say('Read-only milestone view arrives with C3.'), showComparison: () => say('Compare view arrives with C3.'), openDocument: (asset) => say(`New document ${asset} created.`) },
      actor,
      newAssetId: () => `as_${Date.now().toString(36)}${(assets += 1)}` as never,
      title: () => options.title,
    },
    scope,
  );
  const injector = createInjector({
    units: [
      unit({ id: 'instaflow/studio-typography', provides: TypographyServiceToken, scope: 'app', create: () => typography }),
      unit({ id: 'instaflow/studio-lens-controller', provides: LensControllerToken, scope: 'app', create: () => lens.controller }),
      unit({ id: 'instaflow/studio-story-writer', provides: StoryWriterToken, scope: 'app', create: () => lens.story }),
      unit({ id: 'instaflow/studio-library-panel', provides: LibraryPanelModelToken, scope: 'app', create: () => library.panel }),
      unit({ id: 'instaflow/studio-milestones-panel', provides: MilestonesPanelModelToken, scope: 'app', create: () => versioning.panel }),
      unit({ id: 'instaflow/studio-latest', provides: LatestServiceToken, scope: 'app', create: () => versioning.latest }),
    ],
    idle: (cb) => setTimeout(cb, 0),
  });
  scope.defer(() => injector.dispose());

  // ---------------------------------------------------------------- capabilities
  const elementEnv = { context: () => document.context(), target: () => document.target(page()), actorFor };
  const capabilities = createCapabilityRegistry({
    decide: allowAllDecidePort,
    confirm: failClosedConfirmPort,
    meter: unmeteredPort,
    activation: alwaysActivePort,
    declarations: registries.value.vocabulary.list('capability').flatMap((c) => {
      const cap = registries.value.capability(c.id);
      return cap === undefined ? [] : [cap];
    }),
    implementations: [
      ...elementCapabilityImplementations(elementEnv),
      ...repeatCapabilityImplementations(elementEnv),
      ...toolCapabilityImplementations({ session: () => tab()?.tools, actorFor }),
      ...a11yCapabilityImplementations({ canvas: () => tab()?.a11y }),
      implementCreateMilestone({ milestones: versioning.milestones, actorFor, prompt: () => say('Name the milestone in the Milestones panel.') }),
    ],
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
    document,
    page: page(),
    fonts: options.fonts,
    raster: options.raster,
    actor,
    tool: () => studio.activeTool,
    selectTool: (tool: ToolId) => void studio.selectTool(tool),
    shortcuts,
    ...(options.textInput === undefined ? {} : { textInput: (host: HTMLElement, label: string) => (options.textInput as TextInputFactory).create({ host, label }) }),
    announcer: { announce: (m) => announcer.announce(m) },
    timers,
    schedule,
    images: uploads,
    onProblem: problem,
    onTab: (next) => tabBox.set(next),
  });

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
  watch(
    () => selection(),
    (nodes) => {
      const usable = nodes.filter((n) => document.view.read(n) !== undefined).slice(0, 1024);
      wanted = usable.length === 0 ? { kind: 'asset' } : { kind: 'selection', nodes: usable };
      void applyScope();
    },
    { scope },
  );
  // The Pages panel (lens controller) chooses the page the canvas shows.
  watch(
    () => lens.controller.current(),
    (current) => {
      if (current !== undefined && current !== tab()?.page && document.part(current) !== undefined) void canvas.showPage(current).then((r) => (r.ok ? undefined : problem(r.error)));
    },
    { scope },
  );

  const runHudAction = async (action: ActionId): Promise<Result<unknown>> => {
    const hud = registries.value.hud(action);
    if (hud === undefined) return ok(undefined);
    const command = TEXT_HUD_COMMANDS[action];
    if (command !== undefined) {
      const done = command(typography);
      if (!done.ok) problem(done.error);
      return done;
    }
    if (hud.capability === undefined) {
      say(`${hud.label} arrives in a later milestone.`);
      return ok(undefined);
    }
    const nodes = selection().filter((n) => document.view.read(n) !== undefined);
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
      say(`Milestone created: ${(result.value as { name?: string }).name ?? ''}`);
      void versioning.panel.refresh();
    } else problem(result.error);
    return result;
  };

  const app: StudioApp = {
    studio,
    registries: registries.value,
    document,
    capabilities,
    canvas,
    injector,
    shortcuts,
    lens: lens.controller,
    typography,
    get tab() {
      return tab();
    },
    spoken,
    runHudAction,
    createMilestone,
    async place(entry, s) {
      const current = tab();
      if (current === undefined) return err(NoOpenPageError());
      const size = await uploads.upload(entry, s);
      if (!size.ok) return size;
      const view = current.view;
      const center = toPage(view.camera, view.viewport.width / 2, view.viewport.height / 2);
      const node = document.newId();
      const done = commitEdit(document.target(current.page), actor(), `Place ${entry.title}`, ok(placeImageOps(node, view.context, entry, size.value, center, 600)));
      if (!done.ok) return done;
      view.select([node]);
      return ok();
    },
    mount(container) {
      defineUiElements();
      defineStudio();
      definePaintInspector();
      defineRepeatInspector();
      defineTypographyPanel();
      defineSaveStatus();
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
          asset-title=${options.title}
          project-title="Instaflow"
          @if-hud-action=${(e: CustomEvent<{ action: ActionId }>) => void runHudAction(e.detail.action)}
          @if-intent=${(e: CustomEvent<{ intent: string }>) => {
            const intents: Readonly<Record<string, () => void>> = {
              milestone: () => void createMilestone(),
              'zoom-in': () => void tab()?.commands.zoomStep(1),
              'zoom-out': () => void tab()?.commands.zoomStep(-1),
              share: () => say('Sharing arrives with export (C1).'),
            };
            intents[e.detail.intent]?.();
          }}
        ></if-studio>`,
        container,
      );
      const element = container.querySelector('if-studio') as IfStudioElement;
      watch(
        () => tabBox.get()?.view.camera.zoom,
        (zoom) => {
          if (zoom !== undefined) element.zoom = zoom;
        },
        { scope, fireImmediately: true },
      );
      scope.defer(() => render(html``, container));
      return element;
    },
  };
  const openedSpec = await studio.open(signal);
  if (!openedSpec.ok) return openedSpec;
  return ok(app);
}
