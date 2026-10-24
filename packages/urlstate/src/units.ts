/**
 * DI units. Register one history unit (detected browser history, or memory for
 * embedded hosts/tests), a frame scheduler, the declaration registry and the
 * services. Packages contribute declarations to `UrlDeclarationsToken` and
 * intents to `IntentDefinitionsToken`; a collision fails the registry unit at
 * boot (SF-URL-002).
 */
import { err, ok, token, unit, type UnitDefinition } from '@staticflux/core';
import { type AnyIntentDef, createUrlDeclarationRegistry, type UrlDeclaration, type UrlDeclarationRegistry } from './binding.js';
import { createDialogUrl, type DialogUrl } from './dialog.js';
import { createMemoryHistory, detectHistory, type HistoryPort } from './history.js';
import { createIntentService, type IntentHoldPort, type IntentService } from './intents.js';
import { createMarketingCapture, type MarketingCapture, MarketingParams } from './marketing.js';
import { createRafScheduler, type FrameScheduler } from './scheduler.js';
import { createUrlSync, type UrlSync } from './sync.js';

export const HistoryPortToken = token('urlstate/history').type<HistoryPort>();
export const FrameSchedulerToken = token('urlstate/frame-scheduler').type<FrameScheduler>();
export const UrlDeclarationsToken = token('urlstate/declarations').multi<UrlDeclaration>();
export const IntentDefinitionsToken = token('urlstate/intents').multi<AnyIntentDef>();
/** Zero or one hold port (first wins); provide one to carry intents through login. */
export const IntentHoldPortsToken = token('urlstate/intent-hold').multi<IntentHoldPort>();
export const UrlDeclarationRegistryToken = token('urlstate/declaration-registry').type<UrlDeclarationRegistry>();
export const UrlSyncToken = token('urlstate/sync').type<UrlSync>();
export const IntentServiceToken = token('urlstate/intent-service').type<IntentService>();
export const MarketingCaptureToken = token('urlstate/marketing').type<MarketingCapture>();
export const DialogUrlToken = token('urlstate/dialog-url').type<DialogUrl>();

type NoDeps = Record<never, never>;

export const browserHistoryUnit = unit({
  id: 'urlstate/browser-history-unit',
  provides: HistoryPortToken,
  scope: 'app',
  create: (_deps, ctx) => {
    const history = detectHistory();
    ctx.scope.defer(() => history.dispose());
    return history;
  },
  description: 'Navigation API → History API → memory, feature-detected.',
});

export function memoryHistoryUnit(initial = '/'): UnitDefinition<HistoryPort, NoDeps, 'urlstate/history'> {
  return unit({ id: 'urlstate/memory-history-unit', provides: HistoryPortToken, scope: 'app', create: () => createMemoryHistory(initial) });
}

export const rafSchedulerUnit = unit({
  id: 'urlstate/raf-scheduler-unit',
  provides: FrameSchedulerToken,
  scope: 'app',
  create: () => createRafScheduler(),
});

/** Contribute a URL declaration (binding, intent or reserved keys). */
export function urlDeclarationUnit(declaration: UrlDeclaration): UnitDefinition<readonly UrlDeclaration[], NoDeps, 'urlstate/declarations'> {
  const name = declaration.kind === 'url-binding' ? declaration.key : declaration.kind === 'intent' ? declaration.id : declaration.owner;
  return unit({ id: `urlstate/declaration:${name}`, provides: UrlDeclarationsToken, scope: 'app', create: () => declaration as never });
}

/** Contribute an intent (also registers its keys as a declaration). */
export function intentUnit(intent: AnyIntentDef): UnitDefinition<readonly AnyIntentDef[], NoDeps, 'urlstate/intents'> {
  return unit({ id: `urlstate/intent:${intent.id}`, provides: IntentDefinitionsToken, scope: 'app', create: () => intent as never });
}

export function intentHoldUnit(port: IntentHoldPort): UnitDefinition<readonly IntentHoldPort[], NoDeps, 'urlstate/intent-hold'> {
  return unit({ id: 'urlstate/intent-hold-unit', provides: IntentHoldPortsToken, scope: 'app', create: () => port as never });
}

export const urlDeclarationRegistryUnit = unit({
  id: 'urlstate/declaration-registry-unit',
  provides: UrlDeclarationRegistryToken,
  scope: 'app',
  deps: { required: { declarations: UrlDeclarationsToken, intents: IntentDefinitionsToken } },
  create: ({ declarations, intents }) => createUrlDeclarationRegistry([MarketingParams, ...declarations, ...intents]),
  /** Collisions are boot errors (R7.12 safety net; CI catches them earlier). */
  init(registry) {
    const first = registry.initialErrors[0];
    return first === undefined ? ok() : err(first);
  },
});

export const urlSyncUnit = unit({
  id: 'urlstate/sync-unit',
  provides: UrlSyncToken,
  scope: 'app',
  deps: { required: { history: HistoryPortToken, scheduler: FrameSchedulerToken, registry: UrlDeclarationRegistryToken } },
  create: ({ history, scheduler, registry }, ctx) => {
    const sync = createUrlSync({ history, scheduler, registry, telemetry: ctx.telemetry });
    ctx.scope.defer(() => sync.dispose());
    return sync;
  },
  description: 'URL ⇄ store sync for view and sticky params, one write per frame.',
});

export const intentServiceUnit = unit({
  id: 'urlstate/intent-service-unit',
  provides: IntentServiceToken,
  scope: 'app',
  deps: { required: { history: HistoryPortToken, intents: IntentDefinitionsToken, holds: IntentHoldPortsToken } },
  create: ({ history, intents, holds }, ctx) => createIntentService({ history, intents, hold: holds[0], telemetry: ctx.telemetry }),
  description: 'Consume-once URL intents: capture → hold → authorize → deliver (prefill-only by default).',
});

export const marketingCaptureUnit = unit({
  id: 'urlstate/marketing-unit',
  provides: MarketingCaptureToken,
  scope: 'app',
  deps: { required: { history: HistoryPortToken } },
  create: ({ history }, ctx) => createMarketingCapture({ history, telemetry: ctx.telemetry }),
  /** Capture at boot so the params never reach later navigations. */
  init(capture) {
    capture.capture();
    return ok();
  },
});

export const dialogUrlUnit = unit({
  id: 'urlstate/dialog-url-unit',
  provides: DialogUrlToken,
  scope: 'app',
  deps: { required: { history: HistoryPortToken } },
  create: ({ history }) => createDialogUrl({ history }),
});
