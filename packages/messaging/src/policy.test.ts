/**
 * The overlay policy (OVERLAYS-FEEDBACK §1.1, §1.4, §1.7, §2.4, §3.5): one modal at a time, a blocking error replaces,
 * a modal closes the layer-3 surfaces opened before it, toast timers pause and repeat counts, Escape reaches the newest
 * toast, dismiss guards hold user dismissals.
 */
import { createScope } from '@staticflux/core';
import { settle } from '@staticflux/ui/testing';
import { describe, expect, it } from 'vitest';
import {
  createManualClock,
  createSurfaceManager,
  defaultSurfacePolicy,
  defineSurface,
  renderContext,
  strictSurfacePolicy,
  type SurfaceManagerOptions,
} from './index.js';

const dialog = (id: `${string}/${string}`) => defineSurface({ id, kind: 'dialog', scope: 'feature', render: () => id });
const popover = (id: `${string}/${string}`) => defineSurface({ id, kind: 'popover', scope: 'feature', render: () => id });
const toast = (id: `${string}/${string}`, extra: { readonly dedupe?: boolean; readonly durationMs?: number | null } = {}) =>
  defineSurface({ id, kind: 'toast', scope: 'feature', render: () => id, ...extra });

function setup(options: SurfaceManagerOptions = {}) {
  const clock = createManualClock();
  const manager = createSurfaceManager({ clock, policy: strictSurfacePolicy, ...options });
  const owner = { scope: createScope('feature'), level: 'feature' as const };
  return { manager, clock, owner };
}

describe('one modal at a time (strict policy)', () => {
  it('refuses a second dialog with SF-MSG-008 instead of queueing or stacking it', async () => {
    const { manager, owner } = setup();
    const first = manager.request(dialog('test/export'), { owner });
    const second = manager.request(dialog('test/settings'), { owner });
    const stacked = manager.request(dialog('test/confirm'), { owner, stack: true });
    await settle(1);
    expect(first.state).toBe('showing');
    expect(await second.closed).toMatchObject({ state: 'rejected', reason: 'busy' });
    expect((await second.closed).error?.code).toBe('SF-MSG-008');
    expect((await stacked.closed).reason).toBe('busy');
  });

  it('a blocking error replaces the open dialog', async () => {
    const { manager, owner } = setup();
    const first = manager.request(dialog('test/export'), { owner });
    await settle(1);
    const blocking = manager.request(dialog('test/blocking'), { owner, replace: true });
    await settle(1);
    expect((await first.closed).reason).toBe('replaced');
    expect(blocking.state).toBe('showing');
    expect(manager.topModal).toBe(blocking);
  });

  it('the default policy keeps queueing (no change for existing apps)', async () => {
    const { manager, owner } = setup({ policy: defaultSurfacePolicy });
    manager.request(dialog('test/a'), { owner });
    const b = manager.request(dialog('test/b'), { owner });
    await settle(1);
    expect(b.state).toBe('queued');
    expect(manager.policy).toBe(defaultSurfacePolicy);
  });
});

describe('layer order', () => {
  it('opening a modal closes the popovers and tooltips opened before it, not those opened from it', async () => {
    const { manager, owner } = setup();
    const before = manager.request(popover('test/colour'), { owner });
    const tip = manager.request(defineSurface({ id: 'test/tip', kind: 'tooltip', scope: 'feature', render: () => '' }), { owner });
    await settle(1);
    const modal = manager.request(dialog('test/export'), { owner });
    await settle(1);
    expect((await before.closed).reason).toBe('replaced');
    expect((await tip.closed).reason).toBe('replaced');
    const inside = manager.request(popover('test/access'), { owner });
    await settle(1);
    expect(inside.state).toBe('showing');
    expect(modal.state).toBe('showing');
  });

  it('one popover at a time', async () => {
    const { manager, owner } = setup();
    const a = manager.request(popover('test/a'), { owner });
    await settle(1);
    const b = manager.request(popover('test/b'), { owner });
    await settle(1);
    expect((await a.closed).reason).toBe('replaced');
    expect(b.state).toBe('showing');
  });

  it('Escape closes popover, then dialog, then the newest toast', async () => {
    const { manager, owner } = setup();
    const older = manager.request(toast('test/older'), { owner });
    const newer = manager.request(toast('test/newer'), { owner });
    const modal = manager.request(dialog('test/m'), { owner });
    const pop = manager.request(popover('test/p'), { owner });
    await settle(1);
    expect(manager.dismissTop()).toBe(true);
    expect(pop.state).toBe('dismissed');
    manager.dismissTop();
    expect(modal.state).toBe('dismissed');
    manager.dismissTop();
    expect(newer.state).toBe('dismissed');
    expect(older.state).toBe('showing');
    manager.dismissTop();
    expect(manager.dismissTop()).toBe(false);
  });

  it('without the strict policy Escape leaves toasts alone', async () => {
    const { manager, owner } = setup({ policy: defaultSurfacePolicy });
    manager.request(toast('test/t'), { owner });
    await settle(1);
    expect(manager.dismissTop()).toBe(false);
  });
});

describe('toast timers and repeats (§3.5)', () => {
  it('pauses while held and resumes with the time left', async () => {
    const { manager, owner, clock } = setup({ defaultToastMs: 5000 });
    const handle = manager.request(toast('test/saved'), { owner });
    await settle(1);
    clock.advance(3000);
    const release = manager.holdToasts();
    const second = manager.holdToasts();
    expect(manager.toastsHeld).toBe(true);
    clock.advance(60_000);
    expect(handle.state).toBe('showing');
    release();
    release(); // idempotent
    expect(manager.toastsHeld).toBe(true);
    second();
    expect(manager.toastsHeld).toBe(false);
    clock.advance(1999);
    expect(handle.state).toBe('showing');
    clock.advance(1);
    expect((await handle.closed).reason).toBe('timeout');
  });

  it('a toast shown while held waits for the release', async () => {
    const { manager, owner, clock } = setup({ defaultToastMs: 1000 });
    const release = manager.holdToasts();
    const handle = manager.request(toast('test/later'), { owner });
    await settle(1);
    clock.advance(5000);
    expect(handle.state).toBe('showing');
    release();
    clock.advance(1000);
    expect(handle.state).toBe('dismissed');
  });

  it('a repeated deduplicated toast counts up and refreshes its timer', async () => {
    const { manager, owner, clock } = setup({ defaultToastMs: 1000 });
    const copied = toast('test/copied', { dedupe: true });
    const first = manager.request(copied, { owner });
    await settle(1);
    clock.advance(800);
    const again = manager.request(copied, { owner });
    const third = manager.request(copied, { owner });
    expect(again).toBe(first);
    expect(third.count).toBe(3);
    expect(renderContext(first).count).toBe(3);
    clock.advance(800);
    expect(first.state).toBe('showing');
    clock.advance(200);
    expect(first.state).toBe('dismissed');
  });

  it('sticky toasts are not timed', async () => {
    const { manager, owner, clock } = setup();
    const sticky = manager.request(toast('test/storage-full', { durationMs: null }), { owner });
    await settle(1);
    clock.advance(600_000);
    expect(sticky.state).toBe('showing');
  });
});

describe('dismiss guards (§2.3, §2.4)', () => {
  it('hold Escape, backdrop and the close button while the guard says no; programmatic closes still close', async () => {
    const { manager, owner } = setup();
    const handle = manager.request(dialog('test/form'), { owner });
    await settle(1);
    const reasons: string[] = [];
    let dirty = true;
    const unregister = renderContext(handle).guard?.((reason) => {
      reasons.push(reason);
      return !dirty;
    });
    expect(manager.dismissTop()).toBe(true); // consumed: Escape did something (the guard showed its row)
    handle.dismiss('backdrop');
    handle.dismiss('user');
    expect(handle.state).toBe('showing');
    expect(reasons).toEqual(['escape', 'backdrop', 'user']);
    dirty = false;
    handle.dismiss('escape');
    expect(handle.state).toBe('dismissed');
    unregister?.();

    const other = manager.request(dialog('test/form2'), { owner });
    await settle(1);
    other.guard(() => false);
    other.dismiss('action');
    expect(other.state).toBe('dismissed');
  });
});
