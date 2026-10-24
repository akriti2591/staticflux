/**
 * Event replay: user events on an island BEFORE it is hydrated are captured (capture phase on
 * the island element), queued, and re-dispatched on their original targets after `hydrate()`
 * resolved — so the first click/keystroke is never lost to a slow chunk.
 *
 * - Captured by default: `click`, `input`, `change`, `submit`, `keydown`.
 * - `submit` is `preventDefault()`ed while queued (no full-page navigation before the handler
 *   exists); everything else keeps its native default (typing still types, links still work
 *   without JS). Override with `preventDefault`.
 * - Events inside a NESTED island belong to that island only.
 * - Replayed events are fresh clones (`new Ctor(type, original)`), marked for `isReplayedEvent`.
 *   A target that left the DOM (or the island) is dropped. The queue is bounded (`maxQueued`).
 */
import { closestIsland } from './marker.js';
import { isReplayedEvent, markReplayed } from './island.js';

export const REPLAY_EVENTS = ['click', 'input', 'change', 'submit', 'keydown'] as const;
/** First interaction that triggers `hydrate="interaction"` islands. */
export const INTERACTION_EVENTS = ['pointerdown', 'touchstart', 'focusin', 'keydown', 'click', 'input'] as const;
/** Intent signals that preload (not execute) an `interaction` island's chunk (R12.3 speculative). */
export const WARM_EVENTS = ['pointerover', 'focusin'] as const;

export interface ReplayOptions {
  readonly events?: readonly string[];
  /** Max queued events per island (oldest kept). Default 32. */
  readonly maxQueued?: number;
  /** Default: `event.type === 'submit'`. */
  readonly preventDefault?: (event: Event) => boolean;
}

export interface ReplayOutcome {
  readonly replayed: readonly string[];
  readonly dropped: number;
}

export interface EventReplay {
  readonly queued: number;
  /** Stop capturing and re-dispatch the queue in order. */
  replay(): ReplayOutcome;
  /** Stop capturing and drop the queue. Returns the number dropped. */
  discard(): number;
}

interface Queued {
  readonly event: Event;
  readonly target: EventTarget | null;
}

const defaultPreventDefault = (event: Event): boolean => event.type === 'submit';

export function cloneEvent(event: Event): Event {
  const Ctor = event.constructor as new (type: string, init?: EventInit) => Event;
  try {
    return new Ctor(event.type, event as unknown as EventInit);
  } catch {
    return new Event(event.type, { bubbles: event.bubbles, cancelable: event.cancelable, composed: event.composed });
  }
}

export function createEventReplay(island: Element, options: ReplayOptions = {}): EventReplay {
  const events = options.events ?? REPLAY_EVENTS;
  const maxQueued = options.maxQueued ?? 32;
  const prevent = options.preventDefault ?? defaultPreventDefault;
  const queue: Queued[] = [];
  let overflow = 0;
  const detach = new AbortController();
  const onEvent = (event: Event): void => {
    if (isReplayedEvent(event)) return;
    const target = event.target as Node | null;
    if (closestIsland(target) !== island) return;
    if (prevent(event)) event.preventDefault();
    if (queue.length >= maxQueued) {
      overflow += 1;
      return;
    }
    queue.push({ event, target: event.target });
  };
  for (const type of events) island.addEventListener(type, onEvent, { capture: true, signal: detach.signal });

  return {
    get queued() {
      return queue.length;
    },
    replay() {
      detach.abort();
      const replayed: string[] = [];
      let dropped = overflow;
      for (const { event, target } of queue.splice(0)) {
        const node = target as Node | null;
        if (node === null || !node.isConnected || !island.contains(node)) {
          dropped += 1;
          continue;
        }
        const copy = cloneEvent(event);
        markReplayed(copy);
        node.dispatchEvent(copy);
        replayed.push(event.type);
      }
      overflow = 0;
      return { replayed, dropped };
    },
    discard() {
      detach.abort();
      const dropped = queue.length + overflow;
      queue.length = 0;
      overflow = 0;
      return dropped;
    },
  };
}
