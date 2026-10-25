/**
 * The worker side of the sequencing boot: hosts the editor module, the render module, or both,
 * as the plan says (D15). The same module code runs in every case; only the routing of the pipe
 * endpoints differs — direct when both modules share this worker, through main otherwise.
 *
 * @example
 * // pipeline.worker.ts
 * hostSequencingWorker({ port: fromWorkerScope(self), engine: createLoroEngine(), renderPorts: { default: () => createVelloPort() } });
 */
import { err, ok, type Result, type SfError, toSfError } from '@staticflux/core';
import type { CrdtEngine, DocumentCRDTv2 } from '@staticflux/document/v2';
import type { InputRecordFields } from '@staticflux/surface/input-ring';
import { createLink, createProtocolServer, type Link, type Port, type ProtocolServer } from '@staticflux/worker';
import {
  attachCell,
  attachDeltaStream,
  attachRecordRing,
  type CellWriter,
  createCell,
  createDeltaStream,
  type DeltaStreamWriter,
  type RecordRingReader,
  regionTransferList,
} from '@staticflux/worker/pipeline';
import { type PipeEndpoints, SequencingControl, type StartArgs, type WorkerFinal } from './control.js';
import { frameDigest } from './digest-renderer.js';
import { createEditorModule, type EditorModule, scriptedPeer } from './editor-module.js';
import { RenderPortError, SequencingBootError, SequencingRoleError } from './errors.js';
import { cellTicks, type RafLike, rafTicks, type TickDriver, type TickSource } from './pacing.js';
import { EditorInputRing, RenderTickCell, SceneDeltas, ViewFrameCell, type ViewFrameFields } from './protocol.js';
import { createRenderModule, type RenderModule } from './render-module.js';
import type { RenderPortFactory } from './render-port.js';

export interface HostSequencingOptions {
  readonly port: Port;
  readonly engine: CrdtEngine;
  readonly renderPorts: Readonly<Record<string, RenderPortFactory>>;
  /** The worker's rAF (default: `globalThis.requestAnimationFrame` when present). */
  readonly raf?: RafLike;
  readonly timeOrigin?: number;
  readonly now?: () => number;
}

export interface SequencingWorkerHost {
  readonly link: Link;
  readonly editor: EditorModule | undefined;
  readonly render: RenderModule | undefined;
  dispose(): void;
}

interface TickContext {
  readonly args: StartArgs;
  readonly raf: RafLike | undefined;
  readonly timeOrigin: number;
}

const TICK_SOURCES: Readonly<Record<TickDriver, (context: TickContext) => Promise<Result<TickSource | undefined>>>> = {
  'worker-raf': async ({ raf, timeOrigin }) => ok(raf === undefined ? undefined : rafTicks(raf, timeOrigin)),
  'main-raf': async ({ args }) => {
    if (args.tick === undefined) return err(SequencingBootError({ message: 'The main-raf tick needs the tick cell endpoint.' }));
    const reader = await attachCell(RenderTickCell, args.tick);
    return reader.ok ? ok(cellTicks(reader.value)) : reader;
  },
};

const defaultRaf = (): RafLike | undefined => {
  const raf = (globalThis as { requestAnimationFrame?: RafLike }).requestAnimationFrame;
  return typeof raf === 'function' ? raf.bind(globalThis) : undefined;
};

const bootFailed = (step: string, cause: SfError): SfError => SequencingBootError({ message: `Sequencing boot failed at "${step}".`, cause, details: { step } });

/** Serve the sequencing control protocol on `port` (see the module header). */
export function hostSequencingWorker(options: HostSequencingOptions): SequencingWorkerHost {
  const link = createLink({ port: options.port, name: 'instaflow/sequencing-worker' });
  const lifetime = new AbortController();
  const raf = options.raf ?? defaultRaf();
  const timeOrigin = options.timeOrigin ?? globalThis.performance?.timeOrigin ?? 0;
  const closers: (() => void)[] = [];
  let part: DocumentCRDTv2 | undefined;
  let editor: EditorModule | undefined;
  let render: RenderModule | undefined;
  let started: StartArgs | undefined;

  const startRender = async (pipes: PipeEndpoints, args: StartArgs): Promise<Result<void>> => {
    const frames = await attachCell(ViewFrameCell, pipes.frames);
    if (!frames.ok) return err(bootFailed('attach view frames', frames.error));
    const deltas = await attachDeltaStream(SceneDeltas, pipes.deltas);
    if (!deltas.ok) return err(bootFailed('attach scene deltas', deltas.error));
    closers.push(() => frames.value.close(), () => deltas.value.close());
    const factory = options.renderPorts[args.settings.renderPort];
    if (factory === undefined) return err(RenderPortError({ message: `No render port "${args.settings.renderPort}" in this worker.`, details: { port: args.settings.renderPort } }));
    const ticks = await TICK_SOURCES[args.settings.pacing.tick]({ args, raf, timeOrigin });
    if (!ticks.ok) return err(bootFailed('tick source', ticks.error));
    render = createRenderModule({
      ports: { frames: frames.value, deltas: deltas.value, port: factory(), ...(ticks.value === undefined ? {} : { ticks: ticks.value }) },
      pacing: args.settings.pacing,
      record: args.record === true,
      digest: frameDigest,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    void render.run(lifetime.signal);
    return ok();
  };

  const startEditor = async (args: StartArgs, loaded: DocumentCRDTv2): Promise<Result<PipeEndpoints>> => {
    if (args.input === undefined) return err(bootFailed('input ring', SequencingRoleError({ message: 'The editor role needs the input ring endpoint.' })));
    const input = await attachRecordRing(EditorInputRing, args.input);
    if (!input.ok) return err(bootFailed('attach input ring', input.error));
    const deltas = createDeltaStream(SceneDeltas, { medium: args.media.modules });
    if (!deltas.ok) return err(bootFailed('create scene deltas', deltas.error));
    const frames = createCell(ViewFrameCell, { medium: args.media.modules });
    if (!frames.ok) return err(bootFailed('create view frames', frames.error));
    closers.push(
      () => input.value.close(),
      () => deltas.value.close(),
      () => frames.value.close(),
    );
    const module = createEditorModule({
      part: loaded,
      ports: { input: input.value as RecordRingReader<InputRecordFields>, deltas: deltas.value as DeltaStreamWriter, frames: frames.value as CellWriter<ViewFrameFields>, peer: scriptedPeer(args.remote ?? []) },
      coalesceMs: args.settings.editorCoalesceMs,
      ...(args.dropDeltaEvery === undefined ? {} : { dropDeltaEvery: args.dropDeltaEvery }),
    });
    if (!module.ok) return err(bootFailed('editor module', module.error));
    editor = module.value;
    void editor.run(lifetime.signal);
    const framesEndpoint = frames.value.endpoint();
    if (!framesEndpoint.ok) return framesEndpoint;
    const deltasEndpoint = deltas.value.endpoint();
    if (!deltasEndpoint.ok) return deltasEndpoint;
    return ok({ frames: framesEndpoint.value, deltas: deltasEndpoint.value });
  };

  const server: ProtocolServer<typeof SequencingControl> = createProtocolServer(link, SequencingControl, {
    async start(args): Promise<Result<void>> {
      if (started !== undefined) return err(SequencingRoleError({ message: 'This worker was already started.' }));
      started = args;
      const loaded = options.engine.load(args.scene, { peer: args.peer });
      if (!loaded.ok) return err(bootFailed('open scene', loaded.error));
      part = loaded.value;
      const hostsRender = args.roles.includes('render');
      if (!args.roles.includes('editor')) return ok(); // render-only: waits for `attach`
      const pipes = await startEditor(args, part);
      if (!pipes.ok) return pipes;
      if (hostsRender) return startRender(pipes.value, args); // both modules here: wire directly (local medium)
      const transfer = [...regionTransferList(pipes.value.frames), ...regionTransferList(pipes.value.deltas)];
      const emitted = server.emit('pipes', pipes.value, { transfer });
      return emitted.ok ? ok() : emitted;
    },
    async attach(pipes) {
      if (started === undefined || !started.roles.includes('render') || render !== undefined) {
        return err(SequencingRoleError({ message: 'attach is only valid once, on a started render-only worker.' }));
      }
      return startRender(pipes, started);
    },
    async finish() {
      const out: WorkerFinal = {
        ...(editor === undefined ? {} : { editor: { ...editor.core.final(), stats: editor.stats } }),
        ...(render === undefined ? {} : { render: { ...render.final(), stats: render.stats }, presented: render.presented.map((entry) => ({ ...entry })) }),
      };
      return ok(out);
    },
    async stop() {
      dispose();
      return ok();
    },
  });

  const dispose = (): void => {
    if (lifetime.signal.aborted) return;
    lifetime.abort();
    render?.dispose();
    for (const close of closers.splice(0).reverse()) {
      try {
        close();
      } catch (error) {
        void toSfError(error); // closing a pipe twice is harmless
      }
    }
    part?.dispose();
    part = undefined;
  };
  link.onClose(() => {
    dispose();
    server.dispose();
  });

  return {
    link,
    get editor() {
      return editor;
    },
    get render() {
      return render;
    },
    dispose() {
      dispose();
      server.dispose();
      link.close();
    },
  };
}
