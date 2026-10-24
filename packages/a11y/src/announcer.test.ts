import { createMemorySink, createTelemetry } from '@staticflux/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createAnnouncer, LIVE_REGION_ATTR } from './announcer.js';
import type { Timers } from './env.js';

function manualTimers(): Timers & { advance(ms: number): void; pending(): number } {
  let now = 0;
  let nextId = 1;
  const queue = new Map<number, { at: number; callback: () => void }>();
  return {
    set(callback, ms) {
      const id = nextId++;
      queue.set(id, { at: now + ms, callback });
      return id;
    },
    clear(handle) {
      queue.delete(handle as number);
    },
    advance(ms) {
      now += ms;
      for (const [id, entry] of [...queue.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (entry.at <= now) {
          queue.delete(id);
          entry.callback();
        }
      }
    },
    pending: () => queue.size,
  };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('createAnnouncer', () => {
  it('creates visually-hidden polite/assertive regions lazily', () => {
    const timers = manualTimers();
    const a = createAnnouncer({ document, timers });
    expect(document.querySelectorAll(`[${LIVE_REGION_ATTR}]`)).toHaveLength(0);
    a.announce('Saved');
    timers.advance(150);
    const polite = document.querySelector(`[${LIVE_REGION_ATTR}="polite"]`);
    expect(polite?.getAttribute('role')).toBe('status');
    expect(polite?.getAttribute('aria-live')).toBe('polite');
    expect(polite?.getAttribute('aria-atomic')).toBe('true');
    expect(polite?.getAttribute('style')).toContain('clip');
    expect(a.text('polite')).toBe('Saved');
    a.announce('Error!', { politeness: 'assertive' });
    const assertive = document.querySelector(`[${LIVE_REGION_ATTR}="assertive"]`);
    expect(assertive?.getAttribute('role')).toBe('alert');
    expect(a.text('assertive')).toBe('Error!'); // immediate by default
  });

  it('debounces and coalesces bursts, deduplicating pending messages', () => {
    const timers = manualTimers();
    const a = createAnnouncer({ document, timers });
    a.announce('Saving');
    timers.advance(100);
    a.announce('Saving');
    a.announce('Saved');
    timers.advance(100);
    expect(a.text('polite')).toBe('');
    timers.advance(50);
    expect(a.text('polite')).toBe('Saving Saved');
    a.announce('x', { dedupe: false });
    a.announce('x', { dedupe: false });
    a.flush();
    expect(a.text('polite')).toBe('x x');
  });

  it('re-announces identical text by varying it invisibly', () => {
    const timers = manualTimers();
    const a = createAnnouncer({ document, timers, debounceMs: { polite: 0 } });
    a.announce('Saved');
    a.announce('Saved');
    expect(a.text('polite')).toBe('Saved ');
  });

  it('clears regions after clearAfterMs and ignores blank messages', () => {
    const timers = manualTimers();
    const a = createAnnouncer({ document, timers, clearAfterMs: 1000, debounceMs: { polite: 0 } });
    a.announce('   ');
    expect(timers.pending()).toBe(0);
    a.announce('Hello');
    timers.advance(999);
    expect(a.text('polite')).toBe('Hello');
    timers.advance(1);
    expect(a.text('polite')).toBe('');
    const noClear = createAnnouncer({ document, timers, clearAfterMs: 0, debounceMs: { polite: 0 } });
    noClear.announce('stay');
    expect(timers.pending()).toBe(0);
  });

  it('clear() drops pending, dispose() removes regions and stops announcing', () => {
    const timers = manualTimers();
    const a = createAnnouncer({ document, timers });
    a.announce('one', { politeness: 'assertive' });
    a.announce('two');
    a.clear();
    timers.advance(1000);
    expect(a.text('polite')).toBe('');
    expect(a.text('assertive')).toBe('');
    a.dispose();
    expect(document.querySelectorAll(`[${LIVE_REGION_ATTR}]`)).toHaveLength(0);
    a.announce('late', { politeness: 'assertive' });
    expect(document.querySelectorAll(`[${LIVE_REGION_ATTR}]`)).toHaveLength(0);
    a.dispose();
  });

  it('recreates a region removed from the DOM and supports a custom container', () => {
    const timers = manualTimers();
    const host = document.createElement('section');
    document.body.appendChild(host);
    const a = createAnnouncer({ document, timers, container: host, debounceMs: { polite: 0 } });
    a.announce('first');
    host.innerHTML = '';
    a.announce('second');
    expect(host.querySelector(`[${LIVE_REGION_ATTR}="polite"]`)?.textContent).toBe('second');
  });

  it('is a no-op without a document and never sends message text to telemetry', () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'verbose' });
    telemetry.addSink(sink);
    const headless = createAnnouncer({ document: undefined, debounceMs: { polite: 0 }, telemetry });
    headless.announce('nothing');
    expect(headless.text('polite')).toBe('');
    const a = createAnnouncer({ document, debounceMs: { polite: 0 }, telemetry });
    a.announce('secret document title');
    const event = sink.records.find((r) => r.type === 'event' && r.name === 'a11y.announce');
    expect(event?.type === 'event' && event.attrs).toEqual({ politeness: 'polite', length: 21 });
    a.dispose();
  });
});
