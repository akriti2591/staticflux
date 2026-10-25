/**
 * D15: editor and render are modules with fixed ports; **one worker or two is a boot-time setting,
 * not a code path**. The plan below is data: which worker hosts which module and which medium each
 * pipe uses. Module code never asks which topology it runs in.
 *
 * - `colocated` (default): one worker hosts both modules; deltas and view frames use the `local`
 *   medium (plain memory, microtask wake-ups). Met the budget on the owner's GPU (9.8 ms p95).
 * - `split`: one worker each; deltas and frames use `shared` (SharedArrayBuffer + Atomics) when the
 *   page is cross-origin isolated, else `message`. Missed the budget (19.7 ms p95) because the render
 *   worker's rAF phase lands late; the main-rAF tick (`MAIN_TICK_PACING`) is the fix under test.
 * - The input ring and the main tick always cross from main into a worker (`shared` or `message`).
 */
import type { IsolationFacts } from '@staticflux/worker';
import { type PipeMedium, selectMedium, type Topology } from '@staticflux/worker/pipeline';
import { DEFAULT_RENDER_PACING, type RenderPacing } from './pacing.js';

export type { Topology };
export type ModuleRole = 'editor' | 'render';

export interface SequencingSettings {
  readonly topology: Topology;
  readonly pacing: RenderPacing;
  /** Editor coalescing after input arrives (ms). */
  readonly editorCoalesceMs: number;
  /** Name of the render port factory the render worker builds (`hostSequencingWorker({ renderPorts })`). */
  readonly renderPort: string;
}

export const DEFAULT_SEQUENCING_SETTINGS: SequencingSettings = Object.freeze({
  topology: 'colocated',
  pacing: DEFAULT_RENDER_PACING,
  editorCoalesceMs: 0,
  renderPort: 'default',
});

export interface SequencingMedia {
  /** main → editor input ring. */
  readonly input: PipeMedium;
  /** editor → render scene deltas and view frames. */
  readonly modules: PipeMedium;
  /** main → render tick cell. */
  readonly tick: PipeMedium;
}

export interface SequencingWorkerPlan {
  readonly name: string;
  readonly roles: readonly ModuleRole[];
}

export interface SequencingPlan {
  readonly topology: Topology;
  readonly workers: readonly SequencingWorkerPlan[];
  readonly media: SequencingMedia;
}

const WORKERS: Readonly<Record<Topology, readonly SequencingWorkerPlan[]>> = {
  colocated: [{ name: 'pipeline', roles: ['editor', 'render'] }],
  split: [
    { name: 'editor', roles: ['editor'] },
    { name: 'render', roles: ['render'] },
  ],
};

export interface PlanOptions {
  readonly isolation?: IsolationFacts;
  /** Override media (tests run every medium on every topology). */
  readonly media?: Partial<SequencingMedia>;
}

/** The boot plan for a topology (pure data). */
export function planSequencing(settings: Pick<SequencingSettings, 'topology'>, options: PlanOptions = {}): SequencingPlan {
  const isolation = options.isolation === undefined ? {} : { isolation: options.isolation };
  const crossThread = selectMedium({ topology: 'split', ...isolation });
  return {
    topology: settings.topology,
    workers: WORKERS[settings.topology],
    media: {
      input: options.media?.input ?? crossThread,
      modules: options.media?.modules ?? selectMedium({ topology: settings.topology, ...isolation }),
      tick: options.media?.tick ?? crossThread,
    },
  };
}

/** The worker of a plan that hosts `role`. */
export function workerFor(plan: SequencingPlan, role: ModuleRole): SequencingWorkerPlan | undefined {
  return plan.workers.find((worker) => worker.roles.includes(role));
}
