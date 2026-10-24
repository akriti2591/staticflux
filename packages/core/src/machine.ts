/**
 * Typed finite state machines. Every lifecycle in StaticFlux (app, subsystem,
 * worker, unit, feature, navigation, surface, session, slice, reservation) is
 * defined as data with `defineMachine` and run with `createMachine`.
 *
 * Transitions not listed are invalid: `send()` returns an error result and
 * emits telemetry; the state does not change. See docs/LIFECYCLES.md.
 */
import { defineError } from './errors.js';
import { box } from './reactivity.js';
import { err, ok, type Result } from './result.js';

export interface MachineDefinition<S extends string, E extends string> {
  readonly id: string;
  readonly initial: S;
  readonly states: readonly S[];
  /** transitions[state][event] = next state */
  readonly transitions: { readonly [K in S]?: { readonly [Ev in E]?: S } };
  /** States with no outgoing transitions are terminal; listed explicitly for documentation. */
  readonly terminal?: readonly S[];
}

/** Identity function that preserves literal state/event types. */
/* @__NO_SIDE_EFFECTS__ */
export function defineMachine<const S extends string, const E extends string>(
  definition: MachineDefinition<S, E>,
): MachineDefinition<S, E> {
  return definition;
}

export const InvalidTransitionError = defineError(
  'SF-CORE-010',
  'invariant',
  'An event was sent that is not valid in the current state.',
  'Check `machine.can(event)` first, or consult docs/LIFECYCLES.md for the valid transitions of this machine.',
);

export interface TransitionRecord<S extends string, E extends string> {
  readonly machine: string;
  readonly from: S;
  readonly to: S;
  readonly event: E;
}

export interface Machine<S extends string, E extends string> {
  readonly id: string;
  /** Current state. Reactive (reads are tracked). */
  readonly state: S;
  can(event: E): boolean;
  send(event: E): Result<S>;
  /** Listener for every successful transition. Returns an unsubscribe function. */
  onTransition(listener: (record: TransitionRecord<S, E>) => void): () => void;
  /** True when the current state is one of `states`. Reactive. */
  is(...states: readonly S[]): boolean;
}

export interface MachineOptions<S extends string, E extends string> {
  readonly initial?: S;
  readonly onInvalid?: (state: S, event: E) => void;
}

export function createMachine<S extends string, E extends string>(
  definition: MachineDefinition<S, E>,
  options: MachineOptions<S, E> = {},
): Machine<S, E> {
  const current = box<S>(options.initial ?? definition.initial);
  const listeners = new Set<(record: TransitionRecord<S, E>) => void>();
  const nextOf = (state: S, event: E): S | undefined => definition.transitions[state]?.[event];
  return {
    id: definition.id,
    get state() {
      return current.get();
    },
    can(event) {
      return nextOf(current.get(), event) !== undefined;
    },
    is(...states) {
      return states.includes(current.get());
    },
    send(event) {
      const from = current.get();
      const to = nextOf(from, event);
      if (to === undefined) {
        options.onInvalid?.(from, event);
        return err(
          InvalidTransitionError({
            message: `Machine "${definition.id}": event "${event}" is not valid in state "${from}".`,
            details: { machine: definition.id, state: from, event },
          }),
        );
      }
      current.set(to);
      const record = { machine: definition.id, from, to, event };
      for (const listener of listeners) listener(record);
      return ok(to);
    },
    onTransition(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
