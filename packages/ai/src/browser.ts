/**
 * Browser built-in AI adapter (R19.15, R19.17) — Chrome built-in AI shapes:
 *
 *   LanguageModel / Summarizer / Translator / LanguageDetector globals with
 *   `availability(options)` → 'unavailable' | 'downloadable' | 'downloading' | 'available',
 *   `create({ …, signal, monitor(m) { m.addEventListener('downloadprogress', e => e.loaded) } })`.
 *
 * The APIs are experimental, Chromium-first and device-dependent, so:
 * - everything is feature-detected (globals are injectable; the legacy
 *   `self.ai.*` namespace and `capabilities()` shape are accepted as fallbacks);
 * - missing APIs are `unavailable` facts, never errors at import time (Safari/Firefox);
 * - requests never start a model download implicitly: when a model is only
 *   `downloadable`, calls fail with SF-AI-001 and the app calls `prepare(task)`
 *   from a user gesture (Chrome requires user activation for downloads).
 */
import { anySignal, createNoopTelemetry, err, ok, type Result, type Telemetry } from '@staticflux/core';
import { type CompleteJson, promptDecide } from './decision-model.js';
import { AiUnavailableError } from './errors.js';
import {
  AI_TASKS,
  type AiAvailability,
  type AiFacts,
  AiMetrics,
  type AiTask,
  createAiFactsStore,
  instrument,
  mapAiError,
  type ModelProvider,
  type PrepareOptions,
} from './provider.js';

// ---------------------------------------------------------------- structural shapes of the browser APIs

export interface DownloadProgressEventLike extends Event {
  readonly loaded: number;
  readonly total?: number;
}

export interface CreateMonitorLike {
  addEventListener(type: 'downloadprogress', listener: (event: DownloadProgressEventLike) => void): void;
}

interface CreateOptionsBase {
  readonly signal?: AbortSignal;
  readonly monitor?: (monitor: CreateMonitorLike) => void;
}

export interface BuiltInApiStatic<Instance, CreateOptions> {
  availability?(options?: Partial<CreateOptions>): Promise<AiAvailability>;
  /** Legacy (pre-Chrome 138) shape. */
  capabilities?(): Promise<{ readonly available: 'readily' | 'after-download' | 'no' }>;
  create(options?: CreateOptions & CreateOptionsBase): Promise<Instance>;
}

export interface LanguageModelSessionLike {
  prompt(input: string, options?: { readonly signal?: AbortSignal; readonly responseConstraint?: unknown }): Promise<string>;
  destroy(): void;
}
export interface SummarizerLike {
  summarize(text: string, options?: { readonly signal?: AbortSignal; readonly context?: string }): Promise<string>;
  destroy(): void;
}
export interface TranslatorLike {
  translate(text: string, options?: { readonly signal?: AbortSignal }): Promise<string>;
  destroy(): void;
}
export interface LanguageDetectorLike {
  detect(text: string, options?: { readonly signal?: AbortSignal }): Promise<readonly { readonly detectedLanguage: string; readonly confidence: number }[]>;
  destroy(): void;
}

export interface LanguageModelCreateOptions {
  readonly initialPrompts?: readonly { readonly role: 'system' | 'user' | 'assistant'; readonly content: string }[];
}
export interface SummarizerCreateOptions {
  readonly type?: string;
  readonly format?: string;
  readonly length?: string;
}
export interface TranslatorCreateOptions {
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
}

/** The globals this adapter looks for (default: `globalThis`). */
export interface BuiltInAiGlobals {
  readonly LanguageModel?: BuiltInApiStatic<LanguageModelSessionLike, LanguageModelCreateOptions>;
  readonly Summarizer?: BuiltInApiStatic<SummarizerLike, SummarizerCreateOptions>;
  readonly Translator?: BuiltInApiStatic<TranslatorLike, TranslatorCreateOptions>;
  readonly LanguageDetector?: BuiltInApiStatic<LanguageDetectorLike, object>;
  /** Legacy namespace (`self.ai.languageModel`, …). */
  readonly ai?: {
    readonly languageModel?: BuiltInApiStatic<LanguageModelSessionLike, LanguageModelCreateOptions>;
    readonly summarizer?: BuiltInApiStatic<SummarizerLike, SummarizerCreateOptions>;
    readonly translator?: BuiltInApiStatic<TranslatorLike, TranslatorCreateOptions>;
    readonly languageDetector?: BuiltInApiStatic<LanguageDetectorLike, object>;
  };
}

export interface BrowserAiProviderOptions {
  readonly id?: string;
  readonly globals?: BuiltInAiGlobals;
  readonly telemetry?: Telemetry;
  /** Language pair used to probe `translate` availability (it is pair-dependent). Without it the fact stays `unknown`. */
  readonly probeLanguages?: { readonly from: string; readonly to: string };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyStatic = BuiltInApiStatic<any, any>;

const LEGACY: Record<string, string> = {
  LanguageModel: 'languageModel',
  Summarizer: 'summarizer',
  Translator: 'translator',
  LanguageDetector: 'languageDetector',
};

const GLOBAL_FOR_TASK: { readonly [K in AiTask]: keyof typeof LEGACY } = {
  generate: 'LanguageModel',
  decide: 'LanguageModel',
  summarize: 'Summarizer',
  translate: 'Translator',
  'detect-language': 'LanguageDetector',
};

function findApi(globals: BuiltInAiGlobals, name: string): AnyStatic | undefined {
  const direct = (globals as Record<string, unknown>)[name];
  const legacyName = LEGACY[name];
  const legacy = legacyName === undefined ? undefined : (globals.ai as Record<string, unknown> | undefined)?.[legacyName];
  const candidate = direct ?? legacy;
  if (typeof candidate !== 'object' && typeof candidate !== 'function') return undefined;
  if (candidate === null) return undefined;
  const api = candidate as AnyStatic;
  if (typeof api.create !== 'function') return undefined;
  if (typeof api.availability !== 'function' && typeof api.capabilities !== 'function') return undefined;
  return api;
}

async function availabilityOf(api: AnyStatic, options?: object): Promise<AiAvailability> {
  if (typeof api.availability === 'function') {
    const state = await api.availability(options);
    return state === 'available' || state === 'downloadable' || state === 'downloading' ? state : 'unavailable';
  }
  const legacy = await api.capabilities?.();
  if (legacy?.available === 'readily') return 'available';
  if (legacy?.available === 'after-download') return 'downloadable';
  return 'unavailable';
}

/** Feature-detect which built-in AI globals exist (synchronous, no probing). */
export function detectBuiltInAi(globals: BuiltInAiGlobals = globalThis as BuiltInAiGlobals): { readonly [K in AiTask]: boolean } {
  const out = {} as Record<AiTask, boolean>;
  for (const task of AI_TASKS) out[task] = findApi(globals, GLOBAL_FOR_TASK[task]) !== undefined;
  return out;
}

export function createBrowserAiProvider(options: BrowserAiProviderOptions = {}): ModelProvider {
  const id = options.id ?? 'browser-built-in';
  const globals = options.globals ?? (globalThis as BuiltInAiGlobals);
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const present = detectBuiltInAi(globals);
  const initial: Partial<Record<AiTask, AiAvailability>> = {};
  for (const task of AI_TASKS) if (!present[task]) initial[task] = 'unavailable';
  const facts = createAiFactsStore(id, initial, telemetry);
  const instances = new Map<string, Promise<{ destroy(): void }>>();
  const lifetime = new AbortController();

  const api = (task: AiTask): AnyStatic | undefined => findApi(globals, GLOBAL_FOR_TASK[task]);
  const signalFor = (signal: AbortSignal | undefined): AbortSignal => anySignal(signal, lifetime.signal);

  const monitorFor = (tasks: readonly AiTask[], onProgress?: (fraction: number) => void) => (monitor: CreateMonitorLike) => {
    // The monitor is created by the browser for one create() call and dropped with it; CreateMonitorLike takes no options.
    // sf-lint-disable-next-line no-bare-listener -- listener lifetime equals the per-call monitor object
    monitor.addEventListener('downloadprogress', (event) => {
      const fraction = typeof event.total === 'number' && event.total > 1 ? event.loaded / event.total : event.loaded;
      for (const task of tasks) {
        facts.send(task, 'downloading');
        facts.progress(task, fraction);
      }
      onProgress?.(fraction);
    });
  };

  const tasksSharing = (task: AiTask): readonly AiTask[] => AI_TASKS.filter((t) => GLOBAL_FOR_TASK[t] === GLOBAL_FOR_TASK[task]);

  /** Fail fast unless the model is ready (never trigger a download implicitly). */
  const requireReady = async (task: AiTask, availabilityOptions?: object): Promise<Result<AnyStatic>> => {
    const found = api(task);
    if (found === undefined) return err(AiUnavailableError({ message: `Built-in AI for "${task}" is not supported here.`, details: { task } }));
    const state = await availabilityOf(found, availabilityOptions);
    // translate availability is per language pair; only probe() (with probeLanguages) sets that fact.
    if (task !== 'translate') for (const shared of tasksSharing(task)) facts.settle(shared, state);
    if (state === 'available' || state === 'downloading') return ok(found);
    return err(
      AiUnavailableError({
        message:
          state === 'downloadable'
            ? `The "${task}" model must be downloaded first: call prepare("${task}") from a user gesture.`
            : `Built-in AI for "${task}" is unavailable on this device.`,
        details: { task, state },
      }),
    );
  };

  const cached = <T extends { destroy(): void }>(key: string, create: () => Promise<T>): Promise<T> => {
    let instance = instances.get(key) as Promise<T> | undefined;
    if (instance === undefined) {
      instance = create();
      instances.set(key, instance);
      instance.catch(() => instances.delete(key));
    }
    return instance;
  };

  const completeJson: CompleteJson = async (system, user, schema, signal) => {
    const ready = await requireReady('decide');
    if (!ready.ok) return ready;
    const combined = signalFor(signal);
    const session = (await ready.value.create({
      initialPrompts: [{ role: 'system', content: system }],
      signal: combined,
      monitor: monitorFor(tasksSharing('decide')),
    })) as LanguageModelSessionLike;
    try {
      return ok(await session.prompt(user, { signal: combined, responseConstraint: schema }));
    } finally {
      session.destroy();
    }
  };

  const provider: ModelProvider = {
    id,
    kind: 'built-in',
    facts,

    async probe(signal) {
      const probed = new Set<string>();
      for (const task of AI_TASKS) {
        const found = api(task);
        if (found === undefined || signal?.aborted === true) continue;
        if (task === 'translate' && options.probeLanguages === undefined) continue;
        const group = GLOBAL_FOR_TASK[task];
        if (probed.has(group)) continue;
        probed.add(group);
        const shared = tasksSharing(task);
        for (const t of shared) facts.send(t, 'probe');
        try {
          const availabilityOptions =
            task === 'translate' && options.probeLanguages !== undefined
              ? { sourceLanguage: options.probeLanguages.from, targetLanguage: options.probeLanguages.to }
              : undefined;
          const state = await availabilityOf(found, availabilityOptions);
          for (const t of shared) facts.send(t, state);
        } catch {
          for (const t of shared) facts.send(t, 'fail');
        }
      }
      return ok<AiFacts>(facts.get());
    },

    async prepare(task, prepareOptions: PrepareOptions = {}) {
      const found = api(task);
      if (found === undefined) return err(AiUnavailableError({ details: { task } }));
      const shared = tasksSharing(task);
      const languages = prepareOptions.languages;
      if (task === 'translate' && languages === undefined) {
        return err(AiUnavailableError({ message: 'prepare("translate") needs `languages: { from, to }`.', details: { task } }));
      }
      const createOptions =
        task === 'translate' && languages !== undefined ? { sourceLanguage: languages.from, targetLanguage: languages.to } : {};
      let state: AiAvailability;
      try {
        state = await availabilityOf(found, task === 'translate' ? createOptions : undefined);
      } catch (error) {
        return err(mapAiError(error, task));
      }
      if (state === 'unavailable') {
        for (const t of shared) facts.settle(t, 'unavailable');
        return err(AiUnavailableError({ details: { task, state } }));
      }
      for (const t of shared) facts.settle(t, state);
      if (state === 'available' && task !== 'translate') return ok();
      telemetry.record(AiMetrics.downloads, 1, { provider: id, task, phase: 'started' });
      for (const t of shared) facts.send(t, 'downloading');
      try {
        const instance = (await found.create({
          ...createOptions,
          signal: signalFor(prepareOptions.signal),
          monitor: monitorFor(shared, prepareOptions.onProgress),
        })) as { destroy(): void };
        // Keep reusable instances; sessions/summarizers are created per use with their own options.
        if (task === 'translate' && languages !== undefined) instances.set(`translate:${languages.from}:${languages.to}`, Promise.resolve(instance));
        else if (task === 'detect-language') instances.set('detect-language', Promise.resolve(instance));
        else instance.destroy();
        for (const t of shared) facts.send(t, 'available');
        telemetry.record(AiMetrics.downloads, 1, { provider: id, task, phase: 'completed' });
        return ok();
      } catch (error) {
        const mapped = mapAiError(error, task);
        for (const t of shared) facts.send(t, mapped.kind === 'unavailable' && mapped.code === 'SF-AI-001' ? 'unavailable' : 'downloadable');
        telemetry.record(AiMetrics.downloads, 1, { provider: id, task, phase: 'failed' });
        return err(mapped);
      }
    },

    generate(request) {
      return instrument(telemetry, id, 'generate', async () => {
        const ready = await requireReady('generate');
        if (!ready.ok) return ready;
        const signal = signalFor(request.signal);
        const session = (await ready.value.create({
          ...(request.system === undefined ? {} : { initialPrompts: [{ role: 'system', content: request.system }] }),
          signal,
          monitor: monitorFor(tasksSharing('generate')),
        })) as LanguageModelSessionLike;
        try {
          return ok({ text: await session.prompt(request.prompt, { signal }) });
        } finally {
          session.destroy();
        }
      });
    },

    summarize(request) {
      return instrument(telemetry, id, 'summarize', async () => {
        const ready = await requireReady('summarize');
        if (!ready.ok) return ready;
        const createOptions: SummarizerCreateOptions = {
          type: request.type ?? 'key-points',
          format: request.format ?? 'plain-text',
          length: request.length ?? 'medium',
        };
        const summarizer = await cached(`summarize:${createOptions.type}:${createOptions.format}:${createOptions.length}`, () =>
          ready.value.create({ ...createOptions, signal: lifetime.signal, monitor: monitorFor(['summarize']) }) as Promise<SummarizerLike>,
        );
        const text = await summarizer.summarize(request.text, {
          signal: signalFor(request.signal),
          ...(request.context === undefined ? {} : { context: request.context }),
        });
        return ok({ text });
      });
    },

    translate(request) {
      return instrument(telemetry, id, 'translate', async () => {
        const pair = { sourceLanguage: request.from, targetLanguage: request.to };
        const ready = await requireReady('translate', pair);
        if (!ready.ok) return ready;
        const translator = await cached(`translate:${request.from}:${request.to}`, () =>
          ready.value.create({ ...pair, signal: lifetime.signal, monitor: monitorFor(['translate']) }) as Promise<TranslatorLike>,
        );
        return ok({ text: await translator.translate(request.text, { signal: signalFor(request.signal) }) });
      });
    },

    detectLanguage(request) {
      return instrument(telemetry, id, 'detect-language', async () => {
        const ready = await requireReady('detect-language');
        if (!ready.ok) return ready;
        const detector = await cached('detect-language', () =>
          ready.value.create({ signal: lifetime.signal, monitor: monitorFor(['detect-language']) }) as Promise<LanguageDetectorLike>,
        );
        const results = await detector.detect(request.text, { signal: signalFor(request.signal) });
        return ok({
          candidates: results
            .map((r) => ({ language: r.detectedLanguage, confidence: r.confidence }))
            .sort((a, b) => b.confidence - a.confidence),
        });
      });
    },

    decide(request) {
      return instrument(telemetry, id, 'decide', () => promptDecide(completeJson, request));
    },

    async dispose() {
      lifetime.abort();
      const pending = [...instances.values()];
      instances.clear();
      for (const instance of pending) {
        try {
          (await instance).destroy();
        } catch {
          // creation failed or was aborted: nothing to destroy
        }
      }
    },
  };
  return provider;
}
