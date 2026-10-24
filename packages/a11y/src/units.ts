/**
 * DI units. Apps register the environment unit (browser or a custom one for
 * embedded/headless hosts) plus the services they use; all are app-scoped and
 * disposed with the app scope. Tokens live in `tokens.ts` and the shortcut registry unit in
 * `shortcuts-unit.ts`, so importing a token or one unit never bundles the other implementations.
 */
import { unit, type UnitDefinition } from '@staticflux/core';
import { createAnnouncer, type Announcer, type AnnouncerOptions } from './announcer.js';
import { type A11yEnvironment, browserA11yEnvironment } from './env.js';
import { createFocusManager } from './focus.js';
import { createPreferenceFacts } from './preferences.js';
import { A11yEnvironmentToken, AnnouncerToken, FocusManagerToken, PreferenceFactsToken } from './tokens.js';

type NoDeps = Record<never, never>;

/** Environment from browser globals (feature-detected). */
export const browserA11yEnvironmentUnit = unit({
  id: 'a11y/browser-environment-unit',
  provides: A11yEnvironmentToken,
  scope: 'app',
  create: () => browserA11yEnvironment(),
});

/** A fixed environment (tests, embedded hosts without a DOM). */
/* @__NO_SIDE_EFFECTS__ */
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

/* @__NO_SIDE_EFFECTS__ */
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

export const preferenceFactsUnit = unit({
  id: 'a11y/preferences-unit',
  provides: PreferenceFactsToken,
  scope: 'app',
  deps: { required: { env: A11yEnvironmentToken } },
  create: ({ env }, ctx) => createPreferenceFacts({ matchMedia: env.matchMedia, scope: ctx.scope }),
  description: 'Reactive reduced-motion / contrast / forced-colors / color-scheme facts.',
});
