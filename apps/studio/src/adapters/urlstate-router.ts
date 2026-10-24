/**
 * Adapter: @staticflux/urlstate ⇄ @staticflux/router (R7.10–R7.15).
 *
 * - ONE history instance serves both packages (the router's `HistoryAdapter` is a
 *   structural superset of urlstate's `HistoryPort`), so URL-sync writes carry
 *   `source: 'urlstate'` and the router adopts view-only writes without a pipeline.
 * - Intents are captured at `resolve` and authorized at the end of `authorize`.
 * - Pending view-state writes flush before every navigation.
 */
import { contribution, unit } from '@staticflux/core';
import {
  type HistoryAdapter,
  HistoryAdapterToken,
  intentAuthorizePlugin,
  intentCapturePlugin,
  NavigationHooksToken,
  StagePluginsToken,
  urlSyncFlushHook,
} from '@staticflux/router';
import { HistoryPortToken, IntentServiceToken, UrlSyncToken } from '@staticflux/urlstate';

/** Provide the same history instance to router and urlstate. */
export function sharedHistoryUnits(history: HistoryAdapter) {
  return [
    unit({ id: 'studio/router-history-unit', provides: HistoryAdapterToken, scope: 'app', create: () => history }),
    unit({ id: 'studio/urlstate-history-unit', provides: HistoryPortToken, scope: 'app', create: () => history }),
  ] as const;
}

export const intentCapturePluginUnit = contribution({
  id: 'studio/intent-capture-plugin-unit',
  provides: StagePluginsToken,
  scope: 'app',
  deps: { required: { intents: IntentServiceToken } },
  create: ({ intents }) => intentCapturePlugin(intents),
});

export const intentAuthorizePluginUnit = contribution({
  id: 'studio/intent-authorize-plugin-unit',
  provides: StagePluginsToken,
  scope: 'app',
  deps: { required: { intents: IntentServiceToken } },
  create: ({ intents }) => intentAuthorizePlugin(intents),
});

export const urlSyncFlushHookUnit = contribution({
  id: 'studio/url-sync-flush-hook-unit',
  provides: NavigationHooksToken,
  scope: 'app',
  deps: { required: { sync: UrlSyncToken } },
  create: ({ sync }) => urlSyncFlushHook(sync),
});
