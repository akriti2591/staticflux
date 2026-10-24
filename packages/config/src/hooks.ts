/**
 * OpenFeature-shaped evaluation hooks (`before` / `after` / `error` / `finally`).
 * Field names follow the OpenFeature spec so existing hooks (e.g. an OTel
 * hook) can be passed structurally. Hooks are synchronous here because client
 * evaluations are synchronous (static-context paradigm).
 */
import type { SfError } from '@staticflux/core';
import type { EvaluationContext } from './context.js';
import type { FlagKey, FlagValueType } from './flag.js';
import type { EvaluationReason, LayerId } from './layer.js';

export interface LayerTrace {
  readonly layer: LayerId;
  readonly providerId: string | undefined;
  /**
   * - `value`: this layer won
   * - `shadowed`: had a value, but a higher layer won
   * - `no-value`: no opinion
   * - `invalid`: value failed the schema (SF-CFG-001)
   * - `error`: provider error (SF-CFG-006)
   * - `not-ready`: provider not initialized / fatal
   * - `skipped-pre-auth`: identity-bound layer skipped for a non-pre-auth-safe flag
   */
  readonly outcome: 'value' | 'shadowed' | 'no-value' | 'invalid' | 'error' | 'not-ready' | 'skipped-pre-auth';
  readonly value?: unknown;
  readonly errorCode?: string;
}

/** OpenFeature `EvaluationDetails` plus the StaticFlux layer trace. */
export interface FlagEvaluation<T> {
  readonly flagKey: FlagKey;
  readonly value: T;
  readonly variant: string | undefined;
  readonly reason: EvaluationReason;
  readonly errorCode: string | undefined;
  readonly errorMessage: string | undefined;
  readonly flagMetadata: Readonly<Record<string, string | number | boolean>>;
  /** Layer that supplied the value (`default` = package default). */
  readonly layer: LayerId;
  readonly providerId: string | undefined;
  /** Every layer consulted, highest first. */
  readonly trace: readonly LayerTrace[];
}

export interface FlagHookContext {
  readonly flagKey: FlagKey;
  readonly flagValueType: FlagValueType;
  readonly defaultValue: unknown;
  readonly context: EvaluationContext;
  readonly clientMetadata: { readonly domain: string | undefined };
}

export type HookHints = Readonly<Record<string, unknown>>;

export interface FlagHook {
  before?(hookContext: FlagHookContext, hints?: HookHints): void;
  after?(hookContext: FlagHookContext, details: FlagEvaluation<unknown>, hints?: HookHints): void;
  error?(hookContext: FlagHookContext, error: SfError, hints?: HookHints): void;
  finally?(hookContext: FlagHookContext, details: FlagEvaluation<unknown>, hints?: HookHints): void;
}
