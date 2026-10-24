import { afterEach, describe, expect, it } from 'vitest';
import { createInjector, createTelemetry, metric, type Telemetry, token, unit } from '@staticflux/core';
import { because, createGate, createManualFactSource, definePolicy, definePolicySet, fact, GateFacts, gateResource } from '@staticflux/gate';
import { reportViolation } from '@staticflux/perf';
import { createSupervisor } from '@staticflux/runtime';
import { createDevtools, type Devtools } from './devtools.js';
import { CLOSE_EVENT, definePanel, formatMs, PANEL_TAG, SfDevtoolsElement } from './panel.js';
import { DEVTOOLS_TABS } from './tabs.js';

const A = token('p/a').type<number>();

async function populated(): Promise<{ devtools: Devtools; telemetry: Telemetry }> {
  let t = 0;
  const telemetry = createTelemetry({ defaultLevel: 'debug', now: () => (t += 1) });
  const facts = createManualFactSource('p/facts');
  const gate = createGate({
    policySets: [definePolicySet('p/policies', [definePolicy({ id: 'p/login', resource: gateResource('route', '/studio'), when: because(fact(GateFacts.authenticated).eq(true), 'login') })])],
    sources: [facts],
    telemetry,
  });
  const units = [unit({ id: 'p/a-unit', provides: A, scope: 'app', critical: true, create: () => 1 })];
  const injector = createInjector({ telemetry, units });
  const devtools = createDevtools({
    telemetry,
    injector,
    gate,
    units,
    supervisor: createSupervisor({ telemetry }),
    stores: [{ id: 'p/store', version: 1, epoch: 0, getSnapshot: () => ({ state: { title: 'Doc' } }) }],
    metrics: [metric.counter('p/declared')],
  });
  const boot = telemetry.span('app.boot', { subsystem: 'runtime/app', level: 'critical' });
  await injector.resolveCritical(undefined, boot);
  boot.end();
  const nav = telemetry.span('nav.pipeline', { subsystem: 'router/navigation', attrs: { route: '/studio' } });
  telemetry.span('nav.stage', { subsystem: 'router/pipeline', parent: nav, attrs: { stage: 'match' } }).end();
  nav.end();
  gate.decide('route', '/studio');
  facts.set(GateFacts.authenticated, true);
  reportViolation(telemetry, { code: 'SF-PERF-002', fix: 'Batch layout reads.', feature: 'studio' });
  telemetry.event('lifecycle.worker.spawning→handshaking', { subsystem: 'worker/supervisor', attrs: { worker: 'doc' } });
  telemetry.record(metric.histogram('p/latency', { unit: 'ms' }), 12, { endpoint: 'docs' });
  return { devtools, telemetry };
}

async function mount(devtools: Devtools | undefined, open = true): Promise<SfDevtoolsElement> {
  expect(definePanel().ok).toBe(true);
  const el = document.createElement(PANEL_TAG);
  el.devtools = devtools;
  el.open = open;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

const text = (el: SfDevtoolsElement): string => el.shadowRoot?.textContent?.replace(/\s+/g, ' ') ?? '';
const tabButton = (el: SfDevtoolsElement, tab: string): HTMLElement => el.shadowRoot?.querySelector(`#sf-dt-tab-${tab}`) as HTMLElement;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('<sf-devtools>', () => {
  it('definePanel is idempotent and refuses a foreign owner of the tag', () => {
    expect(definePanel().ok).toBe(true);
    expect(definePanel().ok).toBe(true);
    expect(customElements.get(PANEL_TAG)).toBe(SfDevtoolsElement);
    const registry = { get: () => class extends HTMLElement {}, define: () => undefined } as unknown as CustomElementRegistry;
    const foreign = definePanel(registry);
    expect(!foreign.ok && foreign.error.code).toBe('SF-DEV-003');
  });

  it('renders tablist semantics with a roving tabindex and a labelled tabpanel', async () => {
    const { devtools } = await populated();
    const el = await mount(devtools);
    const tabs = [...(el.shadowRoot?.querySelectorAll('[role="tab"]') ?? [])];
    expect(tabs.map((t) => t.textContent?.trim().replace(/\d+$/, ''))).toEqual(['Boot', 'Journeys', 'Graph', 'Lifecycles', 'Decisions', 'Stores', 'Violations', 'Metrics', 'Settings']);
    expect(tabs.filter((t) => t.getAttribute('aria-selected') === 'true')).toHaveLength(1);
    expect(tabs.filter((t) => t.getAttribute('tabindex') === '0').map((t) => t.id)).toEqual(['sf-dt-tab-boot']);
    const panel = el.shadowRoot?.querySelector('[role="tabpanel"]');
    expect(panel?.getAttribute('aria-labelledby')).toBe('sf-dt-tab-boot');
    expect(tabButton(el, 'boot').getAttribute('aria-controls')).toBe(panel?.id);
    expect(el.shadowRoot?.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('StaticFlux devtools');
    // violation badge
    expect(el.shadowRoot?.querySelector('.badge')?.textContent).toBe('1');
  });

  it('arrow keys / Home / End move between tabs and focus follows', async () => {
    const { devtools } = await populated();
    const el = await mount(devtools);
    const tablist = el.shadowRoot?.querySelector('[role="tablist"]') as HTMLElement;
    const press = async (k: string): Promise<void> => {
      tablist.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      await el.updateComplete;
      await el.updateComplete;
    };
    await press('ArrowRight');
    expect(el.tab).toBe('journeys');
    expect(el.shadowRoot?.activeElement?.id).toBe('sf-dt-tab-journeys');
    await press('ArrowLeft');
    await press('ArrowLeft');
    expect(el.tab).toBe('settings');
    await press('Home');
    expect(el.tab).toBe('boot');
    await press('End');
    expect(el.tab).toBe('settings');
    tabButton(el, 'graph').click();
    await el.updateComplete;
    expect(el.tab).toBe('graph');
  });

  it('renders every tab from the view models', async () => {
    const { devtools } = await populated();
    const el = await mount(devtools);
    const expectations: Record<(typeof DEVTOOLS_TABS)[number], string[]> = {
      boot: ['complete', 'app.boot', 'p/a-unit', 'Per-unit DI resolution', 'Critical path'],
      journeys: ['/studio', 'stage match'],
      graph: ['Layer 0', 'p/a-unit', 'ready'],
      lifecycles: ['App', 'Workers', 'doc', 'handshaking'],
      decisions: ['Explain', 'route:/studio', 'allow', 'p/login'],
      stores: ['p/store', '"title": "Doc"'],
      violations: ['SF-PERF-002', 'Batch layout reads.', 'studio'],
      metrics: ['p/latency', 'p/declared', 'Declared but never recorded'],
      settings: ['pause', 'Verbosity', 'core/di', 'Theme', 'Sources'],
    };
    for (const tab of DEVTOOLS_TABS) {
      el.tab = tab;
      await el.updateComplete;
      const content = text(el);
      for (const needle of expectations[tab]) expect(content, `${tab}: ${needle}`).toContain(needle);
      expect(el.shadowRoot?.querySelector('[role="tabpanel"]')?.id).toBe(`sf-dt-panel-${tab}`);
    }
    // waterfall bars are CSS bars with percentage geometry
    el.tab = 'boot';
    await el.updateComplete;
    const bar = el.shadowRoot?.querySelector('.wf-bar') as HTMLElement;
    expect(bar.style.width).toMatch(/%$/);
  });

  it('explain form shows the fully attributed decision', async () => {
    const { devtools } = await populated();
    const el = await mount(devtools);
    el.tab = 'decisions';
    await el.updateComplete;
    const form = el.shadowRoot?.querySelector('form') as HTMLFormElement;
    (form.querySelector('select[name="level"]') as HTMLSelectElement).value = 'route';
    (form.querySelector('input[name="resource"]') as HTMLInputElement).value = '/studio';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await el.updateComplete;
    const status = el.shadowRoot?.querySelector('[role="status"]')?.textContent?.replace(/\s+/g, ' ') ?? '';
    expect(status).toContain('allow');
    expect(status).toContain('determining: p/login');
    expect(status).toContain('not security');
  });

  it('settings change levels and run commands through the handle', async () => {
    const { devtools, telemetry } = await populated();
    const el = await mount(devtools);
    el.tab = 'settings';
    await el.updateComplete;
    const select = el.shadowRoot?.querySelector('select[aria-label="Level for core/di"]') as HTMLSelectElement;
    select.value = 'off';
    select.dispatchEvent(new Event('change'));
    expect(telemetry.enabled('core/di', 'critical')).toBe(false);
    const pause = [...(el.shadowRoot?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'pause') as HTMLButtonElement;
    expect(pause.disabled).toBe(true); // supervisor not started
    const theme = el.shadowRoot?.querySelector('select[aria-label="Theme"]') as HTMLSelectElement;
    theme.value = 'dark';
    theme.dispatchEvent(new Event('change'));
    await el.updateComplete;
    expect(el.getAttribute('theme')).toBe('dark');
  });

  it('Escape closes, fires sf-devtools-close and restores focus', async () => {
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    outside.focus();
    const el = await mount(createDevtools({ telemetry: createTelemetry() }), false);
    el.open = true;
    await el.updateComplete;
    expect(el.shadowRoot?.activeElement?.id).toBe('sf-dt-tab-boot');
    let closed = 0;
    el.addEventListener(CLOSE_EVENT, () => (closed += 1));
    el.shadowRoot?.querySelector('[role="dialog"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await el.updateComplete;
    expect(el.open).toBe(false);
    expect(closed).toBe(1);
    expect(document.activeElement).toBe(outside);
  });

  it('a closed panel does not re-render on telemetry; an open one does (coalesced)', async () => {
    const telemetry = createTelemetry({ defaultLevel: 'debug' });
    const devtools = createDevtools({ telemetry });
    const el = await mount(devtools, false);
    let updates = 0;
    const original = el.requestUpdate.bind(el);
    el.requestUpdate = ((...args: Parameters<typeof original>) => {
      updates += 1;
      return original(...args);
    }) as typeof el.requestUpdate;
    telemetry.event('x.y', { subsystem: 'test/a' });
    await new Promise((r) => setTimeout(r, 0));
    expect(updates).toBe(0);
    el.open = true;
    await el.updateComplete;
    updates = 0;
    for (let i = 0; i < 5; i += 1) telemetry.event('x.y', { subsystem: 'test/a' });
    await new Promise((r) => setTimeout(r, 0));
    expect(updates).toBe(1);
  });

  it('renders a hint without a handle, and empty states', async () => {
    const el = await mount(undefined);
    expect(text(el)).toContain('No devtools handle bound');
    el.devtools = createDevtools({ telemetry: createTelemetry() });
    await el.updateComplete;
    expect(text(el)).toContain('No boot trace recorded');
    el.tab = 'violations';
    await el.updateComplete;
    expect(text(el)).toContain('No conformance violations');
  });

  it('formats durations', () => {
    expect(formatMs(1.234)).toBe('1.2 ms');
    expect(formatMs(123.4)).toBe('123 ms');
    expect(formatMs(12_345)).toBe('12.3 s');
    expect(formatMs(Number.NaN)).toBe('–');
  });
});
