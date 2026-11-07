/**
 * The keyboard cheat sheet (B11b slice 4, STUDIO §2.3.1): every registered Studio shortcut lands on a card in the order
 * a person works, the clipboard keys are rows, and the sheet passes the audit under Clean Pop.
 */
import { createShortcutRegistry } from '@staticflux/a11y';
import { defineShortcutSheet, type SfShortcutSheetElement } from '@staticflux/kit/shortcut-sheet';
import { expectNoA11yIssues } from '@staticflux/testkit/a11y';
import { compileTheme } from '@staticflux/ui/theme';
import { mountTestRoot, settle } from '@staticflux/ui/testing';
import { html, render } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { canvasShortcutDefs } from '../app/canvas-shortcuts.js';
import { ClipboardShortcuts } from '../app/clipboard-controller.js';
import { STUDIO_KEY_COMMANDS } from '../app/studio-commands.js';
import { cleanPopTheme } from '../theme/clean-pop.js';
import { printShortcuts, SHORTCUT_GROUPS, shortcutGroupOf, type ShortcutGroupName, shortcutSheet, shortcutsPrintHtml } from './shortcuts-sheet.js';
import { ChromeShortcuts } from './studio-element.js';
import { createScope } from '@staticflux/core';
import { gateSpecDecide } from '../spec/index.js';
import { editorGate, studioRegistries } from '../spec/testing/fixtures.js';
import { createStudio } from './studio.js';

let dispose: (() => Promise<void>) | undefined;
beforeAll(() => defineShortcutSheet());
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

const ctx = {
  lenses: new Set(['instaflow/lens-pixel']),
  tools: new Set(['instaflow/tool-rect']),
  commands: new Map<string, ShortcutGroupName>(STUDIO_KEY_COMMANDS.map((k) => [k.def.id as string, k.group === 'Style' ? 'Edit' : k.group] as const)),
};

function registry() {
  const r = createShortcutRegistry({ isMac: false });
  for (const def of [...canvasShortcutDefs(), ...Object.values(ChromeShortcuts), ...Object.values(ClipboardShortcuts)]) {
    const done = r.register(def, () => undefined);
    expect(done.ok).toBe(true);
  }
  return r;
}

describe('shortcut groups', () => {
  it('names each card from the id: tools, selection, transform, view, the key commands’ own cards, Studio for the rest', () => {
    expect(shortcutGroupOf({ id: 'instaflow/tool-rect-shortcut' }, ctx)).toBe('Tools');
    expect(shortcutGroupOf({ id: 'instaflow/pen-shortcut' }, ctx)).toBeUndefined(); // #56: not mounted, not listed
    expect(shortcutGroupOf({ id: 'instaflow/lens-pixel-shortcut' }, ctx)).toBe('Studio');
    expect(shortcutGroupOf({ id: 'instaflow/select-next' }, ctx)).toBe('Selection');
    expect(shortcutGroupOf({ id: 'instaflow/arrow-left-large' }, ctx)).toBe('Transform');
    expect(shortcutGroupOf({ id: 'instaflow/zoom-in' }, ctx)).toBe('View');
    expect(shortcutGroupOf({ id: 'instaflow/toggle-dock' }, ctx)).toBe('View');
    expect(shortcutGroupOf({ id: 'instaflow/undo' }, ctx)).toBe('Edit');
    expect(shortcutGroupOf({ id: 'instaflow/undo-chrome' }, ctx)).toBe('Edit');
    expect(shortcutGroupOf({ id: 'instaflow/copy-style-key' }, ctx)).toBe('Edit');
    expect(shortcutGroupOf({ id: 'instaflow/align-left-key' }, ctx)).toBe('Arrange');
    expect(shortcutGroupOf({ id: 'instaflow/copy-key' }, ctx)).toBe('Edit');
    expect(shortcutGroupOf({ id: 'instaflow/shortcuts-help' }, ctx)).toBe('Studio');
  });

  it('a registry snapshot fills the cards in order; every registered shortcut is on one; clipboard keys are Edit rows', () => {
    const r = registry();
    const groups = shortcutSheet(r.list(), ctx);
    const headings = groups.map((g) => g.heading);
    expect(headings).toEqual(SHORTCUT_GROUPS.filter((g) => headings.includes(g)));
    expect(headings).toEqual(expect.arrayContaining(['Selection', 'Edit', 'Arrange', 'Transform', 'View', 'Studio']));
    const rows = groups.flatMap((g) => g.rows.map((row) => row.id));
    const listed = new Set(rows);
    for (const entry of r.list()) if (entry.shadowedBy === undefined) expect(listed.has(entry.id), entry.id).toBe(true);
    const edit = groups.find((g) => g.heading === 'Edit');
    expect(edit?.rows.map((row) => row.label)).toEqual(expect.arrayContaining(['Cut', 'Copy', 'Paste', 'Paste in place', 'Copy style']));
  });

  it('#56: Tools lists only the tools that run now (nothing inert): no Pen, Brush, Heal, Crop, Split or Connect', async () => {
    const { gate } = editorGate('pro');
    const studio = createStudio({ registries: studioRegistries(), decideFor: (s) => gateSpecDecide(gate, s), reducedMotion: () => true });
    await studio.open();
    const r = createShortcutRegistry({ isMac: true });
    const scope = createScope('test');
    expect(studio.bindShortcuts(r, { focusHud: () => undefined, focusCommandBar: () => undefined, focusCanvas: () => undefined }, scope).ok).toBe(true);
    const toolsCard = () => shortcutSheet(r.list(), { ...ctx, lenses: new Set(studio.registries.lenses.map((l) => l.id as string)), tools: new Set(studio.mountedTools) }).find((g) => g.heading === 'Tools');
    const labels = toolsCard()?.rows.map((row) => row.label) ?? [];
    expect(labels).toEqual(expect.arrayContaining(['Select tool', 'Frame tool', 'Rectangle tool', 'Ellipse tool', 'Line tool', 'Text tool', 'Hand tool']));
    for (const inert of ['Pen', 'Brush', 'Heal', 'Crop', 'Split', 'Connect']) expect(labels, inert).not.toContain(`${inert} tool`);
    // Every listed tool key picks a mounted tool.
    for (const row of toolsCard()?.rows ?? []) expect(studio.mountedTools, row.id).toContain(row.id.replace(/-shortcut$/, ''));
    await scope.dispose();
    await studio.dispose();
  });

  it('the sheet over the snapshot passes the audit under Clean Pop', async () => {
    const style = document.createElement('style');
    style.textContent = compileTheme(cleanPopTheme);
    document.head.append(style);
    const root = mountTestRoot({ units: [] });
    dispose = () => root.dispose();
    render(html`<sf-shortcut-sheet .groups=${shortcutSheet(registry().list(), ctx)}></sf-shortcut-sheet>`, root.container);
    await settle(6);
    const sheet = root.container.querySelector('sf-shortcut-sheet') as SfShortcutSheetElement;
    expect(sheet.shadowRoot?.querySelectorAll('section').length).toBeGreaterThan(4);
    expectNoA11yIssues(sheet);
  });

  it('B11c Print: a plain page of the cards with both platforms’ keys, printed from a hidden frame', () => {
    const groups = [{ heading: 'Edit', rows: [{ id: 'u', label: 'Undo <last>', keys: ['Mod+Z'] }] }];
    const page = shortcutsPrintHtml(groups);
    expect(page).toContain('<h2>Edit</h2>');
    expect(page).toContain('<td>Undo &lt;last&gt;</td><td><kbd>Ctrl+Z</kbd></td><td><kbd>⌘Z</kbd></td>');
    let printed = 0;
    const frame = { contentWindow: { document: { open: () => undefined, write: (h: string) => expect(h).toBe(page), close: () => undefined }, addEventListener: () => undefined, focus: () => undefined, print: () => void (printed += 1) } };
    const doc = { createElement: () => Object.assign(document.createElement('div'), frame), body: document.body } as unknown as Document;
    printShortcuts(groups, doc);
    expect(printed).toBe(1);
  });
});
