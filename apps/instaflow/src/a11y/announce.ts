/**
 * Selection announcements (IF-25.12–25.15): a change of the tab's selection or entered container is spoken once
 * through the **polite** live region (`@staticflux/a11y` `Announcer`), after a quiet period, and never while a pointer
 * gesture runs (a marquee changes the selection on every move; a drag must stay silent). The announcement waits for
 * the gesture to end and then says the final state once.
 *
 * Machine `instaflow/a11y-announce` (LIFECYCLES §26): idle → pending (a change) → idle (spoken after `debounceMs`);
 * pending → holding (a gesture started) → pending (it ended); any → disposed.
 *
 * `selectionMessage(view, describe)` is the pure text; `createSelectionAnnouncer` schedules it.
 */
import type { Announcer, Timers } from '@staticflux/a11y';
import { createMachine, defineMachine, type Scope, watch } from '@staticflux/core';
import type { NodeId } from '@staticflux/document/v2';
import type { ViewState } from '../tools/view-state.js';
import { a11yMessages } from './messages.js';
import type { ElementDescription } from './projection.js';

/** Quiet period before a selection change is spoken (Tab held down says only where it stopped). */
export const ANNOUNCE_DEBOUNCE_MS = 300;

export type Describe = (node: NodeId) => ElementDescription | undefined;

/** The sentence for the current selection (and the entered container when it changed). */
export function selectionMessage(view: Pick<ViewState, 'root' | 'selection' | 'context'>, describe: Describe, contextChanged = false): string {
  const parts: string[] = [];
  const inside = contextChanged && view.context !== view.root ? describe(view.context) : undefined;
  if (inside !== undefined) parts.push(a11yMessages.inside(inside.name));
  const only = view.selection.length === 1 ? describe(view.selection[0] as NodeId) : undefined;
  const sentence =
    view.selection.length === 0 ? a11yMessages.cleared : only === undefined ? a11yMessages.selectedMany(view.selection.length) : a11yMessages.selectedOne(only.name, only.role.roleDescription, only.extra.join(', '));
  parts.push(sentence);
  return parts.join('. ');
}

export const SelectionAnnounceLifecycle = /* @__PURE__ */ defineMachine({
  id: 'instaflow/a11y-announce',
  initial: 'idle',
  states: ['idle', 'pending', 'holding', 'disposed'],
  transitions: {
    idle: { change: 'pending', dispose: 'disposed' },
    pending: { change: 'pending', speak: 'idle', hold: 'holding', dispose: 'disposed' },
    holding: { change: 'holding', release: 'pending', dispose: 'disposed' },
  },
});
export type SelectionAnnounceState = (typeof SelectionAnnounceLifecycle.states)[number];

export interface SelectionAnnouncerOptions {
  readonly view: ViewState;
  readonly describe: Describe;
  /** Usually `@staticflux/a11y`'s announcer (polite). */
  readonly announcer: Pick<Announcer, 'announce'>;
  readonly timers: Timers;
  /** True while a pointer gesture runs (B3: `controller.state !== 'idle'`). Reactive reads re-check it. */
  readonly busy?: () => boolean;
  readonly debounceMs?: number;
  readonly scope?: Pick<Scope, 'defer'>;
}

export interface SelectionAnnouncer {
  readonly state: SelectionAnnounceState;
  /** Messages spoken so far (count only; the text is never logged, privacy). */
  readonly spoken: number;
  dispose(): void;
}

/** Speak selection changes politely (see the module header). */
export function createSelectionAnnouncer(options: SelectionAnnouncerOptions): SelectionAnnouncer {
  const { view, timers } = options;
  const busy = options.busy ?? ((): boolean => false);
  const wait = options.debounceMs ?? ANNOUNCE_DEBOUNCE_MS;
  const machine = createMachine(SelectionAnnounceLifecycle);
  let handle: unknown;
  let spoken = 0;
  let contextChanged = false;
  let lastContext = view.context;
  const stopTimer = (): void => {
    if (handle !== undefined) timers.clear(handle);
    handle = undefined;
  };
  const speak = (): void => {
    handle = undefined;
    if (!machine.is('pending')) return;
    machine.send('speak');
    const message = selectionMessage(view, options.describe, contextChanged);
    contextChanged = false;
    spoken += 1;
    options.announcer.announce(message, { politeness: 'polite' });
  };
  const arm = (): void => {
    stopTimer();
    handle = timers.set(speak, wait);
  };
  const onChange = (): void => {
    if (view.context !== lastContext) contextChanged = true;
    lastContext = view.context;
    if (machine.is('disposed')) return;
    machine.send('change');
    if (busy()) {
      if (machine.is('pending')) machine.send('hold');
      stopTimer();
      return;
    }
    arm();
  };
  const onBusy = (isBusy: boolean): void => {
    if (isBusy && machine.is('pending')) {
      machine.send('hold');
      stopTimer();
    } else if (!isBusy && machine.is('holding')) {
      machine.send('release');
      arm();
    }
  };
  const stopSelection = watch(() => [view.selection, view.context], onChange);
  const stopBusy = watch(busy, onBusy);
  const announcer: SelectionAnnouncer = {
    get state() {
      return machine.state;
    },
    get spoken() {
      return spoken;
    },
    dispose() {
      if (machine.is('disposed')) return;
      machine.send('dispose');
      stopTimer();
      stopSelection();
      stopBusy();
    },
  };
  options.scope?.defer(() => announcer.dispose());
  return announcer;
}
