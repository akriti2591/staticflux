/**
 * Integration points for sibling verticals, expressed as structural ports (no imports):
 * the app wires `@staticflux/urlstate` (and others) through these.
 *
 * - `intentCapturePlugin(intents)`   — resolve stage: `intents.capture(url)` (R7.10 intents digested at resolve).
 * - `intentAuthorizePlugin(intents)` — end of the authorize stage: `intents.authorize()` (handed to owners after authorize).
 * - `urlSyncFlushHook(sync)`         — before every navigation: `urlSync.flush()` so pending view-state writes land first.
 *
 * Stage plugins from auth/gate/loader are contributed the same way (`stagePluginUnit`).
 */
import type { NavigationHooks } from './router.js';
import { proceed, type StagePlugin, stagePlugin } from './stages.js';

/** Structural subset of urlstate's `IntentService`. */
export interface IntentCapturePort {
  capture(url?: string): unknown;
}
export interface IntentAuthorizePort {
  authorize(owner?: string): void;
}
/** Structural subset of urlstate's `UrlSync`. */
export interface UrlSyncFlushPort {
  flush(): void;
}

export function intentCapturePlugin(intents: IntentCapturePort): StagePlugin {
  return stagePlugin({
    id: 'router/intent-capture',
    stage: 'resolve',
    order: -500,
    pipelines: ['full', 'view', 'dialog'],
    run: (context) => {
      intents.capture(context.to.location.href);
      return proceed();
    },
    description: 'Captures consume-once URL intents at resolve (urlstate).',
  });
}

/** Runs after every other authorize step (order 10 000), for full and dialog pipelines. */
export function intentAuthorizePlugin(
  intents: IntentAuthorizePort,
  options: { readonly ownerOf?: (feature: string) => string } = {},
): StagePlugin {
  return stagePlugin({
    id: 'router/intent-authorize',
    stage: 'authorize',
    order: 10_000,
    pipelines: ['full', 'dialog'],
    run: (context) => {
      if (options.ownerOf === undefined || context.features.length === 0) intents.authorize();
      else for (const selected of context.features) intents.authorize(options.ownerOf(selected.feature));
      return proceed();
    },
    description: 'Marks captured intents deliverable once authorize passed (urlstate).',
  });
}

export function urlSyncFlushHook(sync: UrlSyncFlushPort): NavigationHooks {
  return {
    id: 'router/url-sync-flush',
    beforeNavigate: () => sync.flush(),
  };
}
