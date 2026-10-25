/**
 * `<if-studio>` under Clean Pop in happy-dom: the frame matches `StudioCP.dc.html` structurally, it is
 * laid out from the mounted spec (and follows spec diffs with motion phases), keyboard paths work, the
 * shell passes the a11y audit, and the DOM satisfies the shared `SpecMountPort` contract.
 */
import { createShortcutRegistry } from '@staticflux/a11y';
import type { SfSegmentedElement } from '@staticflux/kit/segmented';
import type { SfDockElement, SfPanelElement } from '@staticflux/kit/dock';
import { ok, type Result } from '@staticflux/core';
import { type SpecSlotKey } from '@staticflux/shell/spec';
import { runSpecMountPortContract, specContractVocabulary } from '@staticflux/testkit';
import { accessibleName, deepFocused, expectNoA11yIssues, press } from '@staticflux/testkit/a11y';
import { compileTheme } from '@staticflux/ui/theme';
import { mountTestRoot, settle } from '@staticflux/ui/testing';
import { html, render } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createEditorRegistries, gateSpecDecide, pixelTouchUpSpec, StudioIds, studioSpec } from '../spec/index.js';
import { editorGate, studioRegistries } from '../spec/testing/fixtures.js';
import { cleanPopTheme } from '../theme/clean-pop.js';
import { createStudio, type Studio } from './studio.js';
import { defineStudio, type IfStudioElement } from './studio-element.js';

let dispose: (() => Promise<void>) | undefined;

beforeAll(() => defineStudio());

afterEach(async () => {
  await dispose?.();
  dispose = undefined;
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

interface Mounted {
  readonly element: IfStudioElement;
  readonly root: ShadowRoot;
  readonly studio: Studio;
}

async function mount(options: { studio?: Studio; shortcuts?: boolean; open?: boolean } = {}): Promise<Mounted> {
  const style = document.createElement('style');
  style.textContent = compileTheme(cleanPopTheme);
  document.head.append(style);
  const { gate } = editorGate('pro');
  const studio = options.studio ?? createStudio({ registries: studioRegistries(), decideFor: (s) => gateSpecDecide(gate, s), reducedMotion: () => true });
  if (options.open !== false) await studio.open();
  const testRoot = mountTestRoot({ units: [] });
  const shortcuts = options.shortcuts === false ? undefined : createShortcutRegistry({ isMac: false });
  render(html`<if-studio .studio=${studio} .shortcuts=${shortcuts} asset-title="Night Market Flyer" project-title="Spring campaign"></if-studio>`, testRoot.container);
  dispose = async () => {
    await studio.dispose();
    await testRoot.dispose();
  };
  await settle(6);
  const element = testRoot.container.querySelector('if-studio') as IfStudioElement;
  return { element, root: element.shadowRoot as ShadowRoot, studio };
}

const slots = (root: ShadowRoot, group: string): string[] =>
  [...root.querySelectorAll(`[data-group="${group}"]:not([data-phase="exiting"])`)].map((el) => el.getAttribute('data-slot') ?? '').filter((s) => s !== '');

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 0));
  expect(condition()).toBe(true);
}

describe('<if-studio> frame', () => {
  it('matches StudioCP structurally: top bar, chat side panel, tabbed dock, canvas region, inspector', async () => {
    const { root } = await mount();
    const header = root.querySelector('header') as HTMLElement;
    expect(header.querySelector('a.home')?.getAttribute('aria-label')).toBe('Home');
    expect(header.querySelector('nav')?.getAttribute('aria-label')).toBe('Breadcrumb');
    expect(header.querySelector('nav')?.textContent).toContain('Night Market Flyer');
    const mode = header.querySelector('sf-segmented.modes') as SfSegmentedElement;
    expect(mode.options.map((o) => o.label)).toEqual(['Canvas', 'Pixel', 'Timeline', 'Flow', 'Pages']);
    expect(mode.value).toBe(StudioIds.lens.canvas);
    expect([...header.querySelectorAll('sf-button')].map((b) => b.textContent?.trim())).toEqual(['Milestone', 'Save as template', 'Share']);
    expect(header.querySelector('sf-button[variant="primary"]')?.textContent?.trim()).toBe('Share');
    expect(header.querySelector('[role="status"]')?.textContent).toBe('Saved');

    const landmarks = [...root.querySelectorAll('aside, main')].map((el) => `${el.localName}:${el.getAttribute('aria-label')}`);
    expect(landmarks).toEqual(['aside:Chat', 'aside:Dock', 'main:Canvas', 'aside:Typography']);
    expect([...root.querySelectorAll('aside[data-region="dock"] sf-tab')].map((t) => t.textContent?.trim())).toEqual(['Layers', 'Pages', 'Assets', 'Milestones', 'Brand', 'Export']);
    const main = root.querySelector('main') as HTMLElement;
    expect(main.querySelector('sf-toolbar.tools')?.getAttribute('aria-label')).toBe('Tools');
    expect(main.querySelector('sf-toolbar.hud')?.getAttribute('aria-label')).toBe('Selection actions');
    expect(main.querySelector('.command sf-text-field')?.getAttribute('label')).toBe('Command bar');
    expect(main.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Zoom');
    expect(main.querySelector('.surface')?.getAttribute('aria-label')).toBe('Canvas surface');
    expect([...main.querySelectorAll('.hud > *')].map((b) => accessibleName(b))).toEqual(['✦ Rewrite', 'Animate', '✦ Ask']);
  });

  it('the HUD has a fixed block size: a selection bringing more actions never moves or resizes the canvas surface', async () => {
    // B9 smoke flake (colocated): the HUD grew from one row (no selection) to two (a selection's actions), the surface
    // moved 40 px under a drag that had started, and the move lost that distance. The surface keeps its place only if
    // the HUD's block size does not depend on its content.
    const { root } = await mount();
    const hud = root.querySelector('sf-toolbar.hud') as HTMLElement;
    const style = getComputedStyle(hud);
    expect(style.blockSize).not.toBe('');
    expect(style.blockSize).not.toBe('auto');
    expect(style.blockSize).toBe(style.maxBlockSize);
  });

  it('HUD actions of tone `more` share one "More actions" menu (B8); the bar keeps direct and agent actions', async () => {
    const { gate } = editorGate('pro');
    const studio = createStudio({
      registries: studioRegistries(),
      decideFor: (s) => gateSpecDecide(gate, s),
      reducedMotion: () => true,
      spec: { ...studioSpec, hud: [StudioIds.hud.rewrite, StudioIds.hud.more, StudioIds.hud.ask] },
    });
    const { element, root } = await mount({ studio });
    const seen: string[] = [];
    element.addEventListener('if-hud-action', (e) => seen.push((e as CustomEvent<{ action: string }>).detail.action));
    const hud = root.querySelector('.hud') as HTMLElement;
    expect([...hud.children].map((b) => b.localName)).toEqual(['sf-button', 'sf-button', 'sf-menu']);
    expect([...hud.children].slice(0, 2).map((b) => accessibleName(b))).toEqual(['✦ Rewrite', '✦ Ask']);
    expect(accessibleName(hud.querySelector('sf-menu > [slot="trigger"]') as Element)).toBe('More actions');
    const items = [...hud.querySelectorAll('sf-menu-item')];
    expect(items.map((i) => i.getAttribute('data-slot'))).toEqual(['hud:instaflow/more']);
    hud.querySelector('sf-menu')?.dispatchEvent(new CustomEvent('sf-select', { detail: { value: StudioIds.hud.more } }));
    expect(seen).toEqual([StudioIds.hud.more]);
  });

  it('is laid out from the spec: slots per group follow the mounted layout', async () => {
    const { root, studio } = await mount();
    for (const [group, keys] of Object.entries(studio.port.groups())) {
      if (group.startsWith('capability')) continue;
      expect(slots(root, group), group).toEqual(keys);
    }
    await studio.switchLens(StudioIds.lens.pixel);
    await settle(4);
    expect(slots(root, 'tool@default')).toEqual(['tool:instaflow/select', 'tool:instaflow/brush', 'tool:instaflow/heal', 'tool:instaflow/crop', 'tool:instaflow/hand']);
    expect(slots(root, 'panel@inspector')).toEqual(['panel:instaflow/adjust']);
    expect((root.querySelector('sf-segmented.modes') as SfSegmentedElement).value).toBe(StudioIds.lens.pixel);
  });

  it('passes the a11y audit (names, ARIA references, roles, no nested interactive controls)', async () => {
    const { element } = await mount();
    expectNoA11yIssues(element);
  });

  it('density: Focus collapses the docks to rails, Standard opens them, Pro opens the inspector', async () => {
    const { root, studio } = await mount();
    const dock = (region: string) => root.querySelector(`aside[data-region="${region}"] sf-dock`) as SfDockElement;
    const properties = () => root.querySelector('[data-slot="panel:instaflow/typography"]') as SfPanelElement;
    expect([dock('dock').collapsed, dock('inspector').collapsed, properties().collapsed]).toEqual([false, false, false]);
    await studio.setDensity('standard');
    await settle(4);
    expect([dock('dock').collapsed, dock('inspector').collapsed, properties().collapsed]).toEqual([false, true, true]);
    await studio.setDensity('focus');
    await settle(4);
    expect([dock('side').collapsed, dock('dock').collapsed, dock('inspector').collapsed]).toEqual([true, true, true]);
    // The person can still open a collapsed dock (its expand button fires sf-collapse).
    dock('dock').setCollapsed(false);
    await settle(4);
    expect(dock('dock').collapsed).toBe(false);
    expectNoA11yIssues(root.host);
  });

  it('pins a panel from its header; a pinned panel survives a narrow spec', async () => {
    const { root, studio } = await mount();
    const pin = root.querySelector('[data-slot="panel:instaflow/chat"] sf-icon-button[slot="actions"]') as HTMLElement;
    expect(accessibleName(pin)).toBe('Pin Chat');
    pin.click();
    await settle(4);
    expect(studio.runtime.pinned.has('panel:instaflow/chat')).toBe(true);
    await studio.proposals.propose(pixelTouchUpSpec(['img-1']), { kind: 'person', id: 'ann' });
    await settle(4);
    expect(slots(root, 'panel@side')).toEqual(['panel:instaflow/chat']);
    expect(slots(root, 'panel@dock')).toEqual([]);
  });

  it('shows an agent proposal as a preview card; Open mounts it, Dismiss declines it', async () => {
    const { root, studio } = await mount();
    const p = await studio.proposals.propose(pixelTouchUpSpec(['img-1']), { kind: 'agent', id: 'claude', displayName: 'Claude' }, { reason: 'Touch up the photo' });
    await settle(4);
    const card = root.querySelector('section[aria-label="Proposed editor"]') as HTMLElement;
    expect(card.textContent).toContain('Claude proposes');
    expect(card.textContent).toContain('Touch up the photo');
    (card.querySelector('sf-button[variant="agent"]') as HTMLElement).click();
    await until(() => p.state === 'mounted');
    await settle(4);
    expect(root.querySelector('section[aria-label="Proposed editor"]')).toBeNull();
    const second = await studio.proposals.propose(pixelTouchUpSpec(['img-2']), { kind: 'agent', id: 'claude' });
    await settle(4);
    (root.querySelector('section[aria-label="Proposed editor"] .actions sf-button:last-child') as HTMLElement).click();
    expect(second.state).toBe('declined');
  });

  it('motion: entering and exiting slots carry their phase and duration; exiting ones are inert', async () => {
    const waits: (() => void)[] = [];
    const wait = (ms: number, signal: AbortSignal): Promise<Result<void>> =>
      new Promise((resolve) => {
        const done = () => resolve(ok());
        waits.push(done);
        signal.addEventListener('abort', done, { once: true });
        void ms;
      });
    const { gate } = editorGate('pro');
    const studio = createStudio({ registries: studioRegistries(), decideFor: (s) => gateSpecDecide(gate, s), wait });
    const opening = studio.open();
    await until(() => waits.length > 0);
    for (const release of waits.splice(0)) release();
    await opening;
    const { root } = await mount({ studio, open: false });
    const switching = studio.switchLens(StudioIds.lens.pixel);
    await until(() => root.querySelector('[data-phase="exiting"]') !== null);
    await settle(2);
    const exiting = root.querySelector('[data-slot="tool:instaflow/frame"]') as HTMLElement;
    expect(exiting.getAttribute('data-phase')).toBe('exiting');
    expect(exiting.hasAttribute('inert')).toBe(true);
    expect(exiting.getAttribute('style')).toContain('--if-motion:120ms');
    const entering = root.querySelector('[data-slot="tool:instaflow/brush"]') as HTMLElement;
    expect(entering.getAttribute('data-phase')).toBe('entering');
    expect(entering.getAttribute('style')).toContain('--if-motion:160ms');
    for (const release of waits.splice(0)) release();
    await switching;
    await settle(4);
    expect(root.querySelector('[data-slot="tool:instaflow/frame"]')).toBeNull();
    expect(root.querySelector('[data-slot="tool:instaflow/brush"]')?.getAttribute('data-phase')).toBe('present');
  });
});

describe('<if-studio> keyboard paths', () => {
  it('1–4 switch lenses; tool letters pick tools but not while typing in the command bar', async () => {
    const { element, root, studio } = await mount();
    const surface = root.querySelector('.surface') as HTMLElement;
    surface.focus();
    press(surface, '2');
    await until(() => studio.lens?.label === 'Pixel');
    await settle(4);
    press(surface, 'j');
    expect(studio.activeTool).toBe(StudioIds.tool.heal);
    await settle(2);
    expect(root.querySelector('[data-slot="tool:instaflow/heal"]')?.getAttribute('aria-pressed') ?? (root.querySelector('[data-slot="tool:instaflow/heal"]') as { pressed?: unknown }).pressed).toBeTruthy();
    press(surface, 'k', { ctrl: true });
    await settle(2);
    const field = root.querySelector('.command sf-text-field') as HTMLElement;
    const input = field.shadowRoot?.querySelector('input') as HTMLInputElement;
    expect(deepFocused()).toBe(input);
    press(input, 'v');
    expect(studio.activeTool).toBe(StudioIds.tool.heal);
    press(input, 'Escape');
    expect(deepFocused()).toBe(surface);
    press(surface, '1');
    await until(() => studio.lens?.label === 'Canvas');
    expect(element.isConnected).toBe(true);
  });

  it('Alt+Enter focuses the HUD; arrow keys rove inside it; the mode switcher switches lenses by arrow keys', async () => {
    const { root, studio } = await mount();
    const surface = root.querySelector('.surface') as HTMLElement;
    press(surface, 'Enter', { alt: true });
    const hudItems = [...root.querySelectorAll('.hud > *')];
    expect(deepFocused()).toBe(hudItems[0]);
    press(hudItems[0] as Element, 'ArrowRight');
    await settle(2);
    expect(deepFocused()).toBe(hudItems[1]);
    const mode = root.querySelector('sf-segmented.modes') as SfSegmentedElement;
    const checked = mode.shadowRoot?.querySelector('[aria-checked="true"]') as HTMLElement;
    checked.focus();
    press(checked, 'ArrowRight');
    await until(() => studio.lens?.label === 'Pixel');
  });

  it('the dock tabs are an APG tablist: arrows move between Layers, Pages, Assets, Milestones, Brand and Export', async () => {
    const { root } = await mount();
    const tabs = [...root.querySelectorAll('aside[data-region="dock"] sf-tab')] as HTMLElement[];
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false', 'false', 'false']);
    tabs[0]?.focus();
    press(tabs[0] as HTMLElement, 'ArrowRight');
    await settle(4);
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false', 'false', 'false', 'false']);
  });

  it('showPanel selects a dock panel by id and focuses its tab (C1: Share shows Export)', async () => {
    const { element, root } = await mount();
    expect(await element.showPanel('instaflow/export')).toBe(true);
    await settle(4);
    const tabs = [...root.querySelectorAll('aside[data-region="dock"] sf-tab')] as HTMLElement[];
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'false', 'false', 'false', 'false', 'true']);
    expect(await element.showPanel('instaflow/nope')).toBe(false);
    // A control inside a panel (a segmented control's composed `sf-change`) does not switch the dock's tab.
    const inner = root.querySelector('aside[data-region="dock"] sf-tab-panel:last-of-type') as HTMLElement;
    const probe = document.createElement('span');
    inner.append(probe);
    probe.dispatchEvent(new CustomEvent('sf-change', { detail: { value: 'pdf' }, bubbles: true, composed: true }));
    await settle(4);
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'false', 'false', 'false', 'false', 'true']);
  });

  it('the HUD, intents and the command bar emit events for the features that handle them', async () => {
    const { element, root } = await mount();
    const seen: string[] = [];
    element.addEventListener('if-hud-action', (e) => seen.push((e as CustomEvent<{ action: string }>).detail.action));
    element.addEventListener('if-intent', (e) => seen.push((e as CustomEvent<{ intent: string }>).detail.intent));
    element.addEventListener('if-command', (e) => seen.push((e as CustomEvent<{ text: string }>).detail.text));
    (root.querySelector('[data-slot="hud:instaflow/animate"]') as HTMLElement).click();
    (root.querySelector('header sf-button[variant="primary"]') as HTMLElement).click();
    (root.querySelector('.zoom sf-icon-button') as HTMLElement).click();
    const field = root.querySelector('.command sf-text-field') as HTMLElement & { value: string };
    field.value = 'make it pop';
    field.dispatchEvent(new Event('change'));
    expect(seen).toEqual(['instaflow/animate', 'share', 'zoom-out', 'make it pop']);
  });

  it('C0: "Save as template" is an intent; the Home link asks the host first (cancelable) and keeps modified clicks', async () => {
    const { element, root } = await mount();
    const seen: string[] = [];
    element.addEventListener('if-intent', (e) => seen.push((e as CustomEvent<{ intent: string }>).detail.intent));
    const save = [...root.querySelectorAll('header sf-button')].find((b) => b.textContent?.trim() === 'Save as template') as HTMLElement;
    save.click();
    expect(seen).toEqual(['save-template']);
    element.homeHref = '/';
    await element.updateComplete;
    const home = root.querySelector('header a.home') as HTMLAnchorElement;
    expect(home.getAttribute('href')).toBe('/');
    const hrefs: string[] = [];
    const cancel = (e: Event): void => {
      hrefs.push((e as CustomEvent<{ href: string }>).detail.href);
      e.preventDefault();
    };
    element.addEventListener('if-navigate', cancel);
    const plain = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, button: 0 });
    home.dispatchEvent(plain);
    expect(hrefs).toEqual(['/']);
    expect(plain.defaultPrevented).toBe(true); // the host navigates after saving
    const newTab = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, button: 0, metaKey: true });
    newTab.preventDefault = () => undefined; // happy-dom would follow the link otherwise
    home.dispatchEvent(newTab);
    expect(hrefs).toEqual(['/']); // modified clicks are the browser's
  });
});

// The DOM is a SpecMountPort view: the shared suite drives the Studio's layout model with the contract
// vocabulary and reads what <if-studio> shows.
runSpecMountPortContract(
  '<if-studio> DOM',
  {
    create: async () => {
      const registries = createEditorRegistries({ lenses: [], tools: [], panels: [], hud: [], capabilities: [] });
      if (!registries.ok) throw registries.error;
      const studio = createStudio({ registries: { ...registries.value, vocabulary: specContractVocabulary() }, decideFor: () => ({ decide: () => ({ effect: 'allow' }) }) });
      const { root } = await mount({ studio, open: false, shortcuts: false });
      const groups = async (): Promise<Record<string, SpecSlotKey[]>> => {
        await settle(4);
        const out: Record<string, SpecSlotKey[]> = {};
        for (const el of root.querySelectorAll('[data-group]:not([data-phase="exiting"])')) {
          const slot = el.getAttribute('data-slot') as SpecSlotKey | null;
          if (slot === null) continue;
          (out[el.getAttribute('data-group') as string] ??= []).push(slot);
        }
        return out;
      };
      const handle = { port: studio.port, groups, dispose: async () => (await dispose?.(), (dispose = undefined)) };
      return handle;
    },
  },
  { describe, it },
  { numRuns: 5 },
);
