/**
 * Decision models (R19.12, R19.17): Jev-like single-pass classifiers —
 * a typed question + a closed option set → one probability per option.
 *
 * `createDecisionModelProvider` adapts any decision-model transport (remote
 * HTTP, worker, on-device runtime) to the model provider port; only `decide`
 * is supported. The transport is a port so the vendor protocol never leaks.
 *
 * Also hosts the shared validation + prompt-based fallbacks used by LLM
 * providers (built-in Prompt API, remote LLMs) to answer `decide` and
 * `detectLanguage` with constrained JSON output.
 */
import { anySignal, createNoopTelemetry, err, ok, type Result, type Telemetry } from '@staticflux/core';
import { InvalidDecisionError, InvalidModelOutputError } from './errors.js';
import {
  createAiFactsStore,
  type DecideRequest,
  type DecisionResult,
  type DetectLanguageResult,
  instrument,
  type ModelProvider,
  unsupported,
} from './provider.js';

/** Raw decision as returned by a model: array in option order, or a record keyed by option. */
export interface RawDecision {
  readonly probabilities: readonly number[] | Readonly<Partial<Record<string, number>>>;
  readonly confidence?: number;
  readonly explanation?: string;
}

/** Validate and normalize a raw decision against the closed option set. */
export function validateDecision<O extends string>(options: readonly O[], raw: RawDecision): Result<DecisionResult<O>> {
  const values: number[] = [];
  if (Array.isArray(raw.probabilities)) {
    const list = raw.probabilities as readonly number[];
    if (list.length !== options.length) {
      return err(InvalidDecisionError({ message: `Expected ${options.length} probabilities, got ${list.length}.`, details: { options } }));
    }
    values.push(...list);
  } else {
    const record = raw.probabilities as Readonly<Partial<Record<string, number>>>;
    for (const option of options) values.push(record[option] ?? 0);
  }
  if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
    return err(InvalidDecisionError({ message: 'Probabilities must be finite and non-negative.', details: { options } }));
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return err(InvalidDecisionError({ message: 'Decision has no probability mass.', details: { options } }));
  const probabilities = {} as Record<O, number>;
  options.forEach((option, index) => {
    probabilities[option] = (values[index] ?? 0) / total;
  });
  const top = Math.max(...Object.values<number>(probabilities));
  const confidence =
    typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) ? Math.min(1, Math.max(0, raw.confidence)) : top;
  return ok({ probabilities, confidence, ...(raw.explanation === undefined ? {} : { explanation: raw.explanation }) });
}

// ---------------------------------------------------------------- decision-model provider

export interface DecisionModelTransportRequest {
  /** Model id (e.g. a Jev model name). */
  readonly model: string;
  readonly question: unknown;
  readonly options: readonly string[];
}

export interface DecisionModelTransport {
  decide(request: DecisionModelTransportRequest, signal: AbortSignal): Promise<Result<RawDecision>>;
}

export interface DecisionModelProviderOptions {
  readonly id: string;
  readonly model: string;
  readonly transport: DecisionModelTransport;
  readonly telemetry?: Telemetry;
}

export function createDecisionModelProvider(options: DecisionModelProviderOptions): ModelProvider {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const facts = createAiFactsStore(options.id, {
    decide: 'available',
    generate: 'unavailable',
    summarize: 'unavailable',
    translate: 'unavailable',
    'detect-language': 'unavailable',
  }, telemetry);
  const controller = new AbortController();
  return {
    id: options.id,
    kind: 'decision',
    facts,
    probe: () => Promise.resolve(ok(facts.get())),
    prepare: (task) => (task === 'decide' ? Promise.resolve(ok()) : unsupported(options.id, task)),
    generate: () => unsupported(options.id, 'generate'),
    summarize: () => unsupported(options.id, 'summarize'),
    translate: () => unsupported(options.id, 'translate'),
    detectLanguage: () => unsupported(options.id, 'detect-language'),
    decide<O extends string>(request: DecideRequest<O>) {
      return instrument(telemetry, options.id, 'decide', async () => {
        const signal = anySignal(request.signal, controller.signal);
        const raw = await options.transport.decide({ model: options.model, question: request.question, options: request.options }, signal);
        return raw.ok ? validateDecision(request.options, raw.value) : raw;
      });
    },
    dispose: () => {
      controller.abort();
      return Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------- prompt-based fallbacks (LLM providers)

/** A constrained completion: system + user prompt, JSON schema for the reply. */
export type CompleteJson = (
  system: string,
  user: string,
  schema: Readonly<Record<string, unknown>>,
  signal: AbortSignal | undefined,
) => Promise<Result<string>>;

function parseJson(text: string): Result<unknown> {
  try {
    return ok(JSON.parse(text) as unknown);
  } catch (error) {
    return err(InvalidModelOutputError({ cause: error, details: { text: text.slice(0, 200) } }));
  }
}

export async function promptDecide<O extends string>(complete: CompleteJson, request: DecideRequest<O>): Promise<Result<DecisionResult<O>>> {
  const properties = Object.fromEntries(request.options.map((option) => [option, { type: 'number', minimum: 0, maximum: 1 }]));
  const schema = {
    type: 'object',
    properties: {
      probabilities: { type: 'object', properties, required: [...request.options], additionalProperties: false },
      explanation: { type: 'string' },
    },
    required: ['probabilities'],
  };
  const system =
    'You are a classifier. Answer ONLY with JSON matching the schema: a probability in [0,1] for every option, summing to 1.';
  const user = `Question (JSON): ${JSON.stringify(request.question)}\nOptions: ${JSON.stringify(request.options)}`;
  const text = await complete(system, user, schema, request.signal);
  if (!text.ok) return text;
  const parsed = parseJson(text.value);
  if (!parsed.ok) return parsed;
  const value = parsed.value as { probabilities?: unknown; explanation?: unknown };
  if (typeof value !== 'object' || value === null || typeof value.probabilities !== 'object' || value.probabilities === null) {
    return err(InvalidModelOutputError({ message: 'Decision reply has no `probabilities` object.' }));
  }
  return validateDecision(request.options, {
    probabilities: value.probabilities as Readonly<Record<string, number>>,
    ...(typeof value.explanation === 'string' ? { explanation: value.explanation } : {}),
  });
}

export async function promptDetectLanguage(
  complete: CompleteJson,
  text: string,
  signal: AbortSignal | undefined,
): Promise<Result<DetectLanguageResult>> {
  const schema = {
    type: 'object',
    properties: {
      candidates: {
        type: 'array',
        items: {
          type: 'object',
          properties: { language: { type: 'string' }, confidence: { type: 'number' } },
          required: ['language', 'confidence'],
        },
      },
    },
    required: ['candidates'],
  };
  const reply = await complete(
    'Detect the language of the text. Answer ONLY with JSON: BCP 47 codes with confidence in [0,1], most likely first.',
    text,
    schema,
    signal,
  );
  if (!reply.ok) return reply;
  const parsed = parseJson(reply.value);
  if (!parsed.ok) return parsed;
  const candidates = (parsed.value as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return err(InvalidModelOutputError({ message: 'Reply has no `candidates` array.' }));
  const valid = candidates.filter(
    (c): c is { language: string; confidence: number } =>
      typeof c === 'object' && c !== null && typeof (c as { language?: unknown }).language === 'string' &&
      typeof (c as { confidence?: unknown }).confidence === 'number',
  );
  return ok({
    candidates: valid
      .map((c) => ({ language: c.language, confidence: Math.min(1, Math.max(0, c.confidence)) }))
      .sort((a, b) => b.confidence - a.confidence),
  });
}
