/**
 * DI surface of the isolation policy (R11.16a/b).
 *
 * ```ts
 * const units = [
 *   ...platformUnits(),
 *   ...isolationUnits({ mode: 'preferred', coep: 'credentialless' }, { dev: import.meta.env.DEV }),
 * ];
 * ```
 *
 * `isolationPolicyUnit` is critical: with `mode: 'required'` and no isolation its `init`
 * fails with `SF-PLAT-006`, which blocks boot with the fix. `isolationPortBindings()`
 * re-binds (precedence `app`) the ports that ui / loader / surface / worker declare, by
 * token id, to adapters of the policy — those packages keep their no-op defaults otherwise.
 */
import { type AnyUnit, bind, type Binding, token, unit } from '@staticflux/core';
import {
  createIsolationPolicy,
  type IsolationDeclaration,
  type IsolationPolicy,
  type LoaderCrossOriginPort,
  readIsolationFacts,
  type SurfaceImageCorsPort,
  toLoaderIsolationPolicy,
  toSurfaceImagePolicy,
  toUiIsolationPolicy,
  toWorkerIsolationFacts,
  type UiCrossOriginPort,
  type WorkerIsolationFactsPort,
} from './isolation.js';
import { type IsolationReporting, type IsolationReportingOptions, startIsolationReporting } from './isolation-reporting.js';
import { PlatformEnvToken } from './units.js';

export const IsolationDeclarationToken = token('platform/isolation-declaration').type<IsolationDeclaration>();
export const IsolationPolicyToken = token('platform/isolation-policy').type<IsolationPolicy>();
export const IsolationReportingToken = token('platform/isolation-reporting').type<IsolationReporting>();

// Mirrors of ports declared elsewhere (same token ids → the injector binds them).
/** Same id/shape as `@staticflux/ui` `IsolationPolicyToken`. */
export const UiIsolationPolicyPortToken = token('ui/isolation-policy').type<UiCrossOriginPort>();
/** Same id/shape as `@staticflux/loader` `LoaderIsolationPolicyToken`. */
export const LoaderIsolationPolicyPortToken = token('loader/isolation-policy').type<LoaderCrossOriginPort>();
/** Same id/shape as `@staticflux/surface` `SurfaceImagePolicyToken`. */
export const SurfaceImagePolicyPortToken = token('surface/image-policy').type<SurfaceImageCorsPort>();
/** Same id/shape as `@staticflux/worker` `IsolationFactsToken`. */
export const WorkerIsolationFactsPortToken = token('worker/isolation-facts').type<WorkerIsolationFactsPort>();

export function isolationDeclarationUnit(declaration: IsolationDeclaration): AnyUnit {
  const contribution = unit({
    id: 'platform/isolation-declaration-unit',
    provides: IsolationDeclarationToken,
    scope: 'app',
    create: () => declaration,
  });
  return contribution;
}

export const isolationPolicyUnit = unit({
  id: 'platform/isolation-policy-unit',
  provides: IsolationPolicyToken,
  scope: 'app',
  critical: true,
  deps: { required: { env: PlatformEnvToken, declaration: IsolationDeclarationToken } },
  description: 'Isolation mode × crossOriginIsolated × COEP flavour → crossorigin/fetch/iframe/image/shared-memory decisions.',
  create: ({ env, declaration }, context) => {
    const policy = createIsolationPolicy(declaration, readIsolationFacts(env), env);
    context.span.set('isolation.status', policy.status);
    return policy;
  },
  // `required` but not isolated → boot-blocking SF-PLAT-006 with the fix.
  init: (policy) => policy.check(),
});

export function isolationReportingUnit(options: Pick<IsolationReportingOptions, 'dev' | 'attribute' | 'onViolation'> = {}): AnyUnit {
  const contribution = unit({
    id: 'platform/isolation-reporting-unit',
    provides: IsolationReportingToken,
    scope: 'app',
    deps: { required: { env: PlatformEnvToken } },
    description: 'Dev-mode ReportingObserver → conformance `violation` events for COEP/COOP.',
    create: ({ env }, context) => startIsolationReporting({ env, telemetry: context.telemetry, scope: context.scope, ...options }),
  });
  return contribution;
}

export const uiIsolationPolicyUnit = unit({
  id: 'platform/ui-isolation-policy-unit',
  provides: UiIsolationPolicyPortToken,
  scope: 'app',
  deps: { required: { policy: IsolationPolicyToken } },
  create: ({ policy }) => toUiIsolationPolicy(policy),
});

export const loaderIsolationPolicyUnit = unit({
  id: 'platform/loader-isolation-policy-unit',
  provides: LoaderIsolationPolicyPortToken,
  scope: 'app',
  deps: { required: { policy: IsolationPolicyToken } },
  create: ({ policy }) => toLoaderIsolationPolicy(policy),
});

export const surfaceImageIsolationPolicyUnit = unit({
  id: 'platform/surface-image-policy-unit',
  provides: SurfaceImagePolicyPortToken,
  scope: 'app',
  deps: { required: { policy: IsolationPolicyToken } },
  create: ({ policy }) => toSurfaceImagePolicy(policy),
});

export const workerIsolationFactsUnit = unit({
  id: 'platform/worker-isolation-facts-unit',
  provides: WorkerIsolationFactsPortToken,
  scope: 'app',
  deps: { required: { policy: IsolationPolicyToken } },
  create: ({ policy }) => toWorkerIsolationFacts(policy),
});

/** App-precedence bindings of the ui / loader / surface / worker isolation ports. */
export function isolationPortBindings(): readonly Binding[] {
  return [uiIsolationPolicyUnit, loaderIsolationPolicyUnit, surfaceImageIsolationPolicyUnit, workerIsolationFactsUnit].map((u) =>
    bind(u, { precedence: 'app', source: 'platform/isolation' }),
  );
}

/** Declaration + policy + port bindings (+ dev reporting). */
export function isolationUnits(
  declaration: IsolationDeclaration,
  options: { readonly dev?: boolean; readonly attribute?: (url: string) => string | undefined } = {},
): readonly (AnyUnit | Binding)[] {
  return [
    isolationDeclarationUnit(declaration),
    isolationPolicyUnit,
    ...isolationPortBindings(),
    ...(options.dev === true
      ? [isolationReportingUnit({ dev: true, ...(options.attribute === undefined ? {} : { attribute: options.attribute }) })]
      : []),
  ];
}
