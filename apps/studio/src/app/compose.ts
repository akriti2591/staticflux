/**
 * `composeStudio` — the one place every StaticFlux vertical is wired (ARCHITECTURE §3.2).
 *
 * Packages contribute units; adapters (src/adapters, one file per package pair)
 * bridge their ports; features are manifests whose modules load as chunks. Nothing
 * here renders: `bootStudio()` boots headlessly (tests) and `main.ts` mounts the UI.
 *
 * Boot (runtime `bootApp`): injector → supervisor → critical units (platform facts,
 * app profile, flag resolver + what they need) → core-ready → subsystems (router
 * first navigation, document worker, meter sync, …) → running. Verticals the first frame does
 * not need (surfaces, keyboard, capabilities, resource manager, user data, handoff, resource
 * cache) are deferred unit groups
 * (`deferred.ts`): their chunks load on first resolution.
 */
import {
  contribution,
  type Injector,
  type Registration,
  type Result,
  type Telemetry,
  type Token,
  unit,
} from '@staticflux/core';
import { a11yEnvironmentUnit, type A11yEnvironment, announcerUnit, focusManagerUnit, preferenceFactsUnit } from '@staticflux/a11y';
import {
  AuthEnvironmentToken,
  type AuthEnvironment,
  AuthTransportToken,
  bffCookieProviderUnit,
  createSessionUnit,
} from '@staticflux/auth';
import {
  createExperimentLayer,
  createFlagBinder,
  createLocalOverrideLayer,
  createStaticLayer,
  defineExperiment,
  flagBinderUnit,
  flagDefinitionUnits,
  flagResolverUnit,
  layerUnit,
  type StorageLike,
} from '@staticflux/config';
import { DataTransportToken, dataClientUnitWith } from '@staticflux/data';
import { gateUnits, meterDefinitionUnit, policySetUnit } from '@staticflux/gate';
import { catalogLoaderUnit, i18nConfigUnit, i18nUnit } from '@staticflux/i18n';
import { chunkLoaderUnit, manifestUnit, noIsolationPolicyUnit as loaderNoIsolationUnit } from '@staticflux/loader';
import {
  conformanceUnit,
  featureMarksUnit,
  JourneyTrackerToken,
  layoutShiftTrackerUnit,
  perfEnvUnit,
  ViolationCollectorToken,
} from '@staticflux/perf';
import { type DetectedMode, type PlatformEnv, platformUnits } from '@staticflux/platform';
import { dialogUnit, type HistoryAdapter, routerSubsystemUnit, routerUnitWith, routeUnit } from '@staticflux/router';
import {
  type App,
  bootApp,
  featureHostUnit,
  FeatureManifestsToken,
  frameSchedulerSubsystemUnit,
  frameSchedulerUnit,
  registryArchiveStoreUnit,
} from '@staticflux/runtime';
import { shellPresets, ShellPresetToken, workspaceManagerUnit } from '@staticflux/shell';
import { storeFactoryUnit, storeRegistryUnit, type StoreFactory } from '@staticflux/storage';
import { noIsolationPolicyUnit, renderSchedulerUnit, uiEnvironmentUnit, visibilityObserverUnit } from '@staticflux/ui';
import { defaultThemeContribution } from '@staticflux/ui/default-theme';
import { appearanceUnitWith } from '@staticflux/ui/theme';
import { intentServiceUnit, intentUnit, urlDeclarationRegistryUnit, urlDeclarationUnit, urlSyncUnit } from '@staticflux/urlstate';
import type { Spawner } from '@staticflux/worker';
import { routeFocusHookUnit } from '../adapters/a11y-router.js';
import { sessionEvaluationContextUnit } from '../adapters/auth-config.js';
import { userDataIdentityListenerUnit } from '../adapters/auth-data.js';
import { claimFactsUnit, sessionFactsUnit } from '../adapters/auth-gate.js';
import { authBoundaryPluginUnit } from '../adapters/auth-router.js';
import { epochRefreshListenerUnit, sessionScopeUnit } from '../adapters/auth-runtime.js';
import { flagFactsUnit } from '../adapters/config-gate.js';
import { remoteFlagLayerUnit } from '../adapters/data-config.js';
import { dataMeterBackendUnit, meterSyncSubsystemUnit } from '../adapters/gate-data.js';
import { gateChunkGateUnit } from '../adapters/gate-loader.js';
import { gateAuthorizePluginUnit } from '../adapters/gate-router.js';
import { gateDecidePortUnit } from '../adapters/gate-ui.js';
import { guestDraftSlotUnit, guestDraftUnit, guestDraftUpgradeHookUnit } from '../adapters/handoff-auth.js';
import { heldIntentsSlotUnit, intentHoldUnit, intentRestorePluginUnit, loginReturnPortUnit } from '../adapters/handoff-urlstate.js';
import { localeUrlSubsystemUnit } from '../adapters/i18n-urlstate.js';
import { chunkScriptAttributionUnit } from '../adapters/loader-perf.js';
import { buildDevManifest, chunkFeatureLoaderUnit, staticImportStrategyUnit, studioLoaderEnvUnit } from '../adapters/loader-runtime.js';
import { intentActivationHookUnit } from '../adapters/urlstate-runtime.js';
import { featureMarksSubsystemUnit, readinessUnit } from '../adapters/perf-runtime.js';
import { platformFactsGateUnit } from '../adapters/platform-gate.js';
import { platformLoaderProfileUnit, platformWarmupFactsUnit } from '../adapters/platform-loader.js';
import { platformDeviceTierUnit } from '../adapters/platform-perf.js';
import { profilePredicateUnit, profileRefreshSubsystemUnit } from '../adapters/platform-router.js';
import { dataPauseSubsystemUnit, pauseControlUnit, supervisorEpochSourceUnit } from '../adapters/runtime-data.js';
import { reconnectingSurfaceSubsystemUnit } from '../adapters/runtime-messaging.js';
import { outletFeatureDriverUnit } from '../adapters/runtime-router.js';
import { runtimeUrlFrameSchedulerUnit } from '../adapters/runtime-urlstate.js';
import { workspacePreferenceStoreUnit } from '../adapters/storage-shell.js';
import { appearanceStoreUnit } from '../adapters/storage-ui.js';
import { intentAuthorizePluginUnit, intentCapturePluginUnit, sharedHistoryUnits, urlSyncFlushHookUnit } from '../adapters/urlstate-router.js';
import { documentRuntimeUnit, documentStoreUnit, presenceFeedUnit } from './document.js';
import { BFF_ENDPOINTS, CSRF_HEADER, createMockBffTransport } from '../mocks/auth-endpoints.js';
import { createStudioMockTransport } from '../mocks/data-routes.js';
import type { MockServer } from '../mocks/server.js';
import { AiSuggestionsFlag, ChatPromptIntent, CreditsMeter, DebugBinding, LangBinding, OnboardingCopyToken, OnboardingVariantFlag, TabBinding, WorkspaceBinding } from './contracts.js';
import { featureManifests } from './features.js';
import { homeDocsUnit } from './home.js';
import { appCatalogLoader, AVAILABLE_LOCALES } from './messages.js';
import { studioPolicies } from './policies.js';
import { NotFoundRoute, studioDialogs, studioRoutes } from './routes.js';
import { outletsUnit, panelControllerUnit, shellContributionUnits, workspaceSwitchSubsystemUnit } from './shell.js';
import { deferredStudioUnits, resourceCacheGroup } from './deferred.js';
import { createStudioTelemetry, type StudioTelemetry } from './telemetry.js';
import { lateServicesUnit, postBootSubsystemUnit } from './post-boot.js';

/** Everything environment-specific, injected (browser entry vs headless tests). */
export interface StudioEnvironment {
  readonly server: MockServer;
  /** ONE history for router + urlstate (browser: Navigation/History API; embedded/tests: memory). */
  readonly history: HistoryAdapter;
  /** Storage registry backends (browser: IndexedDB → Web Storage → memory). */
  readonly storeFactories: readonly StoreFactory[];
  readonly platformEnv: PlatformEnv;
  /** Result of the inline mode detector (so boot and runtime agree, R12.9). */
  readonly detected?: DetectedMode;
  readonly authEnv: AuthEnvironment;
  readonly spawnWorker: Spawner;
  readonly document: Document | undefined;
  readonly a11yEnv: A11yEnvironment;
  /** URL search for dev overrides (`?sf-flag=key:value`, `?sf-mode=…`). */
  readonly search: string;
  readonly requestedLocales: readonly string[];
  readonly flagStorage?: StorageLike;
  readonly mockLatencyMs?: number;
  readonly telemetry?: StudioTelemetry;
  /** Console sink (`?sf-debug`). */
  readonly debug?: boolean;
}

function valueUnit<T>(id: `${string}/${string}`, provides: Token<T>, value: T) {
  return unit({ id, provides, scope: 'app', create: () => value });
}

/** Onboarding copy variants: feature code injects OnboardingCopyToken and never reads the flag (R8.4). */
const copyA = unit({ id: 'onboarding/copy-a-unit', provides: OnboardingCopyToken, scope: 'app', create: () => ({ variant: 'A' as const, headline: 'Let’s set up your studio' }) });
const copyB = unit({ id: 'onboarding/copy-b-unit', provides: OnboardingCopyToken, scope: 'app', create: () => ({ variant: 'B' as const, headline: 'Three steps to your first document' }) });

export function studioUnits(env: StudioEnvironment, perf: StudioTelemetry): readonly Registration[] {
  const binder = createFlagBinder();
  const server = env.server;

  const platform = platformUnits({ ...(env.detected === undefined ? {} : { initial: env.detected }), probeAiOnStart: false }, env.platformEnv);

  const config: readonly Registration[] = [
    flagResolverUnit({ initTimeoutMs: 1500 }),
    flagBinderUnit(binder),
    ...flagDefinitionUnits([AiSuggestionsFlag, OnboardingVariantFlag]),
    // Layers: package defaults < app < remote (mock) < experiment < local/URL override (R8.5).
    layerUnit(createStaticLayer({ id: 'studio/app-layer', layer: 'app', values: { 'studio/ai-suggestions': true } })),
    remoteFlagLayerUnit,
    layerUnit(createExperimentLayer({ experiments: [defineExperiment({ flag: OnboardingVariantFlag, allocation: { A: 50, B: 50 }, salt: 'onboarding-2026' })] })),
    layerUnit(createLocalOverrideLayer({ search: env.search, ...(env.flagStorage === undefined ? {} : { storage: env.flagStorage }) })),
    sessionEvaluationContextUnit,
    copyA,
    ...binder.variants({ flag: OnboardingVariantFlag, of: OnboardingCopyToken, variants: { B: copyB } }),
  ];

  const storage: readonly Registration[] = [storeRegistryUnit, ...env.storeFactories.map((factory) => storeFactoryUnit(factory))];

  const auth: readonly Registration[] = [
    valueUnit('studio/auth-transport-unit', AuthTransportToken, createMockBffTransport(server)),
    valueUnit('studio/auth-environment-unit', AuthEnvironmentToken, env.authEnv),
    bffCookieProviderUnit({ endpoints: BFF_ENDPOINTS, csrf: { header: CSRF_HEADER } }),
    createSessionUnit({ channelName: 'studio/session' }),
    epochRefreshListenerUnit,
    userDataIdentityListenerUnit,
    guestDraftUpgradeHookUnit,
    sessionScopeUnit(resourceCacheGroup),
  ];

  const gate: readonly Registration[] = [
    ...gateUnits,
    dataMeterBackendUnit, // overrides the local backend (latest registration wins)
    policySetUnit('studio/policies-unit', studioPolicies),
    meterDefinitionUnit('studio/credits-meter-unit', CreditsMeter),
    sessionFactsUnit,
    claimFactsUnit,
    flagFactsUnit,
    platformFactsGateUnit,
    meterSyncSubsystemUnit,
  ];

  const data: readonly Registration[] = [
    valueUnit('studio/mock-transport-unit', DataTransportToken, createStudioMockTransport(server, { latencyMs: env.mockLatencyMs ?? 0 })),
    supervisorEpochSourceUnit,
    pauseControlUnit,
    dataPauseSubsystemUnit,
    dataClientUnitWith({ defaultRetry: { attempts: 3, baseDelayMs: 50, maxDelayMs: 500 }, defaultTimeoutMs: 8_000, defaultBreaker: { failureThreshold: 5, resetAfterMs: 15_000 } }),
  ];

  const runtime: readonly Registration[] = [
    frameSchedulerUnit,
    frameSchedulerSubsystemUnit,
    registryArchiveStoreUnit,
    featureHostUnit,
    chunkFeatureLoaderUnit,
    ...featureManifests.map((manifest) => contribution({ id: `studio/feature-${manifest.id.replace('/', '-')}`, provides: FeatureManifestsToken, scope: 'app', create: () => manifest })),
  ];

  const router: readonly Registration[] = [
    ...sharedHistoryUnits(env.history),
    routerUnitWith({ notFound: NotFoundRoute }),
    routerSubsystemUnit,
    outletFeatureDriverUnit,
    profilePredicateUnit,
    profileRefreshSubsystemUnit,
    ...studioRoutes.map((route) => routeUnit(route)),
    ...studioDialogs.map((dialog) => dialogUnit(dialog)),
    intentCapturePluginUnit,
    intentRestorePluginUnit,
    authBoundaryPluginUnit,
    gateAuthorizePluginUnit,
    intentAuthorizePluginUnit,
    urlSyncFlushHookUnit,
    routeFocusHookUnit,
    intentActivationHookUnit,
  ];

  const urlstate: readonly Registration[] = [
    urlDeclarationUnit(TabBinding),
    urlDeclarationUnit(WorkspaceBinding),
    urlDeclarationUnit(LangBinding),
    urlDeclarationUnit(DebugBinding),
    intentUnit(ChatPromptIntent),
    urlDeclarationRegistryUnit,
    runtimeUrlFrameSchedulerUnit,
    urlSyncUnit,
    intentServiceUnit,
    intentHoldUnit,
    loginReturnPortUnit,
  ];

  const loader: readonly Registration[] = [
    manifestUnit(buildDevManifest()),
    studioLoaderEnvUnit,
    gateChunkGateUnit,
    loaderNoIsolationUnit,
    platformWarmupFactsUnit,
    platformLoaderProfileUnit,
    staticImportStrategyUnit,
    chunkLoaderUnit,
  ];

  const perfUnits: readonly Registration[] = [
    perfEnvUnit,
    platformDeviceTierUnit,
    chunkScriptAttributionUnit,
    conformanceUnit,
    valueUnit('studio/violation-collector-unit', ViolationCollectorToken, perf.violations),
    valueUnit('studio/journey-tracker-unit', JourneyTrackerToken, perf.journeys),
    layoutShiftTrackerUnit,
    featureMarksUnit,
    readinessUnit,
    featureMarksSubsystemUnit,
  ];

  const i18n: readonly Registration[] = [
    i18nConfigUnit({ defaultLocale: 'en', available: AVAILABLE_LOCALES, requested: env.requestedLocales }),
    catalogLoaderUnit(appCatalogLoader),
    i18nUnit,
    localeUrlSubsystemUnit,
  ];

  const a11y: readonly Registration[] = [a11yEnvironmentUnit(env.a11yEnv), focusManagerUnit, announcerUnit(), preferenceFactsUnit];

  const handoff: readonly Registration[] = [heldIntentsSlotUnit, guestDraftSlotUnit, guestDraftUnit];

  const ui: readonly Registration[] = [renderSchedulerUnit, visibilityObserverUnit, noIsolationPolicyUnit, gateDecidePortUnit, uiEnvironmentUnit];

  // Theme contract (@staticflux/ui/theme): the neutral default theme as a contribution (a brand theme would be
  // contributed with a higher `order`), appearance remembered per device; restored after first paint (post-boot).
  const theme: readonly Registration[] = [defaultThemeContribution, appearanceUnitWith({ restore: 'manual' }), appearanceStoreUnit];

  const messaging: readonly Registration[] = [reconnectingSurfaceSubsystemUnit];

  const shell: readonly Registration[] = [
    workspaceManagerUnit,
    workspacePreferenceStoreUnit,
    unit({
      id: 'studio/shell-preset-unit',
      provides: ShellPresetToken,
      scope: 'app',
      create: () => {
        const width = env.platformEnv.window?.innerWidth ?? 1280;
        return width < 600 ? shellPresets.compact : width < 840 ? shellPresets.medium : shellPresets.expanded;
      },
    }),
    ...shellContributionUnits,
    outletsUnit(env.document),
    panelControllerUnit,
    workspaceSwitchSubsystemUnit,
  ];



  const documents: readonly Registration[] = [documentRuntimeUnit(env.spawnWorker), documentStoreUnit, presenceFeedUnit];

  const app: readonly Registration[] = [homeDocsUnit, lateServicesUnit, postBootSubsystemUnit];

  return [
    ...platform,
    ...storage,
    ...config,
    ...auth,
    ...gate,
    ...data,
    ...runtime,
    ...router,
    ...urlstate,
    ...loader,
    ...perfUnits,
    ...i18n,
    ...a11y,
    ...handoff,
    ...ui,
    ...theme,
    ...messaging,
    ...shell,
    ...documents,
    ...app,
    // Off the boot path: loaded on first resolution (see deferred.ts).
    ...deferredStudioUnits,
  ];
}

export interface StudioApp {
  readonly app: App;
  readonly injector: Injector;
  readonly telemetry: Telemetry;
  readonly perf: StudioTelemetry;
  get<T>(token: Token<T>): Promise<T>;
  shutdown(): Promise<Result<void>>;
}

/** Boot the composed app (no rendering). */
export async function bootStudio(env: StudioEnvironment): Promise<Result<StudioApp>> {
  const perf = env.telemetry ?? createStudioTelemetry({ console: env.debug === true });
  const booted = await bootApp({ units: studioUnits(env, perf), telemetry: perf.telemetry, injectorName: 'studio' });
  if (!booted.ok) return booted;
  const app = booted.value;
  return {
    ok: true,
    value: {
      app,
      injector: app.injector,
      telemetry: app.telemetry,
      perf,
      async get<T>(token: Token<T>): Promise<T> {
        const resolved = await app.injector.get(token);
        if (!resolved.ok) throw resolved.error;
        return resolved.value;
      },
      shutdown: () => app.shutdown(),
    },
  };
}
