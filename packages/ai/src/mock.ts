/**
 * Deterministic mock provider (tests, example app, devtools). Availability can
 * be scripted, including a simulated download with progress.
 */
import { AbortedError, createNoopTelemetry, err, ok, type Result, type SfError, type Telemetry } from '@staticflux/core';
import { validateDecision } from './decision-model.js';
import { AiUnavailableError } from './errors.js';
import {
  AI_TASKS,
  type AiAvailability,
  type AiTask,
  createAiFactsStore,
  type DecideRequest,
  type DetectLanguageResult,
  instrument,
  type ModelProvider,
} from './provider.js';

export interface MockProviderOptions {
  readonly id?: string;
  /** Initial availability per task. Default: every task `available`. */
  readonly availability?: Partial<Record<AiTask, AiAvailability>>;
  readonly generate?: (prompt: string, system: string | undefined) => string;
  readonly summarize?: (text: string) => string;
  readonly translate?: (text: string, from: string, to: string) => string;
  readonly detectLanguage?: (text: string) => DetectLanguageResult;
  /** Raw probabilities keyed by option. Default: uniform. */
  readonly decide?: (question: unknown, options: readonly string[]) => Readonly<Record<string, number>>;
  /** Make every call fail with this error. */
  readonly failWith?: SfError;
  /** Simulated latency per call (ms). Default 0 (microtask). */
  readonly latencyMs?: number;
  /** Progress steps reported by `prepare` (default [0.5, 1]). */
  readonly downloadSteps?: readonly number[];
  readonly telemetry?: Telemetry;
}

export interface MockModelProvider extends ModelProvider {
  /** Every request, in order (`task` + payload). */
  readonly calls: { readonly task: AiTask; readonly input: unknown }[];
  /** Script availability changes (e.g. simulate a device losing the model). */
  setAvailability(task: AiTask, state: AiAvailability): void;
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<Result<void>> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve(err(AbortedError({ cause: signal.reason })));
      return;
    }
    // Aborted to detach the abort listener once the timer wins.
    const detach = new AbortController();
    const timer = setTimeout(() => {
      detach.abort();
      resolve(ok());
    }, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve(err(AbortedError({ cause: signal.reason })));
      },
      { once: true, signal: detach.signal },
    );
  });
}

export function createMockProvider(options: MockProviderOptions = {}): MockModelProvider {
  const id = options.id ?? 'mock';
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const initial: Partial<Record<AiTask, AiAvailability>> = {};
  for (const task of AI_TASKS) initial[task] = options.availability?.[task] ?? 'available';
  const facts = createAiFactsStore(id, initial, telemetry);
  const calls: { task: AiTask; input: unknown }[] = [];

  const run = <T>(task: AiTask, input: unknown, signal: AbortSignal | undefined, produce: () => Result<T>): Promise<Result<T>> =>
    instrument(telemetry, id, task, async () => {
      calls.push({ task, input });
      const state = facts.of(task).state;
      if (state !== 'available') {
        return err(AiUnavailableError({ message: `Mock "${task}" is ${state}.`, details: { task, state } }));
      }
      const waited = await delay(options.latencyMs ?? 0, signal);
      if (!waited.ok) return waited;
      if (options.failWith !== undefined) return err(options.failWith);
      return produce();
    });

  return {
    id,
    kind: 'mock',
    facts,
    calls,
    setAvailability(task, state) {
      facts.settle(task, state);
    },
    probe: () => Promise.resolve(ok(facts.get())),
    async prepare(task, prepareOptions = {}) {
      const state = facts.of(task).state;
      if (state === 'available') return ok();
      if (state === 'unavailable') return err(AiUnavailableError({ details: { task } }));
      facts.send(task, 'downloading');
      for (const step of options.downloadSteps ?? [0.5, 1]) {
        const waited = await delay(0, prepareOptions.signal);
        if (!waited.ok) {
          facts.send(task, 'downloadable');
          return waited;
        }
        facts.progress(task, step);
        prepareOptions.onProgress?.(step);
      }
      facts.send(task, 'available');
      return ok();
    },
    generate: (request) =>
      run('generate', request.prompt, request.signal, () =>
        ok({ text: options.generate?.(request.prompt, request.system) ?? `mock: ${request.prompt}` }),
      ),
    summarize: (request) =>
      run('summarize', request.text, request.signal, () =>
        ok({ text: options.summarize?.(request.text) ?? request.text.slice(0, 40) }),
      ),
    translate: (request) =>
      run('translate', request, request.signal, () =>
        ok({ text: options.translate?.(request.text, request.from, request.to) ?? `[${request.to}] ${request.text}` }),
      ),
    detectLanguage: (request) =>
      run('detect-language', request.text, request.signal, () =>
        ok(options.detectLanguage?.(request.text) ?? { candidates: [{ language: 'en', confidence: 1 }] }),
      ),
    decide<O extends string>(request: DecideRequest<O>) {
      return run('decide', request.question, request.signal, () =>
        validateDecision(request.options, {
          probabilities: options.decide?.(request.question, request.options) ?? Object.fromEntries(request.options.map((o) => [o, 1])),
        }),
      );
    },
    dispose: () => Promise.resolve(),
  };
}
