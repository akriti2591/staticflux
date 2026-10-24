/**
 * DI surface of @staticflux/pwa (page side). SW-side code is not DI-driven: it runs
 * in the service worker entry (`@staticflux/pwa/sw`).
 *
 * ```ts
 * const units = [
 *   browserPwaPageEnvUnit,
 *   pwaOptionsUnit({ scriptUrl: '/sw.js', frameworkMajor: 1, enabled: profile.has('serviceWorker') }),
 *   reinitializePortUnit(supervisorReinitialize),   // runtime adapter (app)
 *   updatePromptUnit(messagingUpdatePrompt),        // messaging adapter (app)
 *   pwaUpdaterUnit, swWarmupUnit, launchIntentPortUnit(urlstateAdapter), launchQueueUnit,
 * ];
 * ```
 */
import { type AnyUnit, ok, token, type TokenId, unit } from '@staticflux/core';
import { ChunkManifestToken } from '@staticflux/loader';
import { consumeLaunchQueue, type LaunchIntentPort, receiveNotificationIntents } from './launch.js';
import { createMutationQueueClient, type MutationQueueClient } from './mutation-queue.js';
import { browserPwaPageEnv, type PwaPageEnv } from './page-env.js';
import { PWA_SUBSYSTEMS } from './telemetry.js';
import { createPwaUpdater, type PwaUpdater, type ReinitializePort, type UpdatePromptPort } from './update.js';
import { createSwWarmup, type SwWarmup } from './warmup-bridge.js';

export interface PwaOptions {
  readonly scriptUrl: string;
  readonly scope?: string;
  readonly type?: 'classic' | 'module';
  /** Host-mode capability (`profile.has('serviceWorker')`); embedded modes are always off. */
  readonly enabled?: boolean;
  readonly frameworkMajor: number;
  /** Register during the updater's init (default true). */
  readonly autoRegister?: boolean;
  /** Check for updates at init (default false: the browser checks on navigation). */
  readonly checkOnStart?: boolean;
}

export const PwaPageEnvToken = token('pwa/page-env').type<PwaPageEnv>();
export const PwaOptionsToken = token('pwa/options').type<PwaOptions>();
/** Runtime supervisor `reinitialize` port; the first contribution is used. None → reload. */
export const ReinitializePortsToken = token('pwa/reinitialize-ports').multi<ReinitializePort>();
/** Messaging prompt port; the first contribution is used. None → only `onUpdateAvailable` listeners. */
export const UpdatePromptsToken = token('pwa/update-prompts').multi<UpdatePromptPort>();
/** Where launch/share/file/notification intents go (bind an urlstate adapter). */
export const LaunchIntentPortToken = token('pwa/launch-intent-port').type<LaunchIntentPort>();
export const PwaUpdaterToken = token('pwa/updater').type<PwaUpdater>();
export const SwWarmupToken = token('pwa/sw-warmup').type<SwWarmup>();
/** True when `launchQueue` is supported and consumed. */
export const LaunchQueueToken = token('pwa/launch-queue').type<{ readonly supported: boolean }>();
export const MutationQueueToken = token('pwa/mutation-queue').type<MutationQueueClient>();

export const browserPwaPageEnvUnit = unit({
  id: 'pwa/browser-page-env-unit',
  provides: PwaPageEnvToken,
  scope: 'app',
  create: () => browserPwaPageEnv(),
});

export function pwaPageEnvUnit(env: PwaPageEnv): AnyUnit {
  const contribution = unit({ id: 'pwa/page-env-unit', provides: PwaPageEnvToken, scope: 'app', create: () => env });
  return contribution;
}

export function pwaOptionsUnit(options: PwaOptions): AnyUnit {
  const contribution = unit({ id: 'pwa/options-unit', provides: PwaOptionsToken, scope: 'app', create: () => options });
  return contribution;
}

export function reinitializePortUnit(port: ReinitializePort, id = 'pwa/reinitialize-port'): AnyUnit {
  const contribution = unit({ id: id as TokenId, provides: ReinitializePortsToken, scope: 'app', create: () => port as never });
  return contribution;
}

export function updatePromptUnit(port: UpdatePromptPort, id = 'pwa/update-prompt'): AnyUnit {
  const contribution = unit({ id: id as TokenId, provides: UpdatePromptsToken, scope: 'app', create: () => port as never });
  return contribution;
}

export function launchIntentPortUnit(port: LaunchIntentPort): AnyUnit {
  const contribution = unit({ id: 'pwa/launch-intent-port-unit', provides: LaunchIntentPortToken, scope: 'app', create: () => port });
  return contribution;
}

export const pwaUpdaterUnit = unit({
  id: 'pwa/updater-unit',
  provides: PwaUpdaterToken,
  scope: 'app',
  deps: { required: { env: PwaPageEnvToken, options: PwaOptionsToken, reinitialize: ReinitializePortsToken, prompts: UpdatePromptsToken } },
  description: 'SW registration + update flow (reinitialize instead of reload when the framework major is unchanged).',
  create: ({ env, options, reinitialize, prompts }, context) => {
    const updater = createPwaUpdater({
      env,
      scriptUrl: options.scriptUrl,
      frameworkMajor: options.frameworkMajor,
      telemetry: context.telemetry,
      ...(options.scope === undefined ? {} : { scope: options.scope }),
      ...(options.type === undefined ? {} : { type: options.type }),
      ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
      ...(reinitialize[0] === undefined ? {} : { reinitialize: reinitialize[0] }),
      ...(prompts[0] === undefined ? {} : { prompt: prompts[0] }),
    });
    context.scope.defer(() => updater.dispose());
    return updater;
  },
  async init(updater, context) {
    // Registration problems never block the app: no SW = no offline support (reported).
    if (!updater.supported) return ok();
    const registered = await updater.register(context.signal);
    if (!registered.ok) {
      context.telemetry.event('pwa.sw.register-failed', {
        subsystem: PWA_SUBSYSTEMS.update,
        level: 'critical',
        attrs: { code: registered.error.code },
      });
    }
    return ok();
  },
});

export const swWarmupUnit = unit({
  id: 'pwa/sw-warmup-unit',
  provides: SwWarmupToken,
  scope: 'app',
  deps: { required: { env: PwaPageEnvToken, manifest: ChunkManifestToken } },
  description: 'Warm-cache bridge: likely/speculative chunk warmups fetched by the SW off the main thread.',
  create: ({ env, manifest }) =>
    createSwWarmup({
      container: env.serviceWorker,
      origin: env.location.origin,
      manifest,
      facts: () => ({ saveData: env.saveData(), offline: !env.onLine() }),
    }),
});

export const launchQueueUnit = unit({
  id: 'pwa/launch-queue-unit',
  provides: LaunchQueueToken,
  scope: 'app',
  deps: { required: { env: PwaPageEnvToken, intents: LaunchIntentPortToken } },
  description: 'Consumes window.launchQueue (link capture, file handlers) and notification clicks into the intent port.',
  create: ({ env, intents }, context) => {
    const supported = consumeLaunchQueue({ launchQueue: env.launchQueue, intents, telemetry: context.telemetry, scope: context.scope });
    receiveNotificationIntents({ container: env.serviceWorker, intents, scope: context.scope, origin: env.location.origin, telemetry: context.telemetry });
    return { supported };
  },
});

export const mutationQueueUnit = unit({
  id: 'pwa/mutation-queue-unit',
  provides: MutationQueueToken,
  scope: 'app',
  deps: { required: { env: PwaPageEnvToken, updater: PwaUpdaterToken } },
  description: 'Optional: queue idempotent mutations for SW background-sync replay.',
  create: ({ env, updater }, context) =>
    createMutationQueueClient({
      container: env.serviceWorker,
      registration: () => updater.registration,
      scope: context.scope,
      ...(env.window === undefined ? {} : { window: env.window }),
    }),
});
