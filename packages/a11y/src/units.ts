/**
 * DI units. Apps register the environment unit (browser or a custom one for
 * embedded/headless hosts) plus the services they use; all are app-scoped and
 * disposed with the app scope.
 */
import { token, unit, type UnitDefinition } from '@staticflux/core';
import { createAnnouncer, type Announcer, type AnnouncerOptions } from './announcer.js';
import { type A11yEnvironment, browserA11yEnvironment } from './env.js';
import { createFocusManager, type FocusManager } from './focus.js';
import { createPreferenceFacts, type PreferenceFacts } from './preferences.js';
import { createShortcutRegistry, type ShortcutRegistry } from './shortcuts.js';

export const A11yEnvironmentToken = token('a11y/environment').type<A11yEnvironment>();
export const FocusManagerToken = token('a11y/focus-manager').type<FocusManager>();
export const AnnouncerToken = token('a11y/announcer').type<Announcer>();
export const ShortcutRegistryToken = token('a11y/shortcuts').type<ShortcutRegistry>();
export const PreferenceFactsToken = token('a11y/preferences').type<PreferenceFacts>();

type NoDeps = Record<never, never>;

/** Environment from browser globals (feature-detected). */
export const browserA11yEnvironmentUnit = unit({
  id: 'a11y/browser-environment-unit',
  provides: A11yEnvironmentToken,
  scope: 'app',
  create: () => browserA11yEnvironment(),
});

/** A fixed environment (tests, embedded hosts without a DOM). */
export function a11yEnvironmentUnit(environment: A11yEnvironment): UnitDefinition<A11yEnvironment, NoDeps, 'a11y/environment'> {
  return unit({ id: 'a11y/environment-unit', provides: A11yEnvironmentToken, scope: 'app', create: () => environment });
}

export const focusManagerUnit = unit({
  id: 'a11y/focus-manager-unit',
  provides: FocusManagerToken,
  scope: 'app',
  deps: { required: { env: A11yEnvironmentToken } },
  create: ({ env }, ctx) => {
    const manager = createFocusManager({ document: env.document, telemetry: ctx.telemetry });
    ctx.scope.defer(() => manager.dispose());
    return manager;
  },
  description: 'Route-change focus, stacked focus traps with restore, inert background.',
});

export function announcerUnit(
  options: Pick<AnnouncerOptions, 'debounceMs' | 'clearAfterMs'> = {},
): UnitDefinition<Announcer, { readonly required: { readonly env: typeof A11yEnvironmentToken } }, 'a11y/announcer'> {
  return unit({
    id: 'a11y/announcer-unit',
    provides: AnnouncerToken,
    scope: 'app',
    deps: { required: { env: A11yEnvironmentToken } },
    create: ({ env }, ctx) => {
      const announcer = createAnnouncer({ ...options, document: env.document, timers: env.timers, telemetry: ctx.telemetry });
      ctx.scope.defer(() => announcer.dispose());
      return announcer;
    },
    description: 'Debounced polite/assertive live-region announcements.',
  });
}

/** Registry attached to the environment's document for the app lifetime. */
export const shortcutRegistryUnit = unit({
  id: 'a11y/shortcuts-unit',
  provides: ShortcutRegistryToken,
  scope: 'app',
  deps: { required: { env: A11yEnvironmentToken } },
  create: ({ env }, ctx) => {
    const registry = createShortcutRegistry({ isMac: env.isMac, telemetry: ctx.telemetry });
    if (env.document !== undefined) registry.attach(env.document, ctx.scope);
    return registry;
  },
  description: 'Typed keyboard shortcuts with scopes and conflict detection.',
});

export const preferenceFactsUnit = unit({
  id: 'a11y/preferences-unit',
  provides: PreferenceFactsToken,
  scope: 'app',
  deps: { required: { env: A11yEnvironmentToken } },
  create: ({ env }, ctx) => createPreferenceFacts({ matchMedia: env.matchMedia, scope: ctx.scope }),
  description: 'Reactive reduced-motion / contrast / forced-colors / color-scheme facts.',
});
