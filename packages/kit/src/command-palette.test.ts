import { createShortcutRegistry, GlobalShortcutScope } from '@staticflux/a11y';
import {
  alwaysActivePort,
  allowAllDecidePort,
  type CapabilityRegistry,
  CapabilityRegistryToken,
  createCapabilityRegistry,
  defineCapability,
  failClosedConfirmPort,
  implementCapability,
  s,
  unmeteredPort,
} from '@staticflux/capabilities';
import { createScope, ok, unit } from '@staticflux/core';
import { createSurfaceManager, SurfaceManagerToken } from '@staticflux/messaging';
import { expectNoA11yIssues, press } from '@staticflux/testkit/a11y';
import { html } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  bindCapabilityPalette,
  bindCapabilityShortcuts,
  capabilityPaletteSurface,
  capabilityShortcut,
  defineCapabilityPalette,
  fuzzyScore,
  isPaletteRunnable,
  openCapabilityPalette,
  paletteEntries,
  type SfCapabilityPaletteElement,
} from './command-palette.js';
import { defineSurfaces } from './surfaces.js';
import { cleanup, events, fixture, settle, shadow, shadowAll } from './test-helpers.js';

beforeAll(() => {
  defineCapabilityPalette();
  defineSurfaces();
});
afterEach(cleanup);

const AlignLeft = defineCapability({ id: 'editor/align-left', title: 'Align left', description: 'Align the selection to the left edge.', input: s.object({}), output: s.object({}), requiresConfirmation: false, destructive: false });
const Duplicate = defineCapability({ id: 'editor/duplicate', title: 'Duplicate', description: 'Duplicate the selection.', input: s.object({}), output: s.object({}), requiresConfirmation: false, destructive: false });
const InsertText = defineCapability({ id: 'editor/insert-text', title: 'Insert text', description: 'Insert a paragraph.', input: s.object({ text: s.string() }), output: s.object({}), requiresConfirmation: false, destructive: false });
const Unimplemented = defineCapability({ id: 'editor/rotate', title: 'Rotate', description: 'Rotate.', input: s.object({}), output: s.object({}), requiresConfirmation: false, destructive: false });

function registry(ran: string[]): CapabilityRegistry {
  return createCapabilityRegistry({
    decide: allowAllDecidePort,
    confirm: failClosedConfirmPort,
    meter: unmeteredPort,
    activation: alwaysActivePort,
    declarations: [AlignLeft, Duplicate, InsertText, Unimplemented],
    implementations: [
      implementCapability(AlignLeft, () => (ran.push('align'), ok({}))),
      implementCapability(Duplicate, () => (ran.push('dup'), ok({}))),
      implementCapability(InsertText, () => ok({})),
    ],
  });
}

describe('palette search', () => {
  it('scores subsequence matches, favouring word starts and runs', () => {
    expect(fuzzyScore('', 'Anything')).toEqual({ score: 0, indices: [] });
    expect(fuzzyScore('al', 'Align left')?.indices).toEqual([0, 1]);
    expect(fuzzyScore('xyz', 'Align left')).toBeUndefined();
    expect((fuzzyScore('al', 'Align left')?.score ?? 0) > (fuzzyScore('al', 'Duplicate all')?.score ?? 0)).toBe(true);
    expect(fuzzyScore('a l', 'Align left')?.indices).toEqual([0, 1]);
  });

  it('lists only runnable capabilities, ranked, with shortcuts', () => {
    const reg = registry([]);
    expect(isPaletteRunnable(InsertText, (id) => reg.isImplemented(id))).toBe(false); // needs params
    expect(isPaletteRunnable(Unimplemented, (id) => reg.isImplemented(id))).toBe(false);
    const all = paletteEntries(reg.list(), (id) => reg.isImplemented(id), '', new Map([['editor/duplicate', 'Mod+D']]));
    expect(all.map((e) => e.capability.id)).toEqual(['editor/align-left', 'editor/duplicate']);
    expect(all[1]?.shortcut).toBe('Mod+D');
    expect(paletteEntries(reg.list(), (id) => reg.isImplemented(id), 'dup').map((e) => e.capability.id)).toEqual(['editor/duplicate']);
    // description / id match by substring only, below title matches
    expect(paletteEntries(reg.list(), (id) => reg.isImplemented(id), 'edge').map((e) => e.capability.id)).toEqual(['editor/align-left']);
    expect(paletteEntries(reg.list(), (id) => reg.isImplemented(id), 'editor/dup').map((e) => e.capability.id)).toEqual(['editor/duplicate']);
    expect(paletteEntries(reg.list(), (id) => reg.isImplemented(id), 'eaf').map((e) => e.capability.id)).toEqual([]);
    expect(paletteEntries(reg.list(), (id) => reg.isImplemented(id), 'zzz')).toEqual([]);
    expect(paletteEntries(reg.list(), (id) => reg.isImplemented(id), '', new Map(), 1)).toHaveLength(1);
  });
});

describe('<sf-capability-palette>', () => {
  async function palette(ran: string[]): Promise<SfCapabilityPaletteElement> {
    const reg = registry(ran);
    const registryUnit = unit({ id: 'test/registry', provides: CapabilityRegistryToken, scope: 'app', create: () => reg });
    const { element } = await fixture<SfCapabilityPaletteElement>(html`<sf-capability-palette></sf-capability-palette>`, {
      units: [registryUnit, capabilityShortcut(Duplicate, 'Mod+D')],
    });
    await settle();
    return element;
  }

  it('is an accessible combobox over a listbox of runnable capabilities', async () => {
    const element = await palette([]);
    const input = shadow<HTMLInputElement>(element, 'input');
    expect(input.getAttribute('role')).toBe('combobox');
    const options = shadowAll(element, '[role="option"]');
    expect(options.map((o) => o.dataset['capability'])).toEqual(['editor/align-left', 'editor/duplicate']);
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0]?.id);
    expect(options[1]?.querySelector('kbd')?.textContent).toMatch(/D$/);
    expectNoA11yIssues(element);
  });

  it('filters, moves with arrows, runs with Enter through the registry, and reports', async () => {
    const ran: string[] = [];
    const element = await palette(ran);
    const ranEvents = events<{ id: string }>(element, 'sf-capability-ran');
    const input = shadow<HTMLInputElement>(element, 'input');
    press(input, 'ArrowDown');
    await element.updateComplete;
    expect(shadowAll(element, '[role="option"]')[1]?.getAttribute('aria-selected')).toBe('true');
    press(input, 'ArrowDown'); // wraps
    await element.updateComplete;
    expect(element.active).toBe(0);
    press(input, 'ArrowUp');
    await element.updateComplete;
    expect(element.active).toBe(1);
    input.value = 'align';
    input.dispatchEvent(new Event('input'));
    await element.updateComplete;
    expect(element.active).toBe(0);
    expect(shadowAll(element, '[role="option"]')).toHaveLength(1);
    expect(shadow(element, 'mark').textContent).toBe('A');
    press(input, 'Enter');
    await settle();
    expect(ran).toEqual(['align']);
    expect(ranEvents[0]?.detail.id).toBe('editor/align-left');
    input.value = 'nothing-matches';
    input.dispatchEvent(new Event('input'));
    await element.updateComplete;
    expect(shadow(element, '.empty').textContent).toContain('No matching actions');
    press(input, 'Enter');
    press(input, 'Home', { ctrl: true });
  });

  it('runs on click', async () => {
    const ran: string[] = [];
    const element = await palette(ran);
    shadowAll(element, '[role="option"]')[1]?.click();
    await settle();
    expect(ran).toEqual(['dup']);
  });
});

describe('palette surface and shortcuts', () => {
  it('opens as a messaging dialog bound to Mod+K and closes after a run', async () => {
    const ran: string[] = [];
    const reg = registry(ran);
    const manager = createSurfaceManager();
    const { root } = await fixture(html`<sf-surface-layer></sf-surface-layer>`, {
      units: [
        unit({ id: 'test/registry', provides: CapabilityRegistryToken, scope: 'app', create: () => reg }),
        unit({ id: 'test/surfaces', provides: SurfaceManagerToken, scope: 'app', create: () => manager }),
      ],
    });
    const shortcuts = createShortcutRegistry({ isMac: false });
    const scope = createScope('app');
    shortcuts.attach(document, scope);
    const owner = { scope, level: 'app' as const };
    const bound = bindCapabilityPalette({ shortcuts, manager, owner, scope });
    expect(bound.ok).toBe(true);
    press(document.body, 'k', { ctrl: true });
    await settle();
    expect(manager.showing('dialog').map((h) => h.def.id)).toEqual([capabilityPaletteSurface.id]);
    press(document.body, 'k', { ctrl: true }); // already open: no second palette
    expect(manager.active).toHaveLength(1);
    const layer = root.container.querySelector('sf-surface-layer') as HTMLElement;
    const paletteElement = layer.shadowRoot?.querySelector('sf-capability-palette') as SfCapabilityPaletteElement;
    await settle();
    shadowAll(paletteElement, '[role="option"]')[0]?.click();
    await settle();
    expect(ran).toEqual(['align']);
    expect(manager.active).toHaveLength(0);
    const handle = openCapabilityPalette({ manager, owner });
    handle.dismiss('user');
    expect(bindCapabilityPalette({ shortcuts, manager, owner, scope }).ok).toBe(false); // conflict SF-A11Y-002
    await scope.dispose();
  });

  it('binds capability shortcuts that invoke runnable capabilities only', async () => {
    const ran: string[] = [];
    const reg = registry(ran);
    const shortcuts = createShortcutRegistry({ isMac: false });
    const scope = createScope('app');
    shortcuts.attach(document, scope);
    const results = bindCapabilityShortcuts({
      shortcuts,
      registry: reg,
      entries: [
        { capability: Duplicate.id, keys: 'Mod+D' },
        { capability: InsertText.id, keys: 'Mod+Shift+T' },
        { capability: 'editor/missing', keys: 'Mod+Shift+M' },
      ],
      scope,
    });
    expect(results.every((r) => r.ok)).toBe(true);
    press(document.body, 'd', { ctrl: true });
    press(document.body, 't', { ctrl: true, shift: true });
    press(document.body, 'm', { ctrl: true, shift: true });
    await settle();
    expect(ran).toEqual(['dup']);
    expect(shortcuts.list().some((s) => s.scope === GlobalShortcutScope.id)).toBe(true);
    await scope.dispose();
  });
});
