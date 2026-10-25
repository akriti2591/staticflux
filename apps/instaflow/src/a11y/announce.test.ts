// @vitest-environment node
import type { Timers } from '@staticflux/a11y';
import { box, createScope } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { createViewState } from '../tools/view-state.js';
import { ANNOUNCE_DEBOUNCE_MS, createSelectionAnnouncer, type Describe, SelectionAnnounceLifecycle, selectionMessage } from './announce.js';

/** Manual timers: `tick(ms)` runs what is due. */
function fakeTimers(): Timers & { tick(ms: number): void; readonly pending: number } {
  let now = 0;
  let serial = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  return {
    set(fn, ms) {
      serial += 1;
      due.set(serial, { at: now + ms, fn });
      return serial;
    },
    clear(handle) {
      due.delete(handle as number);
    },
    tick(ms) {
      now += ms;
      for (const [id, t] of [...due].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at > now) continue;
        due.delete(id);
        t.fn();
      }
    },
    get pending() {
      return due.size;
    },
  };
}

const names: Record<string, string> = { a: 'Logo', b: 'Title', g: 'Card' };
const describeNode: Describe = (id) => ({ id, name: names[id] ?? id, role: { role: 'img', roleDescription: 'rectangle' }, extra: id === 'b' ? ['instance 2 of 4'] : [] });

describe('selection announcements', () => {
  it('builds the sentence for none, one, many and an entered container', () => {
    const view = createViewState({ tab: 't', root: 'p1' });
    expect(selectionMessage(view, describeNode)).toBe('Selection cleared');
    view.select(['a']);
    expect(selectionMessage(view, describeNode)).toBe('Logo, rectangle, selected');
    view.select(['b']);
    expect(selectionMessage(view, describeNode)).toBe('Title, rectangle, instance 2 of 4, selected');
    view.select(['a', 'b']);
    expect(selectionMessage(view, describeNode)).toBe('2 elements selected');
    view.setContext('g');
    view.select(['a']);
    expect(selectionMessage(view, describeNode, true)).toBe('Inside Card. Logo, rectangle, selected');
    expect(SelectionAnnounceLifecycle.id).toBe('instaflow/a11y-announce');
  });

  it('speaks once, politely, after the quiet period (a burst of Tab presses says only where it stopped)', async () => {
    const view = createViewState({ tab: 't', root: 'p1' });
    const timers = fakeTimers();
    const spoken: [string, unknown][] = [];
    const scope = createScope('announce');
    const a = createSelectionAnnouncer({ view, describe: describeNode, announcer: { announce: (m, o) => spoken.push([m, o?.politeness]) }, timers, scope });
    view.select(['a']);
    view.select(['b']);
    view.select(['a']);
    expect(a.state).toBe('pending');
    timers.tick(ANNOUNCE_DEBOUNCE_MS - 1);
    expect(spoken).toEqual([]);
    timers.tick(1);
    expect(spoken).toEqual([['Logo, rectangle, selected', 'polite']]);
    expect(a.state).toBe('idle');
    view.setContext('g');
    view.select(['b']);
    timers.tick(ANNOUNCE_DEBOUNCE_MS);
    expect(spoken.at(-1)?.[0]).toBe('Inside Card. Title, rectangle, instance 2 of 4, selected');
    view.clear();
    timers.tick(ANNOUNCE_DEBOUNCE_MS);
    expect(spoken.at(-1)?.[0]).toBe('Selection cleared');
    expect(a.spoken).toBe(3);
    await scope.dispose();
    expect(a.state).toBe('disposed');
    view.select(['a']);
    timers.tick(ANNOUNCE_DEBOUNCE_MS);
    expect(a.spoken).toBe(3);
    expect(timers.pending).toBe(0);
  });

  it('holds during a gesture (a live marquee) and says the final selection once it ends', () => {
    const view = createViewState({ tab: 't', root: 'p1' });
    const timers = fakeTimers();
    const gesture = box('idle');
    const spoken: string[] = [];
    const a = createSelectionAnnouncer({ view, describe: describeNode, announcer: { announce: (m) => spoken.push(m) }, timers, busy: () => gesture.get() !== 'idle', debounceMs: 100 });
    view.select(['a']);
    gesture.set('marqueeing');
    expect(a.state).toBe('holding');
    for (let i = 0; i < 20; i++) {
      view.select(i % 2 === 0 ? ['a', 'b'] : ['b']);
      timers.tick(500);
    }
    expect(spoken).toEqual([]);
    gesture.set('idle');
    expect(a.state).toBe('pending');
    timers.tick(100);
    expect(spoken).toEqual(['Title, rectangle, instance 2 of 4, selected']);
    // A gesture that changes nothing says nothing.
    gesture.set('moving');
    gesture.set('idle');
    timers.tick(1000);
    expect(spoken).toHaveLength(1);
    a.dispose();
    a.dispose();
  });
});
