/**
 * Main-thread boot of Studio's workers (B9, IF-33.1–33.3; D15). Reads the plan for the configured topology (one
 * worker by default, two by the `instaflow/sequencing-topology` boot setting), creates the main-owned pipes (A5's
 * input ring) and the store port, spawns the plan's workers, starts each with its roles, and relays the editor's pipe
 * endpoints to the render worker when the modules are split.
 *
 * Requests go to the worker hosting the module that owns them (`editor`, `render`: the same client in one worker),
 * never through a branch on the topology.
 *
 * @example
 * const workers = unwrap(await bootStudioWorkers({ settings, spawn, editor: { document, person, isMac }, store: { store, blobs }, signal }));
 * createInputForwarder({ target: surface, env, sinks: [inputRingSink(workers.input)] });
 * await workers.render.request('canvas', handoff, { transfer: [handoff.canvas] });
 */
import type { BlobStore } from '@staticflux/blob';
import { err, ok, type Result, type SfError } from '@staticflux/core';
import type { DocumentStore } from '@staticflux/document/v2';
import type { InputRecordFields } from '@staticflux/surface/input-ring';
import { createLink, createProtocolClient, fromMessagePort, type IsolationFacts, type Link, type Port, type ProtocolClient, type ProtocolServer, type SpawnedWorker, type Spawner } from '@staticflux/worker';
import { createRecordRing, type RecordRingWriter, regionTransferList } from '@staticflux/worker/pipeline';
import { type CanvasPipeEndpoints, canvasPipeTransfer } from '../app/canvas-pipeline.js';
import { EditorInputRing } from '../sequencing/protocol.js';
import { planSequencing, type SequencingMedia, type SequencingPlan, type SequencingSettings, type SequencingWorkerPlan } from '../sequencing/topology.js';
import { WorkerBootError, WorkerRoleError } from './errors.js';
import { type StudioAssets, type StudioEditorStart, type StudioStarted, StudioWorkerProtocol } from './protocol.js';
import { serveStudioStore, StudioStoreProtocol } from './store-port.js';

export type StudioWorkerClient = ProtocolClient<typeof StudioWorkerProtocol>;

export interface BootStudioWorkersOptions {
  readonly settings: SequencingSettings;
  /** A spawner for each worker of the plan (`worker.name` is 'pipeline', 'editor' or 'render'). */
  readonly spawn: (worker: SequencingWorkerPlan) => Spawner;
  readonly isolation?: IsolationFacts;
  /** Override media (tests run every medium on both topologies). */
  readonly media?: Partial<SequencingMedia>;
  /** The editor role's start arguments (main adds the input ring and the store port). */
  readonly editor: Omit<StudioEditorStart, 'input' | 'store'>;
  /** Engine Wasm and fonts for the workers to load (the browser entry). */
  readonly assets?: StudioAssets;
  /** The store side main serves (the store-worker stand-in). */
  readonly store: { readonly store: DocumentStore; readonly blobs: Pick<BlobStore, 'get'> };
  /** Keep a presented-frame log in the render module (default true). */
  readonly record?: boolean;
  readonly signal: AbortSignal;
}

export interface StudioWorkerSession {
  readonly plan: SequencingWorkerPlan;
  readonly client: StudioWorkerClient;
  readonly link: Link;
  readonly worker: SpawnedWorker;
}

export interface StudioWorkers {
  readonly plan: SequencingPlan;
  /** main → editor input ring (feed it with `inputRingSink(workers.input)`). */
  readonly input: RecordRingWriter<InputRecordFields>;
  /** The worker hosting the editor module. */
  readonly editor: StudioWorkerClient;
  /** The worker hosting the render module. */
  readonly render: StudioWorkerClient;
  readonly started: StudioStarted;
  readonly workers: readonly StudioWorkerSession[];
  /** Send a request every worker handles (resize): once per worker. */
  everyWorker(send: (client: StudioWorkerClient) => Promise<Result<unknown>>): Promise<Result<void>>;
  stop(): Promise<void>;
}

const failed = (step: string, cause?: SfError): SfError => WorkerBootError({ ...(cause === undefined ? {} : { cause }), details: { step } });

interface StoreChannel {
  readonly local: Port;
  readonly remote: unknown;
  readonly transfer: readonly Transferable[];
}

/** A MessageChannel for the store port (its second port moves to the editor worker). */
function storeChannel(): StoreChannel | undefined {
  if (typeof MessageChannel !== 'function') return undefined;
  const channel = new MessageChannel();
  return { local: fromMessagePort(channel.port1), remote: channel.port2, transfer: [channel.port2] };
}

/** Boot the workers for `settings.topology` (see the module header). Failures are IF-WRK-001. */
export async function bootStudioWorkers(options: BootStudioWorkersOptions): Promise<Result<StudioWorkers>> {
  const plan = planSequencing(options.settings, {
    ...(options.isolation === undefined ? {} : { isolation: options.isolation }),
    ...(options.media === undefined ? {} : { media: options.media }),
  });
  const { signal } = options;
  const ring = createRecordRing(EditorInputRing, { medium: plan.media.input });
  if (!ring.ok) return err(failed('create input ring', ring.error));
  const channel = storeChannel();
  if (channel === undefined) return err(failed('store port', WorkerRoleError({ message: 'No MessageChannel for the store port.' })));
  const storeLink = createLink({ port: channel.local, name: 'instaflow/studio-store' });
  const storeServer: ProtocolServer<typeof StudioStoreProtocol> = serveStudioStore(storeLink, options.store);
  const workers: StudioWorkerSession[] = [];
  const crashes = new Map<string, Promise<SfError>>();
  const stopAll = async (): Promise<void> => {
    await Promise.all(workers.map((w) => w.client.request('stop', undefined, { timeoutMs: 2_000 })));
    for (const w of workers) {
      w.link.close();
      w.worker.terminate();
    }
    ring.value.close();
    storeServer.dispose();
    storeLink.close();
  };
  const bail = async (step: string, cause?: SfError): Promise<Result<never>> => {
    await stopAll();
    return err(failed(step, cause));
  };

  for (const worker of plan.workers) {
    const spawned = await options.spawn(worker)({ signal, attempt: 1 });
    if (!spawned.ok) return bail(`spawn ${worker.name}`, spawned.error);
    const link = createLink({ port: spawned.value.port, name: `instaflow/studio-${worker.name}` });
    // A worker whose script fails to load (or throws at top level) never answers: fail with its error, not a timeout.
    crashes.set(worker.name, new Promise<SfError>((resolve) => spawned.value.port.onError(resolve)));
    workers.push({ plan: worker, client: createProtocolClient(link, StudioWorkerProtocol), link, worker: spawned.value });
  }
  const hosting = (role: 'editor' | 'render'): StudioWorkerSession | undefined => workers.find((w) => w.plan.roles.includes(role));
  const editorSession = hosting('editor');
  const renderSession = hosting('render');
  if (editorSession === undefined || renderSession === undefined) return bail('plan', WorkerRoleError({ details: { workers: plan.workers.map((w) => w.name) } }));

  // Split topology: the editor-only worker announces its pipes; relay them to the render worker.
  const announced =
    editorSession === renderSession
      ? undefined
      : new Promise<CanvasPipeEndpoints>((resolve) => {
          const off = editorSession.client.on('pipes', (pipes: CanvasPipeEndpoints) => {
            off();
            resolve(pipes);
          });
        });

  let started: StudioStarted | undefined;
  for (const w of workers) {
    const isEditor = w === editorSession;
    const input = isEditor ? ring.value.endpoint(0) : undefined;
    if (input !== undefined && !input.ok) return bail('input ring endpoint', input.error);
    const crashed = crashes.get(w.plan.name) ?? new Promise<SfError>(() => undefined);
    const editorArgs: StudioEditorStart | undefined = isEditor && input !== undefined ? { ...options.editor, input: input.value, store: channel.remote } : undefined;
    const transfer = isEditor && input !== undefined ? [...regionTransferList(input.value), ...channel.transfer] : [];
    const reply = await Promise.race([
      w.client.request('start', { roles: w.plan.roles, media: plan.media, pacing: options.settings.pacing, ...(options.assets === undefined ? {} : { assets: options.assets }), ...(editorArgs === undefined ? {} : { editor: editorArgs }), record: options.record !== false }, { transfer, signal }),
      crashed.then((error): Result<never> => err(error)),
    ]);
    if (!reply.ok) return bail(`start ${w.plan.name}`, reply.error);
    if (isEditor) started = reply.value;
  }
  if (announced !== undefined) {
    const pipes = await announced;
    const attached = await renderSession.client.request('attach', pipes, { transfer: canvasPipeTransfer(pipes), signal });
    if (!attached.ok) return bail('attach render pipes', attached.error);
  }
  if (started === undefined) return bail('editor start', WorkerRoleError({ message: 'The editor worker did not report its start.' }));

  return ok({
    plan,
    input: ring.value,
    editor: editorSession.client,
    render: renderSession.client,
    started,
    workers,
    async everyWorker(send) {
      for (const w of workers) {
        const r = await send(w.client);
        if (!r.ok) return r;
      }
      return ok();
    },
    stop: stopAll,
  });
}
