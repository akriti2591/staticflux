/**
 * DI tokens of @staticflux/runtime. Contracts only (types + typed tokens): importing
 * this file pulls in no implementation.
 */
import { type Injector, token } from '@staticflux/core';
import type { ArchiveStore } from './archive.js';
import type { FeatureManifest } from './feature.js';
import type { FeatureHost, FeatureLoader } from './feature-host.js';
import type { CommandPolicy, PausedRequestPolicy } from './policy.js';
import type { MemoryPressure, ReactiveInput, ResourceManager } from './resource-manager.js';
import type { FrameScheduler } from './scheduler.js';
import type { Subsystem } from './subsystem.js';
import type { Supervisor } from './supervisor.js';

/** Provided by `bootApp`. */
export const SupervisorToken = /* @__PURE__ */ token('runtime/supervisor').type<Supervisor>();
/** The app injector itself. Provided by `bootApp`. */
export const AppInjectorToken = /* @__PURE__ */ token('runtime/app-injector').type<Injector>();

export const FrameSchedulerToken = /* @__PURE__ */ token('runtime/frame-scheduler').type<FrameScheduler>();
export const FeatureHostToken = /* @__PURE__ */ token('runtime/feature-host').type<FeatureHost>();
/**
 * How the feature host loads feature modules (e.g. through the loader package's chunk
 * loader: chunk ids, gating I-8, dedup, retries). Optional: when unbound, the host runs
 * `manifest.load(signal)` (`manifestFeatureLoader`). Resolved on the first activation.
 */
export const FeatureLoaderToken = /* @__PURE__ */ token('runtime/feature-loader').type<FeatureLoader>();
export const ResourceManagerToken = /* @__PURE__ */ token('runtime/resource-manager').type<ResourceManager>();
export const ArchiveStoreToken = /* @__PURE__ */ token('runtime/archive-store').type<ArchiveStore>();
/** Reactive memory-pressure fact (the platform package binds the real one). */
export const MemoryPressureToken = /* @__PURE__ */ token('runtime/memory-pressure').type<ReactiveInput<MemoryPressure>>();

/** Shell-provided policy deciding feature command requests (R4.5). Optional; default policy otherwise. */
export const CommandPolicyToken = /* @__PURE__ */ token('runtime/command-policy').type<CommandPolicy>();
/** Paused-request policy for transports (R4.6). Optional; default policy otherwise. */
export const PausedRequestPolicyToken = /* @__PURE__ */ token('runtime/paused-request-policy').type<PausedRequestPolicy>();

/** Feature manifests contributed by apps/feature packages; the feature host registers them all. */
export const FeatureManifestsToken = /* @__PURE__ */ token('runtime/features').multi<FeatureManifest>();
/** Subsystems contributed by packages; `bootApp` registers them with the supervisor during boot. */
export const SubsystemsToken = /* @__PURE__ */ token('runtime/subsystems').multi<Subsystem>();

/** Tokens `bootApp` provides at runtime — list them as `external` in `defineModule`. */
export const BOOT_PROVIDED_TOKENS = [SupervisorToken, AppInjectorToken] as const;
