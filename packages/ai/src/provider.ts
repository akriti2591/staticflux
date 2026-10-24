/**
 * The model provider port (R19.17): one interface over browser built-in AI,
 * on-device models, decision models (Jev-like) and remote LLMs.
 *
 * - Every call is async, takes an AbortSignal and returns a Result.
 *   AI is never on the critical path: callers must have a non-AI fallback.
 * - Availability (including model download state and progress) is exposed as
 *   reactive facts per task, so features and gates can depend on it.
 * - `decide` is the closed-option classifier: a typed question + options →
 *   per-option probabilities. It structurally satisfies the advisors'
 *   `DecisionModelPort`, so a provider plugs into the model advisor tier as-is.
 */
import {
  box,
  createMachine,
  defineMachine,
  err,
  type Machine,
  metric,
  type Result,
  type SfError,
  type Telemetry,
  toSfError,
} from '@staticflux/core';
import { AiProviderFailedError, AiUnavailableError, AiUserActivationRequiredError } from './errors.js';

export const AI_SUBSYSTEM = 'ai/provider' as const;

export const AI_TASKS = ['generate', 'summarize', 'translate', 'detect-language', 'decide'] as const;
export type AiTask = (typeof AI_TASKS)[number];

/** Mirrors the `availability()` states of the Chrome built-in AI APIs. */
export type AiAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';
export type AiAvailabilityState = AiAvailability | 'unknown' | 'probing';

export interface TaskAvailability {
  readonly state: AiAvailabilityState;
  /** Download progress in [0,1] while `downloading`. */
  readonly progress: number | undefined;
}

export type AiFacts = { readonly [K in AiTask]: TaskAvailability };

export type ProviderKind = 'built-in' | 'on-device' | 'decision' | 'remote' | 'mock' | 'router';

// ---------------------------------------------------------------- requests

export interface GenerateRequest {
  readonly prompt: string;
  readonly system?: string;
  readonly signal?: AbortSignal;
}
export interface GenerateResult {
  readonly text: string;
}

export type SummaryType = 'key-points' | 'tldr' | 'teaser' | 'headline';
export type SummaryLength = 'short' | 'medium' | 'long';
export type SummaryFormat = 'plain-text' | 'markdown';

export interface SummarizeRequest {
  readonly text: string;
  readonly type?: SummaryType;
  readonly length?: SummaryLength;
  readonly format?: SummaryFormat;
  /** Extra context (not summarized). */
  readonly context?: string;
  readonly signal?: AbortSignal;
}
export interface SummarizeResult {
  readonly text: string;
}

export interface TranslateRequest {
  readonly text: string;
  /** BCP 47 source language. */
  readonly from: string;
  readonly to: string;
  readonly signal?: AbortSignal;
}
export interface TranslateResult {
  readonly text: string;
}

export interface DetectLanguageRequest {
  readonly text: string;
  readonly signal?: AbortSignal;
}
export interface LanguageCandidate {
  readonly language: string;
  readonly confidence: number;
}
export interface DetectLanguageResult {
  /** Most likely first. */
  readonly candidates: readonly LanguageCandidate[];
}

export interface DecideRequest<O extends string> {
  /** Serializable, minimized question. */
  readonly question: unknown;
  /** The closed option set. */
  readonly options: readonly O[];
  readonly signal?: AbortSignal;
}
export interface DecisionResult<O extends string> {
  /** Normalized; one entry per option. */
  readonly probabilities: { readonly [K in O]: number };
  readonly confidence: number;
  readonly explanation?: string;
}

export interface PrepareOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (fraction: number) => void;
  /** Language pair for `translate`. */
  readonly languages?: { readonly from: string; readonly to: string };
}

/** Reactive availability facts of one provider. */
export interface AiFactsView {
  /** Reactive read. */
  get(): AiFacts;
  of(task: AiTask): TaskAvailability;
  subscribe(listener: (facts: AiFacts) => void): () => void;
}

export interface ModelProvider {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly facts: AiFactsView;
  /** Refresh availability (cheap; never downloads). */
  probe(signal?: AbortSignal): Promise<Result<AiFacts>>;
  /** Start/await the model download for a task (call from a user gesture when `downloadable`). */
  prepare(task: AiTask, options?: PrepareOptions): Promise<Result<void>>;
  generate(request: GenerateRequest): Promise<Result<GenerateResult>>;
  summarize(request: SummarizeRequest): Promise<Result<SummarizeResult>>;
  translate(request: TranslateRequest): Promise<Result<TranslateResult>>;
  detectLanguage(request: DetectLanguageRequest): Promise<Result<DetectLanguageResult>>;
  /** Closed-option decision / classification. */
  decide<O extends string>(request: DecideRequest<O>): Promise<Result<DecisionResult<O>>>;
  dispose(): Promise<void>;
}

/** The most likely option of a decision (classification helper). */
export function classify<O extends string>(result: DecisionResult<O>, options: readonly O[]): O | undefined {
  let best: O | undefined;
  let bestValue = 0;
  for (const option of options) {
    if (result.probabilities[option] > bestValue) {
      best = option;
      bestValue = result.probabilities[option];
    }
  }
  return best;
}

// ---------------------------------------------------------------- availability lifecycle

/** Per-task model availability. Mirror into docs/LIFECYCLES.md §14. */
export const availabilityMachine = defineMachine({
  id: 'ai/model-availability',
  initial: 'unknown',
  states: ['unknown', 'probing', 'unavailable', 'downloadable', 'downloading', 'available'],
  transitions: {
    unknown: { probe: 'probing', unavailable: 'unavailable', downloadable: 'downloadable', available: 'available' },
    probing: {
      unavailable: 'unavailable',
      downloadable: 'downloadable',
      downloading: 'downloading',
      available: 'available',
      fail: 'unknown',
    },
    unavailable: { probe: 'probing' },
    downloadable: { probe: 'probing', downloading: 'downloading' },
    downloading: { available: 'available', downloadable: 'downloadable', unavailable: 'unavailable', probe: 'probing' },
    available: { probe: 'probing' },
  },
});

export type AvailabilityEvent = 'probe' | 'fail' | AiAvailability;

export interface AiFactsStore extends AiFactsView {
  /** Apply a lifecycle event; invalid transitions are ignored (returns false). */
  send(task: AiTask, event: AvailabilityEvent): boolean;
  /** Report download progress (only while downloading). */
  progress(task: AiTask, fraction: number): void;
  /** Set a probe result: probe → result (from any settled state). */
  settle(task: AiTask, state: AiAvailability): void;
}

export function createAiFactsStore(
  providerId: string,
  initial: Partial<Record<AiTask, AiAvailability>> = {},
  telemetry?: Telemetry,
): AiFactsStore {
  const machines = new Map<AiTask, Machine<AiAvailabilityState, AvailabilityEvent>>();
  const progress = new Map<AiTask, number>();
  for (const task of AI_TASKS) {
    const start = initial[task];
    const machine = createMachine(availabilityMachine, start === undefined ? {} : { initial: start });
    machine.onTransition((record) =>
      telemetry?.event(`lifecycle.${availabilityMachine.id}.${record.from}→${record.to}`, {
        subsystem: AI_SUBSYSTEM,
        level: 'verbose',
        attrs: { provider: providerId, task },
      }),
    );
    machines.set(task, machine as Machine<AiAvailabilityState, AvailabilityEvent>);
  }
  const listeners = new Set<(facts: AiFacts) => void>();
  const snapshot = (): AiFacts => {
    const out = {} as Record<AiTask, TaskAvailability>;
    for (const task of AI_TASKS) {
      const state = machines.get(task)?.state ?? 'unknown';
      out[task] = { state, progress: state === 'downloading' ? (progress.get(task) ?? 0) : undefined };
    }
    return out;
  };
  const current = box<AiFacts>(snapshot());
  const publish = (): void => {
    const next = snapshot();
    current.set(next);
    for (const listener of [...listeners]) listener(next);
  };
  const send = (task: AiTask, event: AvailabilityEvent): boolean => {
    const machine = machines.get(task);
    if (machine === undefined || !machine.can(event)) return false;
    machine.send(event);
    if (event !== 'downloading') progress.delete(task);
    publish();
    return true;
  };
  return {
    get: () => current.get(),
    of: (task) => current.get()[task],
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    send,
    progress(task, fraction) {
      if (machines.get(task)?.state !== 'downloading') return;
      progress.set(task, Math.min(1, Math.max(0, fraction)));
      publish();
    },
    settle(task, state) {
      const machine = machines.get(task);
      if (machine === undefined || machine.state === state) return;
      if (machine.state !== 'probing') send(task, 'probe');
      send(task, state);
    },
  };
}

// ---------------------------------------------------------------- telemetry helpers

export const AiMetrics = {
  requests: metric.counter('ai/requests', { description: 'AI requests by provider, task and outcome.' }),
  latency: metric.histogram('ai/latency', { unit: 'ms', description: 'AI request latency by provider and task.' }),
  downloads: metric.counter('ai/downloads', { description: 'Model downloads started/completed/failed.' }),
} as const;

/** Run one provider request inside a span with metrics; thrown errors become Results. */
export async function instrument<T>(
  telemetry: Telemetry,
  providerId: string,
  task: AiTask,
  run: () => Promise<Result<T>>,
): Promise<Result<T>> {
  const start = telemetry.now();
  const span = telemetry.span(`ai.${task}`, { subsystem: AI_SUBSYSTEM, attrs: { provider: providerId, task } });
  let result: Result<T>;
  try {
    result = await run();
  } catch (error) {
    result = err(mapAiError(error, task));
  }
  const outcome = result.ok ? 'ok' : result.error.kind === 'aborted' ? 'cancelled' : 'error';
  telemetry.record(AiMetrics.requests, 1, { provider: providerId, task, outcome }, span);
  telemetry.record(AiMetrics.latency, telemetry.now() - start, { provider: providerId, task }, span);
  if (result.ok) span.end('ok');
  else span.end(outcome === 'cancelled' ? 'cancelled' : 'error', result.error);
  return result;
}

/** Map thrown browser AI exceptions to typed errors. */
export function mapAiError(error: unknown, task: AiTask): SfError {
  const name = typeof error === 'object' && error !== null && 'name' in error ? (error as { name: unknown }).name : undefined;
  if (name === 'AbortError' || name === 'TimeoutError') return toSfError(error);
  if (name === 'NotAllowedError') return AiUserActivationRequiredError({ cause: error, details: { task } });
  if (name === 'NotSupportedError' || name === 'NotReadableError') return AiUnavailableError({ cause: error, details: { task } });
  const known = toSfError(error);
  if (known.code !== 'SF-CORE-000') return known;
  return AiProviderFailedError({ cause: error, message: `AI ${task} failed: ${known.message}`, details: { task } });
}

export function unsupported(providerId: string, task: AiTask): Promise<Result<never>> {
  return Promise.resolve(
    err(AiUnavailableError({ message: `Provider "${providerId}" does not support "${task}".`, details: { provider: providerId, task } })),
  );
}
