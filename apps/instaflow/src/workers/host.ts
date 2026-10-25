/**
 * The worker side of Studio's topology (B9, IF-33.1–33.3; D15): hosts the editor module, the render module, or both,
 * as the boot plan's roles say. The same module code runs in every case; only the routing of the pipe endpoints
 * differs — direct when both modules share this worker (`local` medium), through main otherwise (`pipes` event →
 * main → `attach`).
 *
 * - **Editor role**: attaches A5's input ring, opens the store port, loads its environment (engine Wasm, fonts), creates
 *   the pipes and the canvas publisher, then the editor module; drains the ring (coalesced moves) into it.
 * - **Render role**: once it has the pipe endpoints and the canvas, makes the raster (Vello on the transferred
 *   `OffscreenCanvas` in the browser), B8's element render port over B1's scene side, and runs A7's render module on
 *   the worker's display ticks (frame metrics, `metrics`).
 *
 * Machine `instaflow/studio-worker` (LIFECYCLES §35): idle → starting → running → stopped; starting → failed.
 *
 * @example
 * // studio.worker.ts
 * hostStudioWorker({ port: fromWorkerScope(self), env: browserStudioEnvironment() });
 */
import type { Timers } from '@staticflux/a11y';
import { AbortedError, createMachine, createScope, defineMachine, err, ok, type Result, type Scope, type SfError, toSfError } from '@staticflux/core';
import { drainInputRing, type InputRecordFields } from '@staticflux/surface/input-ring';
import { createLink, createProtocolClient, createProtocolServer, type Link, type Port, type ProtocolServer, toWireError } from '@staticflux/worker';
import { attachRecordRing, type RecordRingReader, toPort } from '@staticflux/worker/pipeline';
import { attachCanvasRender, type CanvasPipeEndpoints, canvasPipeTransfer, type CanvasPipes, type CanvasRender, createCanvasPipes, createElementSceneSide, type PublishedInput } from '../app/canvas-pipeline.js';
import { type CanvasRaster, createElementRenderPort } from '../app/element-port.js';
import { type RafLike, rafTicks } from '../sequencing/pacing.js';
import { EditorInputRing } from '../sequencing/protocol.js';
import { createStudioEditor, type EditorEnv, type StudioEditor } from './editor-module.js';
import { CanvasTransferError, WorkerBootError, WorkerRoleError } from './errors.js';
import { type CanvasHandoff, type StudioAssets, type StudioEditorStart, type StudioMetrics, type StudioStartArgs, StudioWorkerProtocol } from './protocol.js';
import { remoteBlobs, remoteDocumentStore, StudioStoreProtocol } from './store-port.js';
import { toWire } from './wire.js';

/** What this worker can load or make (the browser entry's real pieces; fixtures in tests). */
export interface StudioWorkerEnvironment {
  /** The editor role's environment (engine, geometry and text Wasm, fonts, image decoder). */
  readonly editor?: (assets: StudioAssets | undefined, signal: AbortSignal) => Promise<Result<EditorEnv>>;
  /** The render role's raster on the handed-off canvas. */
  readonly raster?: (handoff: CanvasHandoff, assets: StudioAssets | undefined, signal: AbortSignal) => Promise<Result<CanvasRaster>>;
  /** Display ticks (default the worker's `requestAnimationFrame` when there is one). */
  readonly raf?: RafLike;
  readonly timeOrigin?: number;
  readonly now?: () => number;
  readonly timers?: Timers;
  /** Publish coalescing in the editor (default a microtask). */
  readonly schedule?: (fn: () => void) => void;
  /** Accessibility projection coalescing (default rAF, else a timeout). */
  readonly frame?: (fn: () => void) => void;
}

export const StudioWorkerLifecycle = /* @__PURE__ */ defineMachine({
  id: 'instaflow/studio-worker',
  initial: 'idle',
  states: ['idle', 'starting', 'running', 'failed', 'stopped'],
  transitions: {
    idle: { start: 'starting', stop: 'stopped' },
    starting: { run: 'running', fail: 'failed', stop: 'stopped' },
    running: { stop: 'stopped' },
    failed: { stop: 'stopped' },
  },
  terminal: ['stopped'],
});
export type StudioWorkerState = (typeof StudioWorkerLifecycle.states)[number];

export interface StudioWorkerHost {
  readonly link: Link;
  readonly state: StudioWorkerState;
  readonly editor: StudioEditor | undefined;
  readonly render: CanvasRender | undefined;
  /** Resolves when the render module is drawing (both pipes and canvas arrived). */
  readonly drawing: Promise<void>;
  dispose(): void;
}

const NO_INPUT: PublishedInput = Object.freeze({ inputSeq: 0, inputTs: 0, batchSeq: 0 });

const defaultRaf = (): RafLike | undefined => {
  const raf = (globalThis as { requestAnimationFrame?: RafLike }).requestAnimationFrame;
  return typeof raf === 'function' ? raf.bind(globalThis) : undefined;
};

const percentile = (values: readonly number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1)))] ?? 0;
};

/** Serve Studio's worker protocol on `port` (see the module header). */
export function hostStudioWorker(options: { readonly port: Port; readonly env: StudioWorkerEnvironment; readonly name?: string }): StudioWorkerHost {
  const { env } = options;
  const link = createLink({ port: options.port, name: options.name ?? 'instaflow/studio-worker' });
  const machine = createMachine(StudioWorkerLifecycle);
  const scope: Scope = createScope('instaflow/studio-worker');
  const signal = scope.signal;
  const raf = env.raf ?? defaultRaf();
  const timeOrigin = env.timeOrigin ?? globalThis.performance?.timeOrigin ?? 0;
  let args: StudioStartArgs | undefined;
  let editor: StudioEditor | undefined;
  let pipes: CanvasPipes | undefined;
  let renderPipes: CanvasPipeEndpoints | undefined;
  let handoff: CanvasHandoff | undefined;
  let raster: CanvasRaster | undefined;
  let render: CanvasRender | undefined;
  let rendering: Promise<Result<void>> | undefined;
  let markDrawing: () => void = () => undefined;
  const drawing = new Promise<void>((resolve) => (markDrawing = resolve));
  const failed = (step: string, cause?: SfError): Result<never> => err(WorkerBootError({ ...(cause === undefined ? {} : { cause }), details: { step } }));
  const role = (needed: 'editor' | 'render'): Result<void> => (args?.roles.includes(needed) === true ? ok() : err(WorkerRoleError({ details: { needed, roles: args?.roles ?? [] } })));
  const needEditor = (): Result<StudioEditor> => {
    const r = role('editor');
    if (!r.ok) return r;
    return editor === undefined ? err(WorkerRoleError({ message: 'The editor module has not started.' })) : ok(editor);
  };

  // Render: start once both the pipes and the canvas are here (any order).
  const maybeRender = (): Promise<Result<void>> => {
    if (renderPipes === undefined || handoff === undefined || args === undefined) return Promise.resolve(ok());
    if (rendering !== undefined) return rendering;
    const endpoints = renderPipes;
    const canvas = handoff;
    const pacing = args.pacing;
    rendering = (async (): Promise<Result<void>> => {
      if (env.raster === undefined) return err(CanvasTransferError({ message: 'This worker cannot make a raster.' }));
      const made = await env.raster(canvas, args?.assets, signal);
      if (!made.ok) return failed('raster', made.error);
      raster = made.value;
      const side = createElementSceneSide();
      const port = createElementRenderPort({ side, raster: made.value });
      const attached = await attachCanvasRender({
        pipes: endpoints,
        port,
        side,
        pacing,
        ...(raf === undefined ? {} : { ticks: rafTicks(raf, timeOrigin) }),
        record: args?.record !== false,
        ...(env.now === undefined ? {} : { now: env.now }),
        signal,
      });
      if (!attached.ok) return attached;
      render = attached.value;
      markDrawing();
      return ok();
    })();
    return rendering;
  };

  const startEditor = async (start: StudioEditorStart, media: StudioStartArgs['media'], assets: StudioAssets | undefined): Promise<Result<StudioEditor>> => {
    const input = await attachRecordRing(EditorInputRing, start.input);
    if (!input.ok) return failed('attach input ring', input.error);
    scope.defer(() => input.value.close());
    const storePort = toPort(start.store);
    if (storePort === undefined) return failed('store port', WorkerRoleError({ message: 'The editor role needs the store port.' }));
    const storeLink = createLink({ port: storePort, name: 'instaflow/studio-store-client' });
    scope.defer(() => storeLink.close());
    const store = createProtocolClient(storeLink, StudioStoreProtocol);
    if (env.editor === undefined) return failed('editor environment', WorkerRoleError({ message: 'This worker cannot load the editor module.' }));
    const loaded = await env.editor(assets, signal);
    if (!loaded.ok) return failed('editor environment', loaded.error);
    let counters: (() => PublishedInput) | undefined;
    const made = createCanvasPipes({ medium: media.modules, input: () => counters?.() ?? NO_INPUT });
    if (!made.ok) return made;
    pipes = made.value;
    scope.defer(() => made.value.close());
    const created = await createStudioEditor({
      env: loaded.value,
      store: remoteDocumentStore(store),
      blobs: remoteBlobs(store),
      document: start.document,
      person: start.person,
      isMac: start.isMac,
      ...(start.textInput === undefined ? {} : { textInput: start.textInput }),
      publisher: made.value.publisher,
      events: {
        view: (projection) => void server.emit('view', projection),
        mirror: (update) => void server.emit('mirror', update),
        a11y: (snapshot) => void server.emit('a11y', snapshot),
        labels: (labels, camera) => void server.emit('labels', { labels, camera }),
        text: (command) => void server.emit('text', command),
        announce: (message) => void server.emit('announce', { message }),
        problem: (error) => void server.emit('problem', { error: toWireError(error) }),
        tool: (tool) => void server.emit('tool', { tool }),
      },
      ...(env.timers === undefined ? {} : { timers: env.timers }),
      ...(env.schedule === undefined ? {} : { schedule: env.schedule }),
      ...(env.frame === undefined ? {} : { frame: env.frame }),
      scope,
    });
    if (!created.ok) return created;
    const module = created.value;
    counters = () => module.input;
    void drain(input.value as RecordRingReader<InputRecordFields>, module);
    return ok(module);
  };

  const drain = async (input: RecordRingReader<InputRecordFields>, module: StudioEditor): Promise<void> => {
    for (;;) {
      if (signal.aborted || input.closed) return;
      const waited = await input.wait({ signal, timeoutMs: 100 });
      if (!waited.ok && (waited.error.code === AbortedError.code || input.closed)) return;
      const { events, seq } = drainInputRing(input, { coalesce: true });
      if (events.length > 0) {
        try {
          module.handle(events, seq);
        } catch (error) {
          void server.emit('problem', { error: toWireError(toSfError(error)) });
        }
      }
    }
  };

  const server: ProtocolServer<typeof StudioWorkerProtocol> = createProtocolServer(link, StudioWorkerProtocol, {
    async start(startArgs) {
      if (!machine.can('start')) return err(WorkerRoleError({ message: 'This worker was already started.' }));
      machine.send('start');
      args = startArgs;
      const hostsRender = startArgs.roles.includes('render');
      if (startArgs.roles.includes('editor')) {
        if (startArgs.editor === undefined) {
          machine.send('fail');
          return failed('start', WorkerRoleError({ message: 'The editor role needs its start arguments.' }));
        }
        const started = await startEditor(startArgs.editor, startArgs.media, startArgs.assets);
        if (!started.ok) {
          machine.send('fail');
          return started;
        }
        editor = started.value;
        const endpoints = pipes?.endpoints;
        if (endpoints !== undefined) {
          if (hostsRender) renderPipes = endpoints; // both modules here: wired directly (local medium)
          else {
            const emitted = server.emit('pipes', endpoints, { transfer: canvasPipeTransfer(endpoints) });
            if (!emitted.ok) return emitted;
          }
        }
      }
      machine.send('run');
      const r = await maybeRender();
      if (!r.ok) return r;
      return ok(editor?.started);
    },
    async attach(endpoints) {
      const r = role('render');
      if (!r.ok) return r;
      if (renderPipes !== undefined) return err(WorkerRoleError({ message: 'The render pipes were attached already.' }));
      renderPipes = endpoints;
      return maybeRender();
    },
    async canvas(next) {
      const r = role('render');
      if (!r.ok) return r;
      if (handoff !== undefined) return err(CanvasTransferError({ message: 'This render module has its canvas already.' }));
      handoff = next;
      return maybeRender();
    },
    async sync() {
      const e = needEditor();
      if (!e.ok) return e;
      e.value.sync();
      return ok();
    },
    async open({ page, viewport }) {
      const e = needEditor();
      return e.ok ? e.value.open(page, viewport) : e;
    },
    async resize({ width, height }) {
      if (args?.roles.includes('editor') === true) editor?.setViewport(width, height);
      if (args?.roles.includes('render') === true && raster !== undefined) {
        const resized = raster.resize?.(width, height) ?? ok();
        if (!resized.ok) return resized;
        return raster.present();
      }
      return ok();
    },
    async visible({ visible }) {
      if (visible && raster !== undefined) return raster.present();
      return ok();
    },
    async tool({ tool }) {
      const e = needEditor();
      if (!e.ok) return e;
      e.value.setTool(tool);
      return ok();
    },
    async select({ nodes }) {
      const e = needEditor();
      if (!e.ok) return e;
      e.value.select(nodes);
      return ok();
    },
    async invoke(call, context) {
      const e = needEditor();
      if (!e.ok) return e;
      const out = await e.value.invoke(call, context.signal);
      return out.ok ? ok(toWire(out.value)) : out;
    },
    async call(call) {
      const e = needEditor();
      return e.ok ? e.value.call(call) : e;
    },
    async text(event) {
      const e = needEditor();
      if (!e.ok) return e;
      e.value.text(event);
      return ok();
    },
    async place({ entry }, context) {
      const e = needEditor();
      return e.ok ? e.value.place(entry, context.signal) : e;
    },
    async hud({ action }) {
      const e = needEditor();
      return e.ok ? e.value.hud(action) : e;
    },
    async zoom({ step }) {
      const e = needEditor();
      return e.ok ? e.value.zoom(step) : e;
    },
    async inspect({ nodes }) {
      const e = needEditor();
      return e.ok ? ok(e.value.inspect(nodes)) : e;
    },
    async exportTarget(_, context) {
      const e = needEditor();
      return e.ok ? e.value.exportTarget(context.signal) : e;
    },
    async metrics() {
      const out: { render?: NonNullable<StudioMetrics['render']>; editor?: NonNullable<StudioMetrics['editor']> } = {};
      if (render !== undefined) {
        const latencies = render.render.presented.filter((p) => p.presented > 0 && p.inputTs > 0).map((p) => p.presented - p.inputTs);
        out.render = { ...render.render.stats, presented: render.render.presented.length, ...(latencies.length === 0 ? {} : { latency: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), n: latencies.length } }) };
      }
      if (editor !== undefined && pipes !== undefined) out.editor = { inputs: editor.input.inputSeq, batches: editor.input.batches, records: pipes.publisher.records, docVersion: pipes.publisher.docVersion };
      return ok(out);
    },
    async stop() {
      dispose();
      return ok();
    },
  });

  const dispose = (): void => {
    if (machine.is('stopped')) return;
    machine.send('stop');
    render?.stop();
    raster?.dispose();
    void scope.dispose();
  };
  link.onClose(() => {
    dispose();
    server.dispose();
  });

  return {
    link,
    get state() {
      return machine.state;
    },
    get editor() {
      return editor;
    },
    get render() {
      return render;
    },
    drawing,
    dispose() {
      dispose();
      server.dispose();
      link.close();
    },
  };
}
