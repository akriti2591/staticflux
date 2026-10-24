/**
 * Model and remote tiers (R19.6, R19.11, R19.12, R19.14).
 *
 * - Model tier: an on-device decision model behind `DecisionModelPort`.
 *   `@staticflux/ai` model providers satisfy this port structurally
 *   (`provider.decide({ question, options, signal })`), so advisors never import ai.
 * - Remote tier: a remote decision service behind `RemoteAdvisorTransport`.
 *   It receives ONLY the declared, minimized feature vector — never the raw
 *   question or user content (R19.14) — and is only consulted when the
 *   environment explicitly allows remote advisors (private by default, R19.11).
 */
import { AbortedError, err, ok, type Result } from '@staticflux/core';
import type { Advisor, AdvisorAnswer, AdvisorTier } from './advisor.js';
import type { AnyDecisionPoint, DecisionPoint, DecisionPointId, LatencyClass } from './decision.js';
import { UnsupportedPointError } from './errors.js';

export interface DecisionModelRequest {
  /** A serializable question (already minimized by the binding's `encode`). */
  readonly question: unknown;
  readonly options: readonly string[];
  readonly signal: AbortSignal;
}

export interface DecisionModelAnswer {
  readonly probabilities: Readonly<Partial<Record<string, number>>>;
  readonly confidence?: number;
  readonly explanation?: string;
}

/** On-device decision model (Jev-like: closed options → per-option probabilities). */
export interface DecisionModelPort {
  decide(request: DecisionModelRequest): Promise<Result<DecisionModelAnswer>>;
}

/** Declared, minimized features sent to remote advisors (R19.14). */
export type FeatureVector = Readonly<Record<string, number | boolean | string>>;

export interface RemoteAdviceRequest {
  readonly point: string;
  readonly options: readonly string[];
  readonly features: FeatureVector;
}

export interface RemoteAdvisorTransport {
  advise(request: RemoteAdviceRequest, signal: AbortSignal): Promise<Result<DecisionModelAnswer>>;
}

export interface PointBinding<T> {
  readonly point: AnyDecisionPoint;
  readonly encode: (question: unknown) => T;
}

/** Bind a point to a model, with a typed encoder that minimizes the question. */
export function modelBinding<Q, O extends string, Id extends DecisionPointId>(
  point: DecisionPoint<Q, O, Id>,
  encode: (question: Q) => unknown,
): PointBinding<unknown> {
  return { point, encode: (question) => encode(question as Q) };
}

/** Bind a point to a remote advisor with a feature-vector encoder (the only data that leaves the device). */
export function remoteBinding<Q, O extends string, Id extends DecisionPointId>(
  point: DecisionPoint<Q, O, Id>,
  features: (question: Q) => FeatureVector,
): PointBinding<FeatureVector> {
  return { point, encode: (question) => features(question as Q) };
}

function toAnswer(answer: DecisionModelAnswer): AdvisorAnswer {
  return {
    distribution: answer.probabilities,
    ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
    ...(answer.explanation === undefined ? {} : { explanation: answer.explanation }),
  };
}

function bindingsById<T>(bindings: readonly PointBinding<T>[]): Map<string, PointBinding<T>> {
  return new Map(bindings.map((binding) => [binding.point.id, binding]));
}

export interface ModelAdvisorOptions {
  readonly id: string;
  readonly model: DecisionModelPort;
  readonly bindings: readonly PointBinding<unknown>[];
  /** Default `background`. */
  readonly latency?: LatencyClass;
  readonly tier?: Extract<AdvisorTier, 'model'>;
}

export function createModelAdvisor(options: ModelAdvisorOptions): Advisor {
  const bindings = bindingsById(options.bindings);
  return {
    id: options.id,
    tier: options.tier ?? 'model',
    latency: options.latency ?? 'background',
    supports: (point) => bindings.has(point.id),
    async advise(point, question, context) {
      const binding = bindings.get(point.id);
      if (binding === undefined) return err(UnsupportedPointError({ details: { advisor: options.id, point: point.id } }));
      const answer = await options.model.decide({
        question: binding.encode(question),
        options: point.options,
        signal: context.signal,
      });
      return answer.ok ? ok(toAnswer(answer.value)) : answer;
    },
  };
}

export interface RemoteAdvisorOptions {
  readonly id: string;
  readonly transport: RemoteAdvisorTransport;
  readonly bindings: readonly PointBinding<FeatureVector>[];
}

export function createRemoteAdvisor(options: RemoteAdvisorOptions): Advisor {
  const bindings = bindingsById(options.bindings);
  return {
    id: options.id,
    tier: 'remote',
    latency: 'background',
    supports: (point) => bindings.has(point.id),
    async advise(point, question, context) {
      const binding = bindings.get(point.id);
      if (binding === undefined) return err(UnsupportedPointError({ details: { advisor: options.id, point: point.id } }));
      const answer = await options.transport.advise(
        { point: point.id, options: point.options, features: binding.encode(question) },
        context.signal,
      );
      return answer.ok ? ok(toAnswer(answer.value)) : answer;
    },
  };
}

/** A mocked remote transport (R19.6: remote tier is a contract, mocked). */
export function createMockRemoteTransport(
  answer: (request: RemoteAdviceRequest) => DecisionModelAnswer | Result<DecisionModelAnswer>,
  options: { readonly latencyMs?: number } = {},
): RemoteAdvisorTransport & { readonly requests: RemoteAdviceRequest[] } {
  const requests: RemoteAdviceRequest[] = [];
  return {
    requests,
    advise(request, signal) {
      requests.push(request);
      return new Promise((resolve) => {
        const respond = (): void => {
          const value = answer(request);
          resolve('ok' in value && typeof value.ok === 'boolean' ? (value as Result<DecisionModelAnswer>) : ok(value as DecisionModelAnswer));
        };
        if (options.latencyMs === undefined) {
          respond();
          return;
        }
        const timer = setTimeout(respond, options.latencyMs);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve(err(AbortedError({ cause: signal.reason })));
          },
          { once: true },
        );
      });
    },
  };
}
