import { createInjector, createScope, effect } from '@staticflux/core';
import { describe, expect, it, vi } from 'vitest';
import { bindBusy, busyAttributes, busyCount, markBusy } from './busy.js';
import { browserA11yEnvironment, defaultTimers } from './env.js';
import { createPreferenceFacts, PREFERENCE_DEFAULTS } from './preferences.js';
import {
  a11yEnvironmentUnit,
  AnnouncerToken,
  announcerUnit,
  browserA11yEnvironmentUnit,
  FocusManagerToken,
  focusManagerUnit,
  PreferenceFactsToken,
  preferenceFactsUnit,
  ShortcutRegistryToken,
  shortcutRegistryUnit,
} from './index.js';
import { defineShortcut } from './shortcuts.js';

interface FakeList extends MediaQueryList {
  set(matches: boolean): void;
}

function fakeMatchMedia(initial: Record<string, boolean>, legacy = false): ((q: string) => MediaQueryList) & { lists: Map<string, FakeList> } {
  const lists = new Map<string, FakeList>();
  const fn = (query: string): MediaQueryList => {
    if (query.includes('reduced-transparency')) throw new SyntaxError('unsupported');
    let list = lists.get(query);
    if (list === undefined) {
      const listeners = new Set<() => void>();
      let matches = initial[query] ?? false;
      const base = {
        media: query,
        get matches() {
          return matches;
        },
        onchange: null,
        set(next: boolean) {
          matches = next;
          for (const l of listeners) l();
        },
        dispatchEvent: () => true,
        addListener: (l: () => void) => listeners.add(l),
        removeListener: (l: () => void) => listeners.delete(l),
      };
      list = (legacy
        ? base
        : { ...base, addEventListener: (_: string, l: () => void) => listeners.add(l), removeEventListener: (_: string, l: () => void) => listeners.delete(l) }) as unknown as FakeList;
      Object.defineProperty(list, 'matches', { get: () => matches });
      Object.defineProperty(list, 'listenerCount', { get: () => listeners.size });
      lists.set(query, list);
    }
    return list;
  };
  return Object.assign(fn, { lists });
}

describe('preference facts', () => {
  it('reads initial values and reacts to changes', async () => {
    const mm = fakeMatchMedia({ '(prefers-reduced-motion: reduce)': true, '(prefers-color-scheme: dark)': true });
    const facts = createPreferenceFacts({ matchMedia: mm });
    expect(facts.supported).toBe(true);
    expect(facts.snapshot()).toEqual({ reducedMotion: true, contrast: 'no-preference', forcedColors: false, colorScheme: 'dark', reducedTransparency: false });
    const seen: string[] = [];
    const stop = effect(() => {
      seen.push(facts.contrast);
    });
    mm.lists.get('(prefers-contrast: more)')?.set(true);
    expect(facts.contrast).toBe('more');
    mm.lists.get('(forced-colors: active)')?.set(true);
    expect(facts.forcedColors).toBe(true);
    mm.lists.get('(prefers-reduced-motion: reduce)')?.set(false);
    expect(facts.reducedMotion).toBe(false);
    expect(seen).toEqual(['no-preference', 'more']);
    stop();
    await facts.dispose();
    mm.lists.get('(prefers-contrast: more)')?.set(false);
    expect(facts.contrast).toBe('more'); // listeners removed
  });

  it('supports legacy addListener and scope-bound disposal', async () => {
    const mm = fakeMatchMedia({}, true);
    const scope = createScope('app');
    const facts = createPreferenceFacts({ matchMedia: mm, scope });
    mm.lists.get('(prefers-color-scheme: dark)')?.set(true);
    expect(facts.colorScheme).toBe('dark');
    await scope.dispose();
    mm.lists.get('(prefers-color-scheme: dark)')?.set(false);
    expect(facts.colorScheme).toBe('dark');
  });

  it('keeps safe defaults without matchMedia', () => {
    const facts = createPreferenceFacts({ matchMedia: undefined });
    expect(facts.supported).toBe(false);
    expect(facts.snapshot()).toEqual(PREFERENCE_DEFAULTS);
  });
});

describe('aria-busy helpers', () => {
  it('ref-counts busy marks', async () => {
    const el = document.createElement('section');
    const a = markBusy(el);
    const scope = createScope('loader');
    markBusy(el, scope);
    expect(el.getAttribute('aria-busy')).toBe('true');
    expect(busyCount(el)).toBe(2);
    a();
    a();
    expect(el.getAttribute('aria-busy')).toBe('true');
    await scope.dispose();
    expect(el.hasAttribute('aria-busy')).toBe(false);
    expect(busyCount(el)).toBe(0);
    expect(busyAttributes(true)).toEqual({ 'aria-busy': 'true' });
    expect(busyAttributes(false)).toEqual({ 'aria-busy': 'false' });
  });

  it('binds to a reactive condition', async () => {
    const { box } = await import('@staticflux/core');
    const pending = box(true);
    const el = document.createElement('div');
    const scope = createScope('c');
    bindBusy(el, () => pending.get(), scope);
    expect(el.getAttribute('aria-busy')).toBe('true');
    pending.set(false);
    expect(el.hasAttribute('aria-busy')).toBe(false);
    pending.set(true);
    expect(el.getAttribute('aria-busy')).toBe('true');
    await scope.dispose();
    expect(el.hasAttribute('aria-busy')).toBe(false);
    pending.set(true);
    expect(el.hasAttribute('aria-busy')).toBe(false);
  });
});

describe('environment and DI units', () => {
  it('detects the browser environment', () => {
    const env = browserA11yEnvironment();
    expect(env.document).toBe(document);
    expect(typeof env.isMac).toBe('boolean');
    const mac = browserA11yEnvironment({ navigator: { platform: 'MacIntel' } } as unknown as typeof globalThis);
    expect(mac).toMatchObject({ document: undefined, matchMedia: undefined, isMac: true });
    const handle = defaultTimers.set(() => undefined, 10);
    defaultTimers.clear(handle);
  });

  it('wires every service from one environment', async () => {
    const mm = fakeMatchMedia({ '(prefers-reduced-motion: reduce)': true });
    const injector = createInjector({
      units: [
        a11yEnvironmentUnit({ document, matchMedia: mm, timers: defaultTimers, isMac: false }),
        focusManagerUnit,
        announcerUnit({ debounceMs: { polite: 0 } }),
        shortcutRegistryUnit,
        preferenceFactsUnit,
      ],
    });
    const prefs = await injector.get(PreferenceFactsToken);
    expect(prefs.ok && prefs.value.reducedMotion).toBe(true);
    const announcer = await injector.get(AnnouncerToken);
    if (announcer.ok) announcer.value.announce('Saved');
    expect(document.querySelector('[data-sf-live-region="polite"]')?.textContent).toBe('Saved');
    const shortcuts = await injector.get(ShortcutRegistryToken);
    const handler = vi.fn();
    if (shortcuts.ok) shortcuts.value.register(defineShortcut({ id: 'shell/palette', keys: ['Mod+K'], description: 'x' }), handler);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    expect(handler).toHaveBeenCalledTimes(1); // attached to the document
    const focus = await injector.get(FocusManagerToken);
    expect(focus.ok).toBe(true);
    await injector.dispose();
    expect(document.querySelector('[data-sf-live-region]')).toBeNull();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('browser environment unit resolves; headless registry does not attach', async () => {
    const injector = createInjector({
      units: [browserA11yEnvironmentUnit, shortcutRegistryUnit],
    });
    expect((await injector.get(ShortcutRegistryToken)).ok).toBe(true);
    const headless = createInjector({
      units: [a11yEnvironmentUnit({ document: undefined, matchMedia: undefined, timers: defaultTimers, isMac: false }), shortcutRegistryUnit],
    });
    expect((await headless.get(ShortcutRegistryToken)).ok).toBe(true);
  });
});
