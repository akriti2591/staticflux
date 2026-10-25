// @vitest-environment happy-dom
/** First-use hints (OVERLAYS-FEEDBACK §5): seen once per device, two per session, a Settings switch, suppression. */
import { createScope } from '@staticflux/core';
import { createManualClock, createSurfaceManager, strictSurfacePolicy } from '@staticflux/messaging';
import { manualVisibility, settle } from '@staticflux/ui/testing';
import { describe, expect, it } from 'vitest';
import { createHintSession, HintTargets, HINTS_STORAGE_PREFIX, localSeenStore, seenKeyOf, STUDIO_HINTS } from './hints.js';

function setup(enabled = true) {
  const storage = window.localStorage;
  storage.clear();
  const seen = localSeenStore(storage);
  const visibility = manualVisibility();
  const manager = createSurfaceManager({ clock: createManualClock(), policy: strictSurfacePolicy, seen, visibility });
  for (const target of Object.values(HintTargets)) {
    const element = document.createElement('button');
    document.body.append(element);
    manager.targets.register(target, element);
    visibility.show(element);
  }
  const owner = { scope: createScope('view'), level: 'view' as const };
  let on = enabled;
  const session = createHintSession({ manager, owner, seen, enabled: () => on });
  return { manager, session, seen, storage, toggle: (value: boolean) => (on = value) };
}

describe('first-use hints', () => {
  it('has the M1 set (no Pen until it ships), each one sentence', () => {
    expect(Object.keys(STUDIO_HINTS)).toEqual(['frame', 'shape', 'text', 'hand', 'layers', 'multiSelection']);
    for (const hint of Object.values(STUDIO_HINTS)) {
      expect(hint.kind).toBe('coach-mark');
      expect(hint.dismissible).toBe(false);
      expect(String(hint.label).split('. ').length).toBeLessThanOrEqual(2);
    }
  });

  it('shows at most two per session and marks the third seen', async () => {
    const { session, seen } = setup();
    const frame = session.offer(STUDIO_HINTS.frame);
    await settle(2);
    expect(frame?.state).toBe('showing');
    session.used(STUDIO_HINTS.frame);
    await settle(2);
    const shape = session.offer(STUDIO_HINTS.shape);
    await settle(2);
    expect(shape?.state).toBe('showing');
    shape?.dismiss('user');
    await settle(2);
    expect(session.shownThisSession).toBe(2);
    expect(session.offer(STUDIO_HINTS.text)).toBeUndefined();
    await settle(2);
    expect((await seen.get(seenKeyOf(STUDIO_HINTS.text))).ok).toBe(true);
    expect(((await seen.get(seenKeyOf(STUDIO_HINTS.text))) as { value: unknown }).value).toBe(true);
  });

  it('remembers per device under instaflow/ui/hints, and Reset hints forgets', async () => {
    const { session, storage, manager } = setup();
    const frame = session.offer(STUDIO_HINTS.frame);
    await settle(2);
    session.used(STUDIO_HINTS.frame);
    await settle(2);
    expect(storage.getItem(`${HINTS_STORAGE_PREFIX}/${seenKeyOf(STUDIO_HINTS.frame)}`)).toBe('1');
    expect((await frame?.closed)?.reason).toBe('completed');
    const again = manager.request(STUDIO_HINTS.frame, { owner: { scope: createScope('view') } });
    expect((await again.closed).reason).toBe('seen');
    await session.reset();
    expect(storage.getItem(`${HINTS_STORAGE_PREFIX}/${seenKeyOf(STUDIO_HINTS.frame)}`)).toBeNull();
  });

  it('shows nothing while the Settings switch is off or while suppressed', async () => {
    const { session, toggle } = setup(false);
    expect(session.offer(STUDIO_HINTS.frame)).toBeUndefined();
    toggle(true);
    session.suppress();
    expect(session.offer(STUDIO_HINTS.frame)).toBeUndefined();
    session.resume();
    expect(session.offer(STUDIO_HINTS.frame)).toBeDefined();
  });

  it('degrades to memory when storage is blocked', async () => {
    const blocked = localSeenStore({
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => undefined,
    });
    await blocked.set('k', true);
    expect(((await blocked.get('k')) as { value: unknown }).value).toBe(true);
    expect(((await localSeenStore(undefined).get('k')) as { value: unknown }).value).toBeUndefined();
  });
});
