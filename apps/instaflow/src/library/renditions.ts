/**
 * Renditions (IF-3.9): derived, regenerable blobs — thumbnails in M1 — produced by cancellable,
 * resumable background jobs and recorded in the library document (never in the immutable record).
 *
 * A job decodes the asset's content (`ImageDecoder`), renders it at the target size
 * (`ThumbnailRenderer`: the A6 scene path or the CPU fallback, `thumbnails.ts`), encodes it
 * (`ImageEncoder`, PNG) and stores the blob, then writes `library.renditions.<role>`. Nothing is written
 * before the blob is stored, so a cancelled or failed job leaves no trace; `resume()` re-queues every
 * entry still missing a rendition its kind gets (`RENDITION_PRODUCERS`), and the deterministic encoder
 * makes a regenerated rendition the same blob.
 *
 * Machine `instaflow/rendition-job` (one per job): queued → decoding → rendering → storing → done;
 * queued | decoding | rendering | storing → failed | cancelled.
 */
import type { BlobStore } from '@staticflux/blob';
import { AbortedError, box, createMachine, defineMachine, err, type Machine, ok, type Result, type SfError } from '@staticflux/core';
import { fitWithin, type RasterImage } from '@staticflux/surface/image';
import { LibraryDisposedError, RenditionError, UnknownAssetError } from './errors.js';
import type { LibraryAssetKind } from './kinds.js';
import type { Library } from './library.js';
import type { LibraryEntry, RenditionRole } from './library-doc.js';
import type { AssetId } from './records.js';

/** Longest edge of a thumbnail in pixels (fits the dock rows and a 2× preview). */
export const THUMBNAIL_EDGE = 256;

/** Which renditions each kind gets in this build (data; video posters and waveforms arrive with M3). */
export const RENDITION_PRODUCERS: Readonly<Partial<Record<LibraryAssetKind, readonly RenditionRole[]>>> = Object.freeze({
  image: ['thumbnail'],
});

/** Decodes stored content to straight RGBA. */
export interface ImageDecoder {
  decode(bytes: Uint8Array, mime: string, signal: AbortSignal): Promise<Result<RasterImage>>;
}

/** Renders decoded pixels at a target size. `id` is recorded in the rendition params. */
export interface ThumbnailRenderer {
  readonly id: string;
  render(source: RasterImage, size: { readonly width: number; readonly height: number }, signal: AbortSignal): Promise<Result<RasterImage>>;
}

/** Encodes pixels to a stored, displayable format. */
export interface ImageEncoder {
  readonly mime: string;
  encode(image: RasterImage, signal: AbortSignal): Promise<Result<Uint8Array>>;
}

export const RenditionJobMachine = /* @__PURE__ */ defineMachine({
  id: 'instaflow/rendition-job',
  initial: 'queued',
  states: ['queued', 'decoding', 'rendering', 'storing', 'done', 'failed', 'cancelled'],
  transitions: {
    queued: { start: 'decoding', cancel: 'cancelled', fail: 'failed' },
    decoding: { render: 'rendering', fail: 'failed', cancel: 'cancelled' },
    rendering: { store: 'storing', fail: 'failed', cancel: 'cancelled' },
    storing: { done: 'done', fail: 'failed', cancel: 'cancelled' },
  },
  terminal: ['done', 'failed', 'cancelled'],
});

export type RenditionJobState = (typeof RenditionJobMachine.states)[number];

export interface RenditionJob {
  readonly asset: AssetId;
  readonly role: RenditionRole;
  readonly state: RenditionJobState;
  readonly error?: SfError;
}

export interface RenditionQueueOptions {
  readonly library: Pick<Library, 'entry' | 'entries' | 'setRendition'>;
  readonly blobs: Pick<BlobStore, 'get' | 'put'>;
  readonly decoder: ImageDecoder;
  readonly renderer: ThumbnailRenderer;
  readonly encoder: ImageEncoder;
  /** Default `THUMBNAIL_EDGE`. */
  readonly edge?: number;
  /** Jobs run at once (default 1: renditions are background work). */
  readonly concurrency?: number;
}

export interface RenditionQueue {
  /** Queue every missing rendition of one asset (`force`: regenerate existing ones too). */
  request(asset: AssetId, options?: { readonly force?: boolean }): Result<number>;
  /** Queue every live entry still missing a rendition (session start, after a crash). Returns jobs queued. */
  resume(): number;
  /** Current and finished jobs of this session (reactive). */
  jobs(): readonly RenditionJob[];
  cancel(asset: AssetId): void;
  /** Resolves when nothing is queued or running. */
  idle(signal: AbortSignal): Promise<Result<void>>;
  dispose(): void;
}

const TERMINAL: ReadonlySet<RenditionJobState> = /* @__PURE__ */ new Set(RenditionJobMachine.terminal);

/** Roles an entry still needs (pure). */
export function missingRenditions(entry: LibraryEntry): readonly RenditionRole[] {
  if (entry.content === undefined || entry.trashedAt !== undefined) return [];
  return (RENDITION_PRODUCERS[entry.kind] ?? []).filter((role) => entry.renditions[role] === undefined);
}

interface Job {
  readonly asset: AssetId;
  readonly role: RenditionRole;
  readonly machine: Machine<RenditionJobState, 'start' | 'render' | 'store' | 'done' | 'fail' | 'cancel'>;
  readonly controller: AbortController;
  error?: SfError;
}

const isTerminal = (job: Job): boolean => TERMINAL.has(job.machine.state);

export function createRenditionQueue(options: RenditionQueueOptions): RenditionQueue {
  const edge = options.edge ?? THUMBNAIL_EDGE;
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const lifetime = new AbortController();
  const jobs: Job[] = [];
  const view = box<readonly RenditionJob[]>([]);
  const waiters = new Set<() => void>();
  let running = 0;
  let disposed = false;

  const publish = (): void => {
    view.set(jobs.map((j) => ({ asset: j.asset, role: j.role, state: j.machine.state, ...(j.error === undefined ? {} : { error: j.error }) })));
    if (running === 0 && !jobs.some((j) => j.machine.state === 'queued')) for (const wake of [...waiters]) wake();
  };

  const fail = (job: Job, error: SfError): void => {
    if (job.machine.state === 'cancelled') return;
    if (job.controller.signal.aborted) {
      job.machine.send('cancel');
      return;
    }
    job.error = error.code === 'IF-LIB-006' ? error : RenditionError({ message: `The ${job.role} of ${job.asset} could not be produced.`, details: { asset: job.asset, role: job.role }, cause: error });
    job.machine.send('fail');
  };

  const step = async (job: Job): Promise<void> => {
    const { signal } = job.controller;
    const entry = options.library.entry(job.asset);
    if (entry?.content === undefined) return fail(job, UnknownAssetError({ details: { asset: job.asset } }));
    job.machine.send('start');
    publish();
    const bytes = await options.blobs.get(entry.content, { signal });
    if (!bytes.ok) return fail(job, bytes.error);
    const decoded = await options.decoder.decode(bytes.value, entry.content.mime, signal);
    if (!decoded.ok) return fail(job, decoded.error);
    if (signal.aborted) return fail(job, AbortedError());
    job.machine.send('render');
    publish();
    const size = fitWithin(decoded.value.width, decoded.value.height, edge);
    const rendered = await options.renderer.render(decoded.value, size, signal);
    if (!rendered.ok) return fail(job, rendered.error);
    const encoded = await options.encoder.encode(rendered.value, signal);
    if (!encoded.ok) return fail(job, encoded.error);
    if (signal.aborted) return fail(job, AbortedError());
    job.machine.send('store');
    publish();
    const stored = await options.blobs.put(encoded.value, { mime: options.encoder.mime, signal });
    if (!stored.ok) return fail(job, stored.error);
    if (signal.aborted) return fail(job, AbortedError());
    const written = options.library.setRendition(job.asset, job.role, { blob: stored.value, params: { renderer: options.renderer.id, edge, source: entry.content.digest } });
    if (!written.ok) return fail(job, written.error);
    job.machine.send('done');
  };

  const pump = (): void => {
    while (!disposed && running < concurrency) {
      const next = jobs.find((j) => j.machine.state === 'queued');
      if (next === undefined) break;
      running += 1;
      void step(next)
        .catch((cause: unknown) => fail(next, RenditionError({ details: { asset: next.asset, role: next.role }, cause })))
        .finally(() => {
          running -= 1;
          publish();
          pump();
        });
    }
    publish();
  };

  const enqueue = (asset: AssetId, roles: readonly RenditionRole[]): number => {
    let queued = 0;
    for (const role of roles) {
      if (jobs.some((j) => j.asset === asset && j.role === role && !isTerminal(j))) continue;
      const controller = new AbortController();
      lifetime.signal.addEventListener('abort', () => controller.abort(lifetime.signal.reason), { once: true, signal: controller.signal });
      jobs.push({ asset, role, machine: createMachine(RenditionJobMachine), controller });
      queued += 1;
    }
    if (queued > 0) pump();
    return queued;
  };

  return {
    request(asset, requestOptions = {}) {
      if (disposed) return err(LibraryDisposedError());
      const entry = options.library.entry(asset);
      if (entry === undefined) return err(UnknownAssetError({ details: { asset } }));
      const roles = requestOptions.force === true && entry.content !== undefined ? (RENDITION_PRODUCERS[entry.kind] ?? []) : missingRenditions(entry);
      return ok(enqueue(asset, roles));
    },
    resume() {
      if (disposed) return 0;
      return options.library.entries().reduce((n, entry) => n + enqueue(entry.asset, missingRenditions(entry)), 0);
    },
    jobs: () => view.get(),
    cancel(asset) {
      for (const job of jobs) {
        if (job.asset !== asset || isTerminal(job)) continue;
        job.controller.abort();
        if (job.machine.state === 'queued') job.machine.send('cancel');
      }
      publish();
    },
    idle(signal) {
      if (running === 0 && !jobs.some((j) => j.machine.state === 'queued')) return Promise.resolve(ok());
      return new Promise((resolve) => {
        const done = (): void => {
          waiters.delete(done);
          resolve(signal.aborted ? err(AbortedError({ cause: signal.reason })) : ok());
        };
        waiters.add(done);
        signal.addEventListener('abort', done, { once: true });
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      for (const job of jobs) if (job.machine.state === 'queued') job.machine.send('cancel');
      publish();
      for (const wake of [...waiters]) wake();
    },
  };
}
