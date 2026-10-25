/**
 * Main-thread boot of the editor ↔ render pipeline (D15). Reads the plan for the configured
 * topology, creates the main-owned pipes (input ring, render tick cell), spawns the plan's workers,
 * starts each with its roles, and relays pipe endpoints between workers when the modules are split.
 *
 * @example
 * const session = unwrap(await bootSequencing({
 *   settings: resolveSequencingSettings(readFlag),
 *   spawn: (worker) => dedicatedWorkerSpawner(() => new Worker(new URL('./pipeline.worker.js', import.meta.url), { type: 'module', name: worker.name })),
 *   scene, peer,
 * }));
 * createInputForwarder({ target: canvas, env, sinks: [inputRingSink(session.input)] });
 */
import { err, ok, type Result, type SfError } from '@staticflux/core';
import type { PeerId } from '@staticflux/document/v2';
import type { InputRecordFields } from '@staticflux/surface/input-ring';
import { createLink, createProtocolClient, type IsolationFacts, type Link, type ProtocolClient, type Spawner, type SpawnedWorker } from '@staticflux/worker';
import { createCell, createRecordRing, type RecordRingWriter, type RegionEndpoint, regionTransferList } from '@staticflux/worker/pipeline';
import { type PipeEndpoints, type ScheduledRemoteUpdate, SequencingControl, type StartArgs, type WorkerFinal } from './control.js';
import { SequencingBootError } from './errors.js';
import { createMainTick, type MainTick } from './pacing.js';
import { EditorInputRing, RenderTickCell } from './protocol.js';
import { planSequencing, type SequencingMedia, type SequencingPlan, type SequencingSettings, type SequencingWorkerPlan } from './topology.js';

export interface BootSequencingOptions {
  readonly settings: SequencingSettings;
  /** A spawner for each worker of the plan (`worker.name` is 'pipeline', 'editor' or 'render'). */
  readonly spawn: (worker: SequencingWorkerPlan) => Spawner;
  /** Snapshot of the scene part to open. */
  readonly scene: Uint8Array;
  readonly peer: PeerId;
  readonly isolation?: IsolationFacts;
  readonly media?: Partial<SequencingMedia>;
  readonly remote?: readonly ScheduledRemoteUpdate[];
  readonly dropDeltaEvery?: number;
  readonly record?: boolean;
  readonly signal?: AbortSignal;
}

export interface SequencingWorkerSession {
  readonly plan: SequencingWorkerPlan;
  readonly client: ProtocolClient<typeof SequencingControl>;
  readonly link: Link;
  readonly worker: SpawnedWorker;
}

export interface SequencingSessionFinal {
  readonly workers: readonly (WorkerFinal & { readonly name: string })[];
}

export interface SequencingSession {
  readonly plan: SequencingPlan;
  /** main → editor input ring (feed it with `inputRingSink(session.input)`). */
  readonly input: RecordRingWriter<InputRecordFields>;
  /** Main tick for the main-rAF experiment (pulse after forwarding input in rAF). */
  readonly tick: MainTick;
  readonly workers: readonly SequencingWorkerSession[];
  /** Collect each worker's final state and logs. */
  finish(): Promise<Result<SequencingSessionFinal>>;
  /** Stop the workers and close the pipes. */
  stop(): Promise<void>;
}

const failed = (step: string, cause?: SfError): SfError => SequencingBootError({ message: `Sequencing boot failed at "${step}".`, ...(cause === undefined ? {} : { cause }), details: { step } });

const transferOf = (...endpoints: (RegionEndpoint | undefined)[]): Transferable[] => endpoints.flatMap((endpoint) => (endpoint === undefined ? [] : regionTransferList(endpoint)));

/** Boot the pipeline for `settings.topology` (see the module header). */
export async function bootSequencing(options: BootSequencingOptions): Promise<Result<SequencingSession>> {
  const plan = planSequencing(options.settings, {
    ...(options.isolation === undefined ? {} : { isolation: options.isolation }),
    ...(options.media === undefined ? {} : { media: options.media }),
  });
  const signal = options.signal ?? new AbortController().signal;
  const ring = createRecordRing(EditorInputRing, { medium: plan.media.input });
  if (!ring.ok) return err(failed('create input ring', ring.error));
  const tickCell = createCell(RenderTickCell, { medium: plan.media.tick });
  if (!tickCell.ok) return err(failed('create render tick', tickCell.error));
  const workers: SequencingWorkerSession[] = [];
  const stopAll = async (): Promise<void> => {
    await Promise.all(workers.map((w) => w.client.request('stop', undefined, { timeoutMs: 2_000 })));
    for (const w of workers) {
      w.link.close();
      w.worker.terminate();
    }
    ring.value.close();
    tickCell.value.close();
  };

  for (const worker of plan.workers) {
    const spawned = await options.spawn(worker)({ signal, attempt: 1 });
    if (!spawned.ok) {
      await stopAll();
      return err(failed(`spawn ${worker.name}`, spawned.error));
    }
    const link = createLink({ port: spawned.value.port, name: `instaflow/sequencing-${worker.name}` });
    workers.push({ plan: worker, client: createProtocolClient(link, SequencingControl), link, worker: spawned.value });
  }

  // Split topology: the editor-only worker announces its pipes; relay them once the render worker started.
  const editorOnly = workers.find((w) => w.plan.roles.includes('editor') && !w.plan.roles.includes('render'));
  const renderOnly = workers.find((w) => w.plan.roles.includes('render') && !w.plan.roles.includes('editor'));
  const announced =
    editorOnly === undefined
      ? undefined
      : new Promise<PipeEndpoints>((resolve) => {
          const off = editorOnly.client.on('pipes', (pipes: PipeEndpoints) => {
            off();
            resolve(pipes);
          });
        });

  for (const w of workers) {
    const input = w.plan.roles.includes('editor') ? ring.value.endpoint(0) : undefined;
    if (input !== undefined && !input.ok) {
      await stopAll();
      return err(failed('input ring endpoint', input.error));
    }
    const tick = w.plan.roles.includes('render') ? tickCell.value.endpoint() : undefined;
    if (tick !== undefined && !tick.ok) {
      await stopAll();
      return err(failed('render tick endpoint', tick.error));
    }
    const args: StartArgs = {
      roles: w.plan.roles,
      settings: options.settings,
      media: plan.media,
      scene: options.scene,
      peer: options.peer,
      ...(input === undefined ? {} : { input: input.value }),
      ...(tick === undefined ? {} : { tick: tick.value }),
      ...(options.remote === undefined || !w.plan.roles.includes('editor') ? {} : { remote: options.remote }),
      ...(options.dropDeltaEvery === undefined ? {} : { dropDeltaEvery: options.dropDeltaEvery }),
      record: options.record === true,
    };
    const started = await w.client.request('start', args, { transfer: transferOf(input?.value, tick?.value), signal });
    if (!started.ok) {
      await stopAll();
      return err(failed(`start ${w.plan.name}`, started.error));
    }
  }
  if (announced !== undefined && renderOnly !== undefined) {
    const pipes = await announced;
    const attached = await renderOnly.client.request('attach', pipes, { transfer: transferOf(pipes.frames, pipes.deltas), signal });
    if (!attached.ok) {
      await stopAll();
      return err(failed('attach render pipes', attached.error));
    }
  }

  return ok({
    plan,
    input: ring.value,
    tick: createMainTick(tickCell.value),
    workers,
    async finish() {
      const finals: (WorkerFinal & { name: string })[] = [];
      for (const w of workers) {
        const final = await w.client.request('finish', undefined);
        if (!final.ok) return final;
        finals.push({ ...final.value, name: w.plan.name });
      }
      return ok({ workers: finals });
    },
    stop: stopAll,
  });
}
