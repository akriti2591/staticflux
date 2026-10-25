/**
 * Studio's editor module (B9, IF-33.4–33.13; D15, ARCHITECTURE §2): everything that decides, in the editor worker.
 *
 * - **Document** (A3 repo over the store port; D14 parts; B1 stage with brand rules; B7 repeat view; one undo
 *   service), **versioning** (B5: Latest, milestones; capture reads the live parts, writes go to the store port) and
 *   **story** edits (B4).
 * - **The tab** (`../app/canvas-tab.ts`): B3 view state, tools, snapping, creation tools and the overlay, B2 text
 *   layout and the editing session (over the TextInput port), B6's projector and announcer, attached to the canvas
 *   publisher (scene records first, then the view frame).
 * - **Input**: compact events drained from A5's ring (`handle`): pointer and wheel to the tab, keys through a
 *   worker-side shortcut registry with the canvas scope active (main forwards keys only when they belong to the
 *   canvas); double click by time and distance (the ring carries no click count).
 * - **Read projections** for main: the view, mirrors (typography, appearance, repeat, milestones, Latest, story),
 *   accessibility snapshots, distance labels, the text host's commands, announcements and problems (`EditorEvents`).
 * - **Capabilities**: the implementations behind main's registry (`invoke`), attributed like B8 did on main.
 *
 * Nothing here touches the DOM or the GPU; the module never asks which topology it runs in.
 */
import { createShortcutRegistry, type Timers } from '@staticflux/a11y';
import type { BlobStore } from '@staticflux/blob';
import { type AnyCapabilityImplementation, type CapabilitySubject, type InvocationOrigin, type RunContext } from '@staticflux/capabilities';
import { box, createNoopTelemetry, createScope, err, ok, type Result, type Scope, type SfError, watch } from '@staticflux/core';
import { type CrdtEngine, createDocumentRepo, type DocumentStore, type NodeId, type OpenDocument } from '@staticflux/document/v2';
import { type Actor, createAttributionPort } from '@staticflux/stage';
import { type CompactInputEvent, InputCode, InputModifier } from '@staticflux/surface';
import type { TextInputKind } from '@staticflux/surface/text-input';
import type { CanvasSnapshot } from '../a11y/projection.js';
import { a11yCapabilityImplementations } from '../a11y/contributions.js';
import type { CanvasPublisher } from '../app/canvas-pipeline.js';
import { type CanvasTab, openCanvasTab } from '../app/canvas-tab.js';
import { createStudioDocument, freshPeer, openStudioDocument, type StudioDocument } from '../app/document.js';
import { NoOpenPageError } from '../app/errors.js';
import { createImageUploads, placeImageOps } from '../app/images.js';
import { textBoxOps, type StudioFonts } from '../app/text-layer.js';
import { commitEdit } from '../elements/actions.js';
import { elementCapabilityImplementations } from '../elements/capabilities.js';
import { P } from '../elements/components.js';
import type { GeometryService } from '../elements/geometry.js';
import { appearanceEditOps, appearanceModel } from '../elements/inspector.js';
import { createStoryWriter } from '../lenses/story.js';
import { structureFeed } from '../lenses/structure.js';
import type { LibraryEntry } from '../library/library-doc.js';
import type { ImageDecoder } from '../library/renditions.js';
import { commitRepeatEdit } from '../repeat/actions.js';
import { repeatCapabilityImplementations } from '../repeat/capabilities.js';
import { repeatEditOps, repeatModel } from '../repeat/inspector.js';
import type { ToolId } from '../spec/contributions.js';
import { TEXT_HUD_COMMANDS } from '../text/commands.js';
import { readTextBlock } from '../text/rich-text.js';
import { createTypographyService, type TypographyService } from '../text/typography.js';
import { toolCapabilityImplementations } from '../tools/contributions.js';
import { CanvasToolsShortcutScope } from '../tools/keyboard.js';
import type { GuideLabel } from '../tools/snapping.js';
import { type Camera, toPage } from '../tools/view-state.js';
import { implementCreateMilestone } from '../versioning/command.js';
import { createVersioningServices } from '../versioning/units.js';
import { CapabilityNotServedError, WorkerBootError } from './errors.js';
import { createMirrorServers, type MirrorCall, type MirrorServers, type MirrorUpdate } from './mirror.js';
import { AppearanceMirror, LatestMirror, MilestonesMirror, RepeatMirror, StoryMirror, TypographyMirror } from './mirrors.js';
import type { InspectedElement, StudioDocumentRef, StudioInspection, StudioStarted, ViewProjection } from './protocol.js';
import { createRemoteTextHost, type TextHostCommand, type TextHostEvent } from './text-port.js';

/** What the editor posts to main (the host turns each into a protocol event). */
export interface EditorEvents {
  view(projection: ViewProjection): void;
  mirror(update: MirrorUpdate): void;
  a11y(snapshot: CanvasSnapshot): void;
  labels(labels: readonly GuideLabel[], camera: Camera): void;
  text(command: TextHostCommand): void;
  announce(message: string): void;
  problem(error: SfError): void;
  /** A creation tool finished: Studio's toolbar goes back to `tool`. */
  tool(tool: string): void;
}

/** What the editor worker loaded (engine Wasm, fonts): the browser entry loads them, tests use fixtures. */
export interface EditorEnv {
  readonly engine: CrdtEngine;
  readonly geometry: GeometryService;
  readonly fonts: StudioFonts;
  readonly decoder: ImageDecoder;
}

export interface StudioEditorOptions {
  readonly env: EditorEnv;
  /** The store port (`remoteDocumentStore`) and blob reads (`remoteBlobs`). */
  readonly store: DocumentStore;
  readonly blobs: Pick<BlobStore, 'get'>;
  readonly document: StudioDocumentRef;
  readonly person: Actor;
  readonly isMac: boolean;
  readonly textInput?: TextInputKind;
  readonly publisher: CanvasPublisher;
  readonly events: EditorEvents;
  readonly timers?: Timers;
  /** Publish coalescing (default a microtask: draw on arrival). */
  readonly schedule?: (fn: () => void) => void;
  /** Accessibility projection coalescing (default `requestAnimationFrame` where there is one, else a timeout). */
  readonly frame?: (fn: () => void) => void;
  readonly scope: Scope;
}

export interface EditorInputCounters {
  readonly inputSeq: number;
  readonly inputTs: number;
  readonly batchSeq: number;
  readonly batches: number;
}

export interface StudioEditor {
  readonly document: StudioDocument;
  readonly tab: CanvasTab | undefined;
  readonly started: StudioStarted;
  readonly typography: TypographyService;
  readonly mirrors: MirrorServers;
  /** Input consumed so far (the publisher's frame metadata). */
  readonly input: EditorInputCounters;
  /** Open `page` in the tab (a page switch: the publisher snapshots the new page). */
  open(page: NodeId, viewport: { readonly width: number; readonly height: number }): Promise<Result<void>>;
  /** Apply drained input events (`seq`: their forwarder batch). */
  handle(events: readonly CompactInputEvent[], seq: number | undefined): void;
  setTool(tool: string): void;
  setViewport(width: number, height: number): void;
  /** Accessibility focus (or a panel) selected nodes. */
  select(nodes: readonly NodeId[]): void;
  invoke(call: { readonly capability: string; readonly input: unknown; readonly subject: CapabilitySubject; readonly origin?: InvocationOrigin; readonly invocationId: string }, signal: AbortSignal): Promise<Result<unknown>>;
  call(call: MirrorCall): Promise<Result<unknown>>;
  text(event: TextHostEvent): void;
  place(entry: LibraryEntry, signal: AbortSignal): Promise<Result<void>>;
  hud(action: string): Result<void>;
  inspect(nodes?: readonly NodeId[]): StudioInspection;
}

/** Double click: a second press within this time and distance (the ring carries no click count). */
export const DOUBLE_CLICK = Object.freeze({ ms: 500, px: 4 });

const microtask = (fn: () => void): void => queueMicrotask(fn);
const defaultFrame = (): ((fn: () => void) => void) => {
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => unknown }).requestAnimationFrame;
  return typeof raf === 'function' ? (fn) => void raf.call(globalThis, fn) : (fn) => void setTimeout(fn, 16);
};
const defaultTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
const telemetry = createNoopTelemetry();

const SEED_DOCUMENT_STEP = 'open document';

/** Open the document and every editor service (see the module header). Failures are IF-WRK-001. */
export async function createStudioEditor(options: StudioEditorOptions): Promise<Result<StudioEditor>> {
  const { env, events, scope } = options;
  const signal = scope.signal;
  const failed = (step: string, cause?: SfError): Result<never> => err(WorkerBootError({ ...(cause === undefined ? {} : { cause }), details: { step } }));
  const repo = createDocumentRepo({ store: options.store, engine: env.engine, peer: freshPeer });
  const ref = options.document;
  const head = await options.store.readHead(ref.asset, signal);
  if (!head.ok) return failed(SEED_DOCUMENT_STEP, head.error);
  let doc: OpenDocument;
  if (head.value === undefined && ref.create !== undefined) {
    const created = await createStudioDocument({ repo }, { asset: ref.asset, title: ref.title, pages: ref.create.pages, ...(ref.create.size === undefined ? {} : { size: ref.create.size }), signal });
    if (!created.ok) return failed('create document', created.error);
    doc = created.value;
  } else {
    const opened = await repo.open(ref.asset, signal);
    if (!opened.ok) return failed(SEED_DOCUMENT_STEP, opened.error);
    doc = opened.value;
  }
  scope.defer(() => void doc.close(new AbortController().signal, { compact: false }));
  const studio = await openStudioDocument({ workspace: { engine: env.engine }, doc, geometry: env.geometry, signal, scope });
  if (!studio.ok) return failed('open studio document', studio.error);
  const document = studio.value;

  const schedule = options.schedule ?? microtask;
  const frame = options.frame ?? defaultFrame();
  const timers = options.timers ?? defaultTimers;
  const person = options.person;
  const actor = (): Actor => person;
  const attribution = createAttributionPort({ human: () => ({ id: person.id, displayName: person.displayName ?? person.id }) });
  const actorFor = (run: RunContext): Result<Actor> => attribution.actorFor(run);
  const tabBox = box<CanvasTab | undefined>(undefined);
  const editingBox = box<NodeId | undefined>(undefined);
  const toolBox = box<ToolId | undefined>(undefined);
  const tab = (): CanvasTab | undefined => tabBox.get();
  const page = (): NodeId => tab()?.page ?? document.pages[0]?.id ?? 'p1';
  const selection = (): readonly NodeId[] => tab()?.view.selection ?? [];
  const single = (): NodeId | undefined => (selection().length === 1 ? selection()[0] : undefined);
  const problem = (error: SfError): void => events.problem(error);
  const announce = (message: string): void => events.announce(message);
  const docChanges = (listener: () => void): (() => void) => document.view.onInvalidate(() => listener());

  // ---------------------------------------------------------------- services
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
    defaults: { size: env.fonts.defaults.size },
    fonts: () => env.fonts.engine.fonts.map((f) => ({ label: f.families[0] ?? f.hash.slice(7, 15), value: { font: f.hash as `sha256:${string}`, ...(f.families[0] === undefined ? {} : { family: f.families[0] }) } })),
    watch: docChanges,
  });
  let assets = 0;
  const newAssetId = (): never => `as_${Date.now().toString(36)}${(assets += 1)}` as never;
  const versioning = createVersioningServices(
    {
      doc,
      store: options.store,
      engine: env.engine,
      host: { showReadOnly: () => announce('Read-only milestone view arrives with C3.'), showComparison: () => announce('Compare view arrives with C3.'), openDocument: (asset) => announce(`New document ${asset} created.`) },
      actor,
      newAssetId,
      title: () => ref.title,
    },
    scope,
  );
  const structure = structureFeed(document.root);
  const story = createStoryWriter({ doc, structure: () => structure.read(), actor });
  const uploads = createImageUploads({ blobs: options.blobs, decoder: env.decoder });

  // ---------------------------------------------------------------- capabilities
  const elementEnv = { context: () => document.context(), target: () => document.target(page()), actorFor };
  const implementations: readonly AnyCapabilityImplementation[] = [
    ...elementCapabilityImplementations(elementEnv),
    ...repeatCapabilityImplementations(elementEnv),
    ...toolCapabilityImplementations({ session: () => tab()?.tools, actorFor }),
    ...a11yCapabilityImplementations({ canvas: () => tab()?.a11y }),
    implementCreateMilestone({ milestones: versioning.milestones, actorFor, prompt: () => announce('Name the milestone in the Milestones panel.') }),
  ];
  const byId = new Map(implementations.map((impl) => [impl.capability.id as string, impl]));

  // ---------------------------------------------------------------- mirrors
  const mirrors = createMirrorServers((update) => events.mirror(update), { schedule });
  mirrors.serve(
    TypographyMirror,
    {
      reads: { summary: () => typography.summary(), fonts: () => typography.fontChoices(), colors: () => typography.colorChoices() },
      actions: {
        setFont: (font) => typography.setFont(font),
        setSize: (size) => typography.setSize(size),
        setWeight: (weight) => typography.setWeight(weight),
        toggle: (key) => typography.toggle(key),
        setColor: (color) => typography.setColor(color),
        setLetterSpacing: (px) => typography.setLetterSpacing(px),
        setLink: (href) => typography.setLink(href),
        setAlign: (align) => typography.setAlign(align),
        setLineHeight: (multiple) => typography.setLineHeight(multiple),
        fitToBox: () => typography.fitToBox(),
      },
      changes: docChanges,
    },
    scope,
  );
  const appearance = (): ReturnType<typeof appearanceModel> => {
    const node = single();
    return node === undefined ? undefined : appearanceModel(document.view, node, document.kit);
  };
  mirrors.serve(
    AppearanceMirror,
    {
      reads: { model: appearance },
      actions: {
        apply(edit) {
          const model = appearance();
          if (model === undefined) return err(NoOpenPageError({ message: 'Select one element to edit its appearance.' }));
          return commitEdit(document.target(page()), actor(), 'Edit appearance', appearanceEditOps(model, edit));
        },
      },
      changes: docChanges,
    },
    scope,
  );
  mirrors.serve(
    RepeatMirror,
    {
      reads: {
        model: () => {
          const node = single();
          return node === undefined ? undefined : repeatModel(document.context(), node);
        },
      },
      actions: {
        apply(edit) {
          const node = single();
          if (node === undefined) return err(NoOpenPageError({ message: 'Select one repeat to edit it.' }));
          const ctx = document.context();
          return commitRepeatEdit(document.target(page()), actor(), 'Edit repeat', repeatEditOps(ctx, node, edit), (n) => ctx.stage.params(n));
        },
      },
      changes: docChanges,
    },
    scope,
  );
  const plain = async (run: Promise<Result<unknown>>): Promise<Result<void>> => {
    const r = await run;
    return r.ok ? ok() : r;
  };
  const panel = versioning.panel;
  mirrors.serve(
    MilestonesMirror,
    {
      reads: { milestones: () => panel.milestones(), busy: () => panel.busy() },
      actions: {
        refresh: () => panel.refresh(),
        create: (name, note) => panel.create(name, note),
        pin: (id, pinned) => panel.pin(id, pinned),
        rename: (id, name) => panel.rename(id, name),
        open: (id) => plain(panel.open(id)),
        compare: (left, right) => plain(panel.compare(left, right)),
        newDocument: (id) => plain(panel.newDocument(id)),
      },
    },
    scope,
  );
  mirrors.serve(LatestMirror, { reads: { state: () => versioning.latest.state() }, actions: { flush: () => versioning.latest.flush(signal) }, changes: (l) => versioning.latest.onChange(() => l()) }, scope);
  mirrors.serve(StoryMirror, { reads: { structure: () => structure.read() }, actions: { movePage: (p, to) => story.movePage(p, to) }, changes: (l) => structure.observe(l) }, scope);

  // ---------------------------------------------------------------- the tab
  const textHost = options.textInput === undefined ? undefined : createRemoteTextHost((command) => events.text(command), options.textInput);
  const shortcuts = createShortcutRegistry({ isMac: options.isMac });
  // Keys reach the editor only when they belong to the canvas (main filters them): the canvas scope is always on.
  shortcuts.activate(CanvasToolsShortcutScope, scope);
  let tabScope: Scope | undefined;
  const open = async (target: NodeId, viewport: { readonly width: number; readonly height: number }): Promise<Result<void>> => {
    const previous = tabScope;
    tabBox.set(undefined);
    editingBox.set(undefined);
    await previous?.dispose();
    const next = createScope(`instaflow/editor-tab:${target}`);
    tabScope = next;
    scope.defer(() => next.dispose());
    const opened = await openCanvasTab({
      tab: 'main',
      document,
      page: target,
      fonts: env.fonts,
      publisher: options.publisher,
      viewport,
      actor,
      tool: () => toolBox.get(),
      selectTool: (tool) => {
        toolBox.set(tool);
        events.tool(tool);
      },
      shortcuts,
      ...(textHost === undefined ? {} : { textHost }),
      announcer: { announce },
      timers,
      schedule,
      a11ySchedule: frame,
      images: uploads,
      onLabels: (labels, camera) => events.labels(labels, camera),
      onSnapshot: (snapshot) => events.a11y(snapshot),
      onEditing: (node) => editingBox.set(node),
      onProblem: problem,
      scope: next,
    });
    if (!opened.ok) {
      await next.dispose();
      return opened;
    }
    tabBox.set(opened.value);
    return ok();
  };

  // ---------------------------------------------------------------- view projection
  let lastView = '';
  watch(
    (): ViewProjection => {
      const t = tabBox.get();
      return {
        page: t?.page,
        pages: document.pages.map((p) => p.id),
        tool: t?.view.tool ?? toolBox.get() ?? 'instaflow/select',
        selection: t?.view.selection ?? [],
        context: t?.view.context,
        camera: t?.view.camera ?? { tx: 0, ty: 0, zoom: 1 },
        viewport: t?.view.viewport ?? { width: 0, height: 0 },
        editing: editingBox.get(),
        gesture: t?.controller.state ?? 'idle',
      };
    },
    (projection) => {
      const json = JSON.stringify(projection);
      if (json === lastView) return;
      lastView = json;
      events.view(projection);
    },
    { scope, fireImmediately: true },
  );

  // ---------------------------------------------------------------- input
  const counters = { inputSeq: 0, inputTs: 0, batchSeq: 0, batches: 0 };
  let lastDown: { readonly ts: number; readonly x: number; readonly y: number; clicks: number } | undefined;
  const mods = (m: number): { shift: boolean; alt: boolean; mod: boolean } => ({ shift: (m & InputModifier.shift) !== 0, alt: (m & InputModifier.alt) !== 0, mod: (m & (InputModifier.ctrl | InputModifier.meta)) !== 0 });
  const report = (r: Result<unknown>): void => {
    if (!r.ok) problem(r.error);
  };
  const clicksOf = (e: CompactInputEvent): number => {
    const near = lastDown !== undefined && e.ts - lastDown.ts <= DOUBLE_CLICK.ms && Math.hypot(e.x - lastDown.x, e.y - lastDown.y) <= DOUBLE_CLICK.px;
    const clicks = near && lastDown !== undefined ? lastDown.clicks + 1 : 1;
    lastDown = { ts: e.ts, x: e.x, y: e.y, clicks };
    return clicks;
  };
  const key = (e: CompactInputEvent): void => {
    if (e.key === undefined) return;
    const m = mods(e.m);
    shortcuts.handle({ key: e.key, code: e.code ?? '', ctrlKey: (e.m & InputModifier.ctrl) !== 0, metaKey: (e.m & InputModifier.meta) !== 0, altKey: m.alt, shiftKey: m.shift, defaultPrevented: false, target: null, preventDefault: () => undefined } as unknown as KeyboardEvent);
  };
  /** Ring event → the tab (a table, not a branch on input kinds spread through the module). */
  const INPUT: Readonly<Record<number, (t: CanvasTab, e: CompactInputEvent) => void>> = {
    [InputCode.pointerDown]: (t, e) => {
      if ((e.b & 1) === 0) return; // primary button only (as B8's DOM wiring)
      report(t.pointer({ phase: 'down', x: e.x, y: e.y, ...mods(e.m), clicks: clicksOf(e) }));
    },
    [InputCode.pointerMove]: (t, e) => report(t.pointer({ phase: 'move', x: e.x, y: e.y, ...mods(e.m) })),
    [InputCode.pointerUp]: (t, e) => report(t.pointer({ phase: 'up', x: e.x, y: e.y, ...mods(e.m) })),
    [InputCode.pointerCancel]: (t, e) => report(t.pointer({ phase: 'cancel', x: e.x, y: e.y })),
    [InputCode.wheel]: (t, e) => report(t.wheel({ x: e.x, y: e.y, dx: e.dx ?? 0, dy: e.dy ?? 0, mod: mods(e.m).mod })),
    [InputCode.keyDown]: (_t, e) => key(e),
  };

  const inspectElements = (nodes: readonly NodeId[] | undefined): InspectedElement[] => {
    const out: InspectedElement[] = [];
    const num = (n: NodeId, path: string): number => {
      const v = document.view.value(n, path);
      return typeof v === 'number' ? v : 0;
    };
    const one = (n: NodeId): void => {
      const record = document.view.read(n);
      if (record === undefined) return;
      const part = document.part(page());
      const block = record.kind === 'text' && part !== undefined ? readTextBlock(part, n) : undefined;
      out.push({ id: n, kind: record.kind, parent: record.parent ?? undefined, x: num(n, P.x), y: num(n, P.y), w: num(n, P.w), h: num(n, P.h), rotation: num(n, P.rotation), ...(block?.ok === true ? { text: block.value.text } : {}) });
    };
    if (nodes !== undefined) nodes.forEach(one);
    else {
      const walk = (parent: NodeId): void => {
        for (const child of document.view.children(parent)) {
          one(child);
          walk(child);
        }
      };
      walk(page());
    }
    return out;
  };

  const editor: StudioEditor = {
    document,
    get tab() {
      return tab();
    },
    started: { capabilities: [...byId.keys()], pages: document.pages.map((p) => p.id) },
    typography,
    mirrors,
    get input() {
      return counters;
    },
    open,
    handle(list, seq) {
      const t = tab();
      for (const e of list) {
        counters.inputSeq += 1;
        counters.inputTs = e.ts;
        if (t !== undefined) INPUT[e.t]?.(t, e);
      }
      if (seq !== undefined) counters.batchSeq = seq;
      if (list.length > 0) counters.batches += 1;
    },
    setTool: (tool) => toolBox.set(tool as ToolId),
    setViewport: (width, height) => tab()?.view.setViewport(width, height),
    select(nodes) {
      const view = tab()?.view;
      if (view === undefined) return;
      if (view.selection.length !== nodes.length || view.selection.some((n, i) => n !== nodes[i])) view.select(nodes);
    },
    async invoke(call, callSignal) {
      const impl = byId.get(call.capability);
      if (impl === undefined) return err(CapabilityNotServedError({ details: { capability: call.capability } }));
      const run: RunContext = {
        invocationId: call.invocationId,
        subject: call.subject,
        origin: call.origin,
        signal: callSignal,
        span: telemetry.span('instaflow/editor-invoke', { subsystem: 'instaflow/editor' }),
        reserved: undefined,
        reportCost: () => undefined,
      };
      return impl.run(call.input, run);
    },
    call: (call) => mirrors.call(call),
    text: (event) => textHost?.receive(event),
    async place(entry, placeSignal) {
      const current = tab();
      if (current === undefined) return err(NoOpenPageError());
      const size = await uploads.upload(entry, placeSignal);
      if (!size.ok) return size;
      const view = current.view;
      const center = toPage(view.camera, view.viewport.width / 2, view.viewport.height / 2);
      const node = document.newId();
      const done = commitEdit(document.target(current.page), actor(), `Place ${entry.title}`, ok(placeImageOps(node, view.context, entry, size.value, center, 600)));
      if (!done.ok) return done;
      view.select([node]);
      return ok();
    },
    hud(action) {
      const command = TEXT_HUD_COMMANDS[action];
      return command === undefined ? ok() : command(typography);
    },
    inspect(nodes) {
      const t = tab();
      const editing = t?.editing;
      const frameCorners = t?.view.overlay.frame?.corners;
      return {
        view: JSON.parse(lastView) as ViewProjection,
        elements: inspectElements(nodes),
        textNodes: t?.text.nodes ?? [],
        ...(editing === undefined ? {} : { editing: { node: editing.node, text: editing.session.state.model.text } }),
        ...(frameCorners === undefined ? {} : { frame: frameCorners.map((c) => [c[0], c[1]] as const) }),
        docVersion: options.publisher.docVersion,
        records: options.publisher.records,
        undo: doc.undoHistory().length,
      };
    },
  };
  return ok(editor);
}
