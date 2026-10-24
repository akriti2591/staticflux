import { createInjector, createScope, err, ok, defineError } from '@staticflux/core';
import { allowAllDecideUnit, gateResource, visibilityObserverUnit } from '@staticflux/ui';
import { describe, expect, it, vi } from 'vitest';
import {
  createRoutableDialogBridge,
  createSurfaceManager,
  defineSurface,
  type DismissIntent,
  messagingUnits,
  RoutableDialogBridgeToken,
  routableSurface,
  SurfaceManagerToken,
} from './index.js';
import { settle } from '@staticflux/ui/testing';

const share = defineSurface<{ docId: string }>({
  id: 'studio/share-dialog',
  kind: 'dialog',
  scope: 'route',
  routable: {
    key: 'share',
    params: (raw) => (raw['doc'] === undefined ? err(defineError('SF-TEST-MSG-1', 'validation', 'doc missing', 'pass doc')()) : ok({ docId: raw['doc'] })),
  },
  render: ({ props }) => props.docId,
});

function setup() {
  const manager = createSurfaceManager();
  const route = createScope('route');
  const bridge = createRoutableDialogBridge({ manager, owner: { scope: createScope('app') }, surfaces: [share] });
  const intents: DismissIntent[] = [];
  bridge.onDismissIntent((i) => intents.push(i));
  return { manager, bridge, route, intents };
}

describe('routable dialog bridge (R7.16–R7.21)', () => {
  it('opens by key with parsed params; user dismissal after in-app open emits a back intent', async () => {
    const { bridge, route, intents } = setup();
    const opened = await bridge.openDialog('share', { doc: '42' }, { owner: { scope: route, level: 'route' } });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.props).toEqual({ docId: '42' });
    expect(bridge.current).toBe('share');
    await settle(1);
    opened.value.dismiss('escape');
    await opened.value.closed;
    await settle(1);
    expect(intents).toEqual([{ key: 'share', kind: 'back', reason: 'escape' }]);
    expect(bridge.current).toBeUndefined();
  });

  it('deep-linked dialogs emit replace; router-initiated close emits nothing', async () => {
    const { bridge, intents } = setup();
    const deep = await bridge.openDialog('share', { doc: '1' }, { source: 'deep-link' });
    if (!deep.ok) throw deep.error;
    deep.value.dismiss('user');
    await settle(1);
    expect(intents[0]?.kind).toBe('replace');
    const again = await bridge.openDialog('share', { doc: '2' });
    if (!again.ok) throw again.error;
    expect(bridge.closeDialog('share').ok).toBe(true);
    await settle(1);
    expect(intents).toHaveLength(1);
    expect((await again.value.closed).reason).toBe('navigation');
  });

  it('leaving the owning route closes the dialog without an intent (scope-bound, R7.19)', async () => {
    const { bridge, route, intents } = setup();
    const opened = await bridge.openDialog('share', { doc: '1' }, { owner: { scope: route } });
    if (!opened.ok) throw opened.error;
    await route.dispose();
    expect((await opened.value.closed).reason).toBe('scope-ended');
    await settle(1);
    expect(intents).toHaveLength(0);
  });

  it('errors: unknown key, bad params, duplicate key', async () => {
    const { bridge } = setup();
    const unknown = await bridge.openDialog('nope');
    expect(!unknown.ok && unknown.error.code).toBe('SF-MSG-003');
    const bad = await bridge.openDialog('share', {});
    expect(!bad.ok && bad.error.code).toBe('SF-MSG-004');
    const dup = defineSurface({ id: 'other/share', kind: 'dialog', scope: 'app', routable: { key: 'share' }, render: () => '' });
    const registered = bridge.register(dup);
    expect(!registered.ok && registered.error.code).toBe('SF-MSG-006');
    expect(bridge.closeDialog('share').ok).toBe(true);
  });

  it('authorizes before lazy-loading (I-8) and resolves denial to the upsell', async () => {
    const load = vi.fn(async () => ok());
    const upsell = defineSurface({ id: 'billing/upsell', kind: 'dialog', scope: 'app', render: () => 'up' });
    const premium = defineSurface({
      id: 'billing/upgrade',
      kind: 'dialog',
      scope: 'app',
      gate: gateResource('surface', 'surface:billing/upgrade'),
      upsell,
      routable: { key: 'upgrade', load },
      render: () => '',
    });
    const decide = { decide: () => ({ effect: 'deny', reason: 'guest' }) as const };
    const manager = createSurfaceManager({ decide });
    const bridge = createRoutableDialogBridge({ manager, owner: { scope: createScope('app') }, surfaces: [premium], decide });
    const result = await bridge.openDialog('upgrade');
    expect(!result.ok && result.error.code).toBe('SF-MSG-002');
    expect(load).not.toHaveBeenCalled();
    await settle(2);
    expect(manager.topModal?.def.id).toBe('billing/upsell');
  });

  it('lazy-load failure is SF-MSG-007; a second routable dialog replaces the first (R7.20)', async () => {
    const failing = defineSurface({ id: 'test/fail', kind: 'dialog', scope: 'app', routable: { key: 'fail', load: async () => err(defineError('SF-TEST-MSG-2', 'network', 'x', 'y')()) }, render: () => '' });
    const other = defineSurface({ id: 'test/other', kind: 'dialog', scope: 'app', routable: { key: 'other' }, render: () => '' });
    const { bridge } = setup();
    bridge.register(failing);
    bridge.register(other);
    const failed = await bridge.openDialog('fail');
    expect(!failed.ok && failed.error.code).toBe('SF-MSG-007');
    const first = await bridge.openDialog('share', { doc: '1' });
    const second = await bridge.openDialog('other');
    if (!first.ok || !second.ok) throw new Error('open failed');
    expect((await first.value.closed).reason).toBe('replaced');
    expect(bridge.current).toBe('other');
  });
});

describe('messaging units', () => {
  it('resolve manager and bridge with contributed routable surfaces', async () => {
    const injector = createInjector({
      units: [allowAllDecideUnit, visibilityObserverUnit, ...messagingUnits, routableSurface(share)],
    });
    const bridge = await injector.get(RoutableDialogBridgeToken);
    expect(bridge.ok && bridge.value.has('share')).toBe(true);
    const manager = await injector.get(SurfaceManagerToken);
    expect(manager.ok).toBe(true);
    await injector.dispose();
  });
});
