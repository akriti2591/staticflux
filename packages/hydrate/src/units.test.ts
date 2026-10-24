import { bind, createInjector, ok, token, unit, unwrap } from '@staticflux/core';
import { defineStore, epochSourceUnit, type OwnerStore, s } from '@staticflux/data';
import { ChunkLoaderToken } from '@staticflux/loader';
import { createMemoryStore } from '@staticflux/storage';
import { describe, expect, it } from 'vitest';
import {
  allowAllIslandGateUnit,
  IslandEnvToken,
  IslandGateToken,
  IslandHydratorToken,
  islandUnits,
  SnapshotIdentityToken,
  SnapshotRegistryConfigToken,
  SnapshotRegistryToken,
  SnapshotStoreToken,
  snapshotUnits,
  storeSnapshotUnit,
  type IslandChunkLoader,
} from './index.js';

const Prefs = defineStore({
  id: 'app/prefs',
  version: 1,
  schema: s.object({ theme: s.string() }),
  initial: () => ({ theme: 'light' }),
  actions: {
    setTheme(state, theme: string) {
      state.theme = theme;
    },
  },
});
type PrefsOwner = OwnerStore<{ theme: string }, typeof Prefs.actions>;
const PrefsToken = token('test/prefs').type<PrefsOwner>();

describe('island units', () => {
  it('wires the hydrator from the loader port and default env/gate', async () => {
    const loads: string[] = [];
    const loader: IslandChunkLoader = {
      load: async <T>(id: `${string}:${string}`) => {
        loads.push(id);
        return ok({ hydrate: () => undefined } as T);
      },
    };
    const app = createInjector({
      units: [
        unit({ id: 'test/loader-unit', provides: ChunkLoaderToken, scope: 'app', create: () => loader as never }),
        ...islandUnits,
        bind(unit({ id: 'test/env-unit', provides: IslandEnvToken, scope: 'app', create: () => ({ whenVisible: undefined, idle: (cb) => cb(), afterFrame: () => undefined, measure: () => ({ width: 0, height: 0 }), now: () => 0 }) }), { precedence: 'app' }),
      ],
    });
    const hydrator = unwrap(await app.get(IslandHydratorToken));
    const root = document.createElement('div');
    root.innerHTML = '<sf-island chunk="feature:x" island-id="x"></sf-island>';
    hydrator.start(root, { injector: app });
    expect((await hydrator.get('x')?.whenHydrated())?.ok).toBe(true);
    expect(loads).toEqual(['feature:x']);
    expect(unwrap(await app.get(IslandGateToken))).toBe(allowAllIslandGateUnit.create({} as never, {} as never));
    await app.dispose();
    expect(hydrator.islands()).toEqual([]);
  });
});

describe('snapshot units', () => {
  it('restores contributed store sources during boot (critical) and saves on dispose', async () => {
    const backing = createMemoryStore();
    const units = (identity: string) => [
      epochSourceUnit,
      ...snapshotUnits(),
      unit({ id: 'test/snapshot-store-unit', provides: SnapshotStoreToken, scope: 'app', create: () => backing }),
      bind(unit({ id: 'test/identity-unit', provides: SnapshotIdentityToken, scope: 'app', create: () => () => identity }), { precedence: 'app' }),
      bind(unit({ id: 'test/snapshot-config-unit', provides: SnapshotRegistryConfigToken, scope: 'app', create: () => ({ intervalMs: 0, lifecycle: { onHide: () => () => undefined, every: () => () => undefined } }) }), { precedence: 'app' }),
      unit({ id: 'test/prefs-unit', provides: PrefsToken, scope: 'app', create: () => Prefs.create() }),
      storeSnapshotUnit({ unitId: 'test/prefs-snapshot', store: PrefsToken, sensitivity: 'identity' }),
    ];

    const first = createInjector({ units: units('u1') });
    expect((await first.resolveCritical()).ok).toBe(true);
    const registry = unwrap(await first.get(SnapshotRegistryToken));
    expect(registry.state).toBe('ready');
    unwrap(await first.get(PrefsToken)).actions.setTheme('dark');
    await first.dispose(); // saves on teardown

    const second = createInjector({ units: units('u1') });
    expect((await second.resolveCritical()).ok).toBe(true);
    expect(unwrap(await second.get(PrefsToken)).state.theme).toBe('dark');
    expect(unwrap(await second.get(SnapshotRegistryToken)).provenance('app/prefs')?.source).toBe('snapshot');
    await second.dispose();

    const otherUser = createInjector({ units: units('u2') });
    await otherUser.resolveCritical();
    expect(unwrap(await otherUser.get(PrefsToken)).state.theme).toBe('light');
    await otherUser.dispose();
  });
});
