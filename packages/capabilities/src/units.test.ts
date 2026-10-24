import { bind, createInjector, ok, unit } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import {
  CapabilityConfirmPortToken,
  CapabilityDecidePortToken,
  CapabilityRegistryToken,
  capabilityDeclarationUnit,
  capabilityImplementationUnit,
  capabilityUnits,
  decidePort,
  defineCapability,
  implementCapability,
  provideCapabilities,
  s,
} from './index.js';

const Echo = defineCapability({
  id: 'test/echo',
  description: 'Echo text.',
  input: s.object({ text: s.string() }),
  output: s.object({ text: s.string() }),
  requiresConfirmation: false,
  destructive: false,
});
const Wipe = defineCapability({
  id: 'test/wipe',
  description: 'Wipe everything.',
  input: s.object({}),
  output: s.object({ wiped: s.boolean() }),
  requiresConfirmation: false,
  destructive: true,
});
const echoImpl = implementCapability(Echo, (input) => ok({ text: input.text }));

describe('capability units', () => {
  it('one-line opt-in resolves a registry with contributed declarations and implementations', async () => {
    const injector = createInjector({
      units: [...capabilityUnits, capabilityDeclarationUnit(Wipe), capabilityImplementationUnit(echoImpl)],
    });
    const registry = await injector.get(CapabilityRegistryToken);
    expect(registry.ok).toBe(true);
    if (!registry.ok) return;
    expect(registry.value.list().map((c) => c.id)).toEqual(['test/wipe', 'test/echo']);
    expect(await registry.value.invoke(Echo, { text: 'hi' }, { subject: 'user' })).toEqual(ok({ text: 'hi' }));
    // default confirm port fails closed for destructive agent calls
    expect(await registry.value.invoke('test/wipe', {}, { subject: 'agent' })).toMatchObject({
      ok: false,
      error: { code: 'SF-CAP-005' },
    });
    await injector.dispose();
  });

  it('ports are replaced by app bindings (gate, messaging plug in)', async () => {
    const decide = unit({
      id: 'app/decide',
      provides: CapabilityDecidePortToken,
      scope: 'app',
      create: () => decidePort(({ subject }) => (subject === 'agent' ? { effect: 'deny', reason: 'forbidden' } : { effect: 'allow' })),
    });
    const confirm = unit({
      id: 'app/confirm',
      provides: CapabilityConfirmPortToken,
      scope: 'app',
      create: () => ({ confirm: async () => ok(true) }),
    });
    const injector = createInjector({
      units: [...capabilityUnits, bind(decide, { precedence: 'app' }), confirm, capabilityImplementationUnit(echoImpl)],
    });
    const registry = await injector.get(CapabilityRegistryToken);
    if (!registry.ok) throw registry.error;
    expect(await registry.value.invoke(Echo, { text: 'x' }, { subject: 'agent' })).toMatchObject({
      ok: false,
      error: { code: 'SF-CAP-003' },
    });
    expect(await registry.value.invoke(Echo, { text: 'x' }, { subject: 'user' })).toEqual(ok({ text: 'x' }));
  });

  it('provideCapabilities registers for a scope and rolls back on conflict', async () => {
    const injector = createInjector({ units: [...capabilityUnits] });
    const registry = await injector.get(CapabilityRegistryToken);
    if (!registry.ok) throw registry.error;
    const feature = injector.child('feature', 'studio');
    const wipeImpl = implementCapability(Wipe, () => ok({ wiped: true }));
    expect(provideCapabilities(registry.value, [echoImpl, wipeImpl], feature.scope)).toEqual(
      ok({ ids: ['test/echo', 'test/wipe'] }),
    );
    expect(registry.value.isImplemented('test/echo')).toBe(true);

    const other = injector.child('feature', 'other');
    const Ping = defineCapability({ ...Echo, id: 'test/ping' });
    const conflict = provideCapabilities(
      registry.value,
      [implementCapability(Ping, (input) => ok(input)), implementCapability(Wipe, () => ok({ wiped: false }))],
      other.scope,
    );
    expect(conflict).toMatchObject({ ok: false, error: { code: 'SF-CAP-009' } });
    expect(registry.value.get('test/ping')).toBeUndefined();

    await feature.dispose();
    expect(registry.value.isImplemented('test/echo')).toBe(false);
    expect(registry.value.list()).toEqual([]);
  });
});
