import { checkShortcuts, createShortcutRegistry, defineShortcutScope } from '@staticflux/a11y';
import { createScope, err, defineError, ok } from '@staticflux/core';
import { createMemoryKeyValue } from '@staticflux/messaging';
import { gateResource, type DecidePort } from '@staticflux/ui';
import { describe, expect, it, vi } from 'vitest';
import {
  arrangeSlots,
  bindCommandShortcut,
  bindCommandShortcuts,
  builtInThemes,
  CommandPaletteShortcut,
  commandShortcut,
  commandShortcutDefs,
  commandShortcutLabels,
  createCommandRegistry,
  createThemeController,
  createWorkspaceManager,
  cssVar,
  defineCommand,
  defineWorkspace,
  DEFAULT_SKIP_TARGETS,
  defaultShellMessages,
  fuzzyMatch,
  landmarkOf,
  type MediaPort,
  skipLinksFor,
  type SlotContribution,
  themeToCss,
  tokenVar,
  withViewTransition,
} from './index.js';

const c = (id: `${string}/${string}`, slot: SlotContribution['slot'], extra: Partial<SlotContribution> = {}): SlotContribution => ({
  id,
  slot,
  render: () => id,
  ...extra,
});

describe('arrangeSlots (workspaces as config, R13.2)', () => {
  const contributions = [
    c('app/header', 'header'),
    c('studio/editor', 'main'),
    c('agent/chat', 'panel', { order: 2 }),
    c('studio/outline', 'panel', { order: 1 }),
    c('studio/inspector', 'panel', { byDefault: false, order: 3 }),
    c('studio/basic-toolbar', 'header', { order: 1 }),
    c('studio/pro-toolbar', 'header', { byDefault: false }),
  ];
  const ids = (layout: ReturnType<typeof arrangeSlots>, slot: SlotContribution['slot']) => (layout.get(slot) ?? []).map((x) => x.id);

  it('default workspace: byDefault contributions, ordered', () => {
    const layout = arrangeSlots(contributions);
    expect(ids(layout, 'panel')).toEqual(['studio/outline', 'agent/chat']);
    expect(ids(layout, 'header')).toEqual(['app/header', 'studio/basic-toolbar']);
  });

  it('expert workspace adds, removes, swaps, moves and reorders', () => {
    const expert = defineWorkspace({
      id: 'studio/expert',
      add: ['studio/inspector'],
      remove: ['studio/outline'],
      swap: { 'studio/basic-toolbar': 'studio/pro-toolbar' },
      move: { 'agent/chat': 'sidebar' },
      order: { 'studio/inspector': -1 },
    });
    const layout = arrangeSlots(contributions, expert);
    expect(ids(layout, 'panel')).toEqual(['studio/inspector']);
    expect(ids(layout, 'sidebar')).toEqual(['agent/chat']);
    expect(ids(layout, 'header')).toEqual(['app/header', 'studio/pro-toolbar']);
  });

  it('gated contributions are filtered by the allow predicate', () => {
    const layout = arrangeSlots(contributions, undefined, (x) => x.id !== 'agent/chat');
    expect(ids(layout, 'panel')).toEqual(['studio/outline']);
  });
});

describe('workspace manager', () => {
  it('switches with gating, persists and restores the preference', async () => {
    const expert = defineWorkspace({ id: 'studio/expert', gate: gateResource('workspace', 'workspace:studio/expert') });
    let allow = false;
    const decide: DecidePort = { decide: () => (allow ? { effect: 'allow' } : { effect: 'deny', reason: 'plan:free' }) };
    const store = createMemoryKeyValue<string>();
    const created = createWorkspaceManager({ workspaces: [expert], decide, store });
    if (!created.ok) throw created.error;
    const manager = created.value;
    const switches = vi.fn();
    manager.onSwitch(switches);
    expect(manager.current.id).toBe('shell/default');
    const denied = await manager.switchTo('studio/expert');
    expect(!denied.ok && denied.error.code).toBe('SF-SHELL-002');
    allow = true;
    expect((await manager.switchTo('studio/expert')).ok).toBe(true);
    expect(manager.current.id).toBe('studio/expert');
    expect(switches).toHaveBeenCalledWith(expect.objectContaining({ to: expert }));
    expect(store.entries.get('shell/workspace')).toBe('studio/expert');
    const again = createWorkspaceManager({ workspaces: [expert], decide, store });
    if (!again.ok) throw again.error;
    await again.value.restore();
    expect(again.value.current.id).toBe('studio/expert');
    const unknown = await manager.switchTo('nope/none');
    expect(!unknown.ok && unknown.error.code).toBe('SF-SHELL-001');
  });

  it('rejects duplicate workspace ids and unknown initial workspaces', () => {
    const w = defineWorkspace({ id: 'a/b' });
    expect(createWorkspaceManager({ workspaces: [w, w] }).ok).toBe(false);
    expect(createWorkspaceManager({ workspaces: [], initial: 'x/y' }).ok).toBe(false);
  });
});

describe('theming (R13.1, R15.3)', () => {
  function media(initial: Record<string, boolean>): MediaPort & { set(q: string, v: boolean): void } {
    const state = { ...initial };
    const listeners = new Map<string, Set<() => void>>();
    return {
      matches: (q) => state[q] ?? false,
      subscribe(q, l) {
        const set = listeners.get(q) ?? new Set();
        set.add(l);
        listeners.set(q, set);
        return () => set.delete(l);
      },
      set(q, v) {
        state[q] = v;
        for (const l of listeners.get(q) ?? []) l();
      },
    };
  }

  it('tokens map to CSS custom properties', () => {
    expect(tokenVar('colorBg')).toBe('--sf-color-bg');
    expect(tokenVar('space1')).toBe('--sf-space-1');
    expect(cssVar('radiusSmall')).toBe('var(--sf-radius-small)');
    const cssText = themeToCss(builtInThemes[0]);
    expect(cssText).toContain('--sf-color-bg: #f7f7f8;');
    expect(cssText).toContain('color-scheme: light;');
  });

  it('system preference follows platform facts; explicit choice wins; applied reactively and persisted', async () => {
    const m = media({ '(prefers-color-scheme: dark)': true });
    const store = createMemoryKeyValue<string>();
    const theme = createThemeController({ media: m, store });
    const el = document.createElement('div');
    const scope = createScope('theme');
    theme.apply(el, scope);
    expect(theme.theme.id).toBe('shell/dark');
    expect(el.style.getPropertyValue('--sf-color-bg')).toBe('#111114');
    expect(el.dataset['theme']).toBe('shell/dark');
    m.set('(prefers-contrast: more)', true);
    expect(el.dataset['theme']).toBe('shell/high-contrast');
    await theme.set('light');
    expect(el.dataset['theme']).toBe('shell/light');
    expect(el.style.colorScheme).toBe('light');
    expect(store.entries.get('shell/theme')).toBe('light');
    const restored = createThemeController({ media: m, store });
    await restored.restore();
    expect(restored.preference).toBe('light');
    m.set('(forced-colors: active)', true);
    expect(theme.forcedColors).toBe(true);
    await scope.dispose();
  });
});

describe('commands (R13.3)', () => {
  it('fuzzy match prefers prefixes, word starts and runs', () => {
    expect(fuzzyMatch('exp', 'Export as PDF')).toMatchObject({ indices: [0, 1, 2] });
    expect(fuzzyMatch('xyz', 'Export')).toBeUndefined();
    const prefix = fuzzyMatch('ins', 'Insert image')?.score ?? 0;
    const inner = fuzzyMatch('ins', 'Toggle inspector')?.score ?? 0;
    expect(prefix).toBeGreaterThan(inner);
    expect(fuzzyMatch('', 'x')).toEqual({ score: 0, indices: [] });
  });

  it('search ranks available commands; run returns Results; gating and when filter', async () => {
    let docOpen = false;
    const run = vi.fn(() => ok('done'));
    const decide: DecidePort = { decide: () => ({ effect: 'deny', reason: 'plan' }) };
    const created = createCommandRegistry({
      decide,
      commands: [
        defineCommand({ id: 'studio/export-pdf', title: 'Export as PDF', keywords: ['download'], when: () => docOpen, run }),
        defineCommand({ id: 'studio/insert-image', title: 'Insert image', run: () => undefined }),
        defineCommand({ id: 'agent/premium', title: 'Insert AI image', gate: gateResource('command', 'command:agent/premium'), run: () => undefined }),
        defineCommand({
          id: 'test/throws',
          title: 'Throws',
          run: () => {
            throw new Error('x');
          },
        }),
        defineCommand({ id: 'test/fails', title: 'Fails', run: () => err(defineError('SF-TEST-SH-1', 'conflict', 'f', 'g')()) }),
      ],
    });
    if (!created.ok) throw created.error;
    const registry = created.value;
    await registry.refreshDecisions();
    expect(registry.search('ins').map((r) => r.command.id)).toEqual(['studio/insert-image']);
    expect(registry.search('export')).toHaveLength(0);
    const unavailable = await registry.run('studio/export-pdf');
    expect(!unavailable.ok && unavailable.error.code).toBe('SF-SHELL-006');
    docOpen = true;
    expect(registry.search('download')[0]?.command.id).toBe('studio/export-pdf');
    expect(await registry.run('studio/export-pdf')).toEqual(ok('done'));
    const thrown = await registry.run('test/throws');
    expect(!thrown.ok && thrown.error.code).toBe('SF-SHELL-007');
    const failed = await registry.run('test/fails');
    expect(!failed.ok && failed.error.code).toBe('SF-TEST-SH-1');
    const missing = await registry.run('x/y');
    expect(!missing.ok && missing.error.code).toBe('SF-SHELL-005');
    const scope = createScope('feature');
    const extra = defineCommand({ id: 'studio/runtime', title: 'Runtime command', run: () => undefined });
    expect(registry.register(extra, scope).ok).toBe(true);
    expect(registry.get('studio/runtime')).toBe(extra);
    expect(registry.register(defineCommand({ id: 'studio/runtime', title: 'dup', run: () => undefined })).ok).toBe(false);
    await scope.dispose();
    expect(registry.get('studio/runtime')).toBeUndefined();
  });
});

describe('command shortcuts (a11y registry glue)', () => {
  const key = (init: KeyboardEventInit): KeyboardEvent => new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });

  it('declares commands as typed a11y shortcuts and labels them per platform', () => {
    const editor = defineShortcutScope('studio/editor');
    const exportPdf = defineCommand({ id: 'studio/export-pdf', title: 'Export as PDF', shortcut: 'Mod+Shift+E', run: () => undefined });
    const bold = defineCommand({ id: 'studio/bold', title: 'Bold', shortcut: 'Mod+B', shortcutScope: editor, run: () => undefined });
    const plain = defineCommand({ id: 'studio/plain', title: 'No shortcut', run: () => undefined });
    expect(commandShortcut(plain)).toBeUndefined();
    const def = commandShortcut(exportPdf);
    expect(def).toMatchObject({ kind: 'shortcut', id: 'studio/export-pdf', keys: ['Mod+Shift+E'], description: 'Export as PDF', scope: { id: 'a11y/global' } });
    expect(commandShortcut(bold)?.scope).toBe(editor);
    expect(commandShortcutDefs([exportPdf, bold, plain]).map((d) => d.id)).toEqual(['studio/export-pdf', 'studio/bold']);
    expect(commandShortcutLabels(createShortcutRegistry({ isMac: true }), exportPdf)).toEqual(['⇧⌘E']);
    expect(commandShortcutLabels(createShortcutRegistry({ isMac: false }), exportPdf)).toEqual(['Ctrl+Shift+E']);
    expect(commandShortcutLabels(createShortcutRegistry({ isMac: false }), plain)).toEqual([]);
  });

  it('CI check catches a command colliding with the palette shortcut', () => {
    const clash = defineCommand({ id: 'studio/link', title: 'Insert link', shortcut: 'Mod+K', run: () => undefined });
    const issues = checkShortcuts([CommandPaletteShortcut, ...commandShortcutDefs([clash])]);
    expect(issues.filter((i) => i.code === 'conflict' && i.severity === 'error')).toHaveLength(2); // mac + other
  });

  it('binds command shortcuts: runs with source "shortcut", respects availability, unbinds with the scope', async () => {
    const scope = createScope('app');
    const run = vi.fn();
    let enabled = true;
    const created = createCommandRegistry({
      commands: [
        defineCommand({ id: 'a/b', title: 'A', shortcut: 'Alt+N', when: () => enabled, run }),
        defineCommand({ id: 'a/none', title: 'None', run: vi.fn() }),
      ],
    });
    if (!created.ok) throw created.error;
    const shortcuts = createShortcutRegistry({ isMac: false });
    const bound = bindCommandShortcuts(shortcuts, created.value, scope);
    expect(bound).toHaveLength(1);
    expect(bound.every((b) => b.ok)).toBe(true);
    expect(shortcuts.handle(key({ key: 'n', code: 'KeyN', altKey: true }))).toBe(true);
    await Promise.resolve();
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ source: 'shortcut' }));
    enabled = false;
    expect(shortcuts.handle(key({ key: 'n', code: 'KeyN', altKey: true }))).toBe(false);
    await scope.dispose();
    expect(shortcuts.list()).toHaveLength(0);
  });

  it('conflicts are SF-A11Y-002 errors; a command in a child scope shadows instead', () => {
    const scope = createScope('app');
    const created = createCommandRegistry({
      commands: [
        defineCommand({ id: 'a/one', title: 'One', shortcut: 'Mod+J', run: vi.fn() }),
        defineCommand({ id: 'a/two', title: 'Two', shortcut: 'Mod+J', run: vi.fn() }),
      ],
    });
    if (!created.ok) throw created.error;
    const shortcuts = createShortcutRegistry({ isMac: false });
    const [first, second] = bindCommandShortcuts(shortcuts, created.value, scope);
    expect(first?.ok).toBe(true);
    expect(second !== undefined && !second.ok && second.error.code).toBe('SF-A11Y-002');
    const panel = defineShortcutScope('studio/panel');
    const shadowing = defineCommand({ id: 'a/three', title: 'Three', shortcut: 'Mod+J', shortcutScope: panel, run: vi.fn() });
    expect(created.value.register(shadowing).ok).toBe(true);
    expect(bindCommandShortcut(shortcuts, created.value, shadowing, scope)?.ok).toBe(true);
    expect(shortcuts.conflicts().map((i) => i.code)).toEqual(['shadow']);
    const plain = defineCommand({ id: 'a/plain', title: 'Plain', run: vi.fn() });
    expect(bindCommandShortcut(shortcuts, created.value, plain, scope)).toBeUndefined();
  });
});

describe('skip links and landmarks (pure)', () => {
  it('maps built-in slots to landmarks; custom slots are regions', () => {
    expect(['header', 'sidebar', 'main', 'panel'].map((s) => landmarkOf(s as SlotContribution['slot']))).toEqual([
      'banner',
      'navigation',
      'main',
      'complementary',
    ]);
    expect(landmarkOf('status-bar' as SlotContribution['slot'])).toBe('region');
  });

  it('offers links only for rendered targets with a label, in target order', () => {
    expect(DEFAULT_SKIP_TARGETS).toEqual(['main', 'sidebar', 'panel']);
    expect(skipLinksFor(['header', 'sidebar', 'main'])).toEqual([
      { slot: 'main', label: 'Skip to main content' },
      { slot: 'sidebar', label: 'Skip to navigation' },
    ]);
    const messages = { ...defaultShellMessages, skipTo: { main: 'Zum Inhalt', panel: '' } };
    expect(skipLinksFor(['main', 'panel', 'sidebar'], ['panel', 'main', 'sidebar'], messages)).toEqual([{ slot: 'main', label: 'Zum Inhalt' }]);
  });
});

describe('view transitions (R12.19)', () => {
  it('falls back to a plain update without the API or under reduced motion', async () => {
    const update = vi.fn();
    expect(await withViewTransition(update, { document: document })).toEqual(ok({ animated: false }));
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('uses startViewTransition when available and reports update errors', async () => {
    const fake = {
      startViewTransition(cb: () => Promise<void>) {
        const done = cb();
        return { updateCallbackDone: done, finished: done.catch(() => undefined) };
      },
    } as unknown as Document;
    const update = vi.fn();
    expect(await withViewTransition(update, { document: fake, reducedMotion: false })).toEqual(ok({ animated: true }));
    const failing = await withViewTransition(
      () => {
        throw new Error('boom');
      },
      { document: fake, reducedMotion: false },
    );
    expect(failing.ok).toBe(false);
    const reduced = await withViewTransition(update, { document: fake, reducedMotion: true });
    expect(reduced).toEqual(ok({ animated: false }));
  });
});
