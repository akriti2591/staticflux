import { afterEach, describe, expect, it } from 'vitest';
import { createInjector, createTelemetry, token, unit } from '@staticflux/core';
import { createJourneyTracker, JourneyTrackerToken } from '@staticflux/perf';
import { DEBUG_SESSION_KEY, type SessionStoragePort } from './levels.js';
import { defaultShortcut, installDevtools, type DevtoolsInstallation } from './install.js';
import { devtoolsUnits, DevtoolsToken, DevtoolsInstallationToken, DevtoolsStoresToken, inspectStore } from './units.js';
import type { SfDevtoolsElement } from './panel.js';

function memorySession(): SessionStoragePort & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

const installed: DevtoolsInstallation[] = [];
function install(options: Parameters<typeof installDevtools>[0]): DevtoolsInstallation {
  const result = installDevtools({ url: null, session: memorySession(), ...options });
  if (!result.ok) throw result.error;
  installed.push(result.value);
  return result.value;
}

afterEach(async () => {
  for (const i of installed.splice(0)) await i.dispose();
  document.body.innerHTML = '';
});

const key = (init: KeyboardEventInit): KeyboardEvent => new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });

describe('installDevtools', () => {
  it('needs telemetry or an injector', () => {
    const result = installDevtools({});
    expect(!result.ok && result.error.code).toBe('SF-DEV-002');
  });

  it('applies ?sf-debug=… without reload and keeps it for the tab session (R17.14)', () => {
    const telemetry = createTelemetry({ defaultLevel: 'standard' });
    const session = memorySession();
    const first = install({ telemetry, session, url: 'https://studio.test/doc/42?sf-debug=core/di:debug,router/*:verbose', shortcut: false });
    expect(first.debugEntries).toEqual([
      { subsystem: 'core/di', level: 'debug' },
      { subsystem: 'router/*', level: 'verbose' },
    ]);
    expect(telemetry.enabled('core/di', 'debug')).toBe(true);
    expect(telemetry.enabled('router/pipeline', 'verbose')).toBe(true);
    expect(session.data.get(DEBUG_SESSION_KEY)).toBe('core/di:debug,router/*:verbose');

    // next page load in the same tab, no URL flag → session copy
    const telemetry2 = createTelemetry({ defaultLevel: 'standard' });
    const second = install({ telemetry: telemetry2, session, url: 'https://studio.test/', shortcut: false });
    expect(second.debugEntries).toHaveLength(2);
    expect(telemetry2.enabled('core/di', 'debug')).toBe(true);
  });

  it('reports an invalid flag as a critical devtools event and changes nothing', () => {
    const telemetry = createTelemetry({ defaultLevel: 'standard' });
    const i = install({ telemetry, url: '?sf-debug=core/di:shout', shortcut: false });
    expect(i.debugEntries).toEqual([]);
    expect(telemetry.enabled('core/di', 'verbose')).toBe(false);
    const event = i.devtools.collector.events().find((e) => e.name === 'devtools.invalid-debug-flag');
    expect(event?.attrs['code']).toBe('SF-DEV-001');
  });

  it('Ctrl/Cmd+Shift+D toggles a lazily loaded overlay; focus returns on close', async () => {
    const telemetry = createTelemetry();
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    let loads = 0;
    const i = install({
      telemetry,
      loadPanel: async () => {
        loads += 1;
        return import('./panel.js');
      },
    });
    expect(document.querySelector('sf-devtools')).toBeNull();
    expect(loads).toBe(0);
    window.dispatchEvent(key({ key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true }));
    await new Promise((r) => setTimeout(r, 0));
    await i.open(); // idempotent; awaits the in-flight load
    const panel = document.querySelector('sf-devtools') as SfDevtoolsElement;
    expect(panel).not.toBeNull();
    await panel.updateComplete;
    expect(panel.open).toBe(true);
    expect(i.isOpen).toBe(true);
    expect(loads).toBe(1);
    expect(panel.shadowRoot?.activeElement?.id).toBe('sf-dt-tab-boot');

    window.dispatchEvent(key({ key: 'd', code: 'KeyD', metaKey: true, shiftKey: true }));
    await new Promise((r) => setTimeout(r, 0));
    await panel.updateComplete;
    expect(panel.open).toBe(false);
    expect(i.isOpen).toBe(false);
    expect(document.activeElement).toBe(button);

    // unrelated keys are ignored
    window.dispatchEvent(key({ key: 'd', code: 'KeyD', ctrlKey: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(panel.open).toBe(false);
  });

  it('open(tab) selects a tab; Escape inside the panel syncs the installation state', async () => {
    const i = install({ telemetry: createTelemetry(), shortcut: false });
    expect((await i.open('violations')).ok).toBe(true);
    const panel = document.querySelector('sf-devtools') as SfDevtoolsElement;
    await panel.updateComplete;
    expect(panel.tab).toBe('violations');
    panel.shadowRoot?.querySelector('[role="dialog"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
    await panel.updateComplete;
    expect(panel.open).toBe(false);
    expect(i.isOpen).toBe(false);
    expect((await i.toggle()).ok).toBe(true);
    expect(i.isOpen).toBe(true);
  });

  it('appends into a custom container and removes the panel + listener on dispose', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const target = new EventTarget();
    const i = install({ telemetry: createTelemetry(), container: () => container, keyTarget: target, open: true });
    await new Promise((r) => setTimeout(r, 0));
    await i.open();
    expect(container.querySelector('sf-devtools')).not.toBeNull();
    await i.dispose();
    expect(container.querySelector('sf-devtools')).toBeNull();
    const e = key({ key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true });
    target.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it('a failing panel load is SF-DEV-003 and can be retried', async () => {
    let fail = true;
    const i = install({
      telemetry: createTelemetry(),
      shortcut: false,
      loadPanel: async () => {
        if (fail) throw new Error('chunk 404');
        return import('./panel.js');
      },
    });
    const first = await i.open();
    expect(!first.ok && first.error.code).toBe('SF-DEV-003');
    await new Promise((r) => setTimeout(r, 0));
    fail = false;
    expect((await i.open()).ok).toBe(true);
  });

  it('binds sources the injector already resolved, at install and on open', async () => {
    const telemetry = createTelemetry();
    const tracker = createJourneyTracker({ telemetry });
    const injector = createInjector({ telemetry, units: [unit({ id: 'test/tracker', provides: JourneyTrackerToken, scope: 'app', create: () => tracker })] });
    const i = install({ injector, shortcut: false });
    expect(i.devtools.telemetry).toBe(telemetry);
    expect(i.devtools.sources().journeys).toBeUndefined();
    await injector.get(JourneyTrackerToken);
    await i.open();
    expect(i.devtools.sources().journeys).toBe(tracker);
  });

  it('defaultShortcut matches Ctrl/Cmd+Shift+D only', () => {
    expect(defaultShortcut(key({ key: 'D', ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(defaultShortcut(key({ key: 'x', code: 'KeyD', metaKey: true, shiftKey: true }))).toBe(true);
    expect(defaultShortcut(key({ key: 'D', ctrlKey: true, shiftKey: true, altKey: true }))).toBe(false);
    expect(defaultShortcut(key({ key: 'D', shiftKey: true }))).toBe(false);
  });
});

describe('DI units', () => {
  it('devtoolsUnits install the collector, contribute stores and bind the app injector', async () => {
    const telemetry = createTelemetry();
    const StoreToken = token('test/store').type<{ id: string; version: number; epoch: number; getSnapshot(): { state: unknown } }>();
    const AppInjector = (await import('@staticflux/runtime')).AppInjectorToken;
    const injector = createInjector({
      telemetry,
      units: [
        ...devtoolsUnits,
        unit({ id: 'test/store-unit', provides: StoreToken, scope: 'app', create: () => ({ id: 'test/store', version: 1, epoch: 0, getSnapshot: () => ({ state: { ok: true } }) }) }),
        inspectStore(StoreToken),
        unit({ id: 'test/tracker', provides: JourneyTrackerToken, scope: 'app', create: () => createJourneyTracker({ telemetry }) }),
      ],
    });
    // the app injector value (bootApp provides it)
    injector.register(unit({ id: 'test/app-injector', provides: AppInjector, scope: 'app', create: () => injector }));
    await injector.get(JourneyTrackerToken);
    const handle = await injector.get(DevtoolsToken);
    if (!handle.ok) throw handle.error;
    const installation = await injector.get(DevtoolsInstallationToken);
    expect(installation.ok && installation.value.devtools).toBe(handle.value);
    expect(handle.value.views.stores().map((s) => s.id)).toEqual(['test/store']);
    await new Promise((r) => setTimeout(r, 0));
    expect(handle.value.sources().journeys).toBeDefined();
    expect((await injector.get(DevtoolsStoresToken)).ok).toBe(true);
    await injector.dispose();
  });
});
