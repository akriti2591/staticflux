/**
 * DI tokens and units (R9.6 — stores and services are units). Apps register the
 * units they need; the runtime replaces `epochSourceUnit` / `pauseControlUnit`
 * with bindings driven by the app lifecycle (refresh → epoch, pause → pause).
 *
 *   createInjector({ units: [mockTransportUnit((m) => m.route(DocGet, …)), epochSourceUnit, pauseControlUnit, dataClientUnit, resourcesUnit] })
 */
import { type ScopeLevel, type Token, type TokenId, token, unit, type UnitDefinition } from '@staticflux/core';
import { createDataClient, type DataClient, type DataClientOptions } from './client.js';
import { createEpochSource, type EpochSource } from './epoch.js';
import { createMockTransport, type MockTransport, type MockTransportOptions } from './mock-transport.js';
import { createPauseControl, type PauseControl } from './pause.js';
import { createResources, type Resources } from './resources.js';
import type { ActionMap, OwnerStore, StoreDefinition } from './store.js';
import type { Transport } from './transport.js';
import { createUserData, type UserData, type UserDataOptions } from './user-data.js';

export const DataTransportToken = token('data/transport').type<Transport>();
export const EpochSourceToken = token('data/epoch-source').type<EpochSource>();
export const PauseControlToken = token('data/pause-control').type<PauseControl>();
export const DataClientToken = token('data/client').type<DataClient>();
export const ResourcesToken = token('data/resources').type<Resources>();
export const UserDataConfigToken = token('data/user-data-config').type<Omit<UserDataOptions, 'telemetry'>>();
export const UserDataToken = token('data/user-data').type<UserData>();

/** Standalone epoch source seeded from the injector epoch. Replace with a runtime-driven binding. */
export const epochSourceUnit = unit({
  id: 'data/epoch-source-unit',
  provides: EpochSourceToken,
  scope: 'app',
  create: (_deps, ctx) => createEpochSource(ctx.epoch),
  description: 'Epoch port for I-10. The runtime should bind its own EpochSource that follows app refresh().',
});

export const pauseControlUnit = unit({
  id: 'data/pause-control-unit',
  provides: PauseControlToken,
  scope: 'app',
  create: () => createPauseControl(),
  description: 'Pause port (R4.6). The runtime calls pause()/resume() on app pause/resume.',
});

/** The data client with extra slot bindings (`transports`) and defaults (retry, breaker, timeout). */
export function dataClientUnitWith(
  extra: Omit<DataClientOptions, 'transport' | 'epoch' | 'pause' | 'telemetry'> = {},
): UnitDefinition<DataClient> {
  const definition = unit({
    id: 'data/client-unit',
    provides: DataClientToken,
    scope: 'app',
    deps: { required: { transport: DataTransportToken, epoch: EpochSourceToken, pause: PauseControlToken } },
    create: ({ transport, epoch, pause }, ctx) => {
      const client = createDataClient({ ...extra, transport, epoch, pause, telemetry: ctx.telemetry });
      ctx.scope.defer(() => client.dispose());
      return client;
    },
    description: 'Executes endpoint calls: pause gate, breaker, single retry layer, epoch discard, data/request spans.',
  });
  return definition;
}

export const dataClientUnit = dataClientUnitWith();

/** Resource cache. Session-scoped so logout drops cached user data with the session scope. */
export const resourcesUnit = unit({
  id: 'data/resources-unit',
  provides: ResourcesToken,
  scope: 'session',
  deps: { required: { client: DataClientToken } },
  create: ({ client }, ctx) => {
    const resources = createResources({ client });
    ctx.scope.defer(() => resources.dispose());
    return resources;
  },
  description: 'Keyed SWR cache, dedup, optimistic updates, epoch-aware refetch.',
});

export const userDataUnit = unit({
  id: 'data/user-data-unit',
  provides: UserDataToken,
  scope: 'app',
  deps: { required: { config: UserDataConfigToken } },
  create: ({ config }, ctx) => {
    const userData = createUserData({ ...config, telemetry: ctx.telemetry });
    ctx.scope.defer(() => userData.dispose());
    return userData;
  },
  description: 'User-data document: typed slices, offline-first persistence, remote sync, logout policy.',
});

/** Provide `DataTransportToken` with a configured mock transport (example app, tests). */
export function mockTransportUnit(configure: (mock: MockTransport) => void, options: MockTransportOptions = {}): UnitDefinition<Transport> {
  const definition = unit({
    id: 'data/mock-transport-unit',
    provides: DataTransportToken,
    scope: 'app',
    create: (): Transport => {
      const mock = createMockTransport(options);
      configure(mock);
      return mock;
    },
  });
  return definition;
}

/** A unit owning one store instance (epoch-tagged patches, telemetry from the injector). */
export function storeUnit<S, A extends ActionMap<S>, const P extends TokenId>(options: {
  readonly id: TokenId;
  readonly store: StoreDefinition<S, A>;
  readonly provides: Token<OwnerStore<S, A>, P>;
  readonly scope: ScopeLevel;
}): UnitDefinition<OwnerStore<S, A>, { readonly required: { readonly epoch: typeof EpochSourceToken } }, P> {
  return unit({
    id: options.id,
    provides: options.provides,
    scope: options.scope,
    deps: { required: { epoch: EpochSourceToken } },
    create: ({ epoch }, ctx) => options.store.create({ epoch, telemetry: ctx.telemetry }),
    description: `Owner of store "${options.store.id}".`,
  });
}
