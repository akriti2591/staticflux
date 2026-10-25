/**
 * Required platform baseline (SF-Δ26, R18.15). An app declares the capabilities it cannot
 * run without, each with the **app's own** stable error code and fix (Instaflow maps them to
 * `IF-PLAT-*`). The verdict picks the boot: `supported` boots the app, `unsupported` boots the
 * single unsupported screen (`unsupportedHostMode` + `unsupportedBootPlan`), naming what is missing.
 *
 * Two kinds of requirement:
 * - `requireApi(name)` — a synchronous `WebApiFacts` presence fact (checked inline, before boot);
 * - `requireFact(fact, accept)` — an async fact (e.g. a WebGPU adapter), resolved by the async lane.
 *
 * `checkBaseline` short-circuits: if a synchronous requirement fails, no async probe runs (nothing
 * else loads). This module has no runtime imports beyond `env.ts` and `web-apis.ts` (inline-safe).
 */
import type { ErrorCode } from '@staticflux/core';
import type { AsyncFactDefinition, AsyncFactLane, AsyncFactReading } from './async-facts.js';
import type { PlatformEnv } from './env.js';
import { readWebApis, type WebApiFacts, type WebApiName } from './web-apis.js';

/** What the unsupported screen shows for one requirement. Code and fix default to the baseline's. */
export interface RequirementCopy {
  /** Names the missing capability, e.g. "WebGPU with a usable graphics adapter". */
  readonly label: string;
  readonly code?: ErrorCode;
  readonly fix?: string;
}

interface RequirementBase {
  /** Stable id (`api:<name>` / `fact:<fact id>` unless given). */
  readonly id: string;
  readonly label: string;
  readonly code: ErrorCode | undefined;
  readonly fix: string | undefined;
}

export interface ApiRequirement extends RequirementBase {
  readonly kind: 'api';
  readonly api: WebApiName;
}

export interface FactRequirement extends RequirementBase {
  readonly kind: 'fact';
  readonly fact: AsyncFactDefinition<unknown>;
  accept(value: unknown): boolean;
}

export type BaselineRequirement = ApiRequirement | FactRequirement;

/* @__NO_SIDE_EFFECTS__ */
export function requireApi(api: WebApiName, copy: RequirementCopy & { readonly id?: string }): ApiRequirement {
  return Object.freeze({ kind: 'api', id: copy.id ?? `api:${api}`, api, label: copy.label, code: copy.code, fix: copy.fix });
}

/* @__NO_SIDE_EFFECTS__ */
export function requireFact<T>(
  fact: AsyncFactDefinition<T>,
  accept: (value: T) => boolean,
  copy: RequirementCopy & { readonly id?: string },
): FactRequirement {
  return Object.freeze({
    kind: 'fact',
    id: copy.id ?? `fact:${fact.id}`,
    fact: fact as AsyncFactDefinition<unknown>,
    accept: accept as (value: unknown) => boolean,
    label: copy.label,
    code: copy.code,
    fix: copy.fix,
  });
}

export interface Baseline<Id extends string = string> {
  readonly kind: 'baseline';
  readonly id: Id;
  /** Default code for requirements without one (e.g. `IF-PLAT-001` "browser unsupported"). */
  readonly code: ErrorCode;
  /** Default fix (e.g. "Open Instaflow in Chrome on desktop."). */
  readonly fix: string;
  readonly requirements: readonly BaselineRequirement[];
}

/* @__NO_SIDE_EFFECTS__ */
export function defineBaseline<const Id extends string>(baseline: Omit<Baseline<Id>, 'kind'>): Baseline<Id> {
  return Object.freeze({ ...baseline, kind: 'baseline' });
}

export type BaselineMissReason =
  /** Synchronous API not present. */
  | 'absent'
  /** Async fact settled, but `accept(value)` said no (e.g. `requestAdapter()` gave `null`). */
  | 'rejected'
  /** Async probe threw, timed out or the lane was disposed. */
  | 'probe-failed';

export interface BaselineMiss {
  readonly id: string;
  readonly label: string;
  readonly code: ErrorCode;
  readonly fix: string;
  readonly reason: BaselineMissReason;
}

export type BaselineStatus = 'supported' | 'unsupported' | 'pending';

export interface BaselineVerdict {
  readonly baseline: string;
  /** `unsupported` as soon as one requirement fails; `pending` while async facts are unresolved. */
  readonly status: BaselineStatus;
  /** Failed requirements, in declaration order. */
  readonly missing: readonly BaselineMiss[];
  /** Requirement ids still waiting for an async fact. */
  readonly pending: readonly string[];
  /** Distinct codes of `missing`, in order (the first is the headline code). */
  readonly codes: readonly ErrorCode[];
}

/** Reading source for async facts (an `AsyncFactLane`, or a fixed map in tests and workers). */
export type AsyncFactReader = (fact: AsyncFactDefinition<unknown>) => AsyncFactReading<unknown> | undefined;

/** Pure: verdict from synchronous API facts and whatever async readings exist now. */
export function evaluateBaseline(baseline: Baseline, apis: WebApiFacts, read?: AsyncFactReader): BaselineVerdict {
  const missing: BaselineMiss[] = [];
  const pending: string[] = [];
  const miss = (requirement: BaselineRequirement, reason: BaselineMissReason): void => {
    missing.push({
      id: requirement.id,
      label: requirement.label,
      code: requirement.code ?? baseline.code,
      fix: requirement.fix ?? baseline.fix,
      reason,
    });
  };
  for (const requirement of baseline.requirements) {
    if (requirement.kind === 'api') {
      if (apis[requirement.api] !== true) miss(requirement, 'absent');
      continue;
    }
    const reading = read?.(requirement.fact);
    if (reading === undefined || reading.state === 'idle' || reading.state === 'probing') {
      pending.push(requirement.id);
    } else if (reading.state === 'settled') {
      let accepted = false;
      try {
        accepted = requirement.accept(reading.value) === true;
      } catch {
        accepted = false;
      }
      if (!accepted) miss(requirement, 'rejected');
    } else {
      miss(requirement, 'probe-failed');
    }
  }
  const status: BaselineStatus = missing.length > 0 ? 'unsupported' : pending.length > 0 ? 'pending' : 'supported';
  return Object.freeze({ baseline: baseline.id, status, missing, pending, codes: [...new Set(missing.map((m) => m.code))] });
}

/** Inline (pre-boot) check: synchronous requirements only; async ones stay `pending`. */
export function checkBaselineSync(baseline: Baseline, env: PlatformEnv): BaselineVerdict {
  return evaluateBaseline(baseline, readWebApis(env));
}

export interface CheckBaselineOptions {
  readonly env: PlatformEnv;
  /** Resolves async requirements (and caches them for later readers, e.g. the renderer reusing the adapter). */
  readonly lane: AsyncFactLane;
  readonly signal?: AbortSignal;
  /** Precomputed API facts (default: read from `env`). */
  readonly apis?: WebApiFacts;
}

/**
 * Full check: synchronous requirements first (an early `unsupported` probes nothing), then every
 * async requirement through the lane, in parallel. Never rejects; a probe failure is a miss.
 */
export async function checkBaseline(baseline: Baseline, options: CheckBaselineOptions): Promise<BaselineVerdict> {
  const apis = options.apis ?? readWebApis(options.env);
  const read: AsyncFactReader = (fact) => options.lane.read(fact);
  const first = evaluateBaseline(baseline, apis, read);
  if (first.status !== 'pending') return first;
  const facts = new Set<AsyncFactDefinition<unknown>>();
  for (const requirement of baseline.requirements) if (requirement.kind === 'fact') facts.add(requirement.fact);
  const signal = options.signal;
  await Promise.all([...facts].map((fact) => options.lane.probe(fact, signal === undefined ? {} : { signal })));
  return evaluateBaseline(baseline, apis, read);
}
