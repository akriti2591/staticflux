import { createScope, ok } from '@staticflux/core';
import { describe, expect, it, vi } from 'vitest';
import { createEnvelope } from './envelope.js';
import {
  carry,
  completeLoginRedirect,
  createSlotHold,
  GuestMigrationSlot,
  isSafeReturnPath,
  LoginReturnSlot,
  prepareLoginRedirect,
  stageGuestMigration,
  takeGuestMigration,
} from './redirect.js';
import { defineHandoff } from './slot.js';
import { createWebStorage, detectHandoffStorages, memoryHandoffStorages } from './storage.js';
import { createHandoffStore } from './store.js';
import { createViewStateHandoff, persistOnHide } from './view.js';

interface Draft {
  readonly title: string;
}
const DraftSlot = defineHandoff<Draft>({ key: 'studio/guest-draft', version: 1, lifetime: 'one-shot', scope: 'tab' });
const MemSlot = defineHandoff<number>({ key: 'studio/mem', version: 1, lifetime: 'one-shot', scope: 'memory' });

function freshStore(): ReturnType<typeof createHandoffStore> {
  window.sessionStorage.clear();
  return createHandoffStore({ storages: detectHandoffStorages() });
}

describe('login redirect carry', () => {
  it('carries slots and the return path through a (simulated) reload', async () => {
    const before = freshStore();
    const prepared = await prepareLoginRedirect(before, { returnTo: '/studio/doc/42?panel=chat', carry: [carry(DraftSlot, { title: 'Guest draft' })], random: () => 0.5 });
    expect(prepared).toEqual(ok({ nonce: '80'.repeat(16), degraded: false }));
    if (!prepared.ok) return;
    // new page load: a new store over the same sessionStorage
    const after = createHandoffStore({ storages: detectHandoffStorages() });
    const back = await completeLoginRedirect(after, { nonce: prepared.value.nonce, slots: [DraftSlot] });
    expect(back).toEqual(ok({ returnTo: '/studio/doc/42?panel=chat', nonce: prepared.value.nonce, carried: ['studio/guest-draft'] }));
    expect(await after.take(DraftSlot)).toEqual(ok({ title: 'Guest draft' }));
    expect(await completeLoginRedirect(after)).toEqual(ok(undefined)); // consumed
  });

  it('uses crypto randomness by default and accepts an external nonce', async () => {
    const store = freshStore();
    const a = await prepareLoginRedirect(store, { returnTo: '/' });
    expect(a.ok && a.value.nonce).toMatch(/^[0-9a-f]{32}$/);
    const b = await prepareLoginRedirect(store, { returnTo: '/', nonce: 'oauth-state' });
    expect(b.ok && b.value.nonce).toBe('oauth-state');
    expect(await completeLoginRedirect(store, { nonce: 'oauth-state' })).toMatchObject({ ok: true });
  });

  it('a nonce mismatch discards carried state', async () => {
    const store = freshStore();
    await prepareLoginRedirect(store, { returnTo: '/studio', carry: [carry(DraftSlot, { title: 'x' })], nonce: 'good' });
    const r = await completeLoginRedirect(store, { nonce: 'forged', slots: [DraftSlot] });
    expect(!r.ok && r.error.code).toBe('SF-HANDOFF-008');
    expect(await store.take(DraftSlot)).toEqual(ok(undefined));
  });

  it('rejects unsafe return paths and memory-scoped carries', async () => {
    const store = freshStore();
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil', 'relative', '/ok\n']) {
      expect(isSafeReturnPath(bad), bad).toBe(false);
      const r = await prepareLoginRedirect(store, { returnTo: bad });
      expect(!r.ok && r.error.code).toBe('SF-HANDOFF-009');
    }
    expect(isSafeReturnPath('/studio/doc/1?x=1#y')).toBe(true);
    const r = await prepareLoginRedirect(store, { returnTo: '/', carry: [carry(MemSlot, 1)] });
    expect(!r.ok && r.error.code).toBe('SF-HANDOFF-010');
    // tampered stored return path
    await store.put(LoginReturnSlot, { returnTo: '//evil', nonce: 'n', carried: [] });
    const tampered = await completeLoginRedirect(store, { nonce: 'n' });
    expect(!tampered.ok && tampered.error.code).toBe('SF-HANDOFF-009');
  });

  it('reports degraded storage (embedded host: memory only)', async () => {
    const store = createHandoffStore({ storages: memoryHandoffStorages() });
    const r = await prepareLoginRedirect(store, { returnTo: '/' });
    expect(r.ok && r.value.degraded).toBe(true);
  });

  it('propagates write failures', async () => {
    const full = { ...window.sessionStorage, setItem: () => { throw new Error('quota'); }, getItem: () => null, removeItem: () => undefined, key: () => null, length: 0, clear: () => undefined } as Storage;
    const store = createHandoffStore({ storages: { ...memoryHandoffStorages(), tab: createWebStorage(full, 'session-storage') } });
    expect((await prepareLoginRedirect(store, { returnTo: '/', carry: [carry(DraftSlot, { title: 'x' })] })).ok).toBe(false);
    expect((await prepareLoginRedirect(store, { returnTo: '/' })).ok).toBe(false);
  });
});

describe('guest migration', () => {
  it('stages guest slices as envelopes and takes them once after login', async () => {
    const store = freshStore();
    const slices = { 'settings/theme': createEnvelope({ key: 'settings/theme', version: 1, data: 'dark', now: 0 }) };
    expect((await stageGuestMigration(store, slices)).ok).toBe(true);
    expect(await takeGuestMigration(store)).toEqual(ok(slices));
    expect(await takeGuestMigration(store)).toEqual(ok(undefined));
    await store.put(GuestMigrationSlot, { slices: null } as never);
    expect((await takeGuestMigration(store)).ok).toBe(false);
  });
});

describe('slot hold adapter', () => {
  it('holds and releases once', async () => {
    const store = freshStore();
    const Slot = defineHandoff<readonly string[]>({ key: 'app/held-intents', version: 1, lifetime: { ttlMs: 60_000 }, scope: 'tab' });
    const hold = createSlotHold(store, Slot);
    expect(await hold.hold(['a', 'b'])).toEqual(ok());
    expect(await hold.release()).toEqual(ok(['a', 'b']));
    expect(await hold.release()).toEqual(ok(undefined));
  });
});

describe('view-state handoff', () => {
  it('remembers per-view state and passes one-shot state to the next view', async () => {
    const store = createHandoffStore({ storages: memoryHandoffStorages() });
    const views = createViewStateHandoff<{ scroll: number }>(store, { key: 'studio/doc-view', version: 1 });
    expect(views.key).toBe('studio/doc-view');
    await views.remember('comments', { scroll: 120 });
    await views.remember('history', { scroll: 5 });
    expect(await views.recall('comments')).toEqual(ok({ scroll: 120 }));
    expect(await views.recall('nope')).toEqual(ok(undefined));
    await views.forget('comments');
    expect(await views.recall('comments')).toEqual(ok(undefined));
    expect(await views.recall('history')).toEqual(ok({ scroll: 5 }));
    await views.forget();
    expect(await views.recall('history')).toEqual(ok(undefined));
    expect(await views.forget('x')).toEqual(ok());

    await views.pass({ scroll: 9 });
    expect(await views.receive()).toEqual(ok({ scroll: 9 }));
    expect(await views.receive()).toEqual(ok(undefined));
  });

  it('validates with a schema and can persist across reloads (tab scope)', async () => {
    window.sessionStorage.clear();
    const isState = (v: unknown): v is { scroll: number } => typeof (v as { scroll?: unknown }).scroll === 'number';
    const store = createHandoffStore({ storages: detectHandoffStorages() });
    const views = createViewStateHandoff(store, { key: 'studio/doc-view', version: 1, scope: 'tab', schema: isState });
    await views.remember('a', { scroll: 1 });
    const reloaded = createViewStateHandoff(createHandoffStore({ storages: detectHandoffStorages() }), { key: 'studio/doc-view', version: 1, scope: 'tab', schema: isState });
    expect(await reloaded.recall('a')).toEqual(ok({ scroll: 1 }));
    await views.remember('b', { scroll: 'bad' } as never);
    expect((await reloaded.recall('a')).ok).toBe(false);
    const parseSchema = { parse: (v: unknown) => (isState(v) ? ok(v) : ok({ scroll: 0 })) };
    const withParse = createViewStateHandoff(store, { key: 'studio/other-view', version: 1, schema: parseSchema });
    await withParse.remember('x', { scroll: 3 });
    expect(await withParse.recall('x')).toEqual(ok({ scroll: 3 }));
  });

  it('persistOnHide saves on visibilitychange:hidden and pagehide, until the scope ends', async () => {
    const save = vi.fn();
    const scope = createScope('studio');
    persistOnHide({ document, window }, scope, save);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));
    expect(save).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(save).toHaveBeenCalledTimes(2);
    await scope.dispose();
    window.dispatchEvent(new Event('pagehide'));
    expect(save).toHaveBeenCalledTimes(2);
    persistOnHide({}, createScope('x'), save);
  });
});
