/**
 * DI units. Opt in with one line — `...devtoolsUnits` — (dev builds only; see
 * the `import.meta.env.DEV` pattern in install.ts). Stores are contributed with
 * `inspectStore(SomeStoreToken)`.
 */
import { contribution, type Token, token, unit } from '@staticflux/core';
import { AppInjectorToken } from '@staticflux/runtime';
import type { Devtools, InspectableStore } from './devtools.js';
import { type DevtoolsInstallation, installDevtools, type InstallDevtoolsOptions } from './install.js';

export const DevtoolsInstallationToken = token('devtools/installation').type<DevtoolsInstallation>();
export const DevtoolsToken = token('devtools/handle').type<Devtools>();
/** Stores shown in the Stores tab. */
export const DevtoolsStoresToken = token('devtools/stores').multi<InspectableStore>();

export type DevtoolsUnitOptions = Omit<InstallDevtoolsOptions, 'injector' | 'telemetry' | 'stores'>;

/** Installation unit with custom options (shortcut, capacity, url, units for the graph, …). */
export function devtoolsUnitWith(options: DevtoolsUnitOptions = {}) {
  return unit({
    id: 'devtools/installation-unit',
    provides: DevtoolsInstallationToken,
    scope: 'app',
    deps: {
      required: { stores: DevtoolsStoresToken },
      lazy: { app: { token: AppInjectorToken, init: 'eager' } },
    },
    create: ({ stores, app }, ctx) => {
      const installed = installDevtools({ ...options, telemetry: ctx.telemetry, stores });
      if (!installed.ok) throw installed.error;
      const installation = installed.value;
      ctx.scope.defer(() => installation.dispose());
      // Bind supervisor / feature host / gate / journeys once the app injector is known (never instantiates them).
      ctx.onReady(app, async (injector) => {
        await installation.devtools.bindFromInjector(injector);
      });
      return installation;
    },
    description: 'Devtools collector + overlay (Ctrl/Cmd+Shift+D). Dev builds only.',
  });
}

export const devtoolsInstallationUnit = devtoolsUnitWith();

export const devtoolsHandleUnit = unit({
  id: 'devtools/handle-unit',
  provides: DevtoolsToken,
  scope: 'app',
  deps: { required: { installation: DevtoolsInstallationToken } },
  create: ({ installation }) => installation.devtools,
  description: 'The devtools handle (views, controls) for custom UIs.',
});

/** Contribute a store (data owner/replica or anything `InspectableStore`-shaped) to the Stores tab. */
export function inspectStore<S extends InspectableStore>(storeToken: Token<S>, order?: number) {
  return contribution({
    id: `devtools/store:${storeToken.id}` as `devtools/${string}`,
    provides: DevtoolsStoresToken,
    scope: 'app',
    ...(order === undefined ? {} : { order }),
    deps: { required: { store: storeToken } },
    create: ({ store }) => store as InspectableStore,
  });
}

/** One-line opt-in: `createInjector({ units: [...appUnits, ...devtoolsUnits] })`. */
export const devtoolsUnits = [devtoolsInstallationUnit, devtoolsHandleUnit] as const;
