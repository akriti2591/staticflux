import { describe, expect, it, vi } from 'vitest';
import { browserIslandEnv, cloneEvent, createEventReplay, defaultAfterFrame, intersectionVisibility, isReplayedEvent, measureIsland } from './index.js';

class FakeIO {
  static instances: FakeIO[] = [];
  readonly observed = new Set<Element>();
  readonly options: { rootMargin?: string } | undefined;
  constructor(readonly callback: (entries: readonly { isIntersecting: boolean; target: Element }[]) => void, options?: { rootMargin?: string }) {
    this.options = options;
    FakeIO.instances.push(this);
  }
  observe(target: Element): void {
    this.observed.add(target);
  }
  unobserve(target: Element): void {
    this.observed.delete(target);
  }
  fire(target: Element, isIntersecting = true): void {
    this.callback([{ isIntersecting, target }]);
  }
}

describe('intersectionVisibility', () => {
  it('shares one observer, fires once per element, unobserves, honours abort', () => {
    FakeIO.instances = [];
    const trigger = intersectionVisibility(FakeIO, '100px');
    const a = document.createElement('div');
    const b = document.createElement('div');
    const onA = vi.fn();
    const onB = vi.fn();
    const cancelB = new AbortController();
    trigger(a, onA, new AbortController().signal);
    trigger(b, onB, cancelB.signal);
    expect(FakeIO.instances).toHaveLength(1);
    const io = FakeIO.instances[0] as FakeIO;
    expect(io.options).toEqual({ rootMargin: '100px' });
    io.fire(a, false);
    expect(onA).not.toHaveBeenCalled();
    io.fire(a);
    io.fire(a);
    expect(onA).toHaveBeenCalledTimes(1);
    expect(io.observed.has(a)).toBe(false);
    cancelB.abort();
    expect(io.observed.has(b)).toBe(false);
    io.fire(b);
    expect(onB).not.toHaveBeenCalled();
    const aborted = new AbortController();
    aborted.abort();
    trigger(a, onA, aborted.signal);
    expect(io.observed.has(a)).toBe(false);
  });
});

describe('measureIsland', () => {
  it('measures the element, or the union of its children when it is display: contents (0×0)', () => {
    const host = document.createElement('sf-island');
    const c1 = document.createElement('div');
    const c2 = document.createElement('div');
    host.append(c1, c2);
    const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 0, 0));
    vi.spyOn(c1, 'getBoundingClientRect').mockReturnValue(rect(10, 10, 100, 20));
    vi.spyOn(c2, 'getBoundingClientRect').mockReturnValue(rect(10, 30, 50, 30));
    expect(measureIsland(host)).toEqual({ width: 100, height: 50 });
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 7, 8));
    expect(measureIsland(host)).toEqual({ width: 7, height: 8 });
    expect(measureIsland(document.createElement('div'))).toEqual({ width: 0, height: 0 });
  });
});

describe('browser defaults', () => {
  it('feature-detects the seams', () => {
    const env = browserIslandEnv();
    expect(typeof env.idle).toBe('function');
    expect(typeof env.now()).toBe('number');
  });

  it('defaultAfterFrame runs after a frame unless aborted', async () => {
    const ran = vi.fn();
    const skipped = vi.fn();
    const controller = new AbortController();
    defaultAfterFrame(ran, new AbortController().signal);
    defaultAfterFrame(skipped, controller.signal);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ran).toHaveBeenCalledTimes(1);
    expect(skipped).not.toHaveBeenCalled();
  });
});

describe('event replay primitives', () => {
  it('cloneEvent keeps type and init fields', () => {
    const original = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    const copy = cloneEvent(original) as KeyboardEvent;
    expect(copy).not.toBe(original);
    expect(copy.type).toBe('keydown');
    expect(copy.key).toBe('Enter');
    expect(copy.bubbles).toBe(true);
  });

  it('discard() stops capturing and reports the dropped count; custom preventDefault', () => {
    const island = document.createElement('sf-island');
    island.setAttribute('chunk', 'feature:x');
    const button = document.createElement('button');
    island.append(button);
    document.body.append(island);
    const replay = createEventReplay(island, { events: ['click'], preventDefault: (e) => e.type === 'click' });
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    button.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(replay.queued).toBe(1);
    expect(replay.discard()).toBe(1);
    button.click();
    expect(replay.queued).toBe(0);
    expect(replay.replay()).toEqual({ replayed: [], dropped: 0 });
  });

  it('replayed events are marked and not re-captured', () => {
    const island = document.createElement('sf-island');
    island.setAttribute('chunk', 'feature:x');
    const button = document.createElement('button');
    island.append(button);
    document.body.append(island);
    const seen: boolean[] = [];
    button.addEventListener('click', (e) => seen.push(isReplayedEvent(e)));
    const replay = createEventReplay(island);
    button.click();
    const outcome = replay.replay();
    expect(outcome).toEqual({ replayed: ['click'], dropped: 0 });
    expect(seen).toEqual([false, true]);
  });
});
