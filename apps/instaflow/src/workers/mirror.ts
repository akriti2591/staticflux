/**
 * Service mirrors (B9, IF-33.14–33.15): a service that lives in the editor module, read on main. The worker side
 * evaluates the service's **reads** (plain data) whenever a tracked value or an explicit change signal says so, and
 * posts the values when they differ from the last post; main keeps the latest values in a reactive box, so panels
 * read them like any reactive model. **Actions** are forwarded and answered with the worker's `Result`.
 *
 * A mirror is a typed value (`defineMirror`), never a string: its id is the channel key, its shape is the contract
 * both sides compile against, and `initial` is what main reads before the first post.
 *
 * @example
 * export const CounterMirror = defineMirror<{ reads: { count: number }; actions: { add(n: number): Result<void> } }>('instaflow/mirror/counter', { count: 0 });
 * servers.serve(CounterMirror, { reads: { count: () => counter.get() }, actions: { add: (n) => counter.add(n) } }, scope); // worker
 * const view = hub.view(CounterMirror); view.read('count'); await view.call('add', 1);                                   // main
 */
import { box, err, ok, type Result, type Scope, type SfError, toSfError, untracked, watch } from '@staticflux/core';
import { MirrorUnknownError } from './errors.js';
import { fromWire, toWire } from './wire.js';

/** The contract of a mirror: plain-data reads and forwarded actions. */
export interface MirrorShape {
  readonly reads: object;
  readonly actions: object;
}

export type MirrorId = `instaflow/mirror/${string}`;

export interface MirrorDefinition<S extends MirrorShape> {
  readonly kind: 'mirror';
  readonly id: MirrorId;
  /** What main reads before the first post. */
  readonly initial: S['reads'];
}

/** Declare a mirror (see the module header). */
export function defineMirror<S extends MirrorShape>(id: MirrorId, initial: S['reads']): MirrorDefinition<S> {
  return Object.freeze({ kind: 'mirror', id, initial: Object.freeze({ ...initial }) });
}

type ActionFn = (...args: never[]) => unknown;
type ActionsOf<S extends MirrorShape> = { readonly [K in keyof S['actions']]: S['actions'][K] extends ActionFn ? S['actions'][K] : never };
type ActionArgs<S extends MirrorShape, K extends keyof S['actions']> = S['actions'][K] extends (...args: infer A) => unknown ? A : never;
/** The value an action resolves to across the boundary (a `Result`'s value, or the plain return). */
export type ActionValue<S extends MirrorShape, K extends keyof S['actions']> = S['actions'][K] extends (...args: never[]) => infer R ? (Awaited<R> extends Result<infer V> ? V : Awaited<R>) : never;

/** One post: every read's value (wire form). */
export interface MirrorUpdate {
  readonly id: MirrorId;
  readonly values: Readonly<Record<string, unknown>>;
}

/** One forwarded action. */
export interface MirrorCall {
  readonly id: MirrorId;
  readonly action: string;
  readonly args: readonly unknown[];
}

// ---------------------------------------------------------------- worker side

export interface MirrorSource<S extends MirrorShape> {
  readonly reads: { readonly [K in keyof S['reads']]: () => S['reads'][K] };
  readonly actions: ActionsOf<S>;
  /** Changes reactivity cannot see (document invalidations): re-read and post if anything differs. */
  readonly changes?: (listener: () => void) => () => void;
}

export interface MirrorServers {
  /** Serve `source` under `definition` until `scope` ends (a later serve of the same id replaces it). */
  serve<S extends MirrorShape>(definition: MirrorDefinition<S>, source: MirrorSource<S>, scope: Pick<Scope, 'defer'>): void;
  /** Run a forwarded action (IF-WRK-003 for an unknown mirror or action). */
  call(call: MirrorCall): Promise<Result<unknown>>;
  /** Post every served mirror again (main reconnected). */
  repost(): void;
}

interface Served {
  readonly evaluate: () => Record<string, unknown>;
  readonly actions: Readonly<Record<string, ActionFn>>;
  last: string;
  post(values: Record<string, unknown>, force?: boolean): void;
}

/** The worker side: posts reads through `emit` (coalesced on `schedule`, default a microtask). */
export function createMirrorServers(emit: (update: MirrorUpdate) => void, options: { readonly schedule?: (fn: () => void) => void } = {}): MirrorServers {
  const schedule = options.schedule ?? ((fn: () => void) => queueMicrotask(fn));
  const served = new Map<MirrorId, Served>();
  return {
    serve(definition, source, scope) {
      const keys = Object.keys(source.reads) as (keyof typeof source.reads & string)[];
      const evaluate = (): Record<string, unknown> => Object.fromEntries(keys.map((k) => [k, (source.reads[k] as () => unknown)()]));
      const entry: Served = {
        evaluate,
        actions: source.actions as unknown as Readonly<Record<string, ActionFn>>,
        last: '',
        post(values, force = false) {
          const wire = toWire(values) as Record<string, unknown>;
          const json = JSON.stringify(wire);
          if (!force && json === entry.last) return;
          entry.last = json;
          emit({ id: definition.id, values: wire });
        },
      };
      served.set(definition.id, entry);
      let pending = false;
      const reread = (): void => {
        if (pending) return;
        pending = true;
        schedule(() => {
          pending = false;
          if (served.get(definition.id) === entry) entry.post(untracked(evaluate));
        });
      };
      scope.defer(watch(evaluate, (values) => entry.post(values), { fireImmediately: true }));
      if (source.changes !== undefined) scope.defer(source.changes(reread));
      scope.defer(() => {
        if (served.get(definition.id) === entry) served.delete(definition.id);
      });
    },
    async call(call) {
      const action = served.get(call.id)?.actions[call.action];
      if (action === undefined) return err(MirrorUnknownError({ details: { mirror: call.id, action: call.action } }));
      try {
        const out = await (action as (...args: unknown[]) => unknown)(...(fromWire<unknown[]>(call.args) ?? []));
        const result = isResult(out) ? out : ok(out);
        return result.ok ? ok(toWire(result.value)) : result;
      } catch (error) {
        return err(toSfError(error));
      }
    },
    repost() {
      for (const entry of served.values()) entry.post(untracked(entry.evaluate), true);
    },
  };
}

const isResult = (value: unknown): value is Result<unknown> => typeof value === 'object' && value !== null && typeof (value as { ok?: unknown }).ok === 'boolean' && ('value' in value || 'error' in value);

// ---------------------------------------------------------------- main side

export interface MirrorView<S extends MirrorShape> {
  readonly id: MirrorId;
  /** The latest posted value (reactive). */
  read<K extends keyof S['reads']>(key: K): S['reads'][K];
  /** True once the worker posted at least once (reactive). */
  readonly ready: boolean;
  /** Called after every post. */
  onChange(listener: () => void): () => void;
  /** Forward an action; resolves with the worker's result. */
  call<K extends keyof S['actions']>(action: K, ...args: ActionArgs<S, K>): Promise<Result<ActionValue<S, K>>>;
}

export interface MirrorHub {
  /** The view of a mirror (one per id). */
  view<S extends MirrorShape>(definition: MirrorDefinition<S>): MirrorView<S>;
  /** Apply a post from the worker (unknown ids are kept for a view created later). */
  apply(update: MirrorUpdate): void;
}

/** The main side: views over posts, actions through `call` (the worker request). */
export function createMirrorHub(call: (call: MirrorCall) => Promise<Result<unknown>>): MirrorHub {
  interface Entry {
    readonly values: ReturnType<typeof box<Readonly<Record<string, unknown>> | undefined>>;
    readonly listeners: Set<() => void>;
    view?: MirrorView<MirrorShape>;
  }
  const entries = new Map<MirrorId, Entry>();
  const entry = (id: MirrorId): Entry => {
    let e = entries.get(id);
    if (e === undefined) {
      e = { values: box<Readonly<Record<string, unknown>> | undefined>(undefined), listeners: new Set() };
      entries.set(id, e);
    }
    return e;
  };
  return {
    view<S extends MirrorShape>(definition: MirrorDefinition<S>): MirrorView<S> {
      const e = entry(definition.id);
      if (e.view !== undefined) return e.view as unknown as MirrorView<S>;
      const initial = definition.initial as Readonly<Record<string, unknown>>;
      const view: MirrorView<S> = {
        id: definition.id,
        read: (key) => {
          const values = e.values.get();
          const k = key as string;
          return (values !== undefined && k in values ? values[k] : initial[k]) as S['reads'][typeof key];
        },
        get ready() {
          return e.values.get() !== undefined;
        },
        onChange(listener) {
          e.listeners.add(listener);
          return () => e.listeners.delete(listener);
        },
        async call(action, ...args) {
          const result = await call({ id: definition.id, action: action as string, args: toWire(args) as unknown[] });
          return (result.ok ? ok(fromWire(result.value)) : result) as Result<ActionValue<S, typeof action>>;
        },
      };
      e.view = view as unknown as MirrorView<MirrorShape>;
      return view;
    },
    apply(update) {
      const e = entry(update.id);
      e.values.set(fromWire<Readonly<Record<string, unknown>>>(update.values));
      for (const listener of [...e.listeners]) listener();
    },
  };
}

/** Report a failed forwarded action (sync panel actions answer optimistically; the failure is announced). */
export function reportFailure(promise: Promise<Result<unknown>>, onProblem: (error: SfError) => void): void {
  void promise.then((r) => {
    if (!r.ok) onProblem(r.error);
  });
}
