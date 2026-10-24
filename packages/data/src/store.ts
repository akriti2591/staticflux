/**
 * Schema-first stores (R9.5, R11.2, I-9).
 *
 *   const ChatStore = defineStore({
 *     id: 'agent/chat', version: 1,
 *     schema: s.object({ messages: s.array(MessageSchema), draft: s.string() }),
 *     initial: () => ({ messages: [], draft: '' }),
 *     actions: {
 *       append(state, message: Message) { state.messages.push(message); },
 *       setDraft(state, text: string) { state.draft = text; },
 *     },
 *   });
 *   const owner = ChatStore.create();               // the one owner (main thread by default)
 *   owner.actions.append(msg);                       // → Result<void>; one PatchMessage per outermost action
 *   const replica = ChatStore.replica({ sink });    // read-only; writes become intents to the owner
 *
 * Reactivity: `state` and `version` are reactive (core reactivity port); state is
 * immutable, structurally shared and frozen, so `select()` derivations recompute
 * only when their slice of the tree changes.
 *
 * ## Replication messages (stable, format 1) — consumed by @staticflux/worker
 *
 *   StoreSnapshot { format: 1, storeId, schemaVersion, epoch, version, state }
 *   PatchMessage  { format: 1, storeId, schemaVersion, epoch, version, action, patches, traceparent? }
 *       `version` is the owner version AFTER applying `patches`; versions are contiguous (+1 per message).
 *   StoreIntent   { format: 1, storeId, action, args, baseVersion, traceparent? }
 *
 * Handshake: replica `hello{haveVersion}` → owner `patchesSince(haveVersion)` or `getSnapshot()`.
 * Replica `applyPatches` returns `SF-DATA-041` (gap) / `SF-DATA-042` (epoch) → resnapshot.
 */
import {
  batch,
  box,
  createNoopTelemetry,
  derived,
  type Derived,
  err,
  ok,
  type Result,
  SfError,
  type Telemetry,
  type TokenId,
  toSfError,
  untracked,
} from '@staticflux/core';
import { clonePlain, deepFreeze } from './clone.js';
import { FIXED_EPOCH, type EpochSource } from './epoch.js';
import {
  ActionFailedError,
  EpochMismatchError,
  PatchGapError,
  PatchHistoryExpiredError,
  ReplicaWriteError,
  StoreSchemaVersionError,
  UnknownActionError,
} from './errors.js';
import { DATA_SUBSYSTEMS, DataMetrics } from './metrics.js';
import { applyPatchOps, createTransaction, type PatchOp, type Transaction } from './patches.js';
import type { Schema } from './schema.js';

export const STORE_FORMAT = 1;

export type DeepReadonly<T> = T extends (infer E)[]
  ? readonly DeepReadonly<E>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ActionFn<S> = (state: S, ...args: any[]) => unknown;
export type ActionMap<S> = Readonly<Record<string, ActionFn<S>>>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ActionArgs<F> = F extends (state: any, ...args: infer A) => unknown ? A : never;

export type OwnerActions<A> = { readonly [K in keyof A]: (...args: ActionArgs<A[K]>) => Result<A[K] extends (...a: never[]) => infer R ? R : never> };
export type ReplicaActions<A> = { readonly [K in keyof A]: (...args: ActionArgs<A[K]>) => Result<void> };

export interface StoreSnapshot<S> {
  readonly format: typeof STORE_FORMAT;
  readonly storeId: TokenId;
  readonly schemaVersion: number;
  readonly epoch: number;
  readonly version: number;
  readonly state: S;
}

export interface PatchMessage {
  readonly format: typeof STORE_FORMAT;
  readonly storeId: TokenId;
  readonly schemaVersion: number;
  readonly epoch: number;
  readonly version: number;
  readonly action: string;
  readonly patches: readonly PatchOp[];
  readonly traceparent?: string;
}

export interface StoreIntent {
  readonly format: typeof STORE_FORMAT;
  readonly storeId: TokenId;
  readonly action: string;
  readonly args: readonly unknown[];
  readonly baseVersion: number;
  readonly traceparent?: string;
}

interface StoreBase<S> {
  readonly id: TokenId;
  readonly schemaVersion: number;
  /** Current immutable state. Reactive. */
  readonly state: DeepReadonly<S>;
  /** Patch version (0 = initial). Reactive. */
  readonly version: number;
  /** Epoch of the current state (owner: at last flush; replica: from snapshot). */
  readonly epoch: number;
  /** A cached derivation of the state. */
  select<R>(selector: (state: DeepReadonly<S>) => R): Derived<R>;
  getSnapshot(): StoreSnapshot<S>;
}

export interface OwnerStore<S, A> extends StoreBase<S> {
  readonly mode: 'owner';
  readonly actions: OwnerActions<A>;
  /** Run an intent from a replica (`SF-DATA-040` for unknown actions). */
  dispatch(intent: StoreIntent): Result<unknown>;
  /** Replace the whole state (rehydrate from archive/handoff). Recorded as a root `replace` patch. */
  applySnapshot(snapshot: StoreSnapshot<S> | { readonly state: S }): Result<void>;
  /** Apply external ops as one recorded change. */
  applyPatches(input: readonly PatchOp[] | PatchMessage): Result<void>;
  /** Listener for every flushed message. */
  onPatches(listener: (message: PatchMessage) => void): () => void;
  /** Messages after `version` from the ring buffer (`SF-DATA-047` if expired). */
  patchesSince(version: number): Result<readonly PatchMessage[]>;
}

export interface ReplicaStore<S, A> extends StoreBase<S> {
  readonly mode: 'replica';
  /** Writes become intents handed to the sink (I-9). */
  readonly actions: ReplicaActions<A>;
  /** True after the first snapshot. Reactive. */
  readonly synced: boolean;
  applySnapshot(snapshot: StoreSnapshot<S>): Result<void>;
  /** Apply the owner's next message. Duplicates are ignored; gaps/epoch changes are errors. */
  applyPatches(message: PatchMessage): Result<void>;
}

export interface OwnerOptions<S> {
  readonly epoch?: EpochSource;
  readonly telemetry?: Telemetry;
  /** Start from this state instead of `initial()` (validated). */
  readonly state?: S;
  /** Current trace context for messages (e.g. the active span's traceparent). */
  readonly traceparent?: () => string | undefined;
  /** Patch ring buffer size. Default 256. */
  readonly historyLimit?: number;
}

export interface ReplicaOptions {
  /** Receives intents for the owner. Without a sink, replica writes fail with `SF-WK-002`. */
  readonly sink?: (intent: StoreIntent) => void;
  readonly telemetry?: Telemetry;
  readonly traceparent?: () => string | undefined;
}

export interface StoreDefinition<S, A extends ActionMap<S>> {
  readonly kind: 'store';
  readonly id: TokenId;
  readonly version: number;
  readonly schema: Schema<S>;
  readonly initial: () => S;
  readonly actions: A;
  create(options?: OwnerOptions<S>): OwnerStore<S, A>;
  replica(options?: ReplicaOptions): ReplicaStore<S, A>;
}

export interface StoreInit<S, A extends ActionMap<S>> {
  readonly id: TokenId;
  /** Schema version; bump on incompatible state changes. */
  readonly version: number;
  readonly schema: Schema<S>;
  readonly initial: () => S;
  readonly actions: A;
}

function freezeValidated<S>(schema: Schema<S>, value: S): Result<S> {
  const validated = schema.validate(value);
  if (!validated.ok) return validated;
  try {
    return ok(deepFreeze(clonePlain(validated.value)));
  } catch (error) {
    return err(toSfError(error));
  }
}

/** Merge objects keeping getters live (object spread would snapshot them). */
function withGetters<A extends object, B extends object>(target: A, extra: B): A & B {
  return Object.defineProperties(target, Object.getOwnPropertyDescriptors(extra)) as A & B;
}

function isThenable(value: unknown): boolean {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

export function defineStore<S, const A extends ActionMap<S>>(init: StoreInit<S, A>): StoreDefinition<S, A> {
  const { id, schema } = init;
  const schemaVersion = init.version;
  const actionNames = Object.keys(init.actions);

  const initialState = (): S => {
    const result = freezeValidated(schema, init.initial());
    if (!result.ok) throw result.error;
    return result.value;
  };

  const base = (stateBox: { get(): S }, versionBox: { get(): number }, epochOf: () => number) => ({
    id,
    schemaVersion,
    get state() {
      return stateBox.get() as DeepReadonly<S>;
    },
    get version() {
      return versionBox.get();
    },
    get epoch() {
      return epochOf();
    },
    select<R>(selector: (state: DeepReadonly<S>) => R): Derived<R> {
      return derived(() => selector(stateBox.get() as DeepReadonly<S>));
    },
    getSnapshot(): StoreSnapshot<S> {
      return untracked(() => ({ format: STORE_FORMAT, storeId: id, schemaVersion, epoch: epochOf(), version: versionBox.get(), state: stateBox.get() }));
    },
  });

  const checkHeader = (header: { storeId: TokenId; schemaVersion: number; format?: number }): Result<void> => {
    if (header.storeId !== id || header.schemaVersion !== schemaVersion || (header.format !== undefined && header.format !== STORE_FORMAT)) {
      return err(StoreSchemaVersionError({ details: { storeId: id, schemaVersion, received: { storeId: header.storeId, schemaVersion: header.schemaVersion } } }));
    }
    return ok();
  };

  return {
    kind: 'store',
    id,
    version: schemaVersion,
    schema,
    initial: init.initial,
    actions: init.actions,

    create(options = {}): OwnerStore<S, A> {
      const telemetry = options.telemetry ?? createNoopTelemetry();
      const epochSource = options.epoch ?? FIXED_EPOCH;
      const historyLimit = options.historyLimit ?? 256;
      let start = initialState();
      if (options.state !== undefined) {
        const provided = freezeValidated(schema, options.state);
        if (!provided.ok) throw provided.error;
        start = provided.value;
      }
      const stateBox = box<S>(start, Object.is);
      const versionBox = box(0);
      let flushedEpoch = untracked(() => epochSource.current);
      const listeners = new Set<(message: PatchMessage) => void>();
      const history: PatchMessage[] = [];
      let current: Transaction<S> | undefined;

      const flush = (action: string, next: S, patches: readonly PatchOp[]): void => {
        if (patches.length === 0) return;
        const version = untracked(() => versionBox.get()) + 1;
        flushedEpoch = untracked(() => epochSource.current);
        const traceparent = options.traceparent?.();
        const message: PatchMessage = {
          format: STORE_FORMAT,
          storeId: id,
          schemaVersion,
          epoch: flushedEpoch,
          version,
          action,
          patches,
          ...(traceparent === undefined ? {} : { traceparent }),
        };
        batch(() => {
          stateBox.set(next);
          versionBox.set(version);
        });
        history.push(message);
        if (history.length > historyLimit) history.shift();
        telemetry.record(DataMetrics.storePatches, patches.length, { store: id, action });
        telemetry.event('store.flush', { subsystem: DATA_SUBSYSTEMS.store, level: 'verbose', attrs: { store: id, action, version, ops: patches.length } });
        for (const listener of listeners) listener(message);
      };

      /** Run `fn` inside the (possibly shared) transaction; outermost call flushes. */
      const run = <R>(action: string, fn: (draft: S) => R): Result<R> => {
        if (current !== undefined) {
          // Nested action: share the outer transaction; errors propagate to the outermost action.
          return ok(fn(current.draft));
        }
        const transaction = createTransaction(untracked(() => stateBox.get()), schema as Schema<unknown>);
        current = transaction;
        let result: R;
        try {
          result = fn(transaction.draft);
          if (isThenable(result)) throw ActionFailedError({ message: `Store action "${action}" returned a promise; actions must be synchronous.` });
        } catch (error) {
          transaction.revoke();
          current = undefined;
          const sf = error instanceof SfError ? error : ActionFailedError({ cause: error, details: { store: id, action } });
          telemetry.event('store.action-failed', { subsystem: DATA_SUBSYSTEMS.store, level: 'critical', attrs: { store: id, action, code: sf.code } });
          return err(sf);
        }
        current = undefined;
        flush(action, transaction.commit(), transaction.patches);
        return ok(result);
      };

      const actions = Object.fromEntries(
        actionNames.map((name) => {
          const fn = init.actions[name] as ActionFn<S>;
          return [name, (...args: unknown[]) => run(name, (draft) => fn(draft, ...args))];
        }),
      ) as unknown as OwnerActions<A>;

      const applyOps = (action: string, ops: readonly PatchOp[]): Result<void> => {
        if (current !== undefined) return err(ActionFailedError({ message: 'Cannot apply patches inside an action.' }));
        const applied = applyPatchOps(untracked(() => stateBox.get()), ops, schema as Schema<unknown>);
        if (!applied.ok) return applied;
        // Messages carry their own frozen copies (callers may keep mutating their op objects).
        flush(action, applied.value, ops.map((op) => (op.op === 'remove' ? op : { ...op, value: deepFreeze(clonePlain(op.value)) })));
        return ok();
      };

      return withGetters(base(stateBox, versionBox, () => flushedEpoch), {
        mode: 'owner' as const,
        actions,
        dispatch(intent) {
          if (intent.storeId !== id) return err(StoreSchemaVersionError({ details: { storeId: id, received: { storeId: intent.storeId } } }));
          if (!Object.hasOwn(init.actions, intent.action)) {
            return err(UnknownActionError({ details: { store: id, action: intent.action, known: actionNames } }));
          }
          const fn = init.actions[intent.action] as ActionFn<S>;
          return run(intent.action, (draft) => fn(draft, ...intent.args));
        },
        applySnapshot(snapshot) {
          if ('storeId' in snapshot) {
            const header = checkHeader(snapshot);
            if (!header.ok) return header;
          }
          const validated = schema.validate(snapshot.state);
          if (!validated.ok) return validated;
          return applyOps('@snapshot', [{ op: 'replace', path: [], value: validated.value }]);
        },
        applyPatches(input) {
          if ('patches' in input) {
            const header = checkHeader(input);
            if (!header.ok) return header;
            return applyOps(input.action, input.patches);
          }
          return applyOps('@patches', input);
        },
        onPatches(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        patchesSince(version) {
          const now = untracked(() => versionBox.get());
          if (version === now) return ok([]);
          if (version > now) return err(PatchGapError({ details: { store: id, requested: version, current: now } }));
          const first = history[0];
          if (first === undefined || first.version > version + 1) {
            return err(PatchHistoryExpiredError({ details: { store: id, requested: version, oldest: first?.version ?? now } }));
          }
          return ok(history.filter((m) => m.version > version));
        },
      } satisfies Omit<OwnerStore<S, A>, keyof StoreBase<S>>);
    },

    replica(options = {}): ReplicaStore<S, A> {
      const telemetry = options.telemetry ?? createNoopTelemetry();
      const stateBox = box<S>(initialState(), Object.is);
      const versionBox = box(0);
      const synced = box(false);
      let epoch = 0;

      const actions = Object.fromEntries(
        actionNames.map((name) => [
          name,
          (...args: unknown[]): Result<void> => {
            if (options.sink === undefined) return err(ReplicaWriteError({ details: { store: id, action: name } }));
            let cloned: unknown[];
            try {
              cloned = clonePlain(args);
            } catch (error) {
              return err(toSfError(error));
            }
            const traceparent = options.traceparent?.();
            options.sink({
              format: STORE_FORMAT,
              storeId: id,
              action: name,
              args: cloned,
              baseVersion: untracked(() => versionBox.get()),
              ...(traceparent === undefined ? {} : { traceparent }),
            });
            telemetry.event('store.intent', { subsystem: DATA_SUBSYSTEMS.store, level: 'verbose', attrs: { store: id, action: name } });
            return ok();
          },
        ]),
      ) as unknown as ReplicaActions<A>;

      return withGetters(base(stateBox, versionBox, () => epoch), {
        mode: 'replica' as const,
        actions,
        get synced() {
          return synced.get();
        },
        applySnapshot(snapshot) {
          const header = checkHeader(snapshot);
          if (!header.ok) return header;
          const state = freezeValidated(schema, snapshot.state);
          if (!state.ok) return state;
          epoch = snapshot.epoch;
          batch(() => {
            stateBox.set(state.value);
            versionBox.set(snapshot.version);
            synced.set(true);
          });
          return ok();
        },
        applyPatches(message) {
          const header = checkHeader(message);
          if (!header.ok) return header;
          const version = untracked(() => versionBox.get());
          if (!untracked(() => synced.get())) return err(PatchGapError({ message: 'Replica has no snapshot yet.', details: { store: id, current: version, received: message.version } }));
          if (message.epoch !== epoch) return err(EpochMismatchError({ details: { store: id, epoch, received: message.epoch } }));
          if (message.version <= version) return ok();
          if (message.version !== version + 1) return err(PatchGapError({ details: { store: id, current: version, received: message.version } }));
          // Replication path: schema was enforced by the owner; skip re-validation.
          const applied = applyPatchOps(untracked(() => stateBox.get()), message.patches);
          if (!applied.ok) return applied;
          batch(() => {
            stateBox.set(applied.value);
            versionBox.set(message.version);
          });
          return ok();
        },
      } satisfies Omit<ReplicaStore<S, A>, keyof StoreBase<S>>);
    },
  };
}
