import { createScope } from '@staticflux/core';
import { auditA11y } from '@staticflux/testkit/a11y';
import { compileTheme } from '@staticflux/ui/theme';
import { mountTestRoot, settle } from '@staticflux/ui/testing';
import { html, render } from 'lit';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanPopTheme } from '../theme/clean-pop.js';
import { createDeviceSettings, DEFAULT_DEVICE_SETTINGS, DENSITY_LINES, DEVICE_SETTINGS_KEY, nextDensity, parseDeviceSettings } from './device-settings.js';
import { defineSettings, diagnosticsText, type IfSettingsElement, INSTAFLOW_VERSION, SETTINGS_SECTIONS } from './settings-element.js';
import { HINT_STORAGE_PREFIXES, readShortcutsSnapshot, resetHintsOnDevice, SHORTCUTS_SNAPSHOT_KEY, writeShortcutsSnapshot } from './shortcuts-snapshot.js';

const memory = (): Storage => {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
};

describe('device settings', () => {
  it('default to Standard, follow the system motion, px and hints on; tolerate bad data', () => {
    expect(parseDeviceSettings(null)).toEqual(DEFAULT_DEVICE_SETTINGS);
    expect(parseDeviceSettings('{"density":"pro","motion":"reduce","units":"mm","hints":false}')).toEqual({ density: 'pro', motion: 'reduce', units: 'mm', hints: false });
    expect(parseDeviceSettings('{"density":"huge","units":3}')).toEqual(DEFAULT_DEVICE_SETTINGS);
    expect(parseDeviceSettings('nope')).toEqual(DEFAULT_DEVICE_SETTINGS);
    expect([nextDensity('focus'), nextDensity('standard'), nextDensity('pro')]).toEqual(['standard', 'pro', 'focus']);
    expect(DENSITY_LINES.standard.line).toBe('Your work, with the panels that explain it.');
  });

  it('persist per device, apply to the root (density and motion attributes) and follow other tabs', async () => {
    const storage = memory();
    const listeners: ((e: Event) => void)[] = [];
    const win = { addEventListener: (_: string, fn: (e: Event) => void) => void listeners.push(fn) } as unknown as Window;
    const settings = createDeviceSettings({ storage, window: win });
    const root = document.createElement('div');
    const scope = createScope('settings-test');
    settings.apply(root, scope);
    expect(root.getAttribute('data-sf-density')).toBe('standard');
    expect(root.hasAttribute('data-sf-motion')).toBe(false);
    settings.set({ density: 'pro', motion: 'reduce' });
    expect(JSON.parse(storage.getItem(DEVICE_SETTINGS_KEY) ?? '{}')).toMatchObject({ density: 'pro', motion: 'reduce' });
    expect(root.getAttribute('data-sf-density')).toBe('pro');
    expect(root.getAttribute('data-sf-motion')).toBe('reduce');
    storage.setItem(DEVICE_SETTINGS_KEY, JSON.stringify({ density: 'focus', motion: 'system' }));
    for (const fn of listeners) fn(Object.assign(new Event('storage'), { key: DEVICE_SETTINGS_KEY }));
    expect(settings.current.density).toBe('focus');
    expect(root.hasAttribute('data-sf-motion')).toBe(false);
    scope.dispose();
    const blocked = createDeviceSettings({ storage: { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } }, window: null });
    blocked.set({ units: 'in' });
    expect(blocked.current.units).toBe('in');
  });
});

describe('shortcuts snapshot and reset hints', () => {
  it('round-trips Studio’s groups and drops malformed rows', () => {
    const storage = memory();
    expect(readShortcutsSnapshot(storage)).toEqual([]);
    writeShortcutsSnapshot(storage, [{ heading: 'Edit', rows: [{ id: 'u', label: 'Undo', keys: ['Mod+Z'] }] }]);
    expect(readShortcutsSnapshot(storage)).toEqual([{ heading: 'Edit', rows: [{ id: 'u', label: 'Undo', keys: ['Mod+Z'] }] }]);
    storage.setItem(SHORTCUTS_SNAPSHOT_KEY, JSON.stringify([{ heading: 'X', rows: [{ id: 1 }] }, 'y', { heading: 'Ok', rows: [{ id: 'a', label: 'A', keys: ['A'] }] }]));
    expect(readShortcutsSnapshot(storage).map((g) => g.heading)).toEqual(['Ok']);
    storage.setItem(SHORTCUTS_SNAPSHOT_KEY, '{');
    expect(readShortcutsSnapshot(storage)).toEqual([]);
  });

  it('Reset hints clears the hint seen store and the first run, nothing else', () => {
    const storage = memory();
    storage.setItem('instaflow/ui/hints/messaging/seen/a', 'true');
    storage.setItem('instaflow/ui/first-run', 'seen');
    storage.setItem('instaflow/ui/files', '{}');
    resetHintsOnDevice(storage, HINT_STORAGE_PREFIXES);
    expect([...Array(storage.length)].map((_, i) => storage.key(i))).toEqual(['instaflow/ui/files']);
  });
});

describe('<if-settings>', () => {
  let dispose: (() => Promise<void>) | undefined;
  beforeAll(() => defineSettings());
  beforeEach(() => localStorage.clear());
  afterEach(async () => {
    await dispose?.();
    dispose = undefined;
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  async function mount(section: (typeof SETTINGS_SECTIONS)[number], storage: { estimate?: () => Promise<{ usage?: number; quota?: number }>; persisted?: () => Promise<boolean>; persist?: () => Promise<boolean> } = {}) {
    const style = document.createElement('style');
    style.textContent = compileTheme(cleanPopTheme);
    document.head.append(style);
    const root = mountTestRoot({ units: [] });
    dispose = () => root.dispose();
    const settings = createDeviceSettings({ storage: localStorage, window: null });
    const events: string[] = [];
    render(
      html`<if-settings
        section=${section}
        .settings=${settings}
        .storage=${storage}
        .shortcuts=${[{ heading: 'Edit', rows: [{ id: 'u', label: 'Undo', keys: ['Mod+Z'] }] }]}
        .userFonts=${['Brand Sans']}
        .diagnostics=${() => 'diag'}
        @if-section=${(e: CustomEvent<{ section: string }>) => events.push(`section:${e.detail.section}`)}
        @if-reset-hints=${() => events.push('reset')}
        @if-open-trash=${() => events.push('trash')}
      ></if-settings>`,
      root.container,
    );
    await settle(4);
    const el = root.container.querySelector('if-settings') as IfSettingsElement;
    await el.updateComplete;
    return { el, shadow: el.shadowRoot as ShadowRoot, settings, events, root };
  }

  it('General: density with the three one-liners and previews; More holds units, motion and hints; every change is saved', async () => {
    const { el, shadow, settings, events, root } = await mount('general');
    expect([...shadow.querySelectorAll('nav a')].map((a) => [a.textContent, a.getAttribute('aria-current')])).toEqual([
      ['General', 'page'],
      ['Keyboard shortcuts', null],
      ['Storage', null],
      ['About', null],
    ]);
    expect([...shadow.querySelectorAll('.density')].map((d) => d.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['Focus Just your work.', 'Standard Your work, with the panels that explain it.', 'Pro Everything, with numbers.']);
    expect(auditA11y(root.container)).toEqual([]);
    (shadow.querySelector('input[value="focus"]') as HTMLInputElement).dispatchEvent(new Event('change'));
    await el.updateComplete;
    expect(settings.current.density).toBe('focus');
    expect(shadow.querySelector('.saved')?.textContent).toBe('Saved on this device');
    (shadow.querySelector('sf-segmented.units') as HTMLElement).dispatchEvent(new CustomEvent('sf-change', { detail: { value: 'in' } }));
    (shadow.querySelector('sf-segmented.motion') as HTMLElement).dispatchEvent(new CustomEvent('sf-change', { detail: { value: 'reduce' } }));
    const hints = shadow.querySelector('input.hints') as HTMLInputElement;
    hints.checked = false;
    hints.dispatchEvent(new Event('change'));
    expect(settings.current).toEqual({ density: 'focus', motion: 'reduce', units: 'in', hints: false });
    (shadow.querySelector('sf-button.reset-hints') as HTMLElement).click();
    await el.updateComplete;
    expect(events).toEqual(['reset']);
    expect(shadow.querySelector('.saved')?.textContent).toBe('Hints and the welcome card will show again.');
    (shadow.querySelector('a[data-section="about"]') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    await el.updateComplete;
    expect(events.at(-1)).toBe('section:about');
    expect(shadow.querySelector('#settings-heading')?.textContent).toBe('About');
  });

  it('Keyboard shortcuts: the cheat sheet over the given groups', async () => {
    const { shadow, root } = await mount('shortcuts');
    expect(shadow.querySelector('#settings-heading')?.textContent).toBe('Keyboard shortcuts');
    expect((shadow.querySelector('sf-shortcut-sheet') as HTMLElement & { groups: unknown[] }).groups).toHaveLength(1);
    expect(auditA11y(root.container)).toEqual([]);
  });

  it('Storage: space used with a bar, persistence and the request on the click, the trash', async () => {
    let asked = 0;
    const { el, shadow, events, root } = await mount('storage', { estimate: async () => ({ usage: 2_500_000, quota: 10_000_000 }), persisted: async () => false, persist: async () => ((asked += 1), false) });
    await settle(2);
    await el.updateComplete;
    expect(shadow.querySelector('.used')?.textContent).toBe('2.5 MB of 10 MB available on this device');
    expect(shadow.querySelector('.bar')?.getAttribute('aria-label')).toBe('25 %');
    expect(shadow.querySelector('.persistence')?.textContent).toBe('This browser may clear your workspace under storage pressure.');
    expect(auditA11y(root.container)).toEqual([]);
    (shadow.querySelector('sf-button.keep') as HTMLElement).click();
    await settle(2);
    await el.updateComplete;
    expect(asked).toBe(1);
    expect(shadow.querySelector('.refused')).not.toBeNull();
    (shadow.querySelector('sf-button.open-trash') as HTMLElement).click();
    expect(events).toEqual(['trash']);
  });

  it('About: version, Copy diagnostics, licences with the fonts you added', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void written.push(t) } });
    const { el, shadow, root } = await mount('about');
    expect(shadow.querySelector('.version')?.textContent).toBe(INSTAFLOW_VERSION);
    expect(shadow.querySelector('.licences')?.textContent).toContain('Lucide');
    expect(shadow.querySelector('.licences')?.textContent).toContain('Brand Sans · Yours');
    expect(auditA11y(root.container)).toEqual([]);
    (shadow.querySelector('sf-button.copy-diagnostics') as HTMLElement).click();
    await settle(2);
    await el.updateComplete;
    expect(written).toEqual(['diag']);
    expect(shadow.querySelector('.saved')?.textContent).toBe('Diagnostics copied');
    const text = diagnosticsText({ surface: 'Studio', density: 'pro', extra: { Pages: '3' } });
    expect(text.split('\n').slice(0, 3)).toEqual([`Instaflow ${INSTAFLOW_VERSION}`, 'Surface: Studio', 'Density: pro']);
    expect(text).toContain('Pages: 3');
  });
});
