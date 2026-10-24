/**
 * Fakes that live in their own packages, re-exported in one place (R16.3).
 * Do not duplicate these in testkit — extend them in their package instead.
 */

// data — mock transport, mock remote sync, memory slice backend
export {
  createMockTransport,
  mockStatus,
  mockTransportUnit,
  createMockRemoteSync,
  createMemoryBackend,
  type MockTransport,
  type MockTransportOptions,
  type MockContext,
  type MockCall,
  type MockFailure,
  type MockStatus,
  type MockRemoteSync,
} from '@staticflux/data';

// platform — controllable PlatformEnv
export { createFakePlatformEnv, SAMPLE_USER_AGENTS, type FakePlatformEnv, type FakePlatformEnvOptions } from '@staticflux/platform';

// storage — memory store, fake IndexedDB / cookies / OPFS / BroadcastChannel, mock remote, the store contract
export {
  createMemoryStore,
  createFakeIndexedDb,
  createFakeCookieDocument,
  createFakeOpfsRoot,
  createBroadcastHub,
  createMockRemoteTransport,
  runStoreContract,
  storeContractCases,
  type MemoryStore,
  type FakeIndexedDb,
  type FakeCookieDocument,
  type MockRemoteTransport,
  type ContractOptions as StoreContractOptions,
} from '@staticflux/storage';

// worker — in-memory ports (freeze/thaw/crash) and spawner
export { createPortPair, inMemorySpawner, type PortPair, type PortPairOptions, type MemoryPort } from '@staticflux/worker';

// router / urlstate — memory histories (names disambiguated) and the manual URL frame scheduler
export { createMemoryHistory as createRouterMemoryHistory, type MemoryHistory as RouterMemoryHistory } from '@staticflux/router';
export { createMemoryHistory as createUrlMemoryHistory, createManualScheduler } from '@staticflux/urlstate';

// auth — deterministic auth environment and in-memory BroadcastChannel hub (multi-tab tests)
export { createTestAuthEnvironment, createMemoryChannelHub, memoryStorage, type TestAuthEnvironment } from '@staticflux/auth';
