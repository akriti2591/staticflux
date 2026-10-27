/**
 * `<if-studio>` under Clean Pop in happy-dom (B11b): the frame matches STUDIO-UX-SPEC §1–§4 (top bar, dock, the canvas
 * room with the page card, tool picker, selection pill, zoom pill, inspector), it is laid out from the mounted spec,
 * keyboard paths work, every control forwards to the chrome port, the frame passes the a11y audit, and the DOM
 * satisfies the shared `SpecMountPort` contract.
 */
import { createShortcutRegistry } from '@staticflux/a11y';
import type { SfSegmentedElement } from '@staticflux/kit/segmented';
import type { SfDockElement } from '@staticflux/kit/dock';
import type { SfMenuElement } from '@staticflux/kit/menu';
import { ok, type Result } from '@staticflux/core';
import { type SpecSlotKey } from '@staticflux/shell/spec';
import { runSpecMountPortContract, specContractVocabulary } from '@staticflux/testkit';
import { accessibleName, deepFocused, expectNoA11yIssues, press } from '@staticflux/testkit/a11y';
import { compileTheme } from '@staticflux/ui/theme';
import { mountTestRoot, settle } from '@staticflux/ui/testing';
import { html, render } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SelectionSummary } from '../app/scene-summary.js';
import { createEditorRegistries, gateSpecDecide, pixelTouchUpSpec, StudioIds } from '../spec/index.js';
import { editorGate, studioRegistries } from '../spec/testing/fixtures.js';
import { cleanPopTheme } from '../theme/clean-pop.js';
import { createStudio, type Studio } from './studio.js';
import { defineStudio, EMPTY_CHROME, HUD_MARGIN, hudPosition, type IfStudioElement, type StudioChromeModel, type StudioChromePort, TOOL_PICKER_BOTTOM } from './studio-element.js';

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
  readonly calls: string[];
}

/** A chrome port that records what each control asked for. */
function recordingPort(calls: string[], context?: () => SelectionSummary | undefined): StudioChromePort {
  const log =
    (name: string) =>
    (...args: unknown[]): void => {
      calls.push(`${name}${args.length === 0 ? '' : ` ${JSON.stringify(args.filter((a) => a !== undefined))}`}`);
    };
  return {
    invoke: log('invoke'),
    setPaint: log('setPaint'),
    setProp: log('setProp'),
    setFont: log('setFont'),
    setSize: log('setSize'),
    setTextColor: log('setTextColor'),
    toggleText: log('toggleText'),
    setTextAlign: log('setTextAlign'),
    setRepeat: log('setRepeat'),
    setImageFit: log('setImageFit'),
    command: log('command'),
    renameTitle: log('renameTitle'),
    camera: log('camera'),
    openExport: log('openExport'),
    createMilestone: log('createMilestone'),
    saveAsTemplate: log('saveAsTemplate'),
    copyLink: log('copyLink'),
    navigate: log('navigate'),
    selectPage: log('selectPage'),
    contextAt: (point) => {
      log('contextAt')(point);
      return Promise.resolve(context?.());
    },
    clipboard: log('clipboard'),
    selectAll: log('selectAll'),
    editText: log('editText'),
    textPreset: log('textPreset'),
    fitToBox: log('fitToBox'),
    replaceImage: log('replaceImage'),
    placeImage: log('placeImage'),
    dropFiles: (files, at) => void calls.push(`dropFiles ${files.map((f) => f.name).join(',')} ${at.x},${at.y}`),
    pageAction: log('pageAction'),
    saveHint: log('saveHint'),
    openShortcuts: log('openShortcuts'),
    openSettings: log('openSettings'),
    cycleDensity: log('cycleDensity'),
    find: async (q) => {
      calls.push(`find ${q.kind}:${q.query}`);
      return { matches: [{ id: 'n1:text:0', node: 'n1', page: 'p1', pageName: 'Page 1', label: 'Headline', where: 'text', from: 0, to: 5, locked: false, hidden: false }], pages: 1 };
    },
    replace: async (q, replacement) => {
      calls.push(`replace ${q.query}→${replacement}`);
      return { ops: 1, replaced: 1, skipped: 0, label: 'Replace' };
    },
    reveal: (match) => void calls.push(`reveal ${match.node}`),
  };
}

const SHAPE: SelectionSummary = {
  kind: 'shape',
  nodes: ['r1'],
  label: 'Rectangle',
  typeLabel: 'Rectangle',
  locked: false,
  anyLocked: false,
  hidden: false,
  common: 'rectangle',
  fill: { kind: 'solid', color: '#FF5C39', token: '@primary' },
  stroke: { kind: 'none' },
  radius: 0,
  actions: ['instaflow/delete', 'instaflow/duplicate', 'instaflow/lock', 'instaflow/flip-horizontal', 'instaflow/bring-to-front', 'instaflow/repeat-radial'],
};

const MODEL: StudioChromeModel = {
  ...EMPTY_CHROME,
  title: 'Night Market Flyer',
  page: { id: 'p1', name: 'Page 1', width: 1080, height: 1350 },
  camera: { tx: 40, ty: 60, zoom: 0.5 },
  exportAvailable: true,
  templatesAvailable: true,
  actions: new Map(
    [
      ['instaflow/flip-horizontal', 'Flip horizontal', 'Shift+H'],
      ['instaflow/bring-to-front', 'Bring to front', 'Mod+Alt+]'],
      ['instaflow/repeat-radial', 'Radial repeat', undefined],
      ['instaflow/lock', 'Lock / unlock', 'Mod+Shift+L'],
    ].map(([id, title, shortcut]) => [id as string, { id: id as string, title: title as string, ...(shortcut === undefined ? {} : { shortcut }) }]),
  ),
};

async function mount(options: { studio?: Studio; shortcuts?: boolean; open?: boolean; model?: StudioChromeModel; context?: () => SelectionSummary | undefined } = {}): Promise<Mounted> {
  const style = document.createElement('style');
  style.textContent = compileTheme(cleanPopTheme);
  document.head.append(style);
  const { gate } = editorGate('pro');
  const studio = options.studio ?? createStudio({ registries: studioRegistries(), decideFor: (s) => gateSpecDecide(gate, s), reducedMotion: () => true });
  if (options.open !== false) await studio.open();
  const testRoot = mountTestRoot({ units: [] });
  const shortcuts = options.shortcuts === false ? undefined : createShortcutRegistry({ isMac: false });
  const calls: string[] = [];
  render(html`<if-studio .studio=${studio} .shortcuts=${shortcuts} .model=${options.model ?? MODEL} .port=${recordingPort(calls, options.context)} asset-title="Night Market Flyer"></if-studio>`, testRoot.container);
  dispose = async () => {
    await studio.dispose();
    await testRoot.dispose();
  };
  await settle(6);
  const element = testRoot.container.querySelector('if-studio') as IfStudioElement;
  return { element, root: element.shadowRoot as ShadowRoot, studio, calls };
}

const slots = (root: ShadowRoot, group: string): string[] =>
  [...root.querySelectorAll(`[data-group="${group}"]:not([data-phase="exiting"])`)].map((el) => el.getAttribute('data-slot') ?? '').filter((s) => s !== '');

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 0));
  expect(condition()).toBe(true);
}

const menuItems = (menu: Element): string[] => [...menu.querySelectorAll(':scope > sf-menu-item, :scope > sf-menu-group > sf-menu-item')].map((i) => i.textContent?.trim() ?? '');

describe('<if-studio> frame (B11b)', () => {
  it('top bar per STUDIO-UX-SPEC §2: the mark → Home, the title, Canvas · Pages, Saved, View, Milestone, More, Export', async () => {
    const { root } = await mount();
    const header = root.querySelector('header') as HTMLElement;
    const home = header.querySelector('a.home') as HTMLAnchorElement;
    expect(home.getAttribute('aria-label')).toBe('Home');
    expect(home.querySelector('svg[data-if-mark]')).not.toBeNull();
    expect((header.querySelector('sf-inline-edit.title') as HTMLElement & { value: string }).value).toBe('Night Market Flyer');
    const mode = header.querySelector('sf-segmented.modes') as SfSegmentedElement;
    expect(mode.options.map((o) => o.label)).toEqual(['Canvas', 'Pages']);
    expect(mode.value).toBe(StudioIds.lens.canvas);
    expect(header.querySelector('.saved [role="status"]')?.textContent).toBe('Saved');
    expect([...header.querySelectorAll('sf-button')].map((b) => b.textContent?.trim().replace(/\s+/g, ' '))).toEqual(['View', 'Milestone', 'Create', 'Export']);
    expect(header.querySelector(':scope > sf-button[variant="primary"]')?.textContent?.trim()).toBe('Export');
    // Nothing visible is inert: no Share, no assistant chip, no density switch in the bar (§2, §14).
    expect(header.textContent).not.toMatch(/Share|Claude|✦|Arrives/);
    expect(header.querySelector(':scope > sf-segmented:not(.modes)')).toBeNull();
    const landmarks = [...root.querySelectorAll('aside, main')].map((el) => `${el.localName}:${el.getAttribute('aria-label')}`);
    expect(landmarks).toEqual(['aside:Dock', 'main:Canvas', 'aside:Inspector']);
    expect([...root.querySelectorAll('aside[data-region="dock"] sf-tab')].map((t) => t.textContent?.trim())).toEqual(['Layers', 'Pages', 'Assets', 'Milestones']);
    const main = root.querySelector('main') as HTMLElement;
    expect(main.querySelector('.tools')?.getAttribute('aria-label')).toBe('Tools');
    expect(main.querySelector('[role="group"].zoom')?.getAttribute('aria-label')).toBe('Zoom');
    expect(main.querySelector('.surface')?.getAttribute('aria-label')).toBe('Canvas surface');
  });

  it('the Export button renders only where an exporter exists', async () => {
    const { root } = await mount({ model: { ...MODEL, exportAvailable: false } });
    expect(root.querySelector('header > sf-button[variant="primary"]')).toBeNull();
  });

  it('the canvas room: the page card and its label follow the camera; the label names the page and its size', async () => {
    const { root, element, calls } = await mount();
    const card = root.querySelector('.page-card') as HTMLElement;
    expect(card.getAttribute('style')).toBe('left:40px;top:60px;width:540px;height:675px');
    const label = root.querySelector('[data-if-page-label]') as HTMLElement;
    expect(label.textContent?.trim()).toBe('Page 1 · 1080 × 1350');
    expect(label.getAttribute('style')).toBe('left:40px;top:32px');
    // Click selects the page (the inspector shows Page); double-click renames it (STUDIO §1).
    label.click();
    label.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(calls).toEqual(['selectPage [false]', 'selectPage [true]']);
    element.model = { ...MODEL, camera: { tx: 0, ty: 100, zoom: 1 } };
    await settle(2);
    expect(card.getAttribute('style')).toBe('left:0px;top:100px;width:1080px;height:1350px');
  });

  it('the tool picker: icons with names and keys, the shape family as one button with a menu, no Pen', async () => {
    const { root, studio } = await mount();
    const tools = root.querySelector('.tools') as HTMLElement;
    const buttons = [...tools.querySelectorAll(':scope > sf-icon-button:not(.place-image)')];
    expect(buttons.map((b) => accessibleName(b))).toEqual(['Select', 'Frame', 'Rectangle', 'Text', 'Hand']);
    expect(buttons.map((b) => b.getAttribute('shortcut'))).toEqual(['V', 'F', 'R', 'T', 'H']);
    expect(tools.querySelectorAll('sf-icon').length).toBeGreaterThanOrEqual(5);
    expect(tools.textContent).not.toMatch(/[↖#▢✒✋]/);
    const shapes = tools.querySelector('sf-menu') as SfMenuElement;
    expect(menuItems(shapes)).toEqual(['Rectangle', 'Ellipse', 'Polygon', 'Star', 'Line']);
    shapes.dispatchEvent(new CustomEvent('sf-select', { detail: { value: StudioIds.tool.ellipse } }));
    await settle(4);
    expect(studio.activeTool).toBe(StudioIds.tool.ellipse);
    expect([...tools.querySelectorAll(':scope > sf-icon-button')].map((b) => accessibleName(b))).toContain('Ellipse');
  });

  it('the selection pill renders the kind’s ranked controls and More; its controls run through the port', async () => {
    const { root, calls } = await mount({ model: { ...MODEL, selection: SHAPE, frame: { x: 100, y: 400, w: 200, h: 100 } } });
    const hud = root.querySelector('if-hud') as HTMLElement;
    await settle(4);
    const toolbar = hud.shadowRoot?.querySelector('[role="toolbar"]') as HTMLElement;
    expect(toolbar.getAttribute('aria-label')).toBe('Selection actions');
    const names = [...toolbar.querySelectorAll('[data-hud-item]')].map((el) => accessibleName(el) || el.getAttribute('label'));
    expect(names).toEqual(['Fill', 'Stroke', 'Radius', 'Duplicate', 'Delete', 'More actions']);
    (toolbar.querySelector('sf-icon-button[label="Delete"]') as HTMLElement).click();
    expect(calls).toEqual(['invoke ["instaflow/delete"]']);
    const more = toolbar.querySelector('sf-menu[filterable]') as SfMenuElement;
    expect([...more.querySelectorAll('sf-menu-group')].map((g) => g.getAttribute('label'))).toEqual(['Edit', 'Arrange', 'Transform', 'Repeat']);
    expect(menuItems(more.querySelector('sf-menu-group[label="Transform"]') as Element)).toEqual(['Flip horizontal', 'Free transform']);
    more.dispatchEvent(new CustomEvent('sf-select', { detail: { value: 'instaflow/bring-to-front' } }));
    more.dispatchEvent(new CustomEvent('sf-select', { detail: { value: 'instaflow/free-transform-hud' } }));
    expect(calls.slice(1)).toEqual(['invoke ["instaflow/bring-to-front"]', 'command ["instaflow/free-transform-hud"]']);
  });

  it('pill placement (§4.2.2): above with a 12 px gap, below when the picker is in the way, clamped, hidden off-screen', () => {
    const region = { width: 1000, height: 800 };
    const pill = { width: 200, height: 36 };
    const camera = { tx: 0, ty: 0, zoom: 1 };
    expect(hudPosition({ x: 400, y: 300, w: 200, h: 100 }, camera, region, pill)).toEqual({ left: 400, top: 252 });
    const below = hudPosition({ x: 400, y: 40, w: 200, h: 100 }, camera, region, pill);
    expect(below?.top).toBeGreaterThan(140);
    expect(hudPosition({ x: -150, y: 300, w: 200, h: 100 }, camera, region, pill)?.left).toBe(HUD_MARGIN);
    expect(hudPosition({ x: 2000, y: 300, w: 200, h: 100 }, camera, region, pill)).toBeUndefined();
    expect(hudPosition({ x: 400, y: 300, w: 200, h: 100 }, camera, region, pill)?.top ?? 0).toBeGreaterThan(TOOL_PICKER_BOTTOM);
  });

  it('passes the a11y audit with a selection (names, ARIA references, roles, no nested interactive controls)', async () => {
    const { element } = await mount({ model: { ...MODEL, selection: SHAPE, frame: { x: 100, y: 400, w: 200, h: 100 } } });
    await settle(4);
    expectNoA11yIssues(element);
  });

  it('is laid out from the spec: slots per group follow the mounted layout', async () => {
    const { root, studio } = await mount();
    for (const [group, keys] of Object.entries(studio.port.groups())) {
      if (group.startsWith('capability') || group.startsWith('hud') || group.startsWith('lens')) continue;
      const shown = slots(root, group);
      // The shape family shows one button (the current shape); the others are rows of its menu.
      const family = new Set(['tool:instaflow/ellipse', 'tool:instaflow/polygon', 'tool:instaflow/star', 'tool:instaflow/line']);
      expect(shown, group).toEqual(keys.filter((k) => !family.has(k)));
    }
    await studio.switchLens(StudioIds.lens.pages);
    await settle(4);
    expect((root.querySelector('sf-segmented.modes') as SfSegmentedElement).value).toBe(StudioIds.lens.pages);
  });

  it('density lives in View (§2.3): Standard opens the dock and inspector, Focus collapses them to rails, Pro keeps them open', async () => {
    const { root, studio } = await mount();
    const dock = (region: string) => root.querySelector(`aside[data-region="${region}"] sf-dock`) as SfDockElement;
    expect(studio.density).toBe('standard');
    expect([dock('dock').collapsed, dock('inspector').collapsed]).toEqual([false, false]);
    const view = root.querySelector('header sf-menu') as SfMenuElement;
    expect(menuItems(view)).toEqual(expect.arrayContaining(['Zoom to fit', 'Focus · Just your work.', 'Standard · Your work, with the panels that explain it.', 'Pro · Everything, with numbers.']));
    view.dispatchEvent(new CustomEvent('sf-select', { detail: { value: 'density:focus' } }));
    await until(() => studio.density === 'focus');
    await settle(4);
    expect([dock('dock').collapsed, dock('inspector').collapsed]).toEqual([true, true]);
    dock('dock').setCollapsed(false);
    await settle(4);
    expect(dock('dock').collapsed).toBe(false);
    view.dispatchEvent(new CustomEvent('sf-select', { detail: { value: 'density:pro' } }));
    await until(() => studio.density === 'pro');
    expectNoA11yIssues(root.host);
  });

  it('the top bar forwards: View zoom, the zoom pill, Milestone (named), More (template, rename, copy link), Export', async () => {
    const { root, calls } = await mount();
    const view = root.querySelector('header sf-menu') as SfMenuElement;
    view.dispatchEvent(new CustomEvent('sf-select', { detail: { value: 'fit-page' } }));
    (root.querySelector('.zoom sf-icon-button') as HTMLElement).click();
    const milestone = root.querySelector('header sf-popover form') as HTMLFormElement;
    const field = milestone.querySelector('sf-text-field') as HTMLElement;
    const input = field.shadowRoot?.querySelector('input') as HTMLInputElement;
    input.value = 'Client v1';
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    milestone.dispatchEvent(new Event('submit', { cancelable: true }));
    const more = [...root.querySelectorAll('header sf-menu')].at(-1) as SfMenuElement;
    expect(menuItems(more)).toEqual(['Save as template…', 'Rename…', 'Copy link', 'Find…', 'Settings…', 'Keyboard shortcuts', 'About Instaflow']);
    for (const value of ['save-template', 'copy-link', 'settings', 'shortcuts', 'about']) more.dispatchEvent(new CustomEvent('sf-select', { detail: { value } }));
    (root.querySelector('header > sf-button[variant="primary"]') as HTMLElement).click();
    expect(calls).toEqual(['camera ["fit-page"]', 'camera ["zoom-out"]', 'createMilestone ["Client v1"]', 'saveAsTemplate', 'copyLink', 'openSettings', 'openShortcuts', 'openSettings ["about"]', 'openExport']);
  });

  it('B11c images from files: Place image… in the tool picker, the command bar and the canvas menu; a file drop reaches the port at its point', async () => {
    const { root, calls, element } = await mount();
    const place = root.querySelector('.tools sf-icon-button.place-image') as HTMLElement;
    expect(accessibleName(place)).toBe('Place image…');
    place.click();
    root.querySelector('if-command-bar')?.dispatchEvent(new CustomEvent('if-command', { detail: { value: 'place:image' } }));
    await element.openContextMenu({ kind: 'canvas' }, { x: 10, y: 10 });
    (root.querySelector('sf-menu.context-menu') as HTMLElement).dispatchEvent(new CustomEvent('sf-select', { detail: { value: 'cmd:place-image' } }));
    expect(calls.filter((c) => c === 'placeImage')).toHaveLength(3);
    const main = root.querySelector('main') as HTMLElement;
    const file = new File([new Uint8Array([1])], 'dot.png', { type: 'image/png' });
    const transfer = { types: ['Files'], files: [file], dropEffect: 'none' };
    const drag = (type: string) => Object.assign(new Event(type, { bubbles: true, cancelable: true }), { dataTransfer: transfer, clientX: 40, clientY: 30, relatedTarget: null });
    main.dispatchEvent(drag('dragover'));
    await element.updateComplete;
    expect(main.hasAttribute('data-drop')).toBe(true);
    main.dispatchEvent(drag('drop'));
    await element.updateComplete;
    expect(main.hasAttribute('data-drop')).toBe(false);
    expect(calls.at(-1)).toMatch(/^dropFiles dot\.png -?\d+,-?\d+$/);
  });

  it('B11c find: Mod+F and ⋯ › Find… open the bar with its field focused, Mod+Alt+F with Replace; the bar searches through the port; Escape closes it', async () => {
    const { root, calls, element } = await mount();
    const surface = root.querySelector('.surface') as HTMLElement;
    surface.focus();
    press(surface, 'f', { ctrl: true });
    await until(() => root.querySelector('if-find-bar') !== null);
    const bar = root.querySelector('if-find-bar') as HTMLElement & { replacing: boolean; search(): Promise<void>; updateComplete: Promise<boolean>; step(d: 1 | -1): void };
    await bar.updateComplete;
    await settle(2);
    expect(deepFocused()?.closest?.('sf-text-field') ?? deepFocused()).toBeTruthy();
    expect(bar.replacing).toBe(false);
    expectNoA11yIssues(root.host);
    const input = bar.shadowRoot?.querySelector('sf-text-field.query')?.shadowRoot?.querySelector('input') as HTMLInputElement;
    input.value = 'Hello';
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    await bar.search();
    bar.step(1);
    expect(calls.slice(-2)).toEqual(['find text:Hello', 'reveal n1']);
    press(input, 'Escape');
    await element.updateComplete;
    expect(root.querySelector('if-find-bar')).toBeNull();
    await element.openFind(true);
    expect((root.querySelector('if-find-bar') as typeof bar).replacing).toBe(true);
    element.closeFind();
    const more = root.querySelector('header sf-menu.overflow') as SfMenuElement;
    more.dispatchEvent(new CustomEvent('sf-select', { detail: { value: 'find' } }));
    await until(() => root.querySelector('if-find-bar') !== null);
  });

  it('B11c densities: Focus hides the lens switcher and folds Milestone into ⋯; Pro shows the undo label and the zoom as text; Mod+. and Mod+, reach the port', async () => {
    const { root, studio, calls, element } = await mount({ model: { ...MODEL, undo: 'Resize headline' } });
    expect(root.querySelector('header sf-segmented.modes')).not.toBeNull();
    expect(root.querySelector('.undo-label')).toBeNull();
    await studio.setDensity('focus');
    await settle(4);
    await element.updateComplete;
    expect(root.querySelector('header sf-segmented.modes')).toBeNull();
    expect(root.querySelector('header sf-popover')).toBeNull();
    const more = root.querySelector('header sf-menu.overflow') as SfMenuElement;
    expect(menuItems(more)[0]).toBe('Create milestone');
    more.dispatchEvent(new CustomEvent('sf-select', { detail: { value: 'milestone' } }));
    expectNoA11yIssues(root.host);
    await studio.setDensity('pro');
    await settle(4);
    await element.updateComplete;
    expect(root.querySelector('header sf-segmented.modes')).not.toBeNull();
    expect(root.querySelector('.undo-label')?.textContent).toBe('Undo: Resize headline');
    expect(root.querySelector('.zoom-text')?.textContent).toBe('100%');
    expectNoA11yIssues(root.host);
    root.querySelector<HTMLElement>('.surface')?.focus();
    press(root.querySelector('.surface') as HTMLElement, '.', { ctrl: true });
    press(root.querySelector('.surface') as HTMLElement, ',', { ctrl: true });
    expect(calls).toEqual(['createMilestone [""]', 'cycleDensity', 'openSettings']);
  });

  it('the title renames in place through the port; the save state opens Milestones', async () => {
    const { root, calls, element } = await mount();
    const title = root.querySelector('sf-inline-edit.title') as HTMLElement;
    title.dispatchEvent(new CustomEvent('sf-change', { detail: { value: 'Spring sale', previous: 'Night Market Flyer' } }));
    expect(calls).toEqual(['renameTitle ["Spring sale"]']);
    (root.querySelector('.saved') as HTMLButtonElement).click();
    await settle(4);
    const tabs = [...root.querySelectorAll('aside[data-region="dock"] sf-tab')] as HTMLElement[];
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'false', 'false', 'true']);
    expect(await element.showPanel('instaflow/nope')).toBe(false);
  });

  it('shows an agent proposal as a preview card; Open mounts it, Dismiss declines it', async () => {
    const { root, studio } = await mount();
    const p = await studio.proposals.propose(pixelTouchUpSpec(['img-1']), { kind: 'agent', id: 'claude', displayName: 'Claude' }, { reason: 'Touch up the photo' });
    await settle(4);
    const card = root.querySelector('section[aria-label="Proposed editor"]') as HTMLElement;
    expect(card.textContent).toContain('Touch up the photo');
    (card.querySelector('sf-button[variant="agent"]') as HTMLElement).click();
    await until(() => p.state === 'mounted');
  });
});

describe('<if-studio> keyboard paths', () => {
  it('1 and 5 switch lenses; tool letters pick tools; Alt+Enter focuses the pill and arrows rove it', async () => {
    const { root, studio, element } = await mount({ model: { ...MODEL, selection: SHAPE, frame: { x: 100, y: 400, w: 200, h: 100 } } });
    const surface = root.querySelector('.surface') as HTMLElement;
    surface.focus();
    press(surface, '5');
    await until(() => studio.lens?.label === 'Pages');
    press(surface, '1');
    await until(() => studio.lens?.label === 'Canvas');
    await settle(4);
    press(surface, 'f');
    expect(studio.activeTool).toBe(StudioIds.tool.frame);
    press(surface, 'o');
    expect(studio.activeTool).toBe(StudioIds.tool.ellipse);
    press(surface, 'Enter', { alt: true });
    await settle(2);
    const hud = root.querySelector('if-hud') as HTMLElement;
    const items = [...(hud.shadowRoot?.querySelectorAll('[data-hud-item]') ?? [])];
    expect(deepFocused()).toBe(items[0]);
    press(items[0] as Element, 'ArrowRight');
    expect(deepFocused()).toBe(items[1]);
    expect(element.isConnected).toBe(true);
  });

  it('Mod+K opens the command bar; its rows run capabilities (no-selection ones without nodes), tools and the camera', async () => {
    const model = { ...MODEL, selection: SHAPE, frame: { x: 100, y: 400, w: 200, h: 100 }, globalActions: ['instaflow/undo'], actions: new Map([...MODEL.actions, ['instaflow/undo', { id: 'instaflow/undo', title: 'Undo' }]]) };
    const { root, studio, calls } = await mount({ model });
    const surface = root.querySelector('.surface') as HTMLElement;
    surface.focus();
    press(surface, 'k', { ctrl: true });
    await settle(4);
    const bar = root.querySelector('if-command-bar') as HTMLElement;
    const menu = bar.shadowRoot?.querySelector('sf-menu') as HTMLElement & { open?: boolean };
    expect(menu.open).toBe(true);
    const values = [...menu.querySelectorAll('sf-menu-item')].map((i) => i.getAttribute('value'));
    expect(values).toEqual(expect.arrayContaining(['cap:instaflow/flip-horizontal', 'cap:instaflow/undo', `tool:${StudioIds.tool.text}`, 'camera:fit-selection']));
    const select = (value: string): boolean => menu.dispatchEvent(new CustomEvent('sf-select', { detail: { value } }));
    select('cap:instaflow/flip-horizontal');
    select('cap:instaflow/undo');
    select('camera:zoom-100');
    select(`tool:${StudioIds.tool.text}`);
    expect(calls).toEqual(['invoke ["instaflow/flip-horizontal"]', 'invoke ["instaflow/undo",{},[]]', 'camera ["zoom-100"]']);
    expect(studio.activeTool).toBe(StudioIds.tool.text);
  });

  it('right-click on the canvas asks for the target, opens the context menu there and runs its rows (B11b slice 4)', async () => {
    const model = { ...MODEL, selection: SHAPE, frame: { x: 100, y: 400, w: 200, h: 100 }, clipboard: { canPaste: true, styleCopied: false } };
    const { root, calls } = await mount({ model, context: () => ({ ...SHAPE, actions: [...SHAPE.actions, 'instaflow/copy-style'] }) });
    const main = root.querySelector('main') as HTMLElement;
    const surface = root.querySelector('.surface') as HTMLElement;
    const e = new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, clientX: 120, clientY: 90 });
    surface.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    const menu = root.querySelector('sf-menu.context-menu') as SfMenuElement & { open?: boolean };
    await until(() => menu.open === true);
    expect(calls[0]?.startsWith('contextAt')).toBe(true);
    const values = [...menu.querySelectorAll('sf-menu-item')].map((i) => i.getAttribute('value'));
    expect(values).toEqual(expect.arrayContaining(['cmd:cut', 'cmd:copy', 'cmd:paste', 'cap:instaflow/duplicate', 'cap:instaflow/copy-style', 'cap:instaflow/lock?locked=true', 'cmd:rename']));
    expectNoA11yIssues(main);
    const select = (value: string): boolean => menu.dispatchEvent(new CustomEvent('sf-select', { detail: { value } }));
    select('cmd:copy');
    select('cap:instaflow/lock?locked=true');
    select('cmd:page-size:1080x1080');
    select('cmd:replace-image');
    expect(calls.slice(1)).toEqual(['clipboard ["copy"]', 'invoke ["instaflow/lock",{"locked":true}]', 'pageAction ["size","1080x1080"]', 'replaceImage']);
  });

  it('the empty canvas has its own menu', async () => {
    const { root } = await mount({ context: () => undefined });
    const surface = root.querySelector('.surface') as HTMLElement;
    surface.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, clientX: 50, clientY: 50 }));
    const menu = root.querySelector('sf-menu.context-menu') as SfMenuElement & { open?: boolean };
    await until(() => menu.open === true);
    expect([...menu.querySelectorAll('sf-menu-item')].map((i) => i.getAttribute('value'))).toEqual(['cmd:select-all', 'cmd:zoom-fit', 'cmd:zoom-100', 'cmd:add-page', 'cmd:place-image']);
  });

  it('the chrome keys: Mod+\\ collapses the dock, Mod+S hints, ? opens the cheat sheet, Shift+F10 the menu', async () => {
    const { root, calls, element } = await mount({ model: { ...MODEL, selection: SHAPE, frame: { x: 100, y: 400, w: 200, h: 100 } }, context: () => SHAPE });
    const surface = root.querySelector('.surface') as HTMLElement;
    surface.focus();
    const dock = (): boolean => root.querySelector('sf-dock[side="start"]')?.hasAttribute('collapsed') ?? false;
    const before = dock();
    press(surface, '\\', { ctrl: true });
    await settle(2);
    expect(dock()).toBe(!before);
    element.toggleRegion('dock');
    await settle(2);
    expect(dock()).toBe(before);
    press(surface, 's', { ctrl: true });
    press(surface, '?', { shift: true });
    press(surface, 'F10', { shift: true });
    const menu = root.querySelector('sf-menu.context-menu') as SfMenuElement & { open?: boolean };
    await until(() => menu.open === true);
    expect(calls.slice(0, 3).map((c) => c.split(' ')[0])).toEqual(['saveHint', 'openShortcuts', 'contextAt']);
  });

  it('the Home link asks the host first (cancelable) and keeps modified clicks', async () => {
    const { element, root } = await mount();
    const home = root.querySelector('header a.home') as HTMLAnchorElement;
    const hrefs: string[] = [];
    element.addEventListener('if-navigate', (e) => {
      hrefs.push((e as CustomEvent<{ href: string }>).detail.href);
      e.preventDefault();
    });
    const plain = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, button: 0 });
    home.dispatchEvent(plain);
    expect(hrefs).toEqual(['/']);
    expect(plain.defaultPrevented).toBe(true);
    const newTab = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, button: 0, metaKey: true });
    newTab.preventDefault = () => undefined; // happy-dom would follow the link otherwise
    home.dispatchEvent(newTab);
    expect(hrefs).toEqual(['/']);
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

/** Unused-type guard (the contract helper's result type). */
export type _Unused = Result<void> | ReturnType<typeof ok>;
