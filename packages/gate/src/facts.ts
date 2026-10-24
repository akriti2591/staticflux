/**
 * Facts: typed, reactive inputs to policies (R6.8). Facts come from pluggable
 * `FactSource`s — session, roles, plan, entitlements, cohorts, flags, platform,
 * region, host, meters. Gate never imports the packages that own those facts; apps
 * adapt them with `reactiveFactSource` / `createManualFactSource`.
 */
import { type Scope, watch } from '@staticflux/core';

export type FactId = `${string}/${string}` | `${string}:${string}`;
export type FactPrimitive = string | number | boolean | null;
export type FactValue = FactPrimitive | readonly FactPrimitive[];

declare const factType: unique symbol;

export interface FactDef<T extends FactValue = FactValue, Id extends FactId = FactId> {
  readonly kind: 'fact';
  readonly id: Id;
  readonly description: string | undefined;
  /** Phantom type carrier. */
  readonly [factType]?: T;
}

/** Declare a fact: `defineFact('billing/plan').type<'free' | 'pro'>()`. */
/* @__NO_SIDE_EFFECTS__ */
export function defineFact<const Id extends FactId>(id: Id, description?: string): { type<T extends FactValue>(): FactDef<T, Id> } {
  return { type: <T extends FactValue>() => Object.freeze({ kind: 'fact', id, description }) as FactDef<T, Id> };
}

export interface FactSink {
  set<T extends FactValue>(fact: FactDef<T>, value: T | undefined): void;
  /** Apply several fact updates as one recompute wave. */
  batch(fn: () => void): void;
}

export interface FactSource {
  readonly id: `${string}/${string}`;
  /** Facts this source provides (devtools, conflict detection). */
  readonly facts: readonly FactDef[];
  /** Start pushing values into `sink`. Returns a disconnect function. */
  connect(sink: FactSink): () => void;
}

/** Standard facts. Feature packages declare their own with `defineFact`. */
export const GateFacts = {
  /** The current principal's subject kind. Built in; defaults to `guest`. */
  subjectKind: defineFact('gate/subject-kind', 'guest | user — the current principal').type<'guest' | 'user'>(),
  authenticated: defineFact('session/authenticated').type<boolean>(),
  userId: defineFact('session/user-id').type<string>(),
  roles: defineFact('session/roles').type<readonly string[]>(),
  plan: defineFact('billing/plan').type<string>(),
  entitlements: defineFact('billing/entitlements').type<readonly string[]>(),
  cohorts: defineFact('gate/cohorts').type<readonly string[]>(),
  platform: defineFact('platform/capabilities', 'available platform capabilities (sw, passkeys, …)').type<readonly string[]>(),
  formFactor: defineFact('platform/form-factor').type<string>(),
  region: defineFact('platform/region').type<string>(),
  host: defineFact('platform/host', 'host mode, e.g. web | pwa | embed-agent-host').type<string>(),
} as const;

/** Fact for a feature flag value (flags are owned by @staticflux/config; gate only reads the value). */
/* @__NO_SIDE_EFFECTS__ */
export function flagFact<T extends FactPrimitive = boolean>(flagId: `${string}/${string}`): FactDef<T> {
  return defineFact(`flag:${flagId}`).type<T>();
}

export function factEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) return false;
  return true;
}

export interface ManualFactSource extends FactSource {
  set<T extends FactValue>(fact: FactDef<T>, value: T | undefined): void;
  setMany(values: readonly (readonly [FactDef, FactValue | undefined])[]): void;
  get<T extends FactValue>(fact: FactDef<T>): T | undefined;
}

/** A source whose values are pushed imperatively (tests, server responses, push channels). */
export function createManualFactSource(id: `${string}/${string}`, facts: readonly FactDef[] = []): ManualFactSource {
  const values = new Map<FactId, FactValue | undefined>();
  const sinks = new Set<FactSink>();
  const known = new Map<FactId, FactDef>(facts.map((f) => [f.id, f]));
  const push = (fact: FactDef, value: FactValue | undefined): void => {
    known.set(fact.id, fact);
    values.set(fact.id, value);
    for (const sink of sinks) sink.set(fact, value);
  };
  return {
    id,
    get facts() {
      return [...known.values()];
    },
    connect(sink) {
      sinks.add(sink);
      sink.batch(() => {
        for (const [factId, value] of values) {
          const fact = known.get(factId);
          if (fact !== undefined) sink.set(fact, value);
        }
      });
      return () => sinks.delete(sink);
    },
    set(fact, value) {
      push(fact, value);
    },
    setMany(entries) {
      const run = (): void => {
        for (const [fact, value] of entries) push(fact, value);
      };
      if (sinks.size === 0) run();
      else for (const sink of [...sinks]) sink.batch(run);
    },
    get(fact) {
      return values.get(fact.id) as never;
    },
  };
}

export interface ReactiveBinding<T extends FactValue = FactValue> {
  readonly fact: FactDef<T>;
  /** Read from any reactive store (MobX / core `box`). Re-run when what it reads changes. */
  readonly read: () => T | undefined;
}

/** Bind facts to reactive expressions — e.g. auth session state, platform facts, config flags. */
export function reactiveFactSource(id: `${string}/${string}`, bindings: readonly ReactiveBinding[], scope?: Scope): FactSource {
  return {
    id,
    facts: bindings.map((b) => b.fact),
    connect(sink) {
      const stops = bindings.map((binding) =>
        watch(binding.read, (value) => sink.set(binding.fact, value), { fireImmediately: true }),
      );
      const disconnect = (): void => {
        for (const stop of stops) stop();
      };
      scope?.defer(disconnect);
      return disconnect;
    },
  };
}

export interface SessionFactsInput {
  readonly authenticated: boolean;
  readonly userId?: string | undefined;
  readonly roles?: readonly string[] | undefined;
}

/**
 * Session facts through the fact-source port (gate does not import auth):
 *   sessionFactSource(() => ({ authenticated: session.isAuthenticated, userId: session.principal?.id, roles: session.principal?.roles }))
 * Also drives the built-in `subjectKind` fact.
 */
export function sessionFactSource(read: () => SessionFactsInput, scope?: Scope): FactSource {
  return reactiveFactSource(
    'gate/session-facts',
    [
      { fact: GateFacts.subjectKind, read: () => (read().authenticated ? 'user' : 'guest') },
      { fact: GateFacts.authenticated, read: () => read().authenticated },
      { fact: GateFacts.userId, read: () => read().userId },
      { fact: GateFacts.roles, read: () => read().roles ?? [] },
    ] as readonly ReactiveBinding[],
    scope,
  );
}

export interface GateClock {
  now(): number;
  setTimer(fn: () => void, ms: number): () => void;
}

export const systemGateClock: GateClock = {
  now: () => Date.now(),
  setTimer(fn, ms) {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
};

export interface EntitlementSource extends FactSource {
  /** Authoritative list from the server (also marks the source online). */
  setFromServer(entitlements: readonly string[]): void;
  /**
   * Offline (R6.15): previously granted entitlements stay until `graceMs` elapses,
   * then fail closed. Back online: keep current list until the next server update.
   */
  setOffline(offline: boolean): void;
  /** Revocation via 403 / server push (R6.14): remove immediately. */
  revoke(entitlement: string): void;
  readonly current: readonly string[];
}

export function createEntitlementSource(options: {
  readonly fact?: FactDef<readonly string[]>;
  readonly clock?: GateClock;
  readonly graceMs: number;
}): EntitlementSource {
  const fact = options.fact ?? GateFacts.entitlements;
  const clock = options.clock ?? systemGateClock;
  const source = createManualFactSource('gate/entitlements', [fact]);
  let current: readonly string[] = [];
  let cancelGrace: (() => void) | undefined;
  const publish = (next: readonly string[]): void => {
    current = next;
    source.set(fact, next);
  };
  return {
    id: source.id,
    facts: source.facts,
    connect: (sink) => source.connect(sink),
    get current() {
      return current;
    },
    setFromServer(entitlements) {
      cancelGrace?.();
      cancelGrace = undefined;
      publish([...entitlements]);
    },
    setOffline(offline) {
      if (!offline) {
        cancelGrace?.();
        cancelGrace = undefined;
        return;
      }
      if (cancelGrace !== undefined) return;
      cancelGrace = clock.setTimer(() => {
        cancelGrace = undefined;
        publish([]);
      }, options.graceMs);
    },
    revoke(entitlement) {
      publish(current.filter((e) => e !== entitlement));
    },
  };
}
