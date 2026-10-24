import { createInjector } from '@staticflux/core';
import { it } from 'vitest';
import { createFeatureHost, createResourceManager, defineFeature, featureRef } from '@staticflux/runtime';
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0)); };
const f = (id: any, extra: any = {}) => defineFeature({ id, weight: 'warm', load: async () => ({ mount: () => undefined }), ...extra });
it('dbg', async () => {
  let time = 0;
  const host = createFeatureHost({ injector: createInjector(), features: [f('test/a'), f('test/b'), f('test/c')], now: () => (time += 1) });
  host.onTransition((t) => console.log('T', t.id, t.from, '->', t.to));
  const m = createResourceManager({ host, budgets: { maxWarm: 2 } });
  for (const id of ['test/a', 'test/b', 'test/c']) { await host.mount(id as any); await host.unmount(id as any); }
  await settle();
  console.log(m.history(), host.list().map((i) => [i.id, i.state, i.lastUsed]));
});
