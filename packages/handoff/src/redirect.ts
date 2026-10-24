/**
 * Carry state through a login redirect (R19.1, R7.13, R6.4) and migrate guest
 * slices on login (R9.11).
 *
 *   // before navigating to the identity provider
 *   const prepared = await prepareLoginRedirect(store, {
 *     returnTo: '/studio/doc/42?panel=chat',
 *     carry: [carry(GuestDraftSlot, draft)],
 *   });
 *   // put prepared.value.nonce into the OAuth `state` / BFF login URL
 *
 *   // after the redirect back
 *   const back = await completeLoginRedirect(store, { nonce: stateFromUrl });
 *   // back.value?.returnTo → navigate; carried slots are now readable with take()
 *
 * The nonce binds the stored return state to this login attempt; a mismatch
 * discards everything (login CSRF / injected-state guard). `returnTo` must be a
 * same-origin path (open-redirect guard). Both are UX safety, not security: the
 * server validates the OAuth state too.
 */
import { defineError, err, ok, type Result } from '@staticflux/core';
import type { SnapshotEnvelope } from './envelope.js';
import { type AnyHandoffSlot, defineHandoff, type HandoffSlot } from './slot.js';
import type { HandoffStore } from './store.js';

export const RedirectStateMismatchError = defineError(
  'SF-HANDOFF-008',
  'forbidden',
  'The login redirect came back with a state that does not match the stored one.',
  'Start a fresh login; never resume carried state for a redirect this tab did not start.',
);

export const UnsafeReturnPathError = defineError(
  'SF-HANDOFF-009',
  'forbidden',
  'The login return target is not a same-origin path.',
  'Pass a path starting with a single "/" (e.g. `/studio/doc/42`), never an absolute or protocol-relative URL.',
);

export const NonDurableCarryError = defineError(
  'SF-HANDOFF-010',
  'validation',
  'A slot carried through a redirect uses the `memory` scope, which does not survive the redirect.',
  'Declare carried slots with `scope: "tab"` (or `"origin"` when login opens in another tab).',
);

export interface LoginReturn {
  readonly returnTo: string;
  readonly nonce: string;
  /** Keys of the slots that were written alongside. */
  readonly carried: readonly string[];
}

function isLoginReturn(value: unknown): value is LoginReturn {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v['returnTo'] === 'string' && typeof v['nonce'] === 'string' && Array.isArray(v['carried']) && v['carried'].every((k) => typeof k === 'string');
}

export const LoginReturnSlot: HandoffSlot<LoginReturn> = defineHandoff<LoginReturn>({
  key: 'handoff/login-return',
  version: 1,
  lifetime: { ttlMs: 15 * 60_000 },
  scope: 'tab',
  schema: isLoginReturn,
  description: 'Where to go after login, and which slots were carried.',
});

export interface CarryEntry {
  readonly slot: AnyHandoffSlot;
  readonly data: unknown;
}

/** Typed pair for `prepareLoginRedirect({ carry: [...] })`. */
export function carry<T>(slot: HandoffSlot<T>, data: T): CarryEntry {
  return { slot, data };
}

/** Same-origin path check (`/a/b?c#d`, not `//evil`, not `https://…`, not `/\\evil`). */
export function isSafeReturnPath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\') && !/[\u0000-\u001f]/.test(path);
}

function randomNonce(random: () => number): string {
  const cryptoLike = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  const bytes = new Uint8Array(16);
  if (random === Math.random && typeof cryptoLike?.getRandomValues === 'function') cryptoLike.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(random() * 256);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface PrepareLoginRedirectInput {
  readonly returnTo: string;
  readonly carry?: readonly CarryEntry[];
  /** Use an existing nonce (e.g. the OAuth `state` the auth package generated). */
  readonly nonce?: string;
  /** Injectable randomness (tests). Default: crypto.getRandomValues. */
  readonly random?: () => number;
}

export interface PreparedLoginRedirect {
  readonly nonce: string;
  /** True when the tab/origin storage is memory-only: state will NOT survive a full-page redirect (use a popup flow). */
  readonly degraded: boolean;
}

export async function prepareLoginRedirect(store: HandoffStore, input: PrepareLoginRedirectInput): Promise<Result<PreparedLoginRedirect>> {
  if (!isSafeReturnPath(input.returnTo)) return err(UnsafeReturnPathError({ details: { returnTo: input.returnTo } }));
  const entries = input.carry ?? [];
  const nonDurable = entries.find((e) => e.slot.scope === 'memory');
  if (nonDurable !== undefined) return err(NonDurableCarryError({ details: { key: nonDurable.slot.key } }));
  for (const entry of entries) {
    const written = await store.put(entry.slot, entry.data);
    if (!written.ok) return written;
  }
  const nonce = input.nonce ?? randomNonce(input.random ?? Math.random);
  const saved = await store.put(LoginReturnSlot, { returnTo: input.returnTo, nonce, carried: entries.map((e) => e.slot.key) });
  if (!saved.ok) return saved;
  const degraded = store.isDegraded('tab') || entries.some((e) => store.isDegraded(e.slot.scope));
  return ok({ nonce, degraded });
}

export interface CompleteLoginRedirectInput {
  /** The state that came back from the identity provider. Omit for flows without one (BFF cookie redirect). */
  readonly nonce?: string;
  /** Carried slots, so a mismatch can discard them. */
  readonly slots?: readonly AnyHandoffSlot[];
}

/** Consume the stored return state. `ok(undefined)` when no redirect was pending. */
export async function completeLoginRedirect(store: HandoffStore, input: CompleteLoginRedirectInput = {}): Promise<Result<LoginReturn | undefined>> {
  const taken = await store.take(LoginReturnSlot);
  if (!taken.ok) return taken;
  const value = taken.value;
  if (value === undefined) return ok(undefined);
  if ((input.nonce !== undefined && input.nonce !== value.nonce) || !isSafeReturnPath(value.returnTo)) {
    for (const slot of input.slots ?? []) {
      if (value.carried.includes(slot.key)) await store.discard(slot);
    }
    return err(
      input.nonce !== undefined && input.nonce !== value.nonce
        ? RedirectStateMismatchError({ details: { carried: value.carried } })
        : UnsafeReturnPathError({ details: { returnTo: value.returnTo } }),
    );
  }
  return ok(value);
}

// ------------------------------------------------------------- guest → user migration (R9.11)

export interface GuestMigration {
  /** Guest user-data slices by slice key, in the shared envelope format. */
  readonly slices: Readonly<Record<string, SnapshotEnvelope>>;
}

export const GuestMigrationSlot: HandoffSlot<GuestMigration> = defineHandoff<GuestMigration>({
  key: 'handoff/guest-migration',
  version: 1,
  lifetime: { ttlMs: 30 * 60_000 },
  scope: 'tab',
  schema: (value: unknown): value is GuestMigration =>
    typeof value === 'object' && value !== null && typeof (value as { slices?: unknown }).slices === 'object' && (value as { slices?: unknown }).slices !== null,
  description: 'Guest user-data slices waiting to be merged into the signed-in user after login.',
});

/** Stage guest slices before login (call with the slices the data layer exports). */
export function stageGuestMigration(store: HandoffStore, slices: Readonly<Record<string, SnapshotEnvelope>>): Promise<Result<SnapshotEnvelope<GuestMigration>>> {
  return store.put(GuestMigrationSlot, { slices });
}

/** Take staged guest slices after login (consume-once). */
export async function takeGuestMigration(store: HandoffStore): Promise<Result<Readonly<Record<string, SnapshotEnvelope>> | undefined>> {
  const taken = await store.take(GuestMigrationSlot);
  return taken.ok ? ok(taken.value?.slices) : taken;
}

// ------------------------------------------------------------- hold/release adapter

/**
 * A slot as a hold/release port: `hold` writes, `release` consumes. Matches
 * `@staticflux/urlstate`'s `IntentHoldPort` structurally, so URL intents survive
 * a login redirect without urlstate depending on handoff:
 *
 *   const IntentsSlot = defineHandoff<readonly HeldIntent[]>({ key: 'app/held-intents', version: 1, lifetime: { ttlMs: 900_000 }, scope: 'tab' });
 *   createIntentService({ …, hold: createSlotHold(store, IntentsSlot) });
 */
export interface SlotHold<T> {
  hold(data: T): Promise<Result<void>>;
  release(): Promise<Result<T | undefined>>;
}

export function createSlotHold<T>(store: HandoffStore, slot: HandoffSlot<T>): SlotHold<T> {
  return {
    async hold(data) {
      const written = await store.put(slot, data);
      return written.ok ? ok() : written;
    },
    release: () => store.take(slot),
  };
}
