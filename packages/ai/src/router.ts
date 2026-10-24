/**
 * Model router: the app-facing `ModelProvider`. Routes each task to the first
 * provider (in contribution order) that can serve it — `available` first, then
 * `downloading`, then `unknown` (e.g. pair-dependent translation) — and falls
 * through to the next provider on SF-AI-001. Facts are the best state per task
 * across providers (reactive).
 *
 * Typical order: built-in (private, free) → on-device → decision model → remote.
 */
import { err, ok, type Result } from '@staticflux/core';
import { AiUnavailableError } from './errors.js';
import {
  AI_TASKS,
  type AiAvailabilityState,
  type AiFacts,
  type AiFactsView,
  type AiTask,
  type ModelProvider,
  type TaskAvailability,
} from './provider.js';

const RANK: { readonly [K in AiAvailabilityState]: number } = {
  unavailable: 0,
  unknown: 1,
  probing: 2,
  downloadable: 3,
  downloading: 4,
  available: 5,
};

const ROUTABLE: readonly AiAvailabilityState[] = ['available', 'downloading', 'unknown'];

export interface ModelRouterOptions {
  readonly id?: string;
  readonly providers: readonly ModelProvider[];
}

export function createModelRouter(options: ModelRouterOptions): ModelProvider {
  const id = options.id ?? 'router';
  const providers = options.providers;

  const merged = (): AiFacts => {
    const out = {} as Record<AiTask, TaskAvailability>;
    for (const task of AI_TASKS) {
      let best: TaskAvailability = { state: 'unavailable', progress: undefined };
      for (const provider of providers) {
        const candidate = provider.facts.of(task);
        if (RANK[candidate.state] > RANK[best.state]) best = candidate;
      }
      out[task] = best;
    }
    return out;
  };

  const facts: AiFactsView = {
    get: merged,
    of: (task) => merged()[task],
    subscribe(listener) {
      const unsubscribes = providers.map((provider) => provider.facts.subscribe(() => listener(merged())));
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
  };

  const candidates = (task: AiTask): readonly ModelProvider[] => {
    const out: ModelProvider[] = [];
    for (const state of ROUTABLE) {
      for (const provider of providers) if (provider.facts.of(task).state === state) out.push(provider);
    }
    return out;
  };

  const route = async <T>(task: AiTask, call: (provider: ModelProvider) => Promise<Result<T>>): Promise<Result<T>> => {
    let last: Result<T> | undefined;
    for (const provider of candidates(task)) {
      const result = await call(provider);
      if (result.ok || result.error.code !== AiUnavailableError.code) return result;
      last = result;
    }
    return last ?? err(AiUnavailableError({ message: `No provider can serve "${task}" right now.`, details: { task } }));
  };

  return {
    id,
    kind: 'router',
    facts,
    async probe(signal) {
      await Promise.all(providers.map((provider) => provider.probe(signal)));
      return ok(merged());
    },
    async prepare(task, prepareOptions) {
      if (providers.some((provider) => provider.facts.of(task).state === 'available')) return ok();
      const target =
        providers.find((provider) => provider.facts.of(task).state === 'downloading') ??
        providers.find((provider) => provider.facts.of(task).state === 'downloadable') ??
        providers.find((provider) => provider.facts.of(task).state === 'unknown');
      if (target === undefined) return err(AiUnavailableError({ details: { task } }));
      return target.prepare(task, prepareOptions);
    },
    generate: (request) => route('generate', (provider) => provider.generate(request)),
    summarize: (request) => route('summarize', (provider) => provider.summarize(request)),
    translate: (request) => route('translate', (provider) => provider.translate(request)),
    detectLanguage: (request) => route('detect-language', (provider) => provider.detectLanguage(request)),
    decide: (request) => route('decide', (provider) => provider.decide(request)),
    // Providers are owned (and disposed) by their own units.
    dispose: () => Promise.resolve(),
  };
}
