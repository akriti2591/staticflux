/**
 * Feature manifests and modules (R5, docs/LIFECYCLES.md §6).
 *
 * A manifest is data: id, weight class, retention, modes, units, required features,
 * budgets, readiness and a `load()` function that returns the feature module
 * (the loader package supplies chunk loading; tests pass a plain async function).
 * Features are not routes (R5.9): routers, shells and agents drive the host.
 */
import type { Injector, Registration, Registry, Result, Scope, Span, Telemetry } from '@staticflux/core';
import type { HookReturn } from './subsystem.js';

/** Namespaced feature id, e.g. `studio/desktop`, `agent/chat`. */
export type FeatureId = `${string}/${string}`;

export type FeatureWeight = 'cheap' | 'warm' | 'heavy';

/**
 * Mode ids. Open set via declaration merging (R18.3a):
 * `declare module '@staticflux/core' { interface Registry { modes: { compact: true } } }`
 */
export type FeatureModeId = Registry extends { readonly modes: infer M } ? Extract<keyof M, string> : string;

export interface RetentionPolicy {
  /**
   * After unmount, keep the logic activated at most this long, then demote by weight.
   * Default: cheap → 0 (immediately), warm/heavy → until budget/memory pressure.
   */
  readonly keepAliveMs?: number;
  /** Preference when choosing what to demote (low first). Framework budgets always win (R5.4). */
  readonly priority?: 'low' | 'normal' | 'high';
  /** Heavy features archive on demotion (default true for heavy, ignored otherwise). */
  readonly archive?: boolean;
}

/** Reference to another feature by id (features never import features — R20.3). */
export interface FeatureRef<Id extends FeatureId = FeatureId> {
  readonly id: Id;
}

export function featureRef<const Id extends FeatureId>(id: Id): FeatureRef<Id> {
  return Object.freeze({ id });
}

/**
 * Readiness marks a feature may own (R17.20). camelCase, the same names perf uses
 * (`firstRender | interactive | complete`, plus perf's `placeholderShown | largestRender`).
 */
export const READINESS_MARKS = ['firstRender', 'interactive', 'complete'] as const;
export type ReadinessMark = (typeof READINESS_MARKS)[number];
/** @deprecated kebab-case alias of `'firstRender'`, accepted for one release. */
export type LegacyReadinessMark = 'first-render';
/** A readiness mark as accepted by APIs during the deprecation window. */
export type ReadinessMarkInput = ReadinessMark | LegacyReadinessMark;

export type ReadinessOwner = 'framework' | 'feature';

/** Who reports each readiness mark (R17.20). */
export type ReadinessDeclaration = { readonly [K in ReadinessMark]?: ReadinessOwner } & {
  /** @deprecated use `firstRender` (accepted for one release; `defineFeature` normalizes it). */
  readonly 'first-render'?: ReadinessOwner;
};

/** Canonical (camelCase) readiness mark; maps the deprecated `'first-render'`. */
export function normalizeReadinessMark(mark: ReadinessMarkInput): ReadinessMark {
  return mark === 'first-render' ? 'firstRender' : mark;
}

/** Canonical readiness declaration: the deprecated `'first-render'` key becomes `firstRender`. */
export function normalizeReadiness(readiness: ReadinessDeclaration): { readonly [K in ReadinessMark]?: ReadinessOwner } {
  const firstRender = readiness.firstRender ?? readiness['first-render'];
  return {
    ...(firstRender === undefined ? {} : { firstRender }),
    ...(readiness.interactive === undefined ? {} : { interactive: readiness.interactive }),
    ...(readiness.complete === undefined ? {} : { complete: readiness.complete }),
  };
}

export interface FeatureBudget {
  readonly loadMs?: number;
  readonly activationMs?: number;
  readonly chunkKb?: number;
  readonly memoryMb?: number;
}

export interface FeatureManifest<Id extends FeatureId = FeatureId> {
  readonly kind: 'feature';
  readonly id: Id;
  readonly weight: FeatureWeight;
  readonly retention?: RetentionPolicy;
  /** Modes this feature serves (per-mode variants are separate features, R18.5). Undefined = all. */
  readonly modes?: readonly FeatureModeId[];
  /** Units registered in the feature injector at activation (in addition to the module's units). */
  readonly units?: readonly Registration[];
  readonly requires?: { readonly features?: readonly FeatureRef[] };
  readonly budget?: FeatureBudget;
  /** Who reports each readiness mark: the framework (default) or the feature itself (R17.20). */
  readonly readiness?: ReadinessDeclaration;
  /** Headless features have no UI (R5.7); mount() is rejected for them. */
  readonly headless?: boolean;
  /** Version of the archived snapshot shape (default 1). */
  readonly snapshotVersion?: number;
  /** Load the feature module (chunk). Must honour `signal`. */
  load(signal: AbortSignal): Promise<FeatureModule>;
  readonly description?: string;
}

/** How this activation started (journey classification, R17.8). */
export type ActivationKind = 'fresh' | 'warm' | 'archived';

export interface FeatureLogicContext {
  readonly id: FeatureId;
  readonly manifest: FeatureManifest;
  /** Feature-scoped child injector (level `feature`). Disposed on deactivation. */
  readonly injector: Injector;
  /** Logic scope: disposed on deactivation. */
  readonly scope: Scope;
  readonly signal: AbortSignal;
  readonly telemetry: Telemetry;
  /** Activation span (parent for child spans). */
  readonly span: Span;
  readonly epoch: number;
  readonly activation: ActivationKind;
  /** Injector of a feature listed in `requires.features` (its published capabilities). */
  dependency(ref: FeatureRef): Result<Injector>;
}

export interface FeatureUiContext extends FeatureLogicContext {
  /** UI scope: disposed on unmount (child of the logic scope, so I-5 holds structurally). */
  readonly uiScope: Scope;
  /** Whatever the UI layer passed to `mount()` (host element, slot, …). */
  readonly target: unknown;
  /** Reactive: true while hidden. */
  readonly hidden: boolean;
}

export interface FeatureModule {
  readonly units?: readonly Registration[];
  /** Start feature logic (subscriptions go into `context.scope`). */
  activate?(context: FeatureLogicContext): HookReturn;
  /** Optional explicit teardown before the logic scope is disposed. */
  deactivate?(context: FeatureLogicContext): void | Promise<void>;
  /** Render the UI into `context.target`. */
  mount?(context: FeatureUiContext): HookReturn;
  /**
   * Called after mount and after every un-hide with a fresh `scope` that is disposed
   * on hide/unmount: effects, reactions, timers live here so hidden features cost zero (R5.2, R12.16).
   */
  visible?(context: FeatureUiContext, scope: Scope): HookReturn;
  /** Optional: apply hidden styling (content-visibility etc.). DOM and state stay. */
  hide?(context: FeatureUiContext): void;
  unmount?(context: FeatureUiContext): void | Promise<void>;
  /** Heavy features: serializable state for archive (structured-clone safe). */
  snapshot?(context: FeatureLogicContext): unknown;
  /** Rehydrate from an archived snapshot (runs after activate()). */
  restore?(data: unknown, version: number, context: FeatureLogicContext): HookReturn;
}

/** Declare a feature manifest (typed identity; the declaration is data). */
export function defineFeature<const Id extends FeatureId>(
  manifest: Omit<FeatureManifest<Id>, 'kind'> & { readonly kind?: 'feature' },
): FeatureManifest<Id> {
  return {
    ...manifest,
    ...(manifest.readiness === undefined ? {} : { readiness: normalizeReadiness(manifest.readiness) }),
    kind: 'feature',
  };
}

/** Declare a feature module (typed identity). */
export function defineFeatureModule<const M extends FeatureModule>(module: M): M {
  return module;
}
