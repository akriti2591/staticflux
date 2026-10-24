/**
 * Typed handoff slots (R19.1, R19.2). A slot is a declaration — key, payload
 * version/schema, lifetime and storage scope — shared by the writer and the
 * reader, so both sides agree on the payload type without importing each other.
 *
 *   export const GuestDraftSlot = defineHandoff<Draft>({
 *     key: 'studio/guest-draft', version: 1, lifetime: 'one-shot', scope: 'tab', schema: isDraft,
 *   });
 */
import type { HandoffSchema, Migrations } from './envelope.js';

export type HandoffKey = `${string}/${string}`;

/**
 * - `one-shot` — consumed by the first `take()`.
 * - `session` — lives until cleared (logout clears session entries) or the storage ends.
 * - `{ ttlMs }` — expires `ttlMs` after it was written.
 */
export type HandoffLifetime = 'one-shot' | 'session' | { readonly ttlMs: number };

/**
 * Where the entry lives, i.e. which boundaries it survives:
 * - `memory` — this page only (sub-route/view changes, mode/variant swaps).
 * - `tab` — reload, deep link, login redirect in the same tab (sessionStorage).
 * - `origin` — other tabs/windows of the same origin (localStorage).
 * Missing storages degrade to memory (embedded hosts, private mode).
 */
export type HandoffScope = 'memory' | 'tab' | 'origin';

export interface HandoffSlot<T> {
  readonly kind: 'handoff-slot';
  readonly key: HandoffKey;
  /** Payload schema version; bump on shape changes and add a migration. */
  readonly version: number;
  readonly lifetime: HandoffLifetime;
  readonly scope: HandoffScope;
  readonly schema: HandoffSchema<T> | undefined;
  readonly migrations: Migrations | undefined;
  /** Upper bound on age for any lifetime (e.g. a one-shot draft is useless after a day). */
  readonly maxAgeMs: number | undefined;
  readonly description: string | undefined;
  /** Phantom payload carrier. */
  readonly __type?: T;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyHandoffSlot = HandoffSlot<any>;
export type SlotValue<S> = S extends HandoffSlot<infer T> ? T : never;

export interface DefineHandoffInput<T> {
  readonly key: HandoffKey;
  readonly version: number;
  readonly lifetime: HandoffLifetime;
  readonly scope: HandoffScope;
  readonly schema?: HandoffSchema<T>;
  readonly migrations?: Migrations;
  readonly maxAgeMs?: number;
  readonly description?: string;
}

/* @__NO_SIDE_EFFECTS__ */
export function defineHandoff<T>(input: DefineHandoffInput<T>): HandoffSlot<T> {
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new TypeError(`defineHandoff("${input.key}"): version must be a positive integer.`);
  }
  if (typeof input.lifetime === 'object' && !(input.lifetime.ttlMs > 0)) {
    throw new TypeError(`defineHandoff("${input.key}"): ttlMs must be > 0.`);
  }
  return Object.freeze({
    kind: 'handoff-slot',
    key: input.key,
    version: input.version,
    lifetime: input.lifetime,
    scope: input.scope,
    schema: input.schema,
    migrations: input.migrations,
    maxAgeMs: input.maxAgeMs,
    description: input.description,
  });
}

export type LifetimeKind = 'one-shot' | 'session' | 'ttl';

export function lifetimeKind(lifetime: HandoffLifetime): LifetimeKind {
  return typeof lifetime === 'object' ? 'ttl' : lifetime;
}

/** Effective TTL for a new entry: the lifetime TTL, capped by `maxAgeMs`, overridable per write. */
export function effectiveTtl(slot: AnyHandoffSlot, override?: number): number | undefined {
  const candidates = [override, typeof slot.lifetime === 'object' ? slot.lifetime.ttlMs : undefined, slot.maxAgeMs].filter(
    (n): n is number => n !== undefined,
  );
  return candidates.length === 0 ? undefined : Math.min(...candidates);
}
