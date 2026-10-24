/**
 * Consume-once URL intents (R7.10, R7.13, R7.14, invariant I-13).
 *
 *   ?panel=chat&prompt=Summarize%20this
 *
 * 1. `capture(url)` at the router's resolve stage parses declared intents and
 *    holds them in memory (`captured → held`).
 * 2. Before a login redirect, `persist()` writes them through the `IntentHoldPort`
 *    (usually a handoff slot); after login, `restore()` brings them back.
 * 3. `authorize(owner?)` after the authorize stage marks them deliverable and
 *    strips their params from the URL with `replace`.
 * 4. The owning consumer receives them once via `consume(intent, handler)`
 *    (`authorized → delivered`), immediately if it registers later (lazy chunk).
 *
 * Deliveries are prefill-only unless the declaration says `safe: true`;
 * `delivery.execute()` refuses (SF-URL-001) otherwise. Intent values never go
 * to telemetry (they may contain user text / injected prompts).
 */
import {
  createMachine,
  createNoopTelemetry,
  defineMachine,
  err,
  metric,
  ok,
  type Result,
  type Scope,
  type Telemetry,
} from '@staticflux/core';
import type { AnyIntentDef, IntentDef, IntentPolicy } from './binding.js';
import { IntentNotExecutableError } from './errors.js';
import type { HistoryPort } from './history.js';
import { URLSTATE_SOURCE } from './sync.js';
import { formatUrl, getParam, hasParam, parseUrl, withoutParams } from './url.js';

export const IntentMachine = defineMachine({
  id: 'urlstate/intent',
  initial: 'captured',
  states: ['captured', 'rejected', 'held', 'authorized', 'delivered', 'discarded'],
  transitions: {
    captured: { hold: 'held', reject: 'rejected' },
    held: { authorize: 'authorized', discard: 'discarded' },
    authorized: { deliver: 'delivered', discard: 'discarded' },
  },
  terminal: ['rejected', 'delivered', 'discarded'],
});
export type IntentState = (typeof IntentMachine.states)[number];
type IntentEvent = 'hold' | 'reject' | 'authorize' | 'deliver' | 'discard';

export const IntentMetrics = {
  captured: /* @__PURE__ */ metric.counter('urlstate/intent-captured', { description: 'Intents captured from URLs.' }),
  delivered: /* @__PURE__ */ metric.counter('urlstate/intent-delivered', { description: 'Intents delivered to their owner.' }),
  blocked: /* @__PURE__ */ metric.counter('urlstate/intent-execute-blocked', { description: 'Auto-execution attempts refused (I-13).' }),
} as const;

const SUBSYSTEM = 'urlstate/intent';

/** Serializable form for the hold port (raw strings; re-validated on restore). */
export interface HeldIntent {
  readonly id: string;
  readonly params: Readonly<Record<string, string>>;
  readonly capturedAt: number;
}

/** Survives a login redirect. `createSlotHold()` from `@staticflux/handoff` implements it. */
export interface IntentHoldPort {
  hold(intents: readonly HeldIntent[]): Promise<Result<void>>;
  release(): Promise<Result<readonly HeldIntent[] | undefined>>;
}

export interface IntentDelivery<P> {
  readonly intent: string;
  readonly owner: string;
  readonly params: P;
  /** `prefill`: show it, let the user act. `safe`: may run without confirmation. */
  readonly mode: 'prefill' | 'safe';
  /** Runs `action` only for `safe` intents; otherwise SF-URL-001 (I-13). */
  execute<R>(action: (params: P) => R): Result<R>;
}

export interface IntentInfo {
  readonly id: string;
  readonly owner: string;
  readonly state: IntentState;
  readonly policy: IntentPolicy;
  readonly keys: readonly string[];
}

export interface IntentService {
  /** Parse intents from `url` (default: current URL) and hold them. */
  capture(url?: string): readonly IntentInfo[];
  /** Write held intents through the hold port (before a login redirect). */
  persist(): Promise<Result<number>>;
  /** Bring back intents held through the port (after login). */
  restore(): Promise<Result<number>>;
  /** Authorized signal: make held intents (of `owner`, or all) deliverable and strip them from the URL. */
  authorize(owner?: string): void;
  /** Register the owning consumer; receives each authorized intent once. */
  consume<P>(intent: IntentDef<string, P>, handler: (delivery: IntentDelivery<P>) => void, scope?: Scope): () => void;
  /** Drop held intents (all, or one id) — e.g. the user declined to log in. */
  discard(id?: string): void;
  /** `url` without the params of held intents (for login `returnTo`). */
  strip(url: string): string;
  inspect(): readonly IntentInfo[];
}

export interface IntentServiceOptions {
  readonly history: HistoryPort;
  readonly intents: readonly AnyIntentDef[];
  readonly hold?: IntentHoldPort | undefined;
  readonly telemetry?: Telemetry;
  readonly now?: () => number;
}

interface Record_ {
  readonly def: AnyIntentDef;
  readonly machine: ReturnType<typeof createMachine<IntentState, IntentEvent>>;
  readonly raw: Readonly<Record<string, string>>;
  readonly params: Readonly<Record<string, unknown>>;
  readonly capturedAt: number;
}

export function createIntentService(options: IntentServiceOptions): IntentService {
  const { history } = options;
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const now = options.now ?? Date.now;
  const defs = new Map(options.intents.map((d) => [d.id, d]));
  const records: Record_[] = [];
  const consumers = new Map<string, (delivery: IntentDelivery<never>) => void>();

  const machineFor = (def: AnyIntentDef, initial?: IntentState): Record_['machine'] => {
    const machine = createMachine(IntentMachine, initial === undefined ? {} : { initial });
    machine.onTransition((r) =>
      telemetry.event(`lifecycle.${r.machine}.${r.from}→${r.to}`, { subsystem: SUBSYSTEM, level: 'verbose', attrs: { intent: def.id } }),
    );
    return machine;
  };

  /** Validate raw strings against the declaration. Undefined = intent not present / invalid. */
  const parseRaw = (def: AnyIntentDef, raw: Readonly<Record<string, string>>): { params: Record<string, unknown>; raw: Record<string, string> } | 'absent' | 'invalid' => {
    if (!def.required.every((key) => raw[key] !== undefined)) return 'absent';
    const params: Record<string, unknown> = {};
    const kept: Record<string, string> = {};
    for (const [key, codec] of Object.entries(def.params)) {
      const value = raw[key];
      if (value === undefined) continue;
      const parsed = codec.parse(value);
      if (!parsed.ok) {
        if (def.required.includes(key)) return 'invalid';
        continue; // optional param with a bad value is dropped
      }
      params[key] = parsed.value;
      kept[key] = value;
    }
    return { params, raw: kept };
  };

  const info = (r: Record_): IntentInfo => ({ id: r.def.id, owner: r.def.owner, state: r.machine.state, policy: r.def.policy, keys: Object.keys(r.raw) });

  const live = (): Record_[] => records.filter((r) => r.machine.is('held', 'authorized'));

  const replaceExisting = (id: string): void => {
    for (const r of live()) if (r.def.id === id) r.machine.send('discard');
  };

  const deliver = (record: Record_): void => {
    const consumer = consumers.get(record.def.id);
    if (consumer === undefined || !record.machine.is('authorized')) return;
    record.machine.send('deliver');
    const safe = record.def.policy === 'safe';
    const delivery: IntentDelivery<unknown> = {
      intent: record.def.id,
      owner: record.def.owner,
      params: record.params,
      mode: safe ? 'safe' : 'prefill',
      execute(action) {
        if (safe) return ok(action(record.params));
        telemetry.record(IntentMetrics.blocked, 1, { intent: record.def.id });
        telemetry.event('urlstate.intent-execute-blocked', { subsystem: SUBSYSTEM, level: 'critical', attrs: { intent: record.def.id } });
        return err(IntentNotExecutableError({ details: { intent: record.def.id } }));
      },
    };
    telemetry.record(IntentMetrics.delivered, 1, { intent: record.def.id, mode: delivery.mode });
    consumer(delivery as IntentDelivery<never>);
  };

  const keysOfLive = (filter: (r: Record_) => boolean): string[] => [...new Set(live().filter(filter).flatMap((r) => Object.keys(r.def.params)))];

  const service: IntentService = {
    capture(url = history.url) {
      const parts = parseUrl(url);
      const captured: Record_[] = [];
      for (const def of defs.values()) {
        const raw: Record<string, string> = {};
        for (const key of Object.keys(def.params)) {
          const value = getParam(parts, key);
          if (value !== undefined) raw[key] = value;
        }
        const parsed = parseRaw(def, raw);
        if (parsed === 'absent') continue;
        const machine = machineFor(def);
        if (parsed === 'invalid') {
          const rejected: Record_ = { def, machine, raw, params: {}, capturedAt: now() };
          machine.send('reject');
          records.push(rejected);
          telemetry.event('urlstate.intent-rejected', { subsystem: SUBSYSTEM, attrs: { intent: def.id } });
          continue;
        }
        replaceExisting(def.id);
        const record: Record_ = { def, machine, raw: parsed.raw, params: parsed.params, capturedAt: now() };
        machine.send('hold');
        records.push(record);
        captured.push(record);
        telemetry.record(IntentMetrics.captured, 1, { intent: def.id });
      }
      return captured.map(info);
    },
    async persist() {
      const port = options.hold;
      const held = live();
      if (port === undefined || held.length === 0) return ok(0);
      const result = await port.hold(held.map((r) => ({ id: r.def.id, params: r.raw, capturedAt: r.capturedAt })));
      return result.ok ? ok(held.length) : result;
    },
    async restore() {
      const port = options.hold;
      if (port === undefined) return ok(0);
      const released = await port.release();
      if (!released.ok) return released;
      let restored = 0;
      for (const held of released.value ?? []) {
        const def = defs.get(held.id);
        if (def === undefined) continue;
        const parsed = parseRaw(def, held.params); // storage is untrusted: validate again
        if (parsed === 'absent' || parsed === 'invalid') continue;
        replaceExisting(def.id);
        const record: Record_ = { def, machine: machineFor(def, 'held'), raw: parsed.raw, params: parsed.params, capturedAt: held.capturedAt };
        records.push(record);
        restored += 1;
      }
      return ok(restored);
    },
    authorize(owner) {
      const matching = (r: Record_): boolean => r.machine.is('held') && (owner === undefined || r.def.owner === owner);
      const keys = keysOfLive(matching);
      const authorized = records.filter(matching);
      for (const r of authorized) r.machine.send('authorize');
      const parts = parseUrl(history.url);
      if (keys.some((key) => hasParam(parts, key))) {
        history.replace(formatUrl(withoutParams(parts, keys)), { source: URLSTATE_SOURCE });
        telemetry.event('urlstate.intent-stripped', { subsystem: SUBSYSTEM, attrs: { keys } });
      }
      for (const r of authorized) deliver(r);
    },
    consume(intent, handler, scope) {
      consumers.set(intent.id, handler as (delivery: IntentDelivery<never>) => void);
      for (const r of records.filter((x) => x.def.id === intent.id && x.machine.is('authorized'))) deliver(r);
      const unregister = (): void => {
        if (consumers.get(intent.id) === handler) consumers.delete(intent.id);
      };
      scope?.defer(unregister);
      return unregister;
    },
    discard(id) {
      for (const r of live()) if (id === undefined || r.def.id === id) r.machine.send('discard');
    },
    strip(url) {
      return formatUrl(withoutParams(parseUrl(url), keysOfLive(() => true)));
    },
    inspect: () => records.map(info),
  };
  return service;
}
